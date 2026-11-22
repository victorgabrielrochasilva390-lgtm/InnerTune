import { create } from "zustand";
import { produce, type Draft } from "immer";
import type { Clip, ColorGrade, Job, Project, Range, ServerCapabilities, VisualFx } from "../shared/types";
import { api, type PubMedia } from "./api";
import { clipEnd, projectDuration } from "../shared/timeline";

export type Workspace = "edit" | "ai" | "color" | "audio";
export type LeftTab = "media" | "text" | "effects" | "transitions" | "captions" | "broll" | "audio";

interface HistoryEntry {
  project: Project;
  label: string;
  at: number;
  key?: string;
}

export interface Toast {
  id: number;
  text: string;
  kind: "info" | "error" | "success";
}

interface EditorState {
  project: Project | null;
  past: HistoryEntry[];
  future: HistoryEntry[];
  media: Record<string, PubMedia>;
  sfx: Record<string, string>;
  caps: ServerCapabilities | null;
  jobs: Record<string, Job>;
  selection: string[];
  selectedTrack: string | null;
  playhead: number;
  playing: boolean;
  pxPerSec: number;
  tool: "select" | "blade";
  snapping: boolean;
  workspace: Workspace;
  leftTab: LeftTab;
  saveState: "saved" | "saving" | "unsaved" | "error";
  lastSavedAt: number;
  previewSkip: Range[] | null;
  compare: "off" | "original" | "split";
  showSafe: boolean;
  colorClipboard: { color: ColorGrade; fx: VisualFx } | null;
  toasts: Toast[];
  beginner: boolean;
  focusRec: string | null;
  brollQuery: string;
  inOut: { in: number | null; out: number | null };

  setProject: (p: Project | null) => void;
  commit: (label: string, recipe: (d: Draft<Project>) => void, key?: string) => void;
  replaceProject: (label: string, next: Project, key?: string) => void;
  undo: () => void;
  redo: () => void;
  jumpHistory: (index: number) => void;
  set: (patch: Partial<EditorState>) => void;
  setMedia: (m: PubMedia) => void;
  refreshMedia: (ids?: string[]) => Promise<void>;
  toast: (text: string, kind?: Toast["kind"]) => void;
  seek: (t: number) => void;
}

const MAX_HISTORY = 200;
let toastId = 0;

export const useEditor = create<EditorState>((set, get) => ({
  project: null,
  past: [],
  future: [],
  media: {},
  sfx: {},
  caps: null,
  jobs: {},
  selection: [],
  selectedTrack: null,
  playhead: 0,
  playing: false,
  pxPerSec: 60,
  tool: "select",
  snapping: true,
  workspace: "edit",
  leftTab: "media",
  saveState: "saved",
  lastSavedAt: 0,
  previewSkip: null,
  compare: "off",
  showSafe: false,
  colorClipboard: null,
  toasts: [],
  beginner: safeGet("cutwise:beginner") === "1",
  focusRec: null,
  brollQuery: "",
  inOut: { in: null, out: null },

  setProject: (p) => set({ project: p, past: [], future: [], selection: [], playhead: 0, playing: false, saveState: "saved", inOut: { in: null, out: null } }),

  commit: (label, recipe, key) => {
    const cur = get().project;
    if (!cur) return;
    const next = produce(cur, (d) => {
      recipe(d);
      d.updatedAt = Date.now();
    });
    if (next === cur) return;
    get().replaceProject(label, next, key);
  },

  replaceProject: (label, next, key) => {
    const { project: cur, past } = get();
    if (!cur) return;
    const last = past[past.length - 1];
    // coalesce rapid repeated edits (slider drags) into one history step
    if (key && last && last.key === key && Date.now() - last.at < 1200) {
      last.at = Date.now();
      set({ project: next, future: [], saveState: "unsaved" });
      return;
    }
    const entry: HistoryEntry = { project: cur, label, at: Date.now(), key };
    set({ project: next, past: [...past, entry].slice(-MAX_HISTORY), future: [], saveState: "unsaved" });
  },

  undo: () => {
    const { past, future, project } = get();
    if (!past.length || !project) return;
    const prev = past[past.length - 1];
    set({ project: prev.project, past: past.slice(0, -1), future: [{ project, label: prev.label, at: Date.now() }, ...future], saveState: "unsaved" });
    get().toast(`Undo: ${prev.label}`);
  },

  redo: () => {
    const { past, future, project } = get();
    if (!future.length || !project) return;
    const nxt = future[0];
    set({ project: nxt.project, future: future.slice(1), past: [...past, { project, label: nxt.label, at: Date.now() }], saveState: "unsaved" });
    get().toast(`Redo: ${nxt.label}`);
  },

  jumpHistory: (index) => {
    // index into past: restore the state *before* entry index was applied
    const { past } = get();
    const steps = past.length - index;
    for (let i = 0; i < steps; i++) get().undo();
  },

  set: (patch) => set(patch as any),

  setMedia: (m) => set({ media: { ...get().media, [m.id]: m } }),

  refreshMedia: async (ids) => {
    const list = await api.media(ids);
    const media = { ...get().media };
    for (const m of list) media[m.id] = m;
    set({ media });
  },

  toast: (text, kind = "info") => {
    const id = ++toastId;
    set({ toasts: [...get().toasts, { id, text, kind }] });
    setTimeout(() => set({ toasts: get().toasts.filter((t) => t.id !== id) }), kind === "error" ? 7000 : 3500);
  },

  seek: (t) => {
    const p = get().project;
    const d = p ? projectDuration(p) : 0;
    set({ playhead: Math.max(0, Math.min(Math.max(d, 0), t)) });
  },
}));

export function safeGet(k: string): string | null {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
}
export function safeSet(k: string, v: string) {
  try {
    localStorage.setItem(k, v);
  } catch {}
}
export function safeDel(k: string) {
  try {
    localStorage.removeItem(k);
  } catch {}
}

export const selectedClips = (s: { project: Project | null; selection: string[] }): Clip[] => (s.project ? s.project.clips.filter((c) => s.selection.includes(c.id)) : []);

export function frame(p: Project | null) {
  return 1 / (p?.settings.fps ?? 30);
}

export function snapFrame(t: number, fps: number) {
  return Math.round(t * fps) / fps;
}

export function timelineEnd(p: Project) {
  return p.clips.reduce((d, c) => Math.max(d, clipEnd(c)), 0);
}

// expose the store for debugging / end-to-end tests in development builds
if (import.meta.env.DEV) (globalThis as any).__cutwise = useEditor;
