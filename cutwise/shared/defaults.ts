import type { AudioFx, Clip, Project, Track, TrackKind, VisualFx, Transform, EditGoals, TextData, TextTemplate } from "./types";
import { ASPECTS, DEFAULT_CAPTION_STYLE, NEUTRAL_GRADE } from "./presets";

export function uid(prefix = ""): string {
  const r = Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
  return prefix ? `${prefix}_${r}` : r;
}

export const DEFAULT_AUDIO_FX: AudioFx = {
  highpass: false,
  denoise: 0,
  voiceEnhance: false,
  eqLow: 0,
  eqMid: 0,
  eqHigh: 0,
  compressor: 0,
  limiter: false,
};

export const DEFAULT_FX: VisualFx = { blur: 0, sharpen: 0, vignette: 0, grain: 0, glow: 0 };

export const DEFAULT_TRANSFORM: Transform = { fit: "fit", scale: 1, x: 0, y: 0, rotation: 0, opacity: 1, cropX: 0 };

export function makeTrack(kind: TrackKind, name: string, extra: Partial<Track> = {}): Track {
  return {
    id: uid("trk"),
    kind,
    name,
    role: kind === "audio" ? "music" : kind === "video" ? "voice" : undefined,
    muted: false,
    solo: false,
    locked: false,
    hidden: false,
    volume: 1,
    pan: 0,
    fx: { ...DEFAULT_AUDIO_FX },
    ...extra,
  };
}

export function makeClip(partial: Partial<Clip> & { trackId: string }): Clip {
  return {
    id: uid("clp"),
    kind: "media",
    start: 0,
    in: 0,
    out: 5,
    speed: 1,
    volume: 1,
    fadeIn: 0,
    fadeOut: 0,
    transform: { ...DEFAULT_TRANSFORM },
    motion: { preset: "none", intensity: 0.5 },
    keyframes: [],
    color: structuredClone(NEUTRAL_GRADE),
    fx: { ...DEFAULT_FX },
    ...partial,
  };
}

export function makeTextData(template: TextTemplate, text = "Your text"): TextData {
  const base: TextData = {
    template,
    text,
    x: 0.5,
    y: 0.5,
    w: 0.3,
    h: 0.12,
    rotation: 0,
    style: { font: "montserrat-black", size: 96, color: "#ffffff", accent: "#7b2ff7", background: false, outline: 4, shadow: 2, uppercase: false },
    animIn: "pop",
    animOut: "fade",
  };
  switch (template) {
    case "title":
      return { ...base, text: text === "Your text" ? "YOUR TITLE" : text, y: 0.45, style: { ...base.style, size: 130, uppercase: true } };
    case "lowerThird":
      return { ...base, text: text === "Your text" ? "Jane Doe" : text, subtitle: "Creator & Host", x: 0.27, y: 0.8, animIn: "slideLeft", style: { ...base.style, font: "inter-bold", size: 54, background: true, outline: 0, shadow: 0 } };
    case "callout":
      return { ...base, text: text === "Your text" ? "Look here" : text, x: 0.7, y: 0.3, animIn: "pop", style: { ...base.style, font: "poppins-bold", size: 48, background: true, accent: "#ffd60a", color: "#111111", outline: 0 } };
    case "arrow":
      return { ...base, text: "", x: 0.6, y: 0.4, w: 0.12, h: 0.06, animIn: "slideLeft", style: { ...base.style, accent: "#ffd60a" } };
    case "highlightBox":
      return { ...base, text: "", x: 0.5, y: 0.5, w: 0.3, h: 0.2, animIn: "pop", style: { ...base.style, accent: "#ff4d6d", outline: 8 } };
    case "progressBar":
      return { ...base, text: "", x: 0.5, y: 0.985, w: 1, h: 0.012, animIn: "none", animOut: "none", style: { ...base.style, accent: "#ff4d6d" } };
    default:
      return { ...base, style: { ...base.style, font: "poppins-bold", size: 72 } };
  }
}

export const DEFAULT_GOALS: EditGoals = {
  genre: "talking-head / educational",
  audience: "general YouTube audience",
  platform: "youtube",
  targetDuration: 0,
  style: "balanced",
  tone: "friendly, confident",
  mode: "manual",
  notes: "",
};

export function makeProject(name: string, aspect = "16:9"): Project {
  const size = ASPECTS[aspect] ?? ASPECTS["16:9"];
  const v1 = makeTrack("video", "V1 · Main", { role: "voice" });
  const v2 = makeTrack("video", "V2 · B-roll", { role: "voice" });
  const t1 = makeTrack("text", "T1 · Titles");
  const a1 = makeTrack("audio", "A1 · Voice / VO", { role: "voice" });
  const a2 = makeTrack("audio", "A2 · Music", { role: "music", duckUnderVoice: true, volume: 0.6 });
  const a3 = makeTrack("audio", "A3 · SFX", { role: "sfx", volume: 0.8 });
  const now = Date.now();
  return {
    id: uid("prj"),
    name,
    version: 1,
    createdAt: now,
    updatedAt: now,
    settings: { width: size.width, height: size.height, fps: 30, aspect, background: "#000000" },
    // Order matters: tracks are listed top -> bottom in the UI; video tracks higher in the list draw on top.
    tracks: [t1, v2, v1, a1, a2, a3],
    clips: [],
    transcripts: {},
    captions: { enabled: false, style: { ...DEFAULT_CAPTION_STYLE }, sourceTrackId: v1.id },
    master: { volume: 1, normalize: true, targetLufs: -14, limiter: true },
    markers: [],
    ai: { goals: { ...DEFAULT_GOALS, platform: aspect === "9:16" ? "shorts" : "youtube" }, recommendations: [] },
    mediaIds: [],
  };
}
