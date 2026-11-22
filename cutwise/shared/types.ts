// Core data model shared by the browser editor, the server and the renderer.
// All times are in seconds (floating point). "Source time" is a position inside a
// media file; "timeline time" is a position on the project timeline.

export type MediaKind = "video" | "audio" | "image";

export interface MediaSourceInfo {
  provider: "upload" | "linked" | "openverse" | "pexels" | "pixabay" | "generated";
  url?: string;
  author?: string;
  license?: string;
  licenseUrl?: string;
  title?: string;
}

export interface MediaItem {
  id: string;
  name: string;
  kind: MediaKind;
  path: string; // absolute path of the ORIGINAL file on the server (never modified)
  proxyPath?: string; // lightweight H.264 proxy for preview
  duration: number; // seconds (images: 0)
  width: number;
  height: number;
  fps: number;
  hasAudio: boolean;
  hasVideo: boolean;
  videoCodec?: string;
  audioCodec?: string;
  size: number;
  createdAt: number;
  missing?: boolean; // original file no longer on disk -> needs relinking
  source: MediaSourceInfo;
  status: "ready" | "processing" | "error";
  error?: string;
  filmstrip?: { url: string; frames: number; frameWidth: number; frameHeight: number; interval: number };
  waveformUrl?: string;
  analysis?: MediaAnalysis;
}

export interface Range {
  start: number;
  end: number;
}

export interface MediaAnalysis {
  analyzedAt: number;
  silences: Range[]; // source time
  scenes: number[]; // source timestamps of detected visual cuts
  loudness?: { integrated: number; truePeak: number; lra: number; threshold: number };
  noiseFloorDb?: number;
  clipping?: { peakDb: number; clippedRatio: number; likely: boolean };
  energy: { t: number; rms: number }[]; // RMS dBFS every 0.5s, used for emphasis / tone changes
  visual?: { brightness: number; saturation: number; perScene: { t: number; brightness: number; saturation: number }[] };
  keyframes?: { t: number; url: string }[]; // scene thumbnails (for vision models)
}

export interface Word {
  id: string;
  text: string; // as displayed (includes punctuation)
  start: number; // source time
  end: number;
  speaker?: string;
  confidence?: number;
}

export interface Transcript {
  mediaId: string;
  language?: string;
  provider: string; // deepgram | openai | groq | local-whisper | srt-import | manual
  approximate?: boolean; // word times interpolated (e.g. from SRT)
  words: Word[];
  speakers?: Record<string, string>; // speaker id -> display name
}

// ---------------------------------------------------------------- timeline

export type TrackKind = "video" | "audio" | "text";
export type AudioRole = "voice" | "music" | "sfx";

export interface AudioFx {
  highpass: boolean; // rumble removal (80 Hz)
  denoise: number; // 0..1 FFT noise reduction strength
  voiceEnhance: boolean; // presence + de-mud EQ
  eqLow: number; // dB -12..12 (shelf @120Hz)
  eqMid: number; // dB (peak @1.5kHz)
  eqHigh: number; // dB (shelf @8kHz)
  compressor: number; // 0 = off, 0..1 amount
  limiter: boolean;
}

export interface Track {
  id: string;
  kind: TrackKind;
  name: string;
  role?: AudioRole; // audio role used for ducking / mixing decisions
  muted: boolean;
  solo: boolean;
  locked: boolean;
  hidden: boolean;
  volume: number; // linear gain 0..2
  pan: number; // -1..1
  fx: AudioFx;
  duckUnderVoice?: boolean; // music ducking
}

export type TransitionType =
  | "cut"
  | "crossfade"
  | "fadeBlack"
  | "fadeWhite"
  | "swipeLeft"
  | "swipeRight"
  | "swipeUp"
  | "zoom"
  | "blur"
  | "whipPan"
  | "glitch";

export interface Transition {
  type: TransitionType;
  duration: number;
  intensity: number; // 0..1
}

export type MotionPreset =
  | "none"
  | "slowZoomIn"
  | "slowZoomOut"
  | "punchIn"
  | "punchOut"
  | "panLeft"
  | "panRight"
  | "shake"
  | "kenBurns";

