import type { CaptionStyle, ColorGrade, TransitionType, MotionPreset, ExportSettings, TextTemplate } from "./types";

export interface FontDef {
  id: string;
  label: string;
  css: string; // CSS font-family registered by /fonts/fonts.css
  ass: string; // family/full name libass resolves from the fonts dir
  bold: boolean;
  file: string; // path inside node_modules/@expo-google-fonts
}

// Open Font License fonts bundled through @expo-google-fonts (TTF files). The same
// files are used by the browser preview (@font-face) and by libass during export, so
// captions look identical in preview and render.
export const FONTS: FontDef[] = [
  { id: "montserrat-black", label: "Montserrat Black", css: "Montserrat Black", ass: "Montserrat Black", bold: false, file: "montserrat/900Black/Montserrat_900Black.ttf" },
  { id: "montserrat-xbold", label: "Montserrat ExtraBold", css: "Montserrat ExtraBold", ass: "Montserrat ExtraBold", bold: false, file: "montserrat/800ExtraBold/Montserrat_800ExtraBold.ttf" },
  { id: "bebas", label: "Bebas Neue", css: "Bebas Neue", ass: "Bebas Neue", bold: false, file: "bebas-neue/400Regular/BebasNeue_400Regular.ttf" },
  { id: "anton", label: "Anton", css: "Anton", ass: "Anton", bold: false, file: "anton/400Regular/Anton_400Regular.ttf" },
  { id: "poppins-bold", label: "Poppins Bold", css: "Poppins Bold", ass: "Poppins", bold: true, file: "poppins/700Bold/Poppins_700Bold.ttf" },
  { id: "inter-bold", label: "Inter Bold", css: "Inter Bold", ass: "Inter", bold: true, file: "inter/700Bold/Inter_700Bold.ttf" },
  { id: "inter-medium", label: "Inter Medium", css: "Inter Medium", ass: "Inter Medium", bold: false, file: "inter/500Medium/Inter_500Medium.ttf" },
];

export function fontById(id: string): FontDef {
  return FONTS.find((f) => f.id === id) ?? FONTS[0];
}

export const DEFAULT_CAPTION_STYLE: CaptionStyle = {
  preset: "bold-pop",
  font: "montserrat-black",
  size: 72,
  color: "#ffffff",
  highlightColor: "#ffd60a",
  highlightMode: "color",
  outlineColor: "#000000",
  outline: 5,
  shadow: 2,
  background: false,
  backgroundColor: "#000000",
  backgroundOpacity: 0.6,
  uppercase: true,
  animation: "pop",
  wordsPerLine: 3,
  linesPerPage: 1,
  maxPageDuration: 2.2,
  minWordDuration: 0.08,
  positionY: 0.72,
  autoSafeArea: true,
  timingOffset: 0,
};

// Caption presets inspired by common creator / short-form styles (generic, no branding).
export const CAPTION_PRESETS: { id: string; label: string; description: string; style: Partial<CaptionStyle> }[] = [
  { id: "bold-pop", label: "Bold Pop", description: "Heavy uppercase words, yellow active word with a pop. Classic short-form look.", style: {} },
  {
    id: "clean-box",
    label: "Clean Box",
    description: "Sentence case on a soft dark box. Calm and readable for long-form YouTube.",
    style: { font: "inter-bold", size: 54, uppercase: false, background: true, backgroundOpacity: 0.55, outline: 0, shadow: 0, highlightMode: "none", animation: "fade", wordsPerLine: 7, linesPerPage: 2, maxPageDuration: 4, positionY: 0.86 },
  },
  {
    id: "karaoke",
    label: "Karaoke Sweep",
    description: "Full line visible, spoken words light up as they are said.",
    style: { font: "poppins-bold", size: 64, uppercase: false, highlightColor: "#36f1cd", animation: "karaoke", wordsPerLine: 5, maxPageDuration: 3 },
  },
  {
    id: "word-by-word",
    label: "One Word",
    description: "One huge word at a time. Maximum energy for hooks and fast edits.",
    style: { font: "anton", size: 110, wordsPerLine: 1, maxPageDuration: 0.8, animation: "bounce", highlightColor: "#ffffff", highlightMode: "none", positionY: 0.6 },
  },
  {
    id: "highlight-box",
    label: "Highlight Box",
    description: "Active word sits on a coloured box - podcast-clip style.",
    style: { font: "montserrat-xbold", size: 66, highlightMode: "box", highlightColor: "#7b2ff7", outline: 0, shadow: 3, wordsPerLine: 3 },
  },
  {
    id: "reveal",
    label: "Typewriter Reveal",
    description: "Words appear as they are spoken.",
    style: { font: "bebas", size: 92, uppercase: true, animation: "wordByWord", highlightColor: "#ff4d6d", wordsPerLine: 4, outline: 4 },
  },
];

