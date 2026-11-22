// Media import, probing, proxies, filmstrips and waveforms. Originals are never
// written to: uploads are stored once under data/media and everything else is derived.
import fs from "node:fs";
import path from "node:path";
import type { MediaItem, MediaSourceInfo } from "../shared/types";
import { uid } from "../shared/defaults";
import { DIRS } from "./config";
import { ffmpeg, probe } from "./ffmpeg";
import { Media } from "./db";
import { startJob, type JobCtx } from "./jobs";
import { analyzeMedia } from "./analysis";

const BROWSER_VIDEO = new Set(["h264", "vp8", "vp9", "av1"]);
const BROWSER_AUDIO = new Set(["aac", "mp3", "opus", "vorbis", "flac", "pcm_s16le", "pcm_f32le", "pcm_s24le"]);

export function publicMedia(m: MediaItem) {
  const { path: _p, proxyPath: _x, ...rest } = m;
  return {
    ...rest,
    fileUrl: `/files/media/${m.id}/original`,
    previewUrl: `/files/media/${m.id}/preview`,
    hasProxy: !!m.proxyPath,
  };
}

export async function importFile(file: string, name: string, mode: "copy" | "move" | "link", source: MediaSourceInfo, autoAnalyze = true): Promise<MediaItem> {
  const id = uid("med");
  let stored = file;
  if (mode !== "link") {
    const ext = path.extname(name || file).toLowerCase() || path.extname(file);
    stored = path.join(DIRS.media, `${id}${ext}`);
    if (mode === "move") {
      try {
        fs.renameSync(file, stored);
      } catch {
        fs.copyFileSync(file, stored);
        fs.unlinkSync(file);
      }
    } else fs.copyFileSync(file, stored);
  }
  const info = await probe(stored);
  if (!info.hasVideo && !info.hasAudio) throw new Error("This file has no video or audio stream FFmpeg can read.");
  const kind = info.isImage ? "image" : info.hasVideo ? "video" : "audio";
  const m: MediaItem = {
    id,
    name: name || path.basename(file),
    kind,
    path: stored,
    duration: info.duration,
    width: info.width,
    height: info.height,
    fps: info.fps,
    hasAudio: info.hasAudio,
    hasVideo: info.hasVideo && kind !== "image",
    videoCodec: info.videoCodec,
    audioCodec: info.audioCodec,
    size: fs.statSync(stored).size,
    createdAt: Date.now(),
    source,
    status: "processing",
  };
  Media.put(m);
  processMedia(m.id, autoAnalyze);
  return m;
}

/** Kick off proxy / filmstrip / waveform generation, then analysis. */
export function processMedia(id: string, autoAnalyze = true) {
  return startJob({ type: "proxy", mediaId: id, message: "Preparing media" }, "medium", async (ctx) => {
    let m = Media.get(id)!;
    if (m.kind === "image") {
      await imageThumb(m);
      Media.update(id, { status: "ready" });
      return;
    }
    if (needsProxy(m)) {
      ctx.progress(0.02, "Creating preview proxy");
      await makeProxy(m, ctx);
    }
    m = Media.get(id)!;
    if (m.hasVideo) {
      ctx.progress(0.75, "Generating thumbnails");
      await makeFilmstrip(m, ctx);
    }
    if (m.hasAudio) {
      ctx.progress(0.9, "Drawing waveform");
      await makeWaveform(m, ctx);
    }
    Media.update(id, { status: "ready" });
    if (autoAnalyze) {
      startJob({ type: "analysis", mediaId: id, message: "Analysing" }, "medium", (c) => analyzeMedia(id, c));
    }
  });
}

function needsProxy(m: MediaItem): boolean {
  if (m.hasVideo) return !BROWSER_VIDEO.has(m.videoCodec ?? "") || m.height > 1080 || m.width > 1920 || (m.hasAudio && !BROWSER_AUDIO.has(m.audioCodec ?? ""));
  return m.hasAudio && !BROWSER_AUDIO.has(m.audioCodec ?? "");
}

async function makeProxy(m: MediaItem, ctx: JobCtx) {
  const out = path.join(DIRS.proxies, `${m.id}.${m.hasVideo ? "mp4" : "m4a"}`);
  const args = ["-y", "-i", m.path];
  if (m.hasVideo) args.push("-map", "0:v:0", "-vf", "scale='min(1280,iw)':-2,format=yuv420p", "-c:v", "libx264", "-preset", "veryfast", "-crf", "26", "-g", String(Math.round(m.fps || 30)), "-movflags", "+faststart");
  if (m.hasAudio) args.push("-map", "0:a:0?", "-c:a", "aac", "-b:a", "128k", "-ac", "2");
  args.push("-progress", "pipe:1", "-nostats", out);
  await ffmpeg(args, {
    signal: ctx.signal,
    collectStdout: false,
    onStdout: (d) => {
      const mt = /out_time_us=(\d+)/.exec(d.toString());
      if (mt && m.duration > 0) ctx.progress(Math.min(0.7, (Number(mt[1]) / 1e6 / m.duration) * 0.7), "Creating preview proxy");
    },
  });
  Media.update(m.id, { proxyPath: out });
}

