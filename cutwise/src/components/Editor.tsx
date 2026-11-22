import { useCallback, useEffect, useRef, useState } from "react";
import { useEditor, safeGet, safeSet, safeDel, type LeftTab, type Workspace } from "../store";
import { api, onJob } from "../api";
import type { Project } from "../../shared/types";
import { Preview } from "./Preview";
import { Timeline } from "./Timeline";
import { MediaPanel, TextPanel, EffectsPanel, TransitionsPanel, BrollPanel, AudioLibraryPanel } from "./LeftPanels";
import { CaptionsPanel } from "./CaptionsPanel";
import { Inspector, ColorPanel } from "./Inspector";
import { Mixer } from "./Mixer";
import { AIPanel } from "./AIPanel";
import { ExportDialog } from "./ExportDialog";
import { HistoryDialog, JobsIndicator, ShortcutsDialog, Tutorial } from "./Help";
import { Icon, IconButton, Toggle } from "./ui";
import { addText, deleteSelection, duplicateSelection, goToNextEdit, splitAtPlayhead } from "../actions";
import { projectDuration } from "../../shared/timeline";
import { audioEngine } from "../engine/audio";

const LEFT_TABS: { id: LeftTab; icon: string; label: string }[] = [
  { id: "media", icon: "film", label: "Media" },
  { id: "text", icon: "text", label: "Text" },
  { id: "effects", icon: "wand", label: "Effects" },
  { id: "transitions", icon: "layers", label: "Transitions" },
  { id: "captions", icon: "captions", label: "Captions" },
  { id: "broll", icon: "image", label: "B-roll" },
  { id: "audio", icon: "music", label: "SFX" },
];

const WORKSPACES: { id: Workspace; label: string; icon: string; key: string }[] = [
  { id: "edit", label: "Edit", icon: "film", key: "1" },
  { id: "ai", label: "AI Director", icon: "sparkle", key: "2" },
  { id: "color", label: "Color", icon: "palette", key: "3" },
  { id: "audio", label: "Audio", icon: "sliders", key: "4" },
];

function useResizable(key: string, initial: number, min: number, max: number) {
  const [size, setSize] = useState(() => Number(safeGet(`cutwise:size:${key}`)) || initial);
  const start = (e: React.PointerEvent, dir: 1 | -1, axis: "x" | "y") => {
    e.preventDefault();
    const s0 = size;
    const p0 = axis === "x" ? e.clientX : e.clientY;
    const mv = (ev: PointerEvent) => {
      const v = Math.max(min, Math.min(max, s0 + ((axis === "x" ? ev.clientX : ev.clientY) - p0) * dir));
      setSize(v);
      safeSet(`cutwise:size:${key}`, String(v));
    };
    const up = () => window.removeEventListener("pointermove", mv);
    window.addEventListener("pointermove", mv);
    window.addEventListener("pointerup", up, { once: true });
  };
  return [size, start] as const;
}

