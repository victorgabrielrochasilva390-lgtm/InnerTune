import { useEffect, useLayoutEffect, useState } from "react";
import { Modal } from "./ui";
import { useEditor } from "../store";
import { formatShort } from "../../shared/timeline";
import { api } from "../api";

export const SHORTCUTS: [string, string][] = [
  ["Space / K", "Play / pause"],
  ["J / L", "Back / forward 1 second"],
  ["← / →", "Previous / next frame"],
  ["Shift + ← / →", "Back / forward 1 second"],
  ["↑ / ↓", "Previous / next edit point"],
  ["Home / End", "Start / end of timeline"],
  ["S or Ctrl+B", "Split at playhead"],
  ["Delete / Backspace", "Delete selected clips"],
  ["Shift + Delete", "Ripple delete (close gap)"],
  ["Ctrl + D", "Duplicate selection"],
  ["Ctrl + Z / Ctrl + Shift + Z", "Undo / redo"],
  ["Ctrl + S", "Save version"],
  ["Ctrl + A", "Select all clips"],
  ["V / B", "Select tool / blade tool"],
  ["N", "Toggle snapping"],
  ["M", "Add marker"],
  ["I / O", "Set in / out points (range export)"],
  ["+ / -", "Zoom timeline"],
  ["Shift + Z", "Fit timeline"],
  ["T", "Add title at playhead"],
  ["1 / 2 / 3 / 4", "Edit / AI Director / Color / Audio workspace"],
  ["Ctrl + E", "Export"],
  ["?", "Show shortcuts"],
];

export function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  return (
    <Modal title="Keyboard shortcuts" onClose={onClose}>
      <table className="shortcuts">
        <tbody>
          {SHORTCUTS.map(([k, d]) => (
            <tr key={k}>
              <td>
                <kbd>{k}</kbd>
              </td>
              <td>{d}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Modal>
  );
}

export function HistoryDialog({ onClose, onRestore }: { onClose: () => void; onRestore: (vid: number) => void }) {
  const past = useEditor((s) => s.past);
  const future = useEditor((s) => s.future);
  const project = useEditor((s) => s.project)!;
  const jump = useEditor((s) => s.jumpHistory);
  const [versions, setVersions] = useState<{ id: number; createdAt: number; kind: string }[]>([]);
  useEffect(() => {
    api.versions(project.id).then(setVersions);
  }, [project.id]);
  return (
    <Modal title="Editing history & versions" onClose={onClose} wide>
      <div className="export-grid">
        <div>
          <h4>This session ({past.length} steps)</h4>
          <ol className="history-list">
            {past.map((h, i) => (
              <li key={i} onClick={() => jump(i)} data-tip="Go back to before this step">
                <span>{h.label}</span>
                <span className="muted small">{new Date(h.at).toLocaleTimeString()}</span>
              </li>
            ))}
            <li className="current">● Current state</li>
            {future.map((h, i) => (
              <li key={`f${i}`} className="future">
                {h.label} (undone)
              </li>
            ))}
          </ol>
        </div>
        <div>
          <h4>Saved versions</h4>
          <p className="muted small">Manual saves (Ctrl+S) and automatic snapshots every 5 minutes. Restoring replaces the timeline, and you can undo it.</p>
          <ol className="history-list">
            {versions.map((v) => (
              <li key={v.id} onClick={() => onRestore(v.id)}>
                <span>{v.kind === "manual" ? "💾 Saved" : v.kind === "create" ? "Created" : "Autosave"}</span>
                <span className="muted small">{new Date(v.createdAt).toLocaleString()}</span>
              </li>
            ))}
          </ol>
        </div>
      </div>
    </Modal>
  );
}

const STEPS: { target: string; title: string; body: string }[] = [
  { target: "import", title: "1. Import your footage", body: "Click Import or drag files anywhere onto the media panel. Cutwise makes lightweight preview proxies, thumbnails and waveforms, and analyses silences, scenes and loudness in the background. Your originals are never changed." },
  { target: "timeline", title: "2. Build your edit", body: "Drag media onto the timeline or double-click it. Drag clips to move them and drag their edges to trim. Press S to split at the playhead and Shift+Delete to ripple delete. Ctrl+wheel zooms." },
  { target: "preview", title: "3. Preview in real time", body: "Space plays and pauses, ← → steps one frame. Captions, text, transitions, motion and colour all preview live." },
  { target: "tab-captions", title: "4. Word-by-word captions", body: "Transcribe (free with local Whisper, or Deepgram/Groq/OpenAI), pick a caption style, and fix any word. Shift-click words and press 'Delete from video' to edit by text." },
  { target: "ws-ai", title: "5. Ask the AI Director", body: "Set your platform, style and goals, then build a plan. Each suggestion (cut, B-roll, zoom, audio, colour) explains what, where, why and the expected effect. Preview it, then apply, adjust or reject." },
  { target: "ws-audio", title: "6. Mix the audio", body: "Per-track volume, mute/solo, EQ, compression, noise reduction, music ducking under voice, and master loudness normalisation." },
  { target: "export", title: "7. Export for any platform", body: "Pick YouTube, Shorts, TikTok, Reels or Instagram presets. Smart reframing converts 16:9 to vertical and centres each scene on its subject." },
];

export function Tutorial({ onClose }: { onClose: () => void }) {
  const [i, setI] = useState(0);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const step = STEPS[i];
  useLayoutEffect(() => {
    const el = document.querySelector(`[data-tour="${step.target}"]`);
    setRect(el ? el.getBoundingClientRect() : null);
    if (step.target === "tab-captions") useEditor.getState().set({ leftTab: "captions" });
    if (step.target === "import") useEditor.getState().set({ leftTab: "media" });
  }, [i]);
  const pos = rect ? { left: Math.min(window.innerWidth - 360, Math.max(12, rect.left)), top: rect.bottom + 12 > window.innerHeight - 200 ? Math.max(12, rect.top - 200) : rect.bottom + 12 } : { left: window.innerWidth / 2 - 170, top: window.innerHeight / 2 - 100 };
  return (
    <div className="tour-back">
      {rect && <div className="tour-hole" style={{ left: rect.left - 6, top: rect.top - 6, width: rect.width + 12, height: rect.height + 12 }} />}
      <div className="tour-card" style={pos}>
        <div className="muted small">
          Step {i + 1} of {STEPS.length}
        </div>
        <h3>{step.title}</h3>
        <p>{step.body}</p>
        <div className="row gap">
          <button className="btn ghost" onClick={onClose}>
            Skip tour
          </button>
          <span className="grow" />
          {i > 0 && (
            <button className="btn" onClick={() => setI(i - 1)}>
              Back
            </button>
          )}
          {i < STEPS.length - 1 ? (
            <button className="btn primary" onClick={() => setI(i + 1)}>
              Next
            </button>
          ) : (
            <button className="btn primary" onClick={onClose}>
              Start editing
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export function JobsIndicator() {
  const jobs = useEditor((s) => s.jobs);
  const active = Object.values(jobs).filter((j) => j.status === "running" || j.status === "queued");
  if (!active.length) return null;
  const j = active[0];
  return (
    <div className="jobs-ind" data-tip={active.map((x) => `${x.type}: ${x.message ?? x.status} ${Math.round(x.progress * 100)}%`).join("\n")}>
      <span className="spinner" /> {active.length > 1 ? `${active.length} tasks` : `${j.message ?? j.type}`} {Math.round(j.progress * 100)}%
    </div>
  );
}

export function _unused() {
  return formatShort(0);
}
