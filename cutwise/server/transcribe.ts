// Speech recognition with word-level timestamps. Providers:
//  - deepgram       (paid, free trial credit) word timings + punctuation + speaker diarization
//  - openai / groq  (paid / Groq free tier) Whisper with word timestamps
//  - local-whisper  (free, offline) faster-whisper Python package on this machine
// SRT/VTT import is handled separately (no service needed).
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import type { Transcript, Word } from "../shared/types";
import { uid } from "../shared/defaults";
import { DIRS, ROOT } from "./config";
import { ffmpeg, run } from "./ffmpeg";
import { Media } from "./db";
import type { JobCtx } from "./jobs";

export interface ProviderInfo {
  id: string;
  label: string;
  available: boolean;
  free: boolean;
  note: string;
}

let localWhisper: boolean | null = null;
async function hasLocalWhisper(): Promise<boolean> {
  if (localWhisper !== null) return localWhisper;
  try {
    await run(process.env.PYTHON ?? "python3", ["-c", "import faster_whisper"]);
    localWhisper = true;
  } catch {
    localWhisper = false;
  }
  return localWhisper;
}

export async function providers(): Promise<ProviderInfo[]> {
  return [
    { id: "local-whisper", label: "Local Whisper (faster-whisper)", available: await hasLocalWhisper(), free: true, note: "Free and offline. Run `pip install faster-whisper`. The model downloads on first use; set WHISPER_MODEL (default small)." },
    { id: "deepgram", label: "Deepgram Nova-3", available: !!process.env.DEEPGRAM_API_KEY, free: false, note: "Set DEEPGRAM_API_KEY. Word timings, punctuation and speaker diarization. New accounts get free credit." },
    { id: "groq", label: "Groq Whisper large-v3-turbo", available: !!process.env.GROQ_API_KEY, free: true, note: "Set GROQ_API_KEY. Fast, with a free tier. No speaker labels." },
    { id: "openai", label: "OpenAI Whisper", available: !!process.env.OPENAI_API_KEY, free: false, note: "Set OPENAI_API_KEY (and optionally OPENAI_BASE_URL for compatible servers). No speaker labels." },
  ];
}

export async function transcribe(mediaId: string, provider: string, language: string | undefined, ctx: JobCtx): Promise<Transcript> {
  const m = Media.get(mediaId);
  if (!m) throw new Error("media not found");
  if (!m.hasAudio) throw new Error("This media has no audio track to transcribe.");
  ctx.progress(0.03, "Extracting audio");
  let words: Word[];
  if (provider === "deepgram") words = await deepgram(m.path, language, ctx);
  else if (provider === "openai" || provider === "groq") words = await whisperApi(m.path, m.duration, provider, language, ctx);
  else if (provider === "local-whisper") words = await local(m.path, m.duration, language, ctx);
  else throw new Error(`Unknown transcription provider "${provider}"`);
  words = clean(words, m.duration);
  if (!words.length) throw new Error("No speech was recognised in this media.");
  const speakers = [...new Set(words.map((w) => w.speaker).filter(Boolean))] as string[];
  return {
    mediaId,
    language,
    provider,
    words,
    speakers: speakers.length ? Object.fromEntries(speakers.map((s, i) => [s, `Speaker ${i + 1}`])) : undefined,
  };
}

function clean(words: Word[], duration: number): Word[] {
  const out: Word[] = [];
  for (const w of words) {
    const text = w.text.trim();
    if (!text) continue;
    let start = Math.max(0, w.start);
    let end = Math.min(duration || Infinity, Math.max(w.end, start + 0.05));
    const prev = out[out.length - 1];
    if (prev && start < prev.end) start = prev.end;
    if (end <= start) end = start + 0.05;
    out.push({ ...w, text, start, end, id: w.id || uid("w") });
  }
  return out;
}

async function extractAudio(file: string, ctx: JobCtx, opts: { start?: number; duration?: number; format?: "mp3" | "wav" } = {}): Promise<string> {
  const fmt = opts.format ?? "mp3";
  const out = path.join(DIRS.tmp, `${uid("aud")}.${fmt}`);
  const args = ["-y"];
  if (opts.start) args.push("-ss", String(opts.start));
  if (opts.duration) args.push("-t", String(opts.duration));
  args.push("-i", file, "-vn", "-ac", "1", "-ar", "16000");
  if (fmt === "mp3") args.push("-b:a", "48k");
  args.push(out);
  await ffmpeg(args, { signal: ctx.signal });
  return out;
}

