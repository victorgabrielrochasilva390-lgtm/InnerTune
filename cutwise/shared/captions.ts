// Caption page layout + ASS (libass) generation + SRT/VTT import/export.
// The page layout is shared with the browser preview so the burned-in captions
// match exactly what the editor shows.
import type { CaptionStyle, Clip, Project, TextData, Word } from "./types";
import { timelineWords, type TimelineWord, clipDuration } from "./timeline";
import { fontById } from "./presets";
import { uid } from "./defaults";

export interface CapWord {
  text: string;
  start: number; // timeline time
  end: number;
  wordId: string;
  speaker?: string;
}

export interface CaptionPage {
  start: number;
  end: number;
  lines: CapWord[][];
  words: CapWord[];
}

const SENTENCE_END = /[.?!…]["')\]]?$/;

export function displayWord(text: string, style: Pick<CaptionStyle, "uppercase">): string {
  let t = text.trim();
  if (style.uppercase) t = t.replace(/[,.;:]+$/, "").toUpperCase();
  return t;
}

export function layoutCaptionPages(words: TimelineWord[], style: CaptionStyle): CaptionPage[] {
  const pages: CaptionPage[] = [];
  let cur: CapWord[] = [];
  const flush = () => {
    if (!cur.length) return;
    const lines: CapWord[][] = [];
    for (let i = 0; i < cur.length; i += style.wordsPerLine) lines.push(cur.slice(i, i + style.wordsPerLine));
    pages.push({ start: cur[0].start, end: cur[cur.length - 1].end, lines, words: cur });
    cur = [];
  };
  const perPage = Math.max(1, style.wordsPerLine * style.linesPerPage);
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const text = displayWord(w.text, style);
    if (!text) continue;
    const start = w.tStart + style.timingOffset;
    const end = Math.max(w.tEnd + style.timingOffset, start + style.minWordDuration);
    const prev = cur[cur.length - 1];
    if (prev) {
      const gap = start - prev.end;
      const pageDur = end - cur[0].start;
      const speakerChange = w.speaker && prev.speaker && w.speaker !== prev.speaker;
      if (cur.length >= perPage || gap > 0.7 || pageDur > style.maxPageDuration || speakerChange) flush();
    }
    cur.push({ text, start, end, wordId: w.id, speaker: w.speaker });
    if (SENTENCE_END.test(w.text.trim()) && cur.length >= Math.min(2, perPage)) flush();
  }
  flush();
  // extend page end slightly (reading time) without overlapping the next page
  for (let i = 0; i < pages.length; i++) {
    const next = pages[i + 1];
    const ext = pages[i].end + 0.25;
    pages[i].end = next ? Math.min(ext, next.start) : ext;
  }
  return pages;
}

export function captionPages(project: Project): CaptionPage[] {
  if (!project.captions.enabled) return [];
  return layoutCaptionPages(timelineWords(project), project.captions.style);
}

/** Vertical caption position respecting platform safe areas. */
export function captionY(style: CaptionStyle, width: number, height: number): number {
  let y = style.positionY;
  if (style.autoSafeArea) {
    const vertical = height > width;
    // Short-form apps cover the bottom ~20% (caption, buttons) and the top ~12%.
    const min = vertical ? 0.18 : 0.1;
    const max = vertical ? 0.76 : 0.9;
    y = Math.max(min, Math.min(max, y));
  }
  return y;
}

export function scaleRef(width: number, height: number): number {
  return Math.min(width, height) / 1080;
}

// ------------------------------------------------------------------ ASS

function assColor(hex: string, alpha = 0): string {
  const h = hex.replace("#", "").padEnd(6, "0");
  const r = h.slice(0, 2);
  const g = h.slice(2, 4);
  const b = h.slice(4, 6);
  const a = Math.round(Math.max(0, Math.min(1, alpha)) * 255)
    .toString(16)
    .padStart(2, "0");
  return `&H${a}${b}${g}${r}`.toUpperCase();
}

function assTime(t: number): string {
  t = Math.max(0, t);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = Math.floor(t % 60);
  const cs = Math.floor((t - Math.floor(t)) * 100 + 1e-6);
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
}

function esc(s: string): string {
  return s.replace(/\\/g, "∖").replace(/\{/g, "(").replace(/\}/g, ")").replace(/\n/g, "\\N");
}

interface AssStyleLine {
  name: string;
  font: string;
  size: number;
  primary: string;
  outlineColor: string;
  back: string;
  bold: boolean;
  borderStyle: 1 | 3;
  outline: number;
  shadow: number;
}

