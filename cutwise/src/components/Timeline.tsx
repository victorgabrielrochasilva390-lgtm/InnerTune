import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Clip, Track } from "../../shared/types";
import { useEditor, snapFrame } from "../store";
import { clipDuration, clipEnd, EPS, formatShort, overwrite, snap, snapPoints } from "../../shared/timeline";
import { captionPages } from "../../shared/captions";
import { makeTrack } from "../../shared/defaults";
import { TRANSITIONS } from "../../shared/presets";
import { Icon, IconButton } from "./ui";
import { addMedia, addText, deleteSelection, duplicateSelection, recTimeline, setMotion, setTransition, splitAtPlayhead, splitClipAt } from "../actions";
import { api, loadPeaks, type PubMedia } from "../api";

const HEADER_W = 188;
const LANE_H: Record<Track["kind"], number> = { video: 58, audio: 46, text: 36 };

interface DragState {
  kind: "move" | "trimL" | "trimR" | "scrub";
  ids: string[];
  startX: number;
  startY: number;
  orig: Record<string, { start: number; in: number; out: number; trackId: string }>;
  dt: number;
  trackDelta: number;
  moved: boolean;
}

export function Timeline() {
  const project = useEditor((s) => s.project)!;
  const media = useEditor((s) => s.media);
  const pps = useEditor((s) => s.pxPerSec);
  const playhead = useEditor((s) => s.playhead);
  const playing = useEditor((s) => s.playing);
  const selection = useEditor((s) => s.selection);
  const tool = useEditor((s) => s.tool);
  const snapping = useEditor((s) => s.snapping);
  const inOut = useEditor((s) => s.inOut);
  const set = useEditor((s) => s.set);
  const scroller = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ left: 0, width: 1200 });
  const [drag, setDrag] = useState<DragState | null>(null);
  const dragRef = useRef<DragState | null>(null);
  dragRef.current = drag;
  const [menu, setMenu] = useState<{ x: number; y: number; clip: Clip } | null>(null);
  const [dropHint, setDropHint] = useState<{ trackId: string; t: number } | null>(null);

  const total = Math.max(30, project.clips.reduce((d, c) => Math.max(d, clipEnd(c)), 0) + 20);
  const width = total * pps;
  const fps = project.settings.fps;
  const pages = useMemo(() => (project.captions.enabled ? captionPages(project) : []), [project.captions, project.clips, project.transcripts]);
  const recs = project.ai.recommendations.filter((r) => (r.status === "pending" || r.status === "approved") && !["audio", "color", "caption", "music"].includes(r.kind));

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const upd = () => setView({ left: el.scrollLeft, width: el.clientWidth });
    upd();
    el.addEventListener("scroll", upd);
    const ro = new ResizeObserver(upd);
    ro.observe(el);
    return () => {
      el.removeEventListener("scroll", upd);
      ro.disconnect();
    };
  }, []);

  // keep the playhead visible while playing
  useEffect(() => {
    const el = scroller.current;
    if (!el || !playing) return;
    const x = playhead * pps;
    if (x > el.scrollLeft + el.clientWidth - HEADER_W - 60 || x < el.scrollLeft) el.scrollLeft = Math.max(0, x - 80);
  }, [playhead, playing, pps]);

  const xToTime = (clientX: number) => {
    const el = scroller.current!;
    const r = el.getBoundingClientRect();
    return Math.max(0, (clientX - r.left - HEADER_W + el.scrollLeft) / pps);
  };

  const onWheel = (e: React.WheelEvent) => {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      const t = xToTime(e.clientX);
      const next = Math.max(4, Math.min(600, pps * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
      set({ pxPerSec: next });
      requestAnimationFrame(() => {
        const el = scroller.current!;
        const r = el.getBoundingClientRect();
        el.scrollLeft = t * next - (e.clientX - r.left - HEADER_W);
      });
    }
  };

  // ---------------------------------------------------------------- drag handling
  const beginDrag = (e: React.PointerEvent, kind: DragState["kind"], clip?: Clip) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    if (kind === "scrub") {
      set({ playhead: snapFrame(xToTime(e.clientX), fps), playing: false });
      setDrag({ kind, ids: [], startX: e.clientX, startY: e.clientY, orig: {}, dt: 0, trackDelta: 0, moved: false });
      return;
    }
    if (!clip) return;
    const track = project.tracks.find((t) => t.id === clip.trackId);
    if (track?.locked) return;
    if (tool === "blade" && kind === "move") {
      splitClipAt(clip.id, snapFrame(xToTime(e.clientX), fps));
      return;
    }
    let ids = selection;
    if (e.shiftKey || e.metaKey || e.ctrlKey) {
      ids = selection.includes(clip.id) ? selection.filter((x) => x !== clip.id) : [...selection, clip.id];
      set({ selection: ids });
      return;
    }
    if (!selection.includes(clip.id)) {
      ids = [clip.id];
      set({ selection: ids });
    }
    if (kind !== "move") ids = [clip.id];
    const orig: DragState["orig"] = {};
    for (const c of project.clips) if (ids.includes(c.id)) orig[c.id] = { start: c.start, in: c.in, out: c.out, trackId: c.trackId };
    setDrag({ kind, ids, startX: e.clientX, startY: e.clientY, orig, dt: 0, trackDelta: 0, moved: false });
  };

  useEffect(() => {
    if (!drag) return;
    const laneTops = () => {
      const el = scroller.current!;
      return [...el.querySelectorAll<HTMLElement>(".lane[data-track]")].map((n) => ({ id: n.dataset.track!, r: n.getBoundingClientRect() }));
    };
    const move = (e: PointerEvent) => {
      const d = dragRef.current!;
      if (d.kind === "scrub") {
        set({ playhead: snapFrame(xToTime(e.clientX), fps) });
        return;
      }
      let dt = (e.clientX - d.startX) / pps;
      const first = project.clips.find((c) => c.id === d.ids[0]);
      if (!first) return;
      const o = d.orig[first.id];
      if (snapping) {
        const pts = snapPoints(project, new Set(d.ids), useEditor.getState().playhead);
        const thr = 8 / pps;
        if (d.kind === "move") {
          const dur = (o.out - o.in) / first.speed;
          const a = snap(o.start + dt, pts, thr);
          const b = snap(o.start + dur + dt, pts, thr);
          if (a !== o.start + dt) dt = a - o.start;
          else if (b !== o.start + dur + dt) dt = b - o.start - dur;
        } else if (d.kind === "trimL") dt = snap(o.start + dt, pts, thr) - o.start;
        else dt = snap(o.start + (o.out - o.in) / first.speed + dt, pts, thr) - (o.start + (o.out - o.in) / first.speed);
      }
      dt = Math.round(dt * fps) / fps;
      let trackDelta = 0;
      if (d.kind === "move") {
        const lanes = laneTops();
        const idx = lanes.findIndex((l) => e.clientY >= l.r.top && e.clientY < l.r.bottom);
        const from = lanes.findIndex((l) => l.id === o.trackId);
        if (idx >= 0 && from >= 0) trackDelta = idx - from;
      }
      setDrag({ ...d, dt, trackDelta, moved: d.moved || Math.abs(e.clientX - d.startX) > 2 || Math.abs(e.clientY - d.startY) > 4 });
    };
    const up = () => {
      const d = dragRef.current!;
      setDrag(null);
      if (d.kind === "scrub" || !d.moved) return;
      const lanes = laneTops().map((l) => l.id);
      const p = useEditor.getState().project!;
      let clips = p.clips.slice();
      const moved: Clip[] = [];
      for (const id of d.ids) {
        const c = clips.find((x) => x.id === id);
        if (!c) continue;
        const o = d.orig[id];
        const m = c.mediaId ? media[c.mediaId] : undefined;
        const maxOut = m && m.kind !== "image" ? m.duration : Infinity;
        let next: Clip = { ...c };
        if (d.kind === "move") {
          next.start = Math.max(0, o.start + d.dt);
          const ti = lanes.indexOf(o.trackId) + d.trackDelta;
          const target = p.tracks.find((t) => t.id === lanes[ti]);
          const srcTrack = p.tracks.find((t) => t.id === o.trackId)!;
          const compatible = target && !target.locked && (target.kind === srcTrack.kind || (c.kind === "media" && m?.kind !== "audio" && target.kind === "video") || (m?.kind === "audio" && target.kind === "audio"));
          if (compatible) next.trackId = target.id;
        } else if (d.kind === "trimL") {
          let dt = d.dt;
          dt = Math.max(dt, -o.in / c.speed, -o.start);
          dt = Math.min(dt, (o.out - o.in) / c.speed - 1 / fps);
          next.start = o.start + dt;
          next.in = c.kind === "media" && m?.kind !== "image" ? o.in + dt * c.speed : 0;
          if (c.kind !== "media" || m?.kind === "image") next.out = o.out - dt;
        } else {
          let dt = d.dt;
          dt = Math.max(dt, -((o.out - o.in) / c.speed) + 1 / fps);
          next.out = Math.min(maxOut, o.out + dt * c.speed);
        }
        clips = clips.filter((x) => x.id !== id);
        moved.push(next);
      }
      for (const m of moved) clips = overwrite(clips, m);
      useEditor.getState().replaceProject(d.kind === "move" ? "Move clip" : "Trim clip", { ...p, clips });
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up, { once: true });
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
  }, [drag?.kind, drag?.ids.join(), pps, snapping]);

  const ghost = (c: Clip): { start: number; dur: number; trackShift: number } => {
    const dur = clipDuration(c);
    if (!drag || !drag.ids.includes(c.id) || drag.kind === "scrub") return { start: c.start, dur, trackShift: 0 };
    if (drag.kind === "move") return { start: Math.max(0, c.start + drag.dt), dur, trackShift: drag.trackDelta };
    if (drag.kind === "trimL") {
      const dt = Math.min(Math.max(drag.dt, -c.start), dur - 1 / fps);
      return { start: c.start + dt, dur: dur - dt, trackShift: 0 };
    }
    return { start: c.start, dur: Math.max(1 / fps, dur + drag.dt), trackShift: 0 };
  };

  // ---------------------------------------------------------------- drops (media, transitions, files)
  const onDrop = async (e: React.DragEvent, track: Track) => {
    e.preventDefault();
    setDropHint(null);
    const t = snapFrame(xToTime(e.clientX), fps);
    const mid = e.dataTransfer.getData("application/x-cutwise-media");
    const tr = e.dataTransfer.getData("application/x-cutwise-transition");
    const mo = e.dataTransfer.getData("application/x-cutwise-motion");
    const tx = e.dataTransfer.getData("application/x-cutwise-text");
    const target = project.clips.find((c) => c.trackId === track.id && t >= c.start && t < clipEnd(c));
    if (mid && media[mid]) return addMedia(media[mid], t, track.id);
    if (tr && target) return setTransition([target.id], tr as any);
    if (mo && target) return setMotion([target.id], mo as any);
    if (tx) {
      set({ playhead: t });
      return addText(tx as any);
    }
    if (e.dataTransfer.files.length) {
      const files = [...e.dataTransfer.files];
      useEditor.getState().toast(`Uploading ${files.length} file(s)…`);
      const res = await api.upload(files);
      let at = t;
      for (const m of res) {
        if (!("id" in m)) {
          useEditor.getState().toast(String(m.error), "error");
          continue;
        }
        useEditor.getState().setMedia(m as PubMedia);
        addMedia(m as PubMedia, at, track.id);
        at += (m as PubMedia).kind === "image" ? 4 : (m as PubMedia).duration;
      }
    }
  };

  const addTrack = (kind: Track["kind"]) => {
    useEditor.getState().commit(`Add ${kind} track`, (d) => {
      const n = d.tracks.filter((t) => t.kind === kind).length + 1;
      const t = makeTrack(kind, `${kind === "video" ? "V" : kind === "audio" ? "A" : "T"}${n}`, kind === "audio" ? { role: "music" } : {});
      if (kind === "audio") d.tracks.push(t as any);
      else d.tracks.splice(kind === "text" ? 0 : d.tracks.findIndex((x) => x.kind === "video"), 0, t as any);
    });
  };

  const tickStep = pps > 200 ? 0.5 : pps > 80 ? 1 : pps > 30 ? 5 : pps > 10 ? 10 : 30;
  const firstTick = Math.floor(view.left / pps / tickStep) * tickStep;
  const ticks: number[] = [];
  for (let t = firstTick; t * pps < view.left + view.width; t += tickStep) ticks.push(t);

  return (
    <div className="timeline" data-tour="timeline">
      <div className="tl-toolbar">
        <IconButton icon="cursor" label="Select tool" kbd="V" active={tool === "select"} onClick={() => set({ tool: "select" })} />
        <IconButton icon="scissors" label="Blade tool: click a clip to cut" kbd="B" active={tool === "blade"} onClick={() => set({ tool: "blade" })} />
        <IconButton icon="magnet" label="Snapping" kbd="N" active={snapping} onClick={() => set({ snapping: !snapping })} />
        <span className="sep" />
        <IconButton icon="split" label="Split at playhead" kbd="S" onClick={splitAtPlayhead} />
        <IconButton icon="duplicate" label="Duplicate" kbd="Ctrl+D" onClick={duplicateSelection} disabled={!selection.length} />
        <IconButton icon="trash" label="Delete" kbd="Del" onClick={() => deleteSelection(false)} disabled={!selection.length} />
        <button className="btn sm ghost" disabled={!selection.length} onClick={() => deleteSelection(true)} data-tip="Delete and close the gap (Shift+Del)">
          Ripple delete
        </button>
        <span className="sep" />
        <IconButton icon="marker" label="Add marker" kbd="M" onClick={() => useEditor.getState().commit("Add marker", (d) => void d.markers.push({ id: crypto.randomUUID(), t: playhead, label: `Marker ${d.markers.length + 1}`, color: "#ffd60a" }))} />
        <span className="muted small">
          In {inOut.in !== null ? formatShort(inOut.in) : "--"} · Out {inOut.out !== null ? formatShort(inOut.out) : "--"}
        </span>
        <span className="grow" />
        <button className="btn sm ghost" onClick={() => addTrack("video")} data-tip="Add video track">
          + Video
        </button>
        <button className="btn sm ghost" onClick={() => addTrack("audio")} data-tip="Add audio track">
          + Audio
        </button>
        <button className="btn sm ghost" onClick={() => addTrack("text")} data-tip="Add text track">
          + Text
        </button>
        <span className="sep" />
        <IconButton icon="zoomOut" label="Zoom out" kbd="-" onClick={() => set({ pxPerSec: Math.max(4, pps / 1.4) })} />
        <input className="zoom" type="range" min={4} max={600} value={pps} onChange={(e) => set({ pxPerSec: Number(e.target.value) })} data-tip="Timeline zoom (Ctrl + mouse wheel)" />
        <IconButton icon="zoomIn" label="Zoom in" kbd="+" onClick={() => set({ pxPerSec: Math.min(600, pps * 1.4) })} />
        <button
          className="btn sm ghost"
          onClick={() => {
            const el = scroller.current!;
            const d = Math.max(5, project.clips.reduce((a, c) => Math.max(a, clipEnd(c)), 0));
            set({ pxPerSec: Math.max(4, (el.clientWidth - HEADER_W - 40) / d) });
            el.scrollLeft = 0;
          }}
          data-tip="Fit the whole edit (Shift+Z)"
        >
          Fit
        </button>
      </div>
      <div className="tl-scroll" ref={scroller} onWheel={onWheel} onPointerDown={() => setMenu(null)}>
        <div className="tl-inner" style={{ width: width + HEADER_W }}>
          <div className="tl-row ruler-row">
            <div className="tl-head sticky-left ruler-head">{formatShort(playhead)}</div>
            <div className="ruler" style={{ width }} onPointerDown={(e) => beginDrag(e, "scrub")}>
              {ticks.map((t) => (
                <div key={t} className="tick" style={{ left: t * pps }}>
                  <span>{formatShort(t).replace(/\.0$/, "")}</span>
                </div>
              ))}
              {project.markers.map((m) => (
                <div
                  key={m.id}
                  className="marker"
                  style={{ left: m.t * pps, background: m.color }}
                  title={m.label}
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    set({ playhead: m.t });
                  }}
                  onDoubleClick={() => useEditor.getState().commit("Delete marker", (d) => void (d.markers = d.markers.filter((x) => x.id !== m.id)))}
                />
              ))}
              {inOut.in !== null && inOut.out !== null && inOut.out > inOut.in && <div className="inout" style={{ left: inOut.in * pps, width: (inOut.out - inOut.in) * pps }} />}
            </div>
          </div>
          {recs.length > 0 && (
            <div className="tl-row ai-row">
              <div className="tl-head sticky-left">
                <Icon name="sparkle" size={13} /> AI suggestions
              </div>
              <div className="lane ai-lane" style={{ width }}>
                {recs.map((r) => {
                  const tl = recTimeline(project, r);
                  if (!tl) return null;
                  return (
                    <div
                      key={r.id}
                      className={`rec-mark k-${r.kind}`}
                      style={{ left: tl.start * pps, width: Math.max(4, (tl.end - tl.start) * pps) }}
                      title={`${r.title}: ${r.reason}`}
                      onClick={() => set({ focusRec: r.id, workspace: "ai", playhead: tl.start })}
                    />
                  );
                })}
              </div>
            </div>
          )}
          {project.tracks.map((track) => {
            const h = LANE_H[track.kind];
            const clips = project.clips.filter((c) => c.trackId === track.id);
            return (
              <div className={`tl-row ${track.hidden ? "hidden-track" : ""}`} key={track.id} style={{ height: h }}>
                <TrackHeader track={track} />
                <div
                  className={`lane lane-${track.kind} ${track.locked ? "locked" : ""}`}
                  data-track={track.id}
                  style={{ width, height: h }}
                  onPointerDown={(e) => {
                    if (e.target === e.currentTarget) {
                      set({ selection: [], selectedTrack: track.id });
                      beginDrag(e, "scrub");
                    }
                  }}
                  onDragOver={(e) => {
                    e.preventDefault();
                    setDropHint({ trackId: track.id, t: xToTime(e.clientX) });
                  }}
                  onDragLeave={() => setDropHint(null)}
                  onDrop={(e) => onDrop(e, track)}
                >
                  {clips.map((c) => {
                    const g = ghost(c);
                    const left = g.start * pps;
                    const w = Math.max(3, g.dur * pps);
                    const m = c.mediaId ? media[c.mediaId] : undefined;
                    const sel = selection.includes(c.id);
                    const visL = Math.max(0, view.left - left - HEADER_W);
                    const visR = Math.min(w, view.left + view.width - left);
                    return (
                      <div
                        key={c.id}
                        className={`clip clip-${c.kind} ${m ? `m-${m.kind}` : ""} ${sel ? "selected" : ""} ${g.trackShift ? "shifting" : ""} ${m?.missing ? "offline" : ""}`}
                        style={{ left, width: w, transform: g.trackShift ? `translateY(${g.trackShift * h}px)` : undefined }}
                        onPointerDown={(e) => beginDrag(e, "move", c)}
                        onContextMenu={(e) => {
                          e.preventDefault();
                          if (!sel) set({ selection: [c.id] });
                          setMenu({ x: e.clientX, y: e.clientY, clip: c });
                        }}
                        onDoubleClick={() => set({ selection: [c.id], workspace: "edit" })}
                        data-tip={undefined}
                      >
                        {m && m.filmstrip && m.kind !== "audio" && track.kind === "video" && <Filmstrip clip={c} media={m} pps={pps} width={w} visL={visL} visR={visR} height={h - 16} />}
                        {m && m.waveformUrl && (track.kind === "audio" || (m.hasAudio && c.volume > 0)) && <Waveform clip={c} media={m} pps={pps} visL={visL} visR={visR} height={track.kind === "audio" ? h - 18 : 16} overlay={track.kind === "video"} />}
                        <div className="clip-label">
                          {c.motion.preset !== "none" && <span className="badge">{c.motion.preset}</span>}
                          {c.kind === "text" ? c.text?.text || c.text?.template : c.kind === "adjustment" ? "Adjustment layer" : (c.label ?? m?.name ?? "clip")}
                          {c.speed !== 1 && <span className="badge">{c.speed}x</span>}
                          {m?.missing && <span className="badge err">OFFLINE</span>}
                        </div>
                        {c.transitionIn && <div className="trans-badge" data-tip={`${TRANSITIONS.find((t) => t.id === c.transitionIn!.type)?.label} ${c.transitionIn.duration}s`} style={{ width: Math.max(8, c.transitionIn.duration * pps) }} />}
                        {c.transitionOut && <div className="trans-badge out" style={{ width: Math.max(8, c.transitionOut.duration * pps) }} />}
                        {(c.fadeIn > 0 || c.fadeOut > 0) && (
                          <svg className="fade-lines" width={w} height={h} preserveAspectRatio="none">
                            {c.fadeIn > 0 && <line x1={0} y1={h} x2={c.fadeIn * pps} y2={0} />}
                            {c.fadeOut > 0 && <line x1={w - c.fadeOut * pps} y1={0} x2={w} y2={h} />}
                          </svg>
                        )}
                        <div className="trim l" onPointerDown={(e) => beginDrag(e, "trimL", c)} />
                        <div className="trim r" onPointerDown={(e) => beginDrag(e, "trimR", c)} />
                      </div>
                    );
                  })}
                  {dropHint?.trackId === track.id && <div className="drop-hint" style={{ left: dropHint.t * pps }} />}
                </div>
              </div>
            );
          })}
          {pages.length > 0 && (
            <div className="tl-row caption-row">
              <div className="tl-head sticky-left">
                <Icon name="captions" size={13} /> Captions
              </div>
              <div className="lane caption-lane" style={{ width }}>
                {pages
                  .filter((pg) => pg.end * pps > view.left - HEADER_W && pg.start * pps < view.left + view.width)
                  .map((pg, i) => (
                    <div key={i} className="cap-block" style={{ left: pg.start * pps, width: Math.max(2, (pg.end - pg.start) * pps) }} onClick={() => set({ playhead: pg.start, leftTab: "captions" })} title={pg.words.map((w) => w.text).join(" ")}>
                      {pg.words.map((w) => w.text).join(" ")}
                    </div>
                  ))}
              </div>
            </div>
          )}
          <div className="playhead" style={{ left: HEADER_W + playhead * pps }} />
          {tool === "blade" && <div className="blade-hint">Blade: click a clip to cut it at that point</div>}
        </div>
      </div>
      {menu && (
        <div className="ctx-menu" style={{ left: menu.x, top: menu.y }} onMouseLeave={() => setMenu(null)}>
          <button onClick={() => (splitAtPlayhead(), setMenu(null))}>Split at playhead (S)</button>
          <button onClick={() => (duplicateSelection(), setMenu(null))}>Duplicate (Ctrl+D)</button>
          <button onClick={() => (deleteSelection(false), setMenu(null))}>Delete (Del)</button>
          <button onClick={() => (deleteSelection(true), setMenu(null))}>Ripple delete (Shift+Del)</button>
          <hr />
          <button
            onClick={() => {
              const c = menu.clip;
              useEditor.getState().set({ colorClipboard: { color: c.color, fx: c.fx } });
              useEditor.getState().toast("Colour & effects copied");
              setMenu(null);
            }}
          >
            Copy colour grade
          </button>
          <button
            disabled={!useEditor.getState().colorClipboard}
            onClick={() => {
              const cb = useEditor.getState().colorClipboard!;
              const ids = useEditor.getState().selection;
              useEditor.getState().commit("Paste colour grade", (d) => {
                for (const c of d.clips) if (ids.includes(c.id)) {
                  c.color = structuredClone(cb.color) as any;
                  c.fx = { ...cb.fx };
                }
              });
              setMenu(null);
            }}
          >
            Paste colour grade
          </button>
          <button onClick={() => (set({ workspace: "color" }), setMenu(null))}>Open in Color workspace</button>
        </div>
      )}
    </div>
  );
}

