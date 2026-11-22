// Real signal analysis with FFmpeg: silences, loudness (EBU R128), clipping, noise floor,
// energy envelope, visual scene changes and per-scene exposure / saturation.
import path from "node:path";
import type { MediaAnalysis, Range } from "../shared/types";
import { DIRS } from "./config";
import { ffmpeg } from "./ffmpeg";
import { Media } from "./db";
import type { JobCtx } from "./jobs";

export async function analyzeMedia(id: string, ctx: JobCtx): Promise<MediaAnalysis> {
  const m = Media.get(id);
  if (!m) throw new Error("media not found");
  const a: MediaAnalysis = { analyzedAt: Date.now(), silences: [], scenes: [], energy: [] };
  const tasks: Promise<void>[] = [];
  if (m.hasAudio) {
    tasks.push(
      audioPass(m.path, ctx).then((r) => {
        Object.assign(a, r);
        ctx.progress(0.5, "Audio analysed");
      })
    );
    tasks.push(
      energyPass(m.path, ctx).then((r) => {
        a.energy = r.energy;
        a.noiseFloorDb = r.noiseFloor;
        if (a.clipping) a.clipping.clippedRatio = r.clippedRatio;
        else a.clipping = { peakDb: 0, clippedRatio: r.clippedRatio, likely: r.clippedRatio > 1e-4 };
      })
    );
  }
  if (m.hasVideo) {
    const src = m.proxyPath ?? m.path;
    tasks.push(
      scenePass(src, ctx).then((s) => {
        a.scenes = s;
        ctx.progress(0.7, "Scenes detected");
      })
    );
    tasks.push(
      visualPass(src, ctx).then((v) => {
        a.visual = v;
      })
    );
  }
  await Promise.all(tasks);
  if (a.clipping) a.clipping.likely = a.clipping.peakDb > -0.3 && a.clipping.clippedRatio > 2e-5;
  if (a.visual) a.visual.perScene = perScene(a.visual.perScene, a.scenes);
  if (m.hasVideo) a.keyframes = await keyframes(m.id, m.proxyPath ?? m.path, a.scenes, m.duration, ctx);
  Media.update(id, { analysis: a });
  return a;
}

async function audioPass(file: string, ctx: JobCtx) {
  const { stderr } = await ffmpeg(
    [
      "-i",
      file,
      "-vn",
      "-filter_complex",
      "[0:a:0]asplit=3[a][b][c];[a]silencedetect=n=-38dB:d=0.3[o1];[b]loudnorm=I=-14:TP=-1:LRA=11:print_format=json[o2];[c]astats=measure_perchannel=none:measure_overall=Peak_level+RMS_level[o3]",
      "-map",
      "[o1]",
      "-f",
      "null",
      "-",
      "-map",
      "[o2]",
      "-f",
      "null",
      "-",
      "-map",
      "[o3]",
      "-f",
      "null",
      "-",
    ],
    { signal: ctx.signal }
  );
  const silences: Range[] = [];
  let open: number | null = null;
  for (const line of stderr.split("\n")) {
    const s = /silence_start: (-?[\d.]+)/.exec(line);
    if (s) open = Math.max(0, Number(s[1]));
    const e = /silence_end: ([\d.]+)/.exec(line);
    if (e && open !== null) {
      silences.push({ start: open, end: Number(e[1]) });
      open = null;
    }
  }
  const j = /\{\s*"input_i"[\s\S]*?\}/.exec(stderr);
  let loudness: MediaAnalysis["loudness"];
  if (j) {
    const o = JSON.parse(j[0]);
    loudness = { integrated: Number(o.input_i), truePeak: Number(o.input_tp), lra: Number(o.input_lra), threshold: Number(o.input_thresh) };
    if (!isFinite(loudness.integrated)) loudness = undefined;
  }
  const peak = /Peak level dB:\s*(-?[\d.]+|-inf)/.exec(stderr);
  const peakDb = peak && peak[1] !== "-inf" ? Number(peak[1]) : -90;
  return { silences, loudness, clipping: { peakDb, clippedRatio: 0, likely: false } };
}