function styleLine(s: AssStyleLine): string {
  return `Style: ${s.name},${s.font},${Math.round(s.size)},${s.primary},${s.primary},${s.outlineColor},${s.back},${s.bold ? -1 : 0},0,0,0,100,100,0,0,${s.borderStyle},${s.outline},${s.shadow},5,0,0,0,1`;
}

export function buildAss(project: Project, opts: { includeCaptions: boolean; range?: { start: number; end: number } }): string {
  const { width: W, height: H } = project.settings;
  const k = scaleRef(W, H);
  const cs = project.captions.style;
  const font = fontById(cs.font);
  const styles: AssStyleLine[] = [
    {
      name: "Cap",
      font: font.ass,
      size: cs.size * k,
      primary: assColor(cs.color),
      outlineColor: cs.background ? assColor(cs.backgroundColor, 1 - cs.backgroundOpacity) : assColor(cs.outlineColor),
      back: assColor("#000000", 0.5),
      bold: font.bold,
      borderStyle: cs.background ? 3 : 1,
      outline: cs.background ? Math.round(cs.size * k * 0.22) : cs.outline * k,
      shadow: cs.shadow * k,
    },
    {
      name: "CapBox",
      font: font.ass,
      size: cs.size * k,
      primary: assColor(cs.color),
      outlineColor: assColor(cs.highlightColor),
      back: assColor("#000000", 1),
      bold: font.bold,
      borderStyle: 3,
      outline: Math.round(cs.size * k * 0.14),
      shadow: 0,
    },
  ];
  const events: string[] = [];
  const offset = opts.range?.start ?? 0;
  const inRange = (s: number, e: number) => !opts.range || (e > opts.range.start && s < opts.range.end);
  const ev = (layer: number, s: number, e: number, style: string, text: string) => {
    if (!inRange(s, e) || e - s < 0.005) return;
    events.push(`Dialogue: ${layer},${assTime(s - offset)},${assTime(e - offset)},${style},,0,0,0,,${text}`);
  };

  // --- text overlays (titles, lower thirds, shapes) from text tracks
  const hidden = new Set(project.tracks.filter((t) => t.hidden).map((t) => t.id));
  const textTracks = project.tracks.filter((t) => t.kind === "text");
  textTracks.forEach((track, ti) => {
    const layer = 10 + (textTracks.length - ti) * 3;
    for (const c of project.clips.filter((c) => c.trackId === track.id && c.kind === "text" && c.text)) {
      if (hidden.has(c.trackId)) continue;
      textClipEvents(c, W, H, k, styles, (l, s, e, st, txt) => ev(layer + l, s, e, st, txt));
    }
  });

  // --- captions
  if (opts.includeCaptions && project.captions.enabled) {
    const pages = captionPages(project);
    const cx = Math.round(W / 2);
    const cy = Math.round(captionY(cs, W, H) * H);
    const hl = assColor(cs.highlightColor);
    const base = assColor(cs.color);
    for (const page of pages) {
      const flat = page.words;
      const perWord = cs.animation !== "none" && cs.animation !== "fade" ? true : cs.highlightMode !== "none";
      const slices = perWord ? flat.map((w, i) => ({ i, s: i === 0 ? page.start : w.start, e: i === flat.length - 1 ? page.end : flat[i + 1].start })) : [{ i: -1, s: page.start, e: page.end }];
      for (const sl of slices) {
        const isFirst = sl.i <= 0;
        const isLast = sl.i === flat.length - 1 || sl.i === -1;
        let head = `{\\an5\\pos(${cx},${cy})`;
        if (cs.animation === "fade") head += `\\fad(${isFirst ? 120 : 0},${isLast ? 100 : 0})`;
        if (cs.animation === "bounce" && isFirst) head += `\\fscx80\\fscy80\\t(0,90,\\fscx112\\fscy112)\\t(90,170,\\fscx100\\fscy100)`;
        head += "}";
        let idx = 0;
        const lineTexts = page.lines.map((line) =>
          line
            .map((w) => {
              const j = idx++;
              const active = j === sl.i;
              let tags = "";
              if (cs.animation === "wordByWord" && sl.i >= 0 && j > sl.i) tags += "\\alpha&HFF&";
              if (cs.animation === "karaoke" && sl.i >= 0) tags += `\\c${j <= sl.i ? hl : base}`;
              else if (active && cs.highlightMode === "color") tags += `\\c${hl}`;
              if (active && (cs.animation === "pop" || cs.animation === "wordByWord")) tags += `\\fscx125\\fscy125\\t(0,110,\\fscx106\\fscy106)`;
              const reset = tags ? `{\\alpha&H00&\\c${base}\\fscx100\\fscy100}` : "";
              return tags ? `{${tags}}${esc(w.text)}${reset}` : esc(w.text);
            })
            .join(" ")
        );
        ev(1, sl.s, sl.e, "Cap", head + lineTexts.join("\\N"));
        if (cs.highlightMode === "box" && sl.i >= 0) {
          // A second layer underneath where only the active word is visible draws its box.
          let j2 = 0;
          const boxText = page.lines
            .map((line) =>
              line
                .map((w) => {
                  const j = j2++;
                  return j === sl.i ? `{\\alpha&H00&\\1a&HFF&}${esc(w.text)}` : `{\\alpha&HFF&}${esc(w.text)}`;
                })
                .join(" ")
            )
            .join("\\N");
          ev(0, sl.s, sl.e, "CapBox", `{\\an5\\pos(${cx},${cy})}` + boxText);
        }
      }
    }
  }

  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: ${W}
PlayResY: ${H}
WrapStyle: 2
ScaledBorderAndShadow: yes
YCbCr Matrix: TV.709

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
${styles.map(styleLine).join("\n")}

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;
  return header + events.join("\n") + "\n";
}