export const TRANSITIONS: { id: TransitionType; label: string; description: string; defaultDuration: number }[] = [
  { id: "cut", label: "Cut", description: "Hard cut. The default and usually the best choice.", defaultDuration: 0 },
  { id: "crossfade", label: "Crossfade", description: "Blend the two shots. Good for time passing or mood changes.", defaultDuration: 0.5 },
  { id: "fadeBlack", label: "Fade to black", description: "Dip to black. Marks the end of a chapter.", defaultDuration: 0.8 },
  { id: "fadeWhite", label: "Fade to white", description: "Flash to white. Energetic or dreamy reveals.", defaultDuration: 0.5 },
  { id: "swipeLeft", label: "Swipe left", description: "Next shot pushes in from the right.", defaultDuration: 0.4 },
  { id: "swipeRight", label: "Swipe right", description: "Next shot pushes in from the left.", defaultDuration: 0.4 },
  { id: "swipeUp", label: "Swipe up", description: "Next shot slides up - native to vertical video.", defaultDuration: 0.4 },
  { id: "zoom", label: "Zoom", description: "Incoming shot zooms in while fading.", defaultDuration: 0.4 },
  { id: "blur", label: "Blur", description: "Blur through the cut.", defaultDuration: 0.5 },
  { id: "whipPan", label: "Whip pan", description: "Fast motion-blurred slide.", defaultDuration: 0.25 },
  { id: "glitch", label: "Glitch", description: "RGB split and noise burst. Use sparingly.", defaultDuration: 0.3 },
];

export const MOTION_PRESETS: { id: MotionPreset; label: string; description: string }[] = [
  { id: "none", label: "None", description: "Static framing." },
  { id: "slowZoomIn", label: "Slow zoom in", description: "Gradual push-in over the whole clip. Adds tension and focus." },
  { id: "slowZoomOut", label: "Slow zoom out", description: "Gradual pull-out. Reveals context, calms pacing." },
  { id: "punchIn", label: "Punch in", description: "Instant tighter framing - emphasises a key line (jump-cut zoom)." },
  { id: "punchOut", label: "Punch out", description: "Starts tight and snaps back out." },
  { id: "panLeft", label: "Pan left", description: "Slow lateral move." },
  { id: "panRight", label: "Pan right", description: "Slow lateral move." },
  { id: "kenBurns", label: "Ken Burns", description: "Zoom + pan, ideal for photos." },
  { id: "shake", label: "Camera shake", description: "Handheld energy. Use for impact moments only." },
];

export const TEXT_TEMPLATES: { id: TextTemplate; label: string; description: string }[] = [
  { id: "title", label: "Title", description: "Large animated title" },
  { id: "lowerThird", label: "Lower third", description: "Name / role bar" },
  { id: "callout", label: "Callout", description: "Boxed note pointing out a detail" },
  { id: "text", label: "Plain text", description: "Simple text layer" },
  { id: "arrow", label: "Arrow", description: "Animated arrow shape" },
  { id: "highlightBox", label: "Highlight box", description: "Outline box to draw attention" },
  { id: "progressBar", label: "Progress bar", description: "Fills across the clip duration" },
];

export const NEUTRAL_GRADE: ColorGrade = {
  exposure: 0,
  contrast: 0,
  saturation: 1,
  temperature: 0,
  tint: 0,
  highlights: 0,
  shadows: 0,
  lift: { r: 0, g: 0, b: 0 },
  gamma: { r: 0, g: 0, b: 0 },
  gain: { r: 0, g: 0, b: 0 },
  curve: [0, 0.25, 0.5, 0.75, 1],
  lutIntensity: 1,
};

export const COLOR_PRESETS: { id: string; label: string; grade: Partial<ColorGrade> }[] = [
  { id: "natural", label: "Natural fix", grade: { contrast: 0.08, saturation: 1.08 } },
  { id: "warm", label: "Warm & inviting", grade: { temperature: 0.25, saturation: 1.1, contrast: 0.05 } },
  { id: "cool", label: "Cool tech", grade: { temperature: -0.25, tint: -0.05, contrast: 0.1 } },
  { id: "teal-orange", label: "Teal & Orange", grade: { lutId: "teal-orange", lutIntensity: 0.7, contrast: 0.1 } },
  { id: "film", label: "Warm film", grade: { lutId: "warm-film", lutIntensity: 0.8, curve: [0.04, 0.26, 0.5, 0.74, 0.96] } },
  { id: "moody", label: "Moody", grade: { exposure: -0.2, contrast: 0.2, saturation: 0.8, shadows: -0.15, lutId: "cool-night", lutIntensity: 0.5 } },
  { id: "bleach", label: "Bleach bypass", grade: { lutId: "bleach-bypass", lutIntensity: 0.8 } },
  { id: "mono", label: "Black & white", grade: { lutId: "mono", lutIntensity: 1, contrast: 0.15 } },
];