/** RMS energy every 0.5s, noise floor (10th percentile of 50ms windows), clipped sample ratio. */
async function energyPass(file: string, ctx: JobCtx) {
  const sr = 16000;
  const win = sr / 20; // 50ms
  const windows: number[] = [];
  let sum = 0;
  let n = 0;
  let clipped = 0;
  let total = 0;
  let carry: Buffer = Buffer.alloc(0);
  await ffmpeg(["-i", file, "-map", "0:a:0", "-ac", "1", "-ar", String(sr), "-f", "s16le", "-"], {
    signal: ctx.signal,
    collectStdout: false,
    onStdout: (chunk) => {
      const buf: Buffer = carry.length ? Buffer.concat([carry, chunk]) : chunk;
      const usable = buf.length - (buf.length % 2);
      for (let i = 0; i < usable; i += 2) {
        const v = buf.readInt16LE(i) / 32768;
        sum += v * v;
        total++;
        if (Math.abs(v) > 0.998) clipped++;
        if (++n >= win) {
          windows.push(sum / n);
          sum = 0;
          n = 0;
        }
      }
      carry = buf.subarray(usable);
    },
  });
  const db = (ms: number) => (ms > 1e-10 ? 10 * Math.log10(ms) : -100);
  const energy: { t: number; rms: number }[] = [];
  for (let i = 0; i < windows.length; i += 10) {
    const slice = windows.slice(i, i + 10);
    energy.push({ t: (i / 20) + 0.25, rms: Math.round(db(slice.reduce((a, b) => a + b, 0) / slice.length) * 10) / 10 });
  }
  const sorted = windows.filter((w) => w > 1e-9).sort((a, b) => a - b);
  const noiseFloor = sorted.length ? db(sorted[Math.floor(sorted.length * 0.1)]) : -100;
  return { energy, noiseFloor: Math.round(noiseFloor * 10) / 10, clippedRatio: total ? clipped / total : 0 };
}

async function scenePass(file: string, ctx: JobCtx): Promise<number[]> {
  const { stderr } = await ffmpeg(["-i", file, "-an", "-vf", "scale=320:-2,select='gt(scene,0.32)',showinfo", "-f", "null", "-"], { signal: ctx.signal });
  const out: number[] = [];
  for (const line of stderr.split("\n")) {
    const mt = /Parsed_showinfo.*pts_time:\s*([\d.]+)/.exec(line);
    if (mt) {
      const t = Number(mt[1]);
      if (!out.length || t - out[out.length - 1] > 0.5) out.push(Math.round(t * 1000) / 1000);
    }
  }
  return out;
}

async function visualPass(file: string, ctx: JobCtx): Promise<NonNullable<MediaAnalysis["visual"]>> {
  const { stderr } = await ffmpeg(
    ["-i", file, "-an", "-vf", "fps=1,scale=160:-2,signalstats,metadata=print:key=lavfi.signalstats.YAVG,metadata=print:key=lavfi.signalstats.SATAVG", "-f", "null", "-"],
    { signal: ctx.signal }
  );
  const pts: { t: number; brightness: number; saturation: number }[] = [];
  let cur: { t: number; brightness: number; saturation: number } | null = null;
  for (const line of stderr.split("\n")) {
    const f = /pts_time:([\d.]+)/.exec(line);
    if (f) {
      const t = Number(f[1]);
      if (!cur || cur.t !== t) {
        cur = { t, brightness: NaN, saturation: NaN };
        pts.push(cur);
      }
    }
    const y = /lavfi\.signalstats\.YAVG=([\d.]+)/.exec(line);
    if (y && cur) cur.brightness = Number(y[1]);
    const s = /lavfi\.signalstats\.SATAVG=([\d.]+)/.exec(line);
    if (s && cur) cur.saturation = Number(s[1]);
  }
  const valid = pts.filter((p) => isFinite(p.brightness) && isFinite(p.saturation));
  const avg = (k: "brightness" | "saturation") => (valid.length ? valid.reduce((a, p) => a + p[k], 0) / valid.length : 0);
  return { brightness: avg("brightness"), saturation: avg("saturation"), perScene: valid };
}

function perScene(samples: { t: number; brightness: number; saturation: number }[], scenes: number[]) {
  const bounds = [0, ...scenes, Infinity];
  const out: { t: number; brightness: number; saturation: number }[] = [];
  for (let i = 0; i < bounds.length - 1; i++) {
    const s = samples.filter((p) => p.t >= bounds[i] && p.t < bounds[i + 1]);
    if (!s.length) continue;
    out.push({ t: bounds[i], brightness: s.reduce((a, p) => a + p.brightness, 0) / s.length, saturation: s.reduce((a, p) => a + p.saturation, 0) / s.length });
  }
  return out;
}

async function keyframes(id: string, file: string, scenes: number[], duration: number, ctx: JobCtx) {
  const times = [Math.min(1, duration / 4), ...scenes.map((s) => s + 0.3)].filter((t) => t < duration);
  // spread evenly if there are too many scene cuts; also fill in long scene-less videos
  let pick = times;
  if (pick.length > 10) pick = Array.from({ length: 10 }, (_, i) => times[Math.floor((i * times.length) / 10)]);
  if (pick.length < 4 && duration > 20) pick = Array.from({ length: 4 }, (_, i) => (duration * (i + 0.5)) / 4);
  const out: { t: number; url: string }[] = [];
  for (const t of pick) {
    const name = `${id}-kf-${Math.round(t * 1000)}.jpg`;
    try {
      await ffmpeg(["-y", "-ss", t.toFixed(3), "-i", file, "-frames:v", "1", "-vf", "scale=512:-2", "-q:v", "4", path.join(DIRS.thumbs, name)], { signal: ctx.signal });
      out.push({ t, url: `/files/thumbs/${name}` });
    } catch {}
  }
  return out;
}