function TrackHeader({ track }: { track: Track }) {
  const commit = useEditor((s) => s.commit);
  const selected = useEditor((s) => s.selectedTrack === track.id);
  const [editing, setEditing] = useState(false);
  const upd = (label: string, fn: (t: Track) => void) =>
    commit(label, (d) => {
      const t = d.tracks.find((x) => x.id === track.id);
      if (t) fn(t as Track);
    });
  const empty = !useEditor.getState().project!.clips.some((c) => c.trackId === track.id);
  return (
    <div className={`tl-head sticky-left kind-${track.kind} ${selected ? "sel" : ""}`} onClick={() => useEditor.getState().set({ selectedTrack: track.id })}>
      <div className="th-name" onDoubleClick={() => setEditing(true)}>
        {editing ? (
          <input autoFocus defaultValue={track.name} onBlur={(e) => (upd("Rename track", (t) => (t.name = e.target.value || t.name)), setEditing(false))} onKeyDown={(e) => (e.stopPropagation(), e.key === "Enter" && (e.target as HTMLInputElement).blur())} />
        ) : (
          <span title="Double-click to rename">{track.name}</span>
        )}
      </div>
      <div className="th-btns">
        {track.kind !== "text" && (
          <>
            <button className={`tbtn ${track.muted ? "on mute" : ""}`} onClick={() => upd("Mute track", (t) => (t.muted = !t.muted))} data-tip="Mute">
              M
            </button>
            <button className={`tbtn ${track.solo ? "on solo" : ""}`} onClick={() => upd("Solo track", (t) => (t.solo = !t.solo))} data-tip="Solo">
              S
            </button>
          </>
        )}
        {track.kind !== "audio" && (
          <button className={`tbtn ${track.hidden ? "on" : ""}`} onClick={() => upd("Hide track", (t) => (t.hidden = !t.hidden))} data-tip={track.hidden ? "Show track" : "Hide track"}>
            <Icon name={track.hidden ? "eyeOff" : "eye"} size={12} />
          </button>
        )}
        <button className={`tbtn ${track.locked ? "on" : ""}`} onClick={() => upd("Lock track", (t) => (t.locked = !t.locked))} data-tip={track.locked ? "Unlock" : "Lock (protect from edits and ripple)"}>
          <Icon name={track.locked ? "lock" : "unlock"} size={12} />
        </button>
        {empty && (
          <button className="tbtn" onClick={() => commit("Delete track", (d) => void (d.tracks = d.tracks.filter((t) => t.id !== track.id)))} data-tip="Delete empty track">
            <Icon name="x" size={12} />
          </button>
        )}
      </div>
    </div>
  );
}