function animTags(d: TextData, x: number, y: number, W: number, dur: number): { pos: string; extra: string } {
  const inMs = 300;
  let pos = `\\pos(${x},${y})`;
  let extra = "";
  const fadeIn = d.animIn === "none" ? 0 : 220;
  const fadeOut = d.animOut === "none" ? 0 : 220;
  if (fadeIn || fadeOut) extra += `\\fad(${fadeIn},${Math.min(fadeOut, Math.max(0, dur * 1000 - fadeIn))})`;
  if (d.animIn === "pop") extra += `\\fscx40\\fscy40\\t(0,180,\\fscx108\\fscy108)\\t(180,${inMs},\\fscx100\\fscy100)`;
  if (d.animIn === "slideUp") pos = `\\move(${x},${y + Math.round(W * 0.03)},${x},${y},0,${inMs})`;
  if (d.animIn === "slideLeft") pos = `\\move(${x - Math.round(W * 0.08)},${y},${x},${y},0,${inMs})`;
  return { pos, extra };
}

function textClipEvents(
  c: Clip,
  W: number,
  H: number,
  k: number,
  styles: AssStyleLine[],
  ev: (layer: number, s: number, e: number, style: string, text: string) => void
) {
  const d = c.text!;
  const st = d.style;
  const f = fontById(st.font);
  const name = `T_${c.id.replace(/[^a-z0-9]/gi, "")}`;
  const nameSub = name + "s";
  const dur = clipDuration(c);
  const s = c.start;
  const e = c.start + dur;
  const x = Math.round(d.x * W);
  const y = Math.round(d.y * H);
  const size = st.size * k;
  const txt = st.uppercase ? d.text.toUpperCase() : d.text;
  const boxed = st.background || d.template === "lowerThird" || d.template === "callout";
  styles.push({
    name,
    font: f.ass,
    size,
    primary: assColor(st.color),
    outlineColor: boxed ? assColor(st.accent) : assColor("#000000"),
    back: assColor("#000000", 0.5),
    bold: f.bold,
    borderStyle: boxed ? 3 : 1,
    outline: boxed ? Math.round(size * 0.3) : st.outline * k,
    shadow: st.shadow * k,
  });
  const { pos, extra } = animTags(d, x, y, W, dur);
  const rot = d.rotation ? `\\frz${-d.rotation}` : "";
  const sw = Math.max(2, Math.round(d.w * W));
  const sh = Math.max(2, Math.round(d.h * H));
  switch (d.template) {
    case "arrow": {
      const p = `m 0 ${sh / 3} l ${sw * 0.62} ${sh / 3} l ${sw * 0.62} 0 l ${sw} ${sh / 2} l ${sw * 0.62} ${sh} l ${sw * 0.62} ${(2 * sh) / 3} l 0 ${(2 * sh) / 3}`;
      ev(0, s, e, name, `{\\an5${pos}${extra}${rot}\\bord0\\shad${st.shadow * k}\\1c${assColor(st.accent)}\\p1}${p}{\\p0}`);
      return;
    }
    case "highlightBox": {
      const p = `m 0 0 l ${sw} 0 l ${sw} ${sh} l 0 ${sh}`;
      ev(0, s, e, name, `{\\an5${pos}${extra}${rot}\\1a&HFF&\\bord${Math.max(1, st.outline * k)}\\shad0\\3c${assColor(st.accent)}\\p1}${p}{\\p0}`);
      return;
    }
    case "progressBar": {
      const left = Math.round(x - sw / 2);
      const top = Math.round(y - sh / 2);
      const p = `m 0 0 l ${sw} 0 l ${sw} ${sh} l 0 ${sh}`;
      ev(0, s, e, name, `{\\an7\\pos(${left},${top})\\bord0\\shad0\\1c&HFFFFFF&\\1a&HB0&\\p1}${p}{\\p0}`);
      ev(1, s, e, name, `{\\an7\\pos(${left},${top})\\bord0\\shad0\\1c${assColor(st.accent)}\\fscx0\\t(0,${Math.round(dur * 1000)},\\fscx100)\\p1}${p}{\\p0}`);
      return;
    }
    case "lowerThird": {
      ev(1, s, e, name, `{\\an4${pos}${extra}${rot}}${esc(txt)}`);
      if (d.subtitle) {
        styles.push({ name: nameSub, font: fontById("inter-medium").ass, size: size * 0.6, primary: assColor("#ffffff"), outlineColor: assColor("#111111", 0.15), back: assColor("#000000", 1), bold: false, borderStyle: 3, outline: Math.round(size * 0.22), shadow: 0 });
        const y2 = y + Math.round(size * 1.15);
        const sub = animTags(d, x, y2, W, dur);
        ev(0, s, e, nameSub, `{\\an4${sub.pos}${sub.extra}}${esc(d.subtitle)}`);
      }
      return;
    }
    default:
      ev(0, s, e, name, `{\\an5${pos}${extra}${rot}}${esc(txt)}`);
  }
}

