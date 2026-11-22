import { useEffect, useMemo, useRef, useState } from "react";
import { useEditor } from "../store";
import { Compositor } from "../engine/preview";
import { audioEngine } from "../engine/audio";
import { captionPages } from "../../shared/captions";
import { formatTime, projectDuration } from "../../shared/timeline";
import { IconButton, Select } from "./ui";
import { goToNextEdit } from "../actions";

export function Preview() {
  const project = useEditor((s) => s.project)!;
  const media = useEditor((s) => s.media);
  const playhead = useEditor((s) => s.playhead);
  const playing = useEditor((s) => s.playing);
  const compare = useEditor((s) => s.compare);
  const showSafe = useEditor((s) => s.showSafe);
  const set = useEditor((s) => s.set);
  const wrap = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const comp = useRef<Compositor | null>(null);
  const [box, setBox] = useState({ w: 640, h: 360 });
  const [quality, setQuality] = useState<"full" | "half">("full");
  const pages = useMemo(() => captionPages(project), [project.captions, project.clips, project.transcripts]);
  const duration = projectDuration(project);

  // fit the canvas into the available space, keeping the project aspect ratio
  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      const ar = project.settings.width / project.settings.height;
      let w = r.width - 16;
      let h = w / ar;
      if (h > r.height - 16) {
        h = r.height - 16;
        w = h * ar;
      }
      setBox({ w: Math.max(80, Math.floor(w)), h: Math.max(45, Math.floor(h)) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [project.settings.width, project.settings.height]);

  useEffect(() => {
    comp.current = new Compositor(canvasRef.current!);
    return () => comp.current?.destroy();
  }, []);

  const dpr = Math.min(2, window.devicePixelRatio || 1) * (quality === "half" ? 0.5 : 1);
  const cw = Math.min(project.settings.width, Math.round(box.w * dpr));
  const ch = Math.round((cw * project.settings.height) / project.settings.width);

  // draw loop
  const stateRef = useRef({ project, media, playhead, playing, compare, pages });
  stateRef.current = { project, media, playhead, playing, compare, pages };
  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    let dirty = true;
    const c = comp.current!;
    c.requestDraw = () => (dirty = true);
    const tick = (now: number) => {
      const st = stateRef.current;
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      let t = useEditor.getState().playhead;
      if (st.playing) {
        t += dt;
        const skip = useEditor.getState().previewSkip;
        if (skip) for (const r of skip) if (t >= r.start && t < r.end) t = r.end;
        const end = projectDuration(st.project);
        if (t >= end) {
          t = end;
          useEditor.setState({ playing: false, previewSkip: null });
        }
        useEditor.setState({ playhead: t });
        dirty = true;
      }
      c.sync(st.project, st.media, t, st.playing);
      if (dirty || st.playing) {
        c.draw(st.project, st.media, t, { compare: st.compare, pages: st.pages, captionsOn: st.project.captions.enabled });
        dirty = false;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);
  useEffect(() => {
    comp.current?.requestDraw();
  }, [project, playhead, compare, cw, ch, media]);

  const togglePlay = () => {
    audioEngine.ensure();
    if (!playing && playhead >= duration - 0.01) set({ playhead: 0 });
    set({ playing: !playing, previewSkip: playing ? null : useEditor.getState().previewSkip });
  };

  const exportFrame = () => {
    // full-resolution still of the current frame (thumbnail / social post)
    const off = document.createElement("canvas");
    off.width = project.settings.width;
    off.height = project.settings.height;
    const c = new Compositor(off);
    c.slots = comp.current!.slots;
    c.images = comp.current!.images;
    c.draw(project, media, playhead, { compare: "off", pages, captionsOn: project.captions.enabled });
    off.toBlob((b) => {
      if (!b) return;
      const a = document.createElement("a");
      a.href = URL.createObjectURL(b);
      a.download = `${project.name}-${formatTime(playhead, project.settings.fps).replace(/:/g, "-")}.png`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    }, "image/png");
  };

  const vertical = project.settings.height > project.settings.width;
  return (
    <div className="preview" data-tour="preview">
      <div className="preview-stage" ref={wrap} onDoubleClick={togglePlay}>
        <div className="canvas-wrap" style={{ width: box.w, height: box.h }}>
          <canvas ref={canvasRef} width={cw} height={ch} style={{ width: box.w, height: box.h }} />
          {showSafe && (
            <div className="safe-guides">
              <div className="safe action" />
              <div className="safe title" />
              {vertical && <div className="safe ui-zone" data-label="Platform UI (captions / buttons)" />}
              {vertical && <div className="safe ui-right" />}
            </div>
          )}
          {compare === "split" && <div className="split-line" />}
          {!project.clips.length && <div className="stage-empty">Drop media here or on the timeline to start editing</div>}
        </div>
      </div>
      <div className="transport">
        <span className="tc" data-tip="Playhead timecode (hh:mm:ss:frames)">{formatTime(playhead, project.settings.fps)}</span>
        <div className="transport-center">
          <IconButton icon="prev" label="Previous edit" kbd="↑" onClick={() => goToNextEdit(-1)} />
          <IconButton icon="stepBack" label="Back one frame" kbd="←" onClick={() => set({ playhead: Math.max(0, playhead - 1 / project.settings.fps) })} />
          <button className="play-btn" onClick={togglePlay} data-tip={playing ? "Pause (Space)" : "Play (Space)"} data-tour="play" aria-label="Play/pause">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
              <path d={playing ? "M6 4h4v16H6zM14 4h4v16h-4z" : "M7 4v16l13-8z"} />
            </svg>
          </button>
          <IconButton icon="stepFwd" label="Forward one frame" kbd="→" onClick={() => set({ playhead: Math.min(duration, playhead + 1 / project.settings.fps) })} />
          <IconButton icon="next" label="Next edit" kbd="↓" onClick={() => goToNextEdit(1)} />
        </div>
        <div className="transport-right">
          <span className="tc dim">{formatTime(duration, project.settings.fps)}</span>
          <IconButton icon="grid" label="Safe-area guides" active={showSafe} onClick={() => set({ showSafe: !showSafe })} />
          <IconButton icon="image" label="Export current frame as PNG" onClick={exportFrame} />
          <Select
            value={quality}
            onChange={setQuality}
            options={[
              { value: "full", label: "Full" },
              { value: "half", label: "Half" },
            ]}
            help="Preview resolution. Use Half for smoother playback of heavy projects"
          />
        </div>
      </div>
    </div>
  );
}
