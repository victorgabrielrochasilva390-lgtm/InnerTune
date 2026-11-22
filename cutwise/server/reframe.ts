// Smart vertical reframing. Finds where the visual subject is horizontally by measuring
// per-column edge energy and motion on downscaled frames (a saliency estimate: faces,
// people and moving objects produce more detail and motion than flat backgrounds).
// Returns a smoothed horizontal centre per second and per scene. This is not a face
// detector; it does not need a model download, and the user can adjust the result.
import type { MediaItem } from "../shared/types";
import { ffmpeg } from "./ffmpeg";
import type { JobCtx } from "./jobs";

export interface ReframeResult {
  points: { t: number; x: number }[]; // x: subject centre, 0..1 of source width
  scenes: { start: number; end: number; x: number }[];
}

export async function analyzeReframe(m: MediaItem, ctx: JobCtx): Promise<ReframeResult> {
  const W = 96;
  const H = Math.max(2, Math.round((W * m.height) / Math.max(1, m.width) / 2) * 2);
  const frame = W * H;
  const src = m.proxyPath ?? m.path;
  const cols: number[][] = [];
  let carry: Buffer = Buffer.alloc(0);
  let prev: Uint8Array | null = null;
  await ffmpeg(["-i", src, "-an", "-vf", `fps=2,scale=${W}:${H},format=gray`, "-f", "rawvideo", "-"], {
    signal: ctx.signal,
    collectStdout: false,
    onStdout: (chunk) => {
      let buf: Buffer = carry.length ? Buffer.concat([carry, chunk]) : chunk;
      while (buf.length >= frame) {
        const f = new Uint8Array(buf.subarray(0, frame));
        buf = buf.subarray(frame);
        const col = new Array(W).fill(0);
        for (let y = 1; y < H - 1; y++)
          for (let x = 1; x < W - 1; x++) {
            const i = y * W + x;
            const gx = f[i + 1] - f[i - 1];
            const gy = f[i + W] - f[i - W];
            let e = Math.abs(gx) + Math.abs(gy);
            if (prev) e += 2 * Math.abs(f[i] - prev[i]);
            // centre-weighted vertically: subjects rarely sit at the very top/bottom
            const wy = 1 - Math.abs(y / H - 0.45);
            col[x] += e * wy;
          }
        cols.push(col);
        prev = f;
        if (m.duration) ctx.progress(Math.min(0.95, cols.length / 2 / m.duration));
      }
      carry = buf;
    },
  });
  const raw = cols.map((col, i) => {
    const total = col.reduce((a, b) => a + b, 0) || 1;
    // weighted centre of the strongest region (power sharpens the peak)
    let sw = 0;
    let sx = 0;
    for (let x = 0; x < W; x++) {
      const w = Math.pow(col[x] / total, 2);
      sw += w;
      sx += w * x;
    }
    return { t: i / 2, x: sw ? sx / sw / (W - 1) : 0.5 };
  });
  // smooth (moving average over ~3 seconds) so the virtual camera does not jitter
  const points = raw.map((p, i) => {
    const win = raw.slice(Math.max(0, i - 3), i + 4);
    return { t: p.t, x: win.reduce((a, b) => a + b.x, 0) / win.length };
  });
  const scenes = (m.analysis?.scenes ?? []).length ? [0, ...m.analysis!.scenes, m.duration] : [0, m.duration];
  const per = [];
  for (let i = 0; i < scenes.length - 1; i++) {
    const s = points.filter((p) => p.t >= scenes[i] && p.t < scenes[i + 1]).map((p) => p.x).sort((a, b) => a - b);
    per.push({ start: scenes[i], end: scenes[i + 1], x: s.length ? s[Math.floor(s.length / 2)] : 0.5 });
  }
  return { points, scenes: per };
}