export function Editor({ projectId, onExit, onOpen }: { projectId: string; onExit: () => void; onOpen: (id: string) => void }) {
  const project = useEditor((s) => s.project);
  const workspace = useEditor((s) => s.workspace);
  const leftTab = useEditor((s) => s.leftTab);
  const saveState = useEditor((s) => s.saveState);
  const past = useEditor((s) => s.past);
  const future = useEditor((s) => s.future);
  const beginner = useEditor((s) => s.beginner);
  const toasts = useEditor((s) => s.toasts);
  const S = useEditor.getState;
  const [showExport, setShowExport] = useState(false);
  const [showKeys, setShowKeys] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [tour, setTour] = useState(false);
  const [recover, setRecover] = useState<Project | null>(null);
  const [leftW, startLeft] = useResizable("left", 330, 240, 560);
  const [rightW, startRight] = useResizable("right", 340, 260, 620);
  const [bottomH, startBottom] = useResizable("bottom", 300, 160, 640);
  const [leftOpen, setLeftOpen] = useState(true);

  // ---------------------------------------------------------------- load
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const p = await api.project(projectId);
        if (!alive) return;
        S().setProject(p);
        const [media, sfx] = await Promise.all([api.media(), api.sfx()]);
        const map: Record<string, any> = {};
        for (const m of media) map[m.id] = m;
        S().set({ media: map, sfx });
        // crash recovery: a local backup newer than the server copy
        const raw = safeGet(`cutwise:backup:${projectId}`);
        if (raw) {
          const b = JSON.parse(raw) as { project: Project; at: number };
          if (b.project.updatedAt > p.updatedAt + 1000) setRecover(b.project);
          else safeDel(`cutwise:backup:${projectId}`);
        }
        if (!safeGet("cutwise:toured")) setTour(true);
      } catch (e) {
        S().toast(`Could not open project: ${(e as Error).message}`, "error");
        onExit();
      }
    })();
    return () => {
      alive = false;
      S().set({ playing: false });
      S().setProject(null);
    };
  }, [projectId]);

  // ---------------------------------------------------------------- job events -> refresh media
  useEffect(
    () =>
      onJob((j) => {
        S().set({ jobs: { ...S().jobs, [j.id]: j } });
        if (j.mediaId && (j.status === "done" || j.status === "error")) S().refreshMedia([j.mediaId]).catch(() => {});
      }),
    []
  );

  // ---------------------------------------------------------------- autosave + local backup
  const saveTimer = useRef<number>();
  useEffect(() => {
    if (!project || saveState !== "unsaved") return;
    safeSet(`cutwise:backup:${project.id}`, JSON.stringify({ project, at: Date.now() }));
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(async () => {
      const p = S().project;
      if (!p) return;
      S().set({ saveState: "saving" });
      try {
        await api.saveProject(p, "autosave");
        if (S().project === p) {
          S().set({ saveState: "saved", lastSavedAt: Date.now() });
          safeDel(`cutwise:backup:${p.id}`);
        }
      } catch {
        S().set({ saveState: "error" });
      }
    }, 1500);
  }, [project, saveState]);

  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (S().saveState === "unsaved" || S().saveState === "saving") e.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, []);

  // project thumbnail for the projects screen (once per minute at most)
  useEffect(() => {
    const id = window.setInterval(() => {
      const c = document.querySelector<HTMLCanvasElement>(".preview canvas");
      const p = S().project;
      if (!c || !p || !p.clips.length) return;
      const t = document.createElement("canvas");
      t.width = 320;
      t.height = Math.round((320 * c.height) / c.width);
      t.getContext("2d")!.drawImage(c, 0, 0, t.width, t.height);
      api.saveThumb(p.id, t.toDataURL("image/jpeg", 0.7)).catch(() => {});
    }, 60000);
    return () => window.clearInterval(id);
  }, []);

  const manualSave = useCallback(async () => {
    const p = S().project;
    if (!p) return;
    S().set({ saveState: "saving" });
    try {
      await api.saveProject(p, "manual");
      S().set({ saveState: "saved", lastSavedAt: Date.now() });
      safeDel(`cutwise:backup:${p.id}`);
      S().toast("Version saved", "success");
    } catch (e) {
      S().set({ saveState: "error" });
      S().toast((e as Error).message, "error");
    }
  }, []);

  // ---------------------------------------------------------------- keyboard
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
      const st = S();
      const p = st.project;
      if (!p) return;
      const mod = e.ctrlKey || e.metaKey;
      const fps = p.settings.fps;
      const k = e.key;
      const handled = () => e.preventDefault();
      if (k === " " || (k === "k" && !mod)) {
        handled();
        audioEngine.ensure();
        if (!st.playing && st.playhead >= projectDuration(p) - 0.01) st.set({ playhead: 0 });
        st.set({ playing: !st.playing, previewSkip: null });
      } else if (mod && k.toLowerCase() === "z") {
        handled();
        e.shiftKey ? st.redo() : st.undo();
      } else if (mod && k.toLowerCase() === "y") {
        handled();
        st.redo();
      } else if (mod && k.toLowerCase() === "s") {
        handled();
        manualSave();
      } else if (mod && k.toLowerCase() === "d") {
        handled();
        duplicateSelection();
      } else if (mod && k.toLowerCase() === "a") {
        handled();
        st.set({ selection: p.clips.map((c) => c.id) });
      } else if (mod && k.toLowerCase() === "e") {
        handled();
        setShowExport(true);
      } else if ((mod && k.toLowerCase() === "b") || (!mod && k.toLowerCase() === "s")) {
        handled();
        splitAtPlayhead();
      } else if (k === "Delete" || k === "Backspace") {
        handled();
        deleteSelection(e.shiftKey);
      } else if (k === "ArrowLeft") {
        handled();
        st.seek(st.playhead - (e.shiftKey ? 1 : 1 / fps));
      } else if (k === "ArrowRight") {
        handled();
        st.seek(st.playhead + (e.shiftKey ? 1 : 1 / fps));
      } else if (k === "ArrowUp") {
        handled();
        goToNextEdit(-1);
      } else if (k === "ArrowDown") {
        handled();
        goToNextEdit(1);
      } else if (k === "j") st.seek(st.playhead - 1);
      else if (k === "l") st.seek(st.playhead + 1);
      else if (k === "Home") st.seek(0);
      else if (k === "End") st.seek(projectDuration(p));
      else if (k === "v") st.set({ tool: "select" });
      else if (k === "b") st.set({ tool: "blade" });
      else if (k === "n") st.set({ snapping: !st.snapping });
      else if (k === "m") st.commit("Add marker", (d) => void d.markers.push({ id: crypto.randomUUID(), t: st.playhead, label: `Marker ${d.markers.length + 1}`, color: "#ffd60a" }));
      else if (k === "i") st.set({ inOut: { ...st.inOut, in: st.playhead } });
      else if (k === "o") st.set({ inOut: { ...st.inOut, out: st.playhead } });
      else if (k === "+" || k === "=") st.set({ pxPerSec: Math.min(600, st.pxPerSec * 1.3) });
      else if (k === "-") st.set({ pxPerSec: Math.max(4, st.pxPerSec / 1.3) });
      else if (k === "Z" && e.shiftKey) document.querySelector<HTMLButtonElement>('.tl-toolbar button[data-tip^="Fit"]')?.click();
      else if (k === "t") addText("title");
      else if (k === "?") setShowKeys(true);
      else if (k === "Escape") st.set({ selection: [], tool: "select" });
      else if (["1", "2", "3", "4"].includes(k)) st.set({ workspace: WORKSPACES[Number(k) - 1].id });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (!project) return <div className="loading">Loading project…</div>;

  const right = workspace === "ai" ? <AIPanel onOpenProject={onOpen} /> : workspace === "color" ? <ColorPanel /> : <Inspector />;
  const rightTitle = workspace === "ai" ? "AI Editing Director" : workspace === "color" ? "Color grading" : "Inspector";
  const effRight = workspace === "ai" ? Math.max(rightW, 420) : rightW;

  return (
    <div className={`editor ws-${workspace} ${beginner ? "mode-beginner" : ""}`}>
      <header className="topbar">
        <button className="logo" onClick={onExit} data-tip="All projects">
          <span className="logo-mark">▶</span> Cutwise
        </button>
        <input className="project-name" value={project.name} onChange={(e) => S().commit("Rename project", (d) => void (d.name = e.target.value), "rename")} onKeyDown={(e) => e.stopPropagation()} />
        <span className={`save-state s-${saveState}`} data-tip="Autosaves 1.5s after each change; a local backup protects against crashes">
          {saveState === "saved" ? "✓ Saved" : saveState === "saving" ? "Saving…" : saveState === "error" ? "⚠ Save failed (backup kept locally)" : "● Unsaved"}
        </span>
        <IconButton icon="undo" label="Undo" kbd="Ctrl+Z" disabled={!past.length} onClick={() => S().undo()} />
        <IconButton icon="redo" label="Redo" kbd="Ctrl+Shift+Z" disabled={!future.length} onClick={() => S().redo()} />
        <IconButton icon="history" label="Editing history & versions" onClick={() => setShowHistory(true)} />
        <IconButton icon="save" label="Save version" kbd="Ctrl+S" onClick={manualSave} />
        <nav className="workspaces">
          {WORKSPACES.map((w) => (
            <button key={w.id} className={workspace === w.id ? "active" : ""} onClick={() => S().set({ workspace: w.id })} data-tip={`${w.label} workspace (${w.key})`} data-tour={`ws-${w.id}`}>
              <Icon name={w.icon} size={14} /> {w.label}
            </button>
          ))}
        </nav>
        <span className="grow" />
        <JobsIndicator />
        <Toggle label="Beginner" checked={beginner} onChange={(v) => (S().set({ beginner: v }), safeSet("cutwise:beginner", v ? "1" : "0"))} help="Hides advanced controls (keyframes, wheels, curves, EQ)" />
        <IconButton icon="help" label="Interactive tour" onClick={() => setTour(true)} />
        <IconButton icon="keyboard" label="Keyboard shortcuts" kbd="?" onClick={() => setShowKeys(true)} />
        <button className="btn primary" onClick={() => setShowExport(true)} data-tour="export">
          <Icon name="export" /> Export
        </button>
      </header>

      <div className="main" style={{ gridTemplateColumns: `${leftOpen ? leftW : 44}px 4px 1fr 4px ${effRight}px` }}>
        <aside className="left">
          <div className="left-tabs">
            {LEFT_TABS.map((t) => (
              <button key={t.id} className={leftTab === t.id && leftOpen ? "active" : ""} onClick={() => (leftOpen && leftTab === t.id ? setLeftOpen(false) : (setLeftOpen(true), S().set({ leftTab: t.id })))} data-tip={t.label} data-tour={`tab-${t.id}`}>
                <Icon name={t.icon} size={17} />
                <span>{t.label}</span>
              </button>
            ))}
          </div>
          {leftOpen && (
            <div className="left-content">
              <div className="panel-title">{LEFT_TABS.find((t) => t.id === leftTab)?.label}</div>
              {leftTab === "media" && <MediaPanel />}
              {leftTab === "text" && <TextPanel />}
              {leftTab === "effects" && <EffectsPanel />}
              {leftTab === "transitions" && <TransitionsPanel />}
              {leftTab === "captions" && <CaptionsPanel />}
              {leftTab === "broll" && <BrollPanel />}
              {leftTab === "audio" && <AudioLibraryPanel />}
            </div>
          )}
        </aside>
        <div className="resizer v" onPointerDown={(e) => startLeft(e, 1, "x")} />
        <section className="center">
          <Preview />
        </section>
        <div className="resizer v" onPointerDown={(e) => startRight(e, -1, "x")} />
        <aside className="right">
          <div className="panel-title">{rightTitle}</div>
          {right}
        </aside>
      </div>
      <div className="resizer h" onPointerDown={(e) => startBottom(e, -1, "y")} />
      <div className="bottom" style={{ height: bottomH }}>
        {workspace === "audio" ? (
          <div className="audio-split">
            <Mixer />
            <Timeline />
          </div>
        ) : (
          <Timeline />
        )}
      </div>

      {showExport && <ExportDialog onClose={() => setShowExport(false)} />}
      {showKeys && <ShortcutsDialog onClose={() => setShowKeys(false)} />}
      {showHistory && (
        <HistoryDialog
          onClose={() => setShowHistory(false)}
          onRestore={async (vid) => {
            const v = await api.version(project.id, vid);
            S().replaceProject("Restore version", { ...v, updatedAt: Date.now() });
            setShowHistory(false);
            S().toast("Version restored (Ctrl+Z to undo)", "success");
          }}
        />
      )}
      {tour && (
        <Tutorial
          onClose={() => {
            setTour(false);
            safeSet("cutwise:toured", "1");
          }}
        />
      )}
      {recover && (
        <div className="recover-bar">
          Unsaved changes from {new Date(recover.updatedAt).toLocaleString()} were found (the app closed before saving).
          <button className="btn sm primary" onClick={() => (S().replaceProject("Recover unsaved changes", recover), setRecover(null))}>
            Recover
          </button>
          <button className="btn sm ghost" onClick={() => (safeDel(`cutwise:backup:${project.id}`), setRecover(null))}>
            Discard
          </button>
        </div>
      )}
      <div className="toasts">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`}>
            {t.text}
          </div>
        ))}
      </div>
    </div>
  );
}
