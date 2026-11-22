import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, "..");
export const DATA_DIR = path.resolve(process.env.CUTWISE_DATA ?? path.join(ROOT, "data"));
export const DIRS = {
  media: path.join(DATA_DIR, "media"), // uploaded originals (never modified)
  proxies: path.join(DATA_DIR, "proxies"),
  thumbs: path.join(DATA_DIR, "thumbs"),
  waveforms: path.join(DATA_DIR, "waveforms"),
  exports: path.join(DATA_DIR, "exports"),
  tmp: path.join(DATA_DIR, "tmp"),
  luts: path.join(DATA_DIR, "luts"),
  sfx: path.join(DATA_DIR, "sfx"),
  fonts: path.join(DATA_DIR, "fonts"),
};
for (const d of [DATA_DIR, ...Object.values(DIRS)]) fs.mkdirSync(d, { recursive: true });

export const PORT = Number(process.env.PORT ?? 8787);
export const FFMPEG = process.env.FFMPEG_PATH ?? "ffmpeg";
export const FFPROBE = process.env.FFPROBE_PATH ?? "ffprobe";
export const CLAUDE_MODEL = process.env.CUTWISE_CLAUDE_MODEL ?? "claude-opus-5-5";