async function makeFilmstrip(m: MediaItem, ctx: JobCtx) {
  const frames = Math.max(8, Math.min(120, Math.round(m.duration / 2)));
  const fw = 160;
  const fh = 90;
  const out = path.join(DIRS.thumbs, `${m.id}-strip.jpg`);
  const src = m.proxyPath ?? m.path;
  const rate = frames / Math.max(0.1, m.duration);
  await ffmpeg(["-y", "-i", src, "-an", "-vf", `fps=${rate.toFixed(6)},scale=${fw}:${fh}:force_original_aspect_ratio=decrease,pad=${fw}:${fh}:(ow-iw)/2:(oh-ih)/2,tile=${frames}x1`, "-frames:v", "1", "-q:v", "5", out], { signal: ctx.signal });
  Media.update(m.id, { filmstrip: { url: `/files/thumbs/${m.id}-strip.jpg`, frames, frameWidth: fw, frameHeight: fh, interval: m.duration / frames } });
  const poster = path.join(DIRS.thumbs, `${m.id}.jpg`);
  await ffmpeg(["-y", "-ss", String(Math.min(1, m.duration / 3)), "-i", src, "-frames:v", "1", "-vf", "scale=320:-2", "-q:v", "4", poster], { signal: ctx.signal }).catch(() => {});
}

async function imageThumb(m: MediaItem) {
  const poster = path.join(DIRS.thumbs, `${m.id}.jpg`);
  await ffmpeg(["-y", "-i", m.path, "-frames:v", "1", "-vf", "scale=320:-2", "-q:v", "4", poster]).catch(() => {});
  Media.update(m.id, { filmstrip: { url: `/files/thumbs/${m.id}.jpg`, frames: 1, frameWidth: 160, frameHeight: 90, interval: 1 } });
}

/** Peaks at 100 values / second, each an unsigned byte (0..255) of max |sample|. */
async function makeWaveform(m: MediaItem, ctx: JobCtx) {
  const out = path.join(DIRS.waveforms, `${m.id}.bin`);
  const perSec = 100;
  const sr = 8000;
  const block = sr / perSec;
  const peaks: number[] = [];
  let carry: Buffer = Buffer.alloc(0);
  let max = 0;
  let n = 0;
  await ffmpeg(["-i", m.path, "-map", "0:a:0", "-ac", "1", "-ar", String(sr), "-f", "s16le", "-"], {
    signal: ctx.signal,
    collectStdout: false,
    onStdout: (chunk) => {
      const buf: Buffer = carry.length ? Buffer.concat([carry, chunk]) : chunk;
      const usable = buf.length - (buf.length % 2);
      for (let i = 0; i < usable; i += 2) {
        const v = Math.abs(buf.readInt16LE(i));
        if (v > max) max = v;
        if (++n >= block) {
          peaks.push(Math.min(255, Math.round((max / 32768) * 255)));
          max = 0;
          n = 0;
        }
      }
      carry = buf.subarray(usable);
    },
  });
  fs.writeFileSync(out, Buffer.from(peaks));
  Media.update(m.id, { waveformUrl: `/files/waveforms/${m.id}.bin` });
}

/** Mark media whose original disappeared (linked files moved / deleted). */
export function checkMissing(m: MediaItem): MediaItem {
  const missing = !fs.existsSync(m.path);
  if (missing !== !!m.missing) return Media.update(m.id, { missing })!;
  return m;
}

/** Point a media item at a new file (relink). Validates the replacement is compatible. */
export async function relink(id: string, file: string, mode: "move" | "link") {
  const m = Media.get(id);
  if (!m) throw new Error("Unknown media");
  const info = await probe(file);
  if (m.duration > 0 && Math.abs(info.duration - m.duration) > Math.max(1, m.duration * 0.02)) {
    throw new Error(`Duration mismatch: original ${m.duration.toFixed(2)}s, new file ${info.duration.toFixed(2)}s. Relinking to a different clip would break your edit.`);
  }
  let stored = file;
  if (mode === "move") {
    stored = path.join(DIRS.media, `${id}-relinked${path.extname(file)}`);
    fs.copyFileSync(file, stored);
    fs.unlinkSync(file);
  }
  const next = Media.update(id, { path: stored, missing: false, size: fs.statSync(stored).size, status: "processing" })!;
  processMedia(id, false);
  return next;
}