export interface Keyframe {
  t: number; // seconds from clip start (timeline-relative)
  scale: number;
  x: number;
  y: number;
  rotation: number;
  opacity: number;
  ease: "linear" | "easeInOut";
}

export interface Transform {
  fit: "fit" | "fill" | "blurFill";
  scale: number;
  x: number; // offset as fraction of canvas width
  y: number; // offset as fraction of canvas height
  rotation: number; // degrees
  opacity: number;
  cropX: number; // reframing pan within source (-1..1) used when fill crops the image
}

export interface ColorGrade {
  exposure: number; // stops -2..2
  contrast: number; // -1..1
  saturation: number; // 0..2 (1 = unchanged)
  temperature: number; // -1 (cool) .. 1 (warm)
  tint: number; // -1 (green) .. 1 (magenta)
  highlights: number; // -1..1
  shadows: number; // -1..1
  lift: RGB;
  gamma: RGB;
  gain: RGB;
  curve: [number, number, number, number, number]; // master curve output at 0, .25, .5, .75, 1
  lutId?: string;
  lutIntensity: number;
}

export interface RGB {
  r: number;
  g: number;
  b: number;
}

export interface VisualFx {
  blur: number; // px at 1080p, 0..40
  sharpen: number; // 0..2
  vignette: number; // 0..1
  grain: number; // 0..1
  glow: number; // 0..1
}

export type TextTemplate = "text" | "title" | "lowerThird" | "callout" | "arrow" | "highlightBox" | "progressBar";
export type TextAnim = "none" | "fade" | "pop" | "slideUp" | "slideLeft";

export interface TextStyle {
  font: string; // FontDef id
  size: number; // px relative to a 1080px-high canvas
  color: string; // #rrggbb
  accent: string; // box / shape / highlight colour
  background: boolean;
  outline: number;
  shadow: number;
  uppercase: boolean;
}

export interface TextData {
  template: TextTemplate;
  text: string;
  subtitle?: string;
  x: number; // 0..1 canvas position of anchor (center)
  y: number;
  w: number; // shape width (fraction of canvas width) for boxes/arrows/progress
  h: number;
  rotation: number;
  style: TextStyle;
  animIn: TextAnim;
  animOut: TextAnim;
}

export interface Clip {
  id: string;
  trackId: string;
  kind: "media" | "text" | "adjustment"; // adjustment layers grade everything below them
  mediaId?: string;
  start: number; // timeline position
  in: number; // source in (media clips)
  out: number; // source out (media clips); for text/images: in=0,out=duration
  speed: number;
  volume: number; // linear 0..2
  fadeIn: number; // audio fade seconds
  fadeOut: number;
  transform: Transform;
  motion: { preset: MotionPreset; intensity: number };
  keyframes: Keyframe[];
  color: ColorGrade;
  fx: VisualFx;
  transitionIn?: Transition;
  transitionOut?: Transition; // only meaningful on overlay/B-roll tracks (fade out over what's below)
  text?: TextData;
  label?: string;
  linkedTo?: string; // AI recommendation id that created this clip
}

export interface CaptionStyle {
  preset: string;
  font: string;
  size: number; // px at 1080p
  color: string;
  highlightColor: string;
  highlightMode: "color" | "box" | "none";
  outlineColor: string;
  outline: number;
  shadow: number;
  background: boolean;
  backgroundColor: string;
  backgroundOpacity: number;
  uppercase: boolean;
  animation: "none" | "pop" | "karaoke" | "wordByWord" | "bounce" | "fade";
  wordsPerLine: number;
  linesPerPage: number;
  maxPageDuration: number; // seconds; reading speed control
  minWordDuration: number;
  positionY: number; // 0..1 (center of caption block)
  autoSafeArea: boolean;
  timingOffset: number; // global caption delay (seconds)
}

export interface Captions {
  enabled: boolean;
  style: CaptionStyle;
  sourceTrackId?: string; // the track whose clips drive captions (default: first video track)
}

export interface MasterAudio {
  volume: number;
  normalize: boolean;
  targetLufs: number; // -14 YouTube/Spotify, -16 podcasts
  limiter: boolean;
}

export interface ProjectSettings {
  width: number;
  height: number;
  fps: number;
  aspect: string; // "16:9" | "9:16" | "1:1" | "4:5"
  background: string;
}