function Filmstrip({ clip, media, pps, width, visL, visR, height }: { clip: Clip; media: PubMedia; pps: number; width: number; visL: number; visR: number; height: number }) {
  const fs = media.filmstrip!;
  const tileW = Math.round((height * 16) / 9);
  const scale = height / fs.frameHeight;
  const tiles: React.ReactNode[] = [];
  const startI = Math.max(0, Math.floor(visL / tileW));
  const endI = Math.min(Math.ceil(width / tileW), Math.ceil(visR / tileW) + 1);
  for (let i = startI; i < endI && i - startI < 80; i++) {
    const x = i * tileW;
    let idx = 0;
    if (media.kind !== "image") {
      const src = clip.in + ((x + tileW / 2) / pps) * clip.speed;
      idx = Math.max(0, Math.min(fs.frames - 1, Math.floor(src / fs.interval)));
    }
    tiles.push(
      <div
        key={i}
        className="film-tile"
        style={{ left: x, width: tileW, height, backgroundImage: `url(${fs.url})`, backgroundSize: `${fs.frames * fs.frameWidth * scale}px ${height}px`, backgroundPosition: `${-idx * fs.frameWidth * scale}px 0` }}
      />
    );
  }
  return <div className="filmstrip">{tiles}</div>;
}

function Waveform({ clip, media, pps, visL, visR, height, overlay }: { clip: Clip; media: PubMedia; pps: number; visL: number; visR: number; height: number; overlay: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const w = Math.max(1, Math.min(4000, Math.ceil(visR - visL)));
  useEffect(() => {
    let alive = true;
    loadPeaks(media.waveformUrl!).then((peaks) => {
      const cv = ref.current;
      if (!alive || !cv) return;
      const ctx = cv.getContext("2d")!;
      cv.width = w;
      cv.height = height;
      ctx.clearRect(0, 0, w, height);
      ctx.fillStyle = overlay ? "rgba(255,255,255,0.45)" : "rgba(160,255,220,0.8)";
      const mid = height / 2;
      for (let x = 0; x < w; x++) {
        const t0 = clip.in + ((visL + x) / pps) * clip.speed;
        const t1 = clip.in + ((visL + x + 1) / pps) * clip.speed;
        let peak = 0;
        for (let i = Math.floor(t0 * 100); i <= Math.floor(t1 * 100); i++) peak = Math.max(peak, peaks[i] ?? 0);
        const a = (peak / 255) * clip.volume * mid;
        ctx.fillRect(x, overlay ? height - a * 2 : mid - a, 1, overlay ? a * 2 : a * 2);
      }
    });
    return () => {
      alive = false;
    };
  }, [clip.in, clip.speed, clip.volume, pps, visL, w, height, media.waveformUrl]);
  return <canvas ref={ref} className={`waveform ${overlay ? "overlay" : ""}`} style={{ left: visL, width: w, height }} />;
}