export const BUILTIN_LUTS: { id: string; label: string }[] = [
  { id: "teal-orange", label: "Teal & Orange" },
  { id: "warm-film", label: "Warm Film" },
  { id: "cool-night", label: "Cool Night" },
  { id: "bleach-bypass", label: "Bleach Bypass" },
  { id: "mono", label: "Monochrome" },
];

export const EXPORT_PRESETS: (Omit<ExportSettings, "fileName" | "burnCaptions"> & { label: string; aspect: string; platform: string })[] = [
  { preset: "youtube-1080", label: "YouTube 1080p", platform: "YouTube", aspect: "16:9", width: 1920, height: 1080, fps: 30, videoBitrateKbps: 12000, codec: "h264", audioBitrateKbps: 320, sampleRate: 48000 },
  { preset: "youtube-4k", label: "YouTube 4K", platform: "YouTube", aspect: "16:9", width: 3840, height: 2160, fps: 30, videoBitrateKbps: 45000, codec: "h264", audioBitrateKbps: 320, sampleRate: 48000 },
  { preset: "youtube-720", label: "YouTube 720p (fast)", platform: "YouTube", aspect: "16:9", width: 1280, height: 720, fps: 30, videoBitrateKbps: 6000, codec: "h264", audioBitrateKbps: 192, sampleRate: 48000 },
  { preset: "shorts", label: "YouTube Shorts", platform: "YouTube Shorts", aspect: "9:16", width: 1080, height: 1920, fps: 30, videoBitrateKbps: 12000, codec: "h264", audioBitrateKbps: 256, sampleRate: 48000 },
  { preset: "tiktok", label: "TikTok", platform: "TikTok", aspect: "9:16", width: 1080, height: 1920, fps: 30, videoBitrateKbps: 10000, codec: "h264", audioBitrateKbps: 256, sampleRate: 44100 },
  { preset: "reels", label: "Instagram Reels", platform: "Instagram", aspect: "9:16", width: 1080, height: 1920, fps: 30, videoBitrateKbps: 10000, codec: "h264", audioBitrateKbps: 256, sampleRate: 48000 },
  { preset: "ig-square", label: "Instagram Feed 1:1", platform: "Instagram", aspect: "1:1", width: 1080, height: 1080, fps: 30, videoBitrateKbps: 8000, codec: "h264", audioBitrateKbps: 256, sampleRate: 48000 },
  { preset: "ig-portrait", label: "Instagram Feed 4:5", platform: "Instagram", aspect: "4:5", width: 1080, height: 1350, fps: 30, videoBitrateKbps: 8000, codec: "h264", audioBitrateKbps: 256, sampleRate: 48000 },
];

export const ASPECTS: Record<string, { width: number; height: number }> = {
  "16:9": { width: 1920, height: 1080 },
  "9:16": { width: 1080, height: 1920 },
  "1:1": { width: 1080, height: 1080 },
  "4:5": { width: 1080, height: 1350 },
};

export const SFX_LIBRARY: { id: string; label: string; mood: string; description: string }[] = [
  { id: "whoosh", label: "Whoosh", mood: "transition", description: "Airy swipe for transitions" },
  { id: "whoosh-short", label: "Quick whoosh", mood: "transition", description: "Short swish for text pop-ins" },
  { id: "impact", label: "Deep impact", mood: "emphasis", description: "Controlled low boom under key statements" },
  { id: "riser", label: "Riser", mood: "tension", description: "3s tension build before a reveal" },
  { id: "pop", label: "Pop", mood: "ui", description: "Light pop for captions / callouts" },
  { id: "click", label: "Click", mood: "ui", description: "Mouse-click tick for screen recordings" },
  { id: "ding", label: "Ding", mood: "positive", description: "Bright chime for a tip or success" },
  { id: "ambient-bed", label: "Ambient pad (30s)", mood: "atmospheric", description: "Soft generated drone bed for emotional moments" },
  { id: "pulse-bed", label: "Pulse bed (30s)", mood: "energetic", description: "Generated rhythmic pulse for energetic sections" },
  { id: "tension-bed", label: "Tension bed (30s)", mood: "tension", description: "Low generated tension drone" },
];