// ------------------------------------------------------------------ SRT / VTT

function srtTime(t: number, sep = ","): string {
  t = Math.max(0, t);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = Math.floor(t % 60);
  const ms = Math.round((t - Math.floor(t)) * 1000);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}${sep}${String(Math.min(999, ms)).padStart(3, "0")}`;
}

export function toSrt(pages: CaptionPage[]): string {
  return pages.map((p, i) => `${i + 1}\n${srtTime(p.start)} --> ${srtTime(p.end)}\n${p.lines.map((l) => l.map((w) => w.text).join(" ")).join("\n")}\n`).join("\n");
}

export function toVtt(pages: CaptionPage[]): string {
  return "WEBVTT\n\n" + pages.map((p) => `${srtTime(p.start, ".")} --> ${srtTime(p.end, ".")}\n${p.lines.map((l) => l.map((w) => w.text).join(" ")).join("\n")}\n`).join("\n");
}

function parseTs(s: string): number {
  const m = s.trim().match(/(?:(\d+):)?(\d+):(\d+)[,.](\d+)/);
  if (!m) return NaN;
  return (Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4].padEnd(3, "0").slice(0, 3)) / 1000);
}

/**
 * Parse SRT or WebVTT into words. Cue timing is distributed over words proportionally
 * to their length (marked approximate) because these formats carry no word timing.
 */
export function parseSubtitles(text: string): Word[] {
  const words: Word[] = [];
  const blocks = text.replace(/\r/g, "").split(/\n\n+/);
  for (const b of blocks) {
    const lines = b.split("\n").filter(Boolean);
    const ti = lines.findIndex((l) => l.includes("-->"));
    if (ti < 0) continue;
    const [a, z] = lines[ti].split("-->");
    const start = parseTs(a);
    const end = parseTs(z);
    if (!isFinite(start) || !isFinite(end) || end <= start) continue;
    let speaker: string | undefined;
    const body = lines
      .slice(ti + 1)
      .join(" ")
      .replace(/<v\s+([^>]+)>/g, (_m, sp) => {
        speaker = String(sp).trim();
        return "";
      })
      .replace(/<[^>]+>/g, "")
      .trim();
    const toks = body.split(/\s+/).filter(Boolean);
    const total = toks.reduce((n, t) => n + t.length + 1, 0);
    let cur = start;
    for (const t of toks) {
      const d = ((t.length + 1) / total) * (end - start);
      words.push({ id: uid("w"), text: t, start: cur, end: cur + d * 0.92, speaker });
      cur += d;
    }
  }
  return words;
}

/** Group words into sentences (used by AI analysis and the transcript editor). */
export interface Sentence {
  words: Word[];
  text: string;
  start: number;
  end: number;
  index: number;
}

export function sentences(words: Word[]): Sentence[] {
  const out: Sentence[] = [];
  let cur: Word[] = [];
  const push = () => {
    if (!cur.length) return;
    out.push({ words: cur, text: cur.map((w) => w.text).join(" "), start: cur[0].start, end: cur[cur.length - 1].end, index: out.length });
    cur = [];
  };
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const prev = cur[cur.length - 1];
    if (prev && w.start - prev.end > 1.2) push();
    cur.push(w);
    if (SENTENCE_END.test(w.text) || cur.length > 40) push();
  }
  push();
  return out;
}
