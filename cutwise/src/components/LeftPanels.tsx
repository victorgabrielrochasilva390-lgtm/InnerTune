import { useEffect, useRef, useState } from "react";
import { useEditor } from "../store";
import { api, waitForJob, type PubMedia } from "../api";
import { addAdjustmentLayer, addMedia, addText, applyRec, recTimeline, setMotion, setTransition, updateSelected } from "../actions";
import { MOTION_PRESETS, SFX_LIBRARY, TEXT_TEMPLATES, TRANSITIONS, COLOR_PRESETS } from "../../shared/presets";
import { formatShort } from "../../shared/timeline";
import { Empty, Icon, IconButton, Progress, Select, fmtBytes } from "./ui";

function useProjectMedia(): PubMedia[] {
  const project = useEditor((s) => s.project)!;
  const media = useEditor((s) => s.media);
  const sfx = useEditor((s) => s.sfx);
  const sfxIds = new Set(Object.values(sfx));
  return project.mediaIds.map((id) => media[id]).filter((m): m is PubMedia => !!m && !sfxIds.has(m.id));
}

export function MediaPanel() {
  const project = useEditor((s) => s.project)!;
  const jobs = useEditor((s) => s.jobs);
  const items = useProjectMedia();
  const fileInput = useRef<HTMLInputElement>(null);
  const relinkInput = useRef<HTMLInputElement>(null);
  const [relinkId, setRelinkId] = useState<string | null>(null);
  const [uploading, setUploading] = useState<number | null>(null);
  const [over, setOver] = useState(false);
  const [filter, setFilter] = useState<"all" | "video" | "audio" | "image">("all");
  const S = useEditor.getState;

  const upload = async (files: File[]) => {
    if (!files.length) return;
    setUploading(0);
    try {
      const res = await api.upload(files, setUploading);
      const ids: string[] = [];
      for (const m of res) {
        if (!("id" in m)) S().toast(String(m.error), "error");
        else {
          S().setMedia(m as PubMedia);
          ids.push((m as PubMedia).id);
        }
      }
      if (ids.length)
        S().commit("Import media", (d) => {
          for (const id of ids) if (!d.mediaIds.includes(id)) d.mediaIds.push(id);
        });
      S().toast(`Imported ${ids.length} file(s). Proxies, thumbnails and analysis run in the background.`, "success");
    } catch (e) {
      S().toast((e as Error).message, "error");
    } finally {
      setUploading(null);
    }
  };

  const linkPath = async () => {
    const p = prompt("Absolute path of a file on the server machine (linked in place, not copied):");
    if (!p) return;
    try {
      const m = await api.linkMedia(p);
      S().setMedia(m);
      S().commit("Link media", (d) => void d.mediaIds.push(m.id));
    } catch (e) {
      S().toast((e as Error).message, "error");
    }
  };

  const shown = items.filter((m) => filter === "all" || m.kind === filter);
  return (
    <div
      className={`panel-body media-panel ${over ? "drag-over" : ""}`}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("Files")) {
          e.preventDefault();
          setOver(true);
        }
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        upload([...e.dataTransfer.files]);
      }}
    >
      <div className="row gap">
        <button className="btn primary" onClick={() => fileInput.current?.click()} data-tour="import">
          <Icon name="upload" /> Import media
        </button>
        <IconButton icon="link" label="Link a file by path (no copy)" onClick={linkPath} />
        <span className="grow" />
        <Select value={filter} onChange={setFilter} options={[{ value: "all", label: "All" }, { value: "video", label: "Video" }, { value: "audio", label: "Audio" }, { value: "image", label: "Images" }]} />
      </div>
      <input ref={fileInput} type="file" multiple hidden accept="video/*,audio/*,image/*,.mkv,.mov,.mxf" onChange={(e) => upload([...(e.target.files ?? [])])} />
      <input
        ref={relinkInput}
        type="file"
        hidden
        onChange={async (e) => {
          const f = e.target.files?.[0];
          if (!f || !relinkId) return;
          try {
            S().setMedia(await api.relinkUpload(relinkId, f));
            S().toast("Media relinked", "success");
          } catch (err) {
            S().toast((err as Error).message, "error");
          }
        }}
      />
      {uploading !== null && <Progress value={uploading} label={`Uploading ${Math.round(uploading * 100)}%`} />}
      {!shown.length && (
        <Empty icon="film" title="No media yet">
          Drag video, audio or image files here or click Import. MP4, MOV, MKV, WebM, MP3, WAV, M4A, PNG, JPG and more are supported. Originals are never modified.
        </Empty>
      )}
      <div className="media-grid">
        {shown.map((m) => {
          const job = Object.values(jobs).find((j) => j.mediaId === m.id && (j.status === "running" || j.status === "queued"));
          return (
            <div
              key={m.id}
              className={`media-card ${m.missing ? "offline" : ""}`}
              draggable={!m.missing}
              onDragStart={(e) => e.dataTransfer.setData("application/x-cutwise-media", m.id)}
              onDoubleClick={() => addMedia(m)}
              data-tip={`${m.name}\n${m.width ? `${m.width}x${m.height} · ` : ""}${m.duration ? formatShort(m.duration) : ""} · ${fmtBytes(m.size)}${m.source.license ? `\nLicence: ${m.source.license}${m.source.author ? ` by ${m.source.author}` : ""}` : ""}`}
            >
              <div className="thumb" style={m.kind !== "audio" && m.filmstrip ? { backgroundImage: `url(/files/thumbs/${m.id}.jpg?v=${m.status})` } : undefined}>
                {m.kind === "audio" && <Icon name="music" size={26} />}
                <span className="dur">{m.kind === "image" ? "IMG" : formatShort(m.duration)}</span>
                {m.analysis && <span className="tag ok" data-tip="Analysed (silences, scenes, loudness)">AI</span>}
                {project.transcripts[m.id] && <span className="tag cc" data-tip="Has transcript">CC</span>}
                {m.source.provider !== "upload" && m.source.provider !== "linked" && <span className="tag lic" data-tip={`${m.source.provider}: ${m.source.license}`}>©</span>}
              </div>
              <div className="media-name">{m.name}</div>
              {job && <Progress value={job.progress} label={job.message} />}
              {m.status === "error" && <div className="err small">{m.error ?? "Import failed"}</div>}
              {m.missing && (
                <button className="btn sm danger" onClick={() => (setRelinkId(m.id), relinkInput.current?.click())}>
                  Relink missing file
                </button>
              )}
              <div className="media-actions">
                <IconButton icon="plus" label="Append to timeline" onClick={() => addMedia(m)} />
                <IconButton icon="target" label="Insert at playhead" onClick={() => addMedia(m, S().playhead)} />
                <IconButton icon="refresh" label="Re-run analysis" onClick={() => api.analyze(m.id).then(() => S().toast("Analysis started"))} />
                <IconButton
                  icon="trash"
                  label="Remove from project"
                  onClick={() => {
                    if (project.clips.some((c) => c.mediaId === m.id)) return S().toast("Remove its clips from the timeline first", "error");
                    S().commit("Remove media", (d) => void (d.mediaIds = d.mediaIds.filter((x) => x !== m.id)));
                  }}
                />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function TextPanel() {
  return (
    <div className="panel-body">
      <p className="muted small">Click to add at the playhead, or drag onto a text track. Text and graphics are rendered with the same fonts in preview and export.</p>
      <div className="tile-grid">
        {TEXT_TEMPLATES.map((t) => (
          <button key={t.id} className="tile" draggable onDragStart={(e) => e.dataTransfer.setData("application/x-cutwise-text", t.id)} onClick={() => addText(t.id)} data-tip={t.description}>
            <span className={`tile-preview tp-${t.id}`}>{t.id === "title" ? "TITLE" : t.id === "lowerThird" ? "Name" : t.id === "callout" ? "Note" : t.id === "arrow" ? "➜" : t.id === "highlightBox" ? "▢" : t.id === "progressBar" ? "▬" : "Aa"}</span>
            <span>{t.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

export function EffectsPanel() {
  const selection = useEditor((s) => s.selection);
  const none = !selection.length;
  return (
    <div className="panel-body">
      {none && <div className="hint">Select a clip on the timeline, then click an effect. You can also drag motion presets onto clips.</div>}
      <h4>Camera & motion</h4>
      <div className="tile-grid">
        {MOTION_PRESETS.map((m) => (
          <button key={m.id} className="tile" disabled={none} draggable onDragStart={(e) => e.dataTransfer.setData("application/x-cutwise-motion", m.id)} onClick={() => setMotion(selection, m.id)} data-tip={m.description}>
            <span className={`tile-preview motion mo-${m.id}`} />
            <span>{m.label}</span>
          </button>
        ))}
      </div>
      <h4>Visual effects</h4>
      <div className="tile-grid">
        {[
          { id: "vignette", label: "Cinematic vignette", fn: (c: any) => (c.fx.vignette = 0.5) },
          { id: "grain", label: "Film grain", fn: (c: any) => (c.fx.grain = 0.35) },
          { id: "glow", label: "Soft glow", fn: (c: any) => (c.fx.glow = 0.45) },
          { id: "sharpen", label: "Sharpen", fn: (c: any) => (c.fx.sharpen = 0.6) },
          { id: "blur", label: "Blur", fn: (c: any) => (c.fx.blur = 8) },
          { id: "bgblur", label: "Blurred background fill", fn: (c: any) => (c.transform.fit = "blurFill") },
          { id: "clear", label: "Clear effects", fn: (c: any) => (c.fx = { blur: 0, sharpen: 0, vignette: 0, grain: 0, glow: 0 }) },
        ].map((f) => (
          <button key={f.id} className="tile" disabled={none} onClick={() => updateSelected(f.label, f.fn)}>
            <span className={`tile-preview fx-${f.id}`} />
            <span>{f.label}</span>
          </button>
        ))}
      </div>
      <h4>Colour looks</h4>
      <div className="tile-grid">
        {COLOR_PRESETS.map((p) => (
          <button key={p.id} className="tile" disabled={none} onClick={() => updateSelected(`Look: ${p.label}`, (c) => Object.assign(c.color, p.grade))}>
            <span className={`tile-preview look-${p.id}`} />
            <span>{p.label}</span>
          </button>
        ))}
      </div>
      <button className="btn" onClick={addAdjustmentLayer} data-tip="A layer that grades and adds effects to every track below it">
        <Icon name="layers" /> Add adjustment layer
      </button>
    </div>
  );
}

export function TransitionsPanel() {
  const selection = useEditor((s) => s.selection);
  return (
    <div className="panel-body">
      <div className="hint">Transitions apply to the start of the selected clip (the cut from the clip before it). Hard cuts are usually best, so use these to mark a real change.</div>
      <div className="tile-grid">
        {TRANSITIONS.map((t) => (
          <button key={t.id} className="tile" disabled={!selection.length} draggable onDragStart={(e) => e.dataTransfer.setData("application/x-cutwise-transition", t.id)} onClick={() => setTransition(selection, t.id)} data-tip={t.description}>
            <span className={`tile-preview tr-${t.id}`} />
            <span>{t.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

export function BrollPanel() {
  const project = useEditor((s) => s.project)!;
  const caps = useEditor((s) => s.caps);
  const query = useEditor((s) => s.brollQuery);
  const set = useEditor((s) => s.set);
  const [provider, setProvider] = useState("openverse");
  const [type, setType] = useState<"video" | "photo" | "audio">("photo");
  const [results, setResults] = useState<any[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [importing, setImporting] = useState<Record<string, number>>({});
  const vertical = project.settings.height > project.settings.width;
  const S = useEditor.getState;
  const brolls = project.ai.recommendations.filter((r) => r.kind === "broll");
  const [target, setTarget] = useState<string | null>(null);

  const search = async (q = query) => {
    if (!q.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      setResults(await api.stockSearch(provider, q, type, vertical ? "portrait" : "landscape"));
    } catch (e) {
      setErr((e as Error).message);
      setResults([]);
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    if (query) search(query);
  }, [query]);

  const doImport = async (r: any) => {
    setImporting((x) => ({ ...x, [r.id]: 0 }));
    try {
      const job = await api.stockImport(r);
      const m = await waitForJob<PubMedia>(job.id, (j) => setImporting((x) => ({ ...x, [r.id]: j.progress })));
      S().setMedia(m);
      S().commit("Import stock media", (d) => void (!d.mediaIds.includes(m.id) && d.mediaIds.push(m.id)));
      if (target) {
        await new Promise((res) => setTimeout(res, 800));
        await S().refreshMedia([m.id]);
        await applyRec(target, S().media[m.id]);
        setTarget(null);
      }
      S().toast(`Imported ${r.provider} asset (${r.license})`, "success");
    } catch (e) {
      S().toast((e as Error).message, "error");
    } finally {
      setImporting((x) => {
        const n = { ...x };
        delete n[r.id];
        return n;
      });
    }
  };

  return (
    <div className="panel-body">
      {brolls.length > 0 && (
        <>
          <h4>Scene-by-scene suggestions</h4>
          <div className="scene-list">
            {brolls.map((r) => {
              const tl = recTimeline(project, r);
              return (
                <div key={r.id} className={`scene-item ${target === r.id ? "targeted" : ""} st-${r.status}`}>
                  <div className="scene-head">
                    <strong>SCENE {String(r.sceneIndex ?? 0).padStart(2, "0")}</strong>
                    <span className="muted">{tl ? formatShort(tl.start) : "not in edit"}</span>
                    <span className="badge">{r.payload?.assetType}</span>
                    {r.status === "applied" && <span className="badge ok">placed</span>}
                  </div>
                  <div className="small">“{r.payload?.narration}”</div>
                  <div className="small">
                    <b>Visual:</b> {r.payload?.visual}
                  </div>
                  <div className="row gap">
                    <button
                      className="btn sm"
                      onClick={() => {
                        setTarget(r.id);
                        set({ brollQuery: r.payload?.query ?? "" });
                      }}
                    >
                      <Icon name="search" size={12} /> Find “{r.payload?.query}”
                    </button>
                    {tl && <button className="btn sm ghost" onClick={() => set({ playhead: tl.start })}>Go to</button>}
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}
      <h4>Stock search</h4>
      <div className="row gap wrap">
        <Select value={provider} onChange={setProvider} options={(caps?.stock ?? [{ id: "openverse", label: "Openverse", available: true }]).map((s) => ({ value: s.id, label: `${s.label}${s.available ? "" : " (needs key)"}` }))} />
        <Select value={type} onChange={(v) => setType(v as any)} options={[{ value: "photo", label: "Photos" }, { value: "video", label: "Videos" }, { value: "audio", label: "Audio (Openverse)" }]} />
      </div>
      <form
        className="row gap"
        onSubmit={(e) => {
          e.preventDefault();
          search();
        }}
      >
        <input className="text-input grow" placeholder="e.g. modern office AI" value={query} onChange={(e) => set({ brollQuery: e.target.value })} onKeyDown={(e) => e.stopPropagation()} />
        <button className="btn primary" disabled={busy}>
          {busy ? "…" : "Search"}
        </button>
      </form>
      <p className="muted small">{caps?.stock.find((s) => s.id === provider)?.note}</p>
      {target && <div className="hint">The next asset you import will be placed for the selected scene.</div>}
      {err && <div className="err small">{err}</div>}
      <div className="stock-grid">
        {results.map((r) => (
          <div key={r.id} className="stock-card">
            {r.type === "audio" ? <div className="thumb audio"><Icon name="music" size={22} /></div> : <img src={r.thumb} alt={r.title} loading="lazy" />}
            <div className="stock-meta">
              <div className="small ellipsis" title={r.title}>
                {r.title}
              </div>
              <div className="lic" title={r.licenseUrl}>
                {r.license}
                {r.author ? ` · ${r.author}` : ""}
              </div>
              {r.duration && <div className="muted small">{formatShort(r.duration)}</div>}
            </div>
            {importing[r.id] !== undefined ? <Progress value={importing[r.id]} /> : <button className="btn sm" onClick={() => doImport(r)}>Import</button>}
            {r.pageUrl && (
              <a className="small" href={r.pageUrl} target="_blank" rel="noreferrer">
                source
              </a>
            )}
          </div>
        ))}
      </div>
      <p className="muted small">Only licensed sources are searched. Licence, author and source link are stored with each imported file. Respect attribution and non-commercial / no-derivatives terms.</p>
    </div>
  );
}

export function AudioLibraryPanel() {
  const sfx = useEditor((s) => s.sfx);
  const media = useEditor((s) => s.media);
  const S = useEditor.getState;
  const audioRef = useRef<HTMLAudioElement | null>(null);
  return (
    <div className="panel-body">
      <p className="muted small">Royalty-free sound effects and simple music beds generated locally by Cutwise. Drag onto an audio track or click + to place at the playhead. Import your own music in Media.</p>
      <div className="sfx-list">
        {SFX_LIBRARY.map((s) => {
          const m = media[sfx[s.id]];
          return (
            <div key={s.id} className="sfx-item" draggable={!!m} onDragStart={(e) => m && e.dataTransfer.setData("application/x-cutwise-media", m.id)}>
              <IconButton
                icon="play"
                label="Listen"
                onClick={() => {
                  if (!m) return;
                  audioRef.current?.pause();
                  audioRef.current = new Audio(m.previewUrl);
                  audioRef.current.play();
                }}
              />
              <div className="grow">
                <div>{s.label}</div>
                <div className="muted small">
                  {s.mood} · {s.description}
                </div>
              </div>
              <IconButton
                icon="plus"
                label="Add at playhead"
                disabled={!m}
                onClick={async () => {
                  if (!m) return;
                  S().commit("Add SFX", (d) => void (!d.mediaIds.includes(m.id) && d.mediaIds.push(m.id)));
                  addMedia(m, S().playhead);
                }}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}