async function deepgram(file: string, language: string | undefined, ctx: JobCtx): Promise<Word[]> {
  const key = process.env.DEEPGRAM_API_KEY;
  if (!key) throw new Error("DEEPGRAM_API_KEY is not set on the server.");
  const audio = await extractAudio(file, ctx);
  try {
    ctx.progress(0.2, "Uploading to Deepgram");
    const q = new URLSearchParams({ model: "nova-3", smart_format: "true", punctuate: "true", diarize: "true", filler_words: "true" });
    if (language) q.set("language", language);
    else q.set("detect_language", "true");
    const res = await fetch(`https://api.deepgram.com/v1/listen?${q}`, {
      method: "POST",
      headers: { Authorization: `Token ${key}`, "Content-Type": "audio/mpeg" },
      body: fs.readFileSync(audio),
      signal: ctx.signal,
    });
    if (!res.ok) throw new Error(`Deepgram error ${res.status}: ${(await res.text()).slice(0, 400)}`);
    const j: any = await res.json();
    const ws = j.results?.channels?.[0]?.alternatives?.[0]?.words ?? [];
    return ws.map((w: any) => ({ id: uid("w"), text: w.punctuated_word ?? w.word, start: w.start, end: w.end, confidence: w.confidence, speaker: w.speaker !== undefined ? `S${w.speaker}` : undefined }));
  } finally {
    fs.rmSync(audio, { force: true });
  }
}

/** Whisper (OpenAI-compatible) with word timestamps. Long files are sent in 20-minute chunks. */
async function whisperApi(file: string, duration: number, provider: "openai" | "groq", language: string | undefined, ctx: JobCtx): Promise<Word[]> {
  const key = provider === "groq" ? process.env.GROQ_API_KEY : process.env.OPENAI_API_KEY;
  if (!key) throw new Error(`${provider === "groq" ? "GROQ_API_KEY" : "OPENAI_API_KEY"} is not set on the server.`);
  const base = provider === "groq" ? "https://api.groq.com/openai/v1" : process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1";
  const model = provider === "groq" ? process.env.GROQ_WHISPER_MODEL ?? "whisper-large-v3-turbo" : process.env.OPENAI_WHISPER_MODEL ?? "whisper-1";
  const chunk = 1200;
  const words: Word[] = [];
  const n = Math.max(1, Math.ceil(duration / chunk));
  for (let i = 0; i < n; i++) {
    const offset = i * chunk;
    const audio = await extractAudio(file, ctx, { start: offset, duration: chunk });
    try {
      ctx.progress(0.1 + (0.85 * i) / n, `Transcribing part ${i + 1}/${n}`);
      const form = new FormData();
      form.append("file", new Blob([fs.readFileSync(audio)], { type: "audio/mpeg" }), "audio.mp3");
      form.append("model", model);
      form.append("response_format", "verbose_json");
      form.append("timestamp_granularities[]", "word");
      form.append("timestamp_granularities[]", "segment");
      if (language) form.append("language", language);
      const res = await fetch(`${base}/audio/transcriptions`, { method: "POST", headers: { Authorization: `Bearer ${key}` }, body: form, signal: ctx.signal });
      if (!res.ok) throw new Error(`${provider} transcription error ${res.status}: ${(await res.text()).slice(0, 400)}`);
      const j: any = await res.json();
      const aligned = punctuate(j.words ?? [], j.segments ?? []);
      for (const w of aligned) words.push({ id: uid("w"), text: w.text, start: w.start + offset, end: w.end + offset });
    } finally {
      fs.rmSync(audio, { force: true });
    }
  }
  return words;
}

const normTok = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}']+/gu, "");

/** Whisper word lists have no punctuation; copy punctuation/casing from segment text. */
export function punctuate(words: { word: string; start: number; end: number }[], segments: { text: string; start: number; end: number }[]) {
  const toks = segments.flatMap((s) => s.text.trim().split(/\s+/).filter(Boolean));
  const out: { text: string; start: number; end: number }[] = [];
  let ti = 0;
  for (const w of words) {
    const target = normTok(w.word);
    let text = w.word.trim();
    for (let look = 0; look < 4 && ti + look < toks.length; look++) {
      if (normTok(toks[ti + look]) === target) {
        text = toks[ti + look];
        ti += look + 1;
        break;
      }
    }
    out.push({ text, start: w.start, end: w.end });
  }
  return out;
}

async function local(file: string, duration: number, language: string | undefined, ctx: JobCtx): Promise<Word[]> {
  if (!(await hasLocalWhisper())) throw new Error("faster-whisper is not installed. Run: pip install faster-whisper");
  const audio = await extractAudio(file, ctx, { format: "wav" });
  try {
    ctx.progress(0.08, "Loading Whisper model (first run downloads it)");
    const script = path.join(ROOT, "server", "scripts", "transcribe_local.py");
    const args = [script, audio, process.env.WHISPER_MODEL ?? "small", language ?? ""];
    const json = await new Promise<string>((resolve, reject) => {
      const p = spawn(process.env.PYTHON ?? "python3", args, { stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      let err = "";
      ctx.signal.addEventListener("abort", () => p.kill("SIGKILL"), { once: true });
      p.stdout.on("data", (d) => (out += d));
      p.stderr.on("data", (d) => {
        err += d;
        const mt = /PROGRESS ([\d.]+)/.exec(String(d));
        if (mt && duration) ctx.progress(0.1 + 0.88 * Math.min(1, Number(mt[1]) / duration), "Transcribing locally");
      });
      p.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(`local whisper failed: ${err.slice(-800)}`))));
    });
    const j = JSON.parse(json);
    return j.words.map((w: any) => ({ id: uid("w"), text: w.text, start: w.start, end: w.end, confidence: w.probability }));
  } finally {
    fs.rmSync(audio, { force: true });
  }
}
