import { spawn } from "node:child_process";
import { FFMPEG, FFPROBE } from "./config";

export interface RunOptions {
  signal?: AbortSignal;
  onStderr?: (chunk: string) => void;
  onStdout?: (chunk: Buffer) => void;
  collectStdout?: boolean;
}

export class FfmpegError extends Error {
  constructor(message: string, public stderr: string, public code: number | null) {
    super(message);
  }
}

export function run(bin: string, args: string[], opts: RunOptions = {}): Promise<{ stdout: Buffer; stderr: string }> {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    const out: Buffer[] = [];
    let err = "";
    const onAbort = () => p.kill("SIGKILL");
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    p.stdout.on("data", (d: Buffer) => {
      if (opts.collectStdout !== false) out.push(d);
      opts.onStdout?.(d);
    });
    p.stderr.on("data", (d: Buffer) => {
      const s = d.toString();
      err += s;
      if (err.length > 200_000) err = err.slice(-100_000);
      opts.onStderr?.(s);
    });
    p.on("error", (e) => reject(new FfmpegError(`${bin} could not start: ${e.message}`, err, null)));
    p.on("close", (code) => {
      opts.signal?.removeEventListener("abort", onAbort);
      if (opts.signal?.aborted) return reject(new FfmpegError("cancelled", err, code));
      if (code === 0) resolve({ stdout: Buffer.concat(out), stderr: err });
      else reject(new FfmpegError(`${bin} exited with code ${code}: ${tail(err)}`, err, code));
    });
  });
}

export function tail(s: string, lines = 6): string {
  return s.trim().split("\n").slice(-lines).join("\n");
}

export const ffmpeg = (args: string[], opts?: RunOptions) => run(FFMPEG, ["-hide_banner", "-nostdin", ...args], opts);

export interface Probe {
  duration: number;
  width: number;
  height: number;
  fps: number;
  hasVideo: boolean;
  hasAudio: boolean;
  videoCodec?: string;
  audioCodec?: string;
  isImage: boolean;
  rotation: number;
}

export async function probe(file: string): Promise<Probe> {
  const { stdout } = await run(FFPROBE, ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", file]);
  const j = JSON.parse(stdout.toString());
  const v = j.streams.find((s: any) => s.codec_type === "video");
  const a = j.streams.find((s: any) => s.codec_type === "audio");
  const fmt = String(j.format?.format_name ?? "");
  const isImage = !!v && (/image2|png_pipe|jpeg_pipe|webp_pipe|bmp_pipe|gif|tiff_pipe|svg/.test(fmt) || ["png", "mjpeg", "webp", "bmp", "tiff", "gif"].includes(v.codec_name)) && !(Number(j.format?.duration) > 0.5 && v.codec_name === "gif" && Number(v.nb_frames) > 1) && !a && (!(Number(j.format?.duration) > 0) || /pipe|image2/.test(fmt));
  const rate = String(v?.avg_frame_rate || v?.r_frame_rate || "30/1");
  const [n, d] = rate.split("/").map(Number);
  let rotation = 0;
  const sd = v?.side_data_list?.find((x: any) => x.rotation !== undefined);
  if (sd) rotation = Number(sd.rotation) || 0;
  else if (v?.tags?.rotate) rotation = Number(v.tags.rotate) || 0;
  let width = Number(v?.width ?? 0);
  let height = Number(v?.height ?? 0);
  if (Math.abs(rotation) % 180 === 90) [width, height] = [height, width];
  return {
    duration: isImage ? 0 : Number(j.format?.duration ?? v?.duration ?? a?.duration ?? 0),
    width,
    height,
    fps: d ? Math.round((n / d) * 1000) / 1000 || 30 : 30,
    hasVideo: !!v,
    hasAudio: !!a,
    videoCodec: v?.codec_name,
    audioCodec: a?.codec_name,
    isImage,
    rotation,
  };
}

export async function ffmpegVersion(): Promise<string> {
  try {
    const { stdout } = await run(FFMPEG, ["-version"]);
    return stdout.toString().split("\n")[0];
  } catch {
    return "not found";
  }
}