export interface Marker {
  id: string;
  t: number;
  label: string;
  color: string;
}

export interface Project {
  id: string;
  name: string;
  version: number;
  createdAt: number;
  updatedAt: number;
  settings: ProjectSettings;
  tracks: Track[];
  clips: Clip[];
  transcripts: Record<string, Transcript>;
  captions: Captions;
  master: MasterAudio;
  markers: Marker[];
  ai: AiState;
  mediaIds: string[]; // media used / imported into this project
}

// ---------------------------------------------------------------- AI

export type RecKind =
  | "cut"
  | "broll"
  | "zoom"
  | "transition"
  | "music"
  | "sfx"
  | "color"
  | "audio"
  | "caption"
  | "hook"
  | "title"
  | "pacing";

export type RecStatus = "pending" | "approved" | "rejected" | "applied";

export interface Recommendation {
  id: string;
  kind: RecKind;
  mediaId?: string;
  start: number; // source time on mediaId (or timeline time when mediaId undefined)
  end: number;
  title: string;
  action: string; // what should be changed
  reason: string; // why
  effect: string; // expected result
  auto: boolean; // safe to apply automatically
  confidence: number; // 0..1
  status: RecStatus;
  source: "heuristic" | "claude";
  sceneIndex?: number;
  payload?: RecPayload;
}

export interface RecPayload {
  // cut
  savedSeconds?: number;
  cutType?: "silence" | "filler" | "repeat" | "stutter" | "redundant";
  transcriptExcerpt?: string;
  // broll
  narration?: string;
  visual?: string;
  query?: string;
  assetType?: "video" | "photo" | "illustration" | "screenshot" | "graphic" | "animation" | "overlay";
  duration?: number;
  animation?: MotionPreset;
  transition?: TransitionType;
  // zoom
  motion?: MotionPreset;
  intensity?: number;
  // transition
  transitionType?: TransitionType;
  // music / sfx
  mood?: string;
  sfxId?: string;
  // color
  grade?: Partial<ColorGrade>;
  // audio
  fx?: Partial<AudioFx>;
  master?: Partial<MasterAudio>;
  trackRole?: AudioRole;
  // caption
  captionPreset?: string;
  // title / text overlay
  text?: string;
  template?: TextTemplate;
}

export interface EditGoals {
  genre: string;
  audience: string;
  platform: "youtube" | "shorts" | "tiktok" | "reels" | "instagram";
  targetDuration: number; // seconds, 0 = no target
  style: "fast" | "balanced" | "calm" | "cinematic" | "educational";
  tone: string;
  mode: "automatic" | "manual";
  notes: string;
}

export interface PublishingKit {
  titles: string[];
  hooks: string[];
  description: string;
  chapters: { t: number; title: string }[];
  thumbnails: string[];
  shorts: { start: number; end: number; mediaId?: string; title: string; reason: string }[];
  openings: string[];
  tags?: string[];
}

export interface AiState {
  goals: EditGoals;
  recommendations: Recommendation[];
  kit?: PublishingKit;
  summary?: string;
  strategy?: string[];
  lastRun?: { at: number; source: "heuristic" | "claude"; model?: string; warnings: string[] };
}

// ---------------------------------------------------------------- export

export interface ExportSettings {
  preset: string;
  width: number;
  height: number;
  fps: number;
  videoBitrateKbps: number;
  crf?: number;
  codec: "h264" | "h265";
  audioBitrateKbps: number;
  sampleRate: number;
  range?: Range; // timeline range (for exporting shorts)
  burnCaptions: boolean;
  fileName: string;
}

export interface Job {
  id: string;
  type: "proxy" | "analysis" | "transcribe" | "render" | "reframe" | "stock-import";
  status: "queued" | "running" | "done" | "error" | "cancelled";
  progress: number; // 0..1
  message?: string;
  error?: string;
  mediaId?: string;
  projectId?: string;
  result?: unknown;
  createdAt: number;
  updatedAt: number;
}

export interface ServerCapabilities {
  ffmpeg: string;
  transcription: { id: string; label: string; available: boolean; free: boolean; note: string }[];
  claude: { available: boolean; model: string };
  stock: { id: string; label: string; available: boolean; note: string }[];
}
