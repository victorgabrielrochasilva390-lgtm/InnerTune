// Built-in, royalty-free assets generated on first start:
//  - fonts (OFL, copied from @expo-google-fonts packages) shared by preview and libass
//  - LUTs (.cube) for cinematic presets, computed mathematically
//  - sound effects and simple music beds synthesised with FFmpeg (no third-party audio)
import fs from "node:fs";
import path from "node:path";
import { DIRS, ROOT } from "./config";
import { FONTS, SFX_LIBRARY } from "../shared/presets";
import { ffmpeg } from "./ffmpeg";
import { Media } from "./db";
import { importFile } from "./media";

export function ensureFonts() {
  const css: string[] = [];
  for (const f of FONTS) {
    const src = path.join(ROOT, "node_modules", "@expo-google-fonts", f.file);
    const dest = path.join(DIRS.fonts, path.basename(f.file));
    if (!fs.existsSync(dest) && fs.existsSync(src)) fs.copyFileSync(src, dest);
    css.push(`@font-face{font-family:"${f.css}";src:url("/fonts/${path.basename(f.file)}") format("truetype");font-display:block;}`);
  }
  fs.writeFileSync(path.join(DIRS.fonts, "fonts.css"), css.join("\n"));
}

type RGBf = [number, number, number];
const clamp = (v: number) => Math.max(0, Math.min(1, v));
const luma = (c: RGBf) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
const mix = (a: RGBf, b: RGBf, t: number): RGBf => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const sat = (c: RGBf, s: number): RGBf => {
  const l = luma(c);
  return [l + (c[0] - l) * s, l + (c[1] - l) * s, l + (c[2] - l) * s];
};
// contrast S-curve: blends towards smoothstep by 2k (k = 0.5 -> full smoothstep)
const scurve = (v: number, k: number) => v + (v * v * (3 - 2 * v) - v) * k * 2;

const LUT_FNS: Record<string, (c: RGBf) => RGBf> = {
  "teal-orange": (c) => {
    const l = luma(c);
    const teal: RGBf = [-0.06, 0.03, 0.08];
    const orange: RGBf = [0.08, 0.02, -0.07];
    const w = l < 0.5 ? (0.5 - l) * 2 : 0;
    const h = l > 0.45 ? Math.min(1, (l - 0.45) * 2) : 0;
    let o: RGBf = [c[0] + teal[0] * w + orange[0] * h, c[1] + teal[1] * w + orange[1] * h, c[2] + teal[2] * w + orange[2] * h];
    o = sat(o, 1.12);
    return o.map((v) => scurve(clamp(v), 0.08)) as RGBf;
  },
  "warm-film": (c) => {
    let o: RGBf = [c[0] * 1.04 + 0.02, c[1] * 1.0 + 0.015, c[2] * 0.92 + 0.03];
    o = sat(o, 0.88);
    return o.map((v) => clamp(0.04 + scurve(clamp(v), 0.1) * 0.93)) as RGBf;
  },
  "cool-night": (c) => {
    let o: RGBf = [c[0] * 0.88, c[1] * 0.97, c[2] * 1.08 + 0.03];
    o = sat(o, 0.75);
    return o.map((v) => clamp(Math.pow(clamp(v), 1.12))) as RGBf;
  },
  "bleach-bypass": (c) => {
    const l = luma(c);
    const g: RGBf = [l, l, l];
    const ov = (a: number, b: number) => (b < 0.5 ? 2 * a * b : 1 - 2 * (1 - a) * (1 - b));
    const o: RGBf = [ov(c[0], l), ov(c[1], l), ov(c[2], l)];
    return mix(o, g, 0.45).map((v) => clamp(v)) as RGBf;
  },
  mono: (c) => {
    const l = clamp(scurve(luma(c), 0.08));
    return [l, l, l];
  },
};

export function lutPath(id: string): string | undefined {
  const builtin = path.join(DIRS.luts, `${id}.cube`);
  if (fs.existsSync(builtin)) return builtin;
  return undefined;
}

export function ensureLuts() {
  const N = 33;
  for (const [id, fn] of Object.entries(LUT_FNS)) {
    const file = path.join(DIRS.luts, `${id}.cube`);
    if (fs.existsSync(file)) continue;
    const lines = [`TITLE "${id}"`, `LUT_3D_SIZE ${N}`];
    for (let b = 0; b < N; b++)
      for (let g = 0; g < N; g++)
        for (let r = 0; r < N; r++) {
          const o = fn([r / (N - 1), g / (N - 1), b / (N - 1)]);
          lines.push(o.map((v) => clamp(v).toFixed(5)).join(" "));
        }
    fs.writeFileSync(file, lines.join("\n") + "\n");
  }
}

const SFX_RECIPES: Record<string, { d: number; graph: string }> = {
  whoosh: { d: 0.9, graph: "anoisesrc=d=0.9:c=pink:a=0.7,bandpass=f=1400:width_type=o:w=2.2,afade=t=in:d=0.45:curve=exp,afade=t=out:st=0.45:d=0.45:curve=exp,apulsator=hz=1.2:amount=0.6,volume=2.2" },
  "whoosh-short": { d: 0.35, graph: "anoisesrc=d=0.35:c=white:a=0.6,bandpass=f=2500:width_type=o:w=2,afade=t=in:d=0.12,afade=t=out:st=0.12:d=0.23,volume=1.8" },
  impact: { d: 1.6, graph: "aevalsrc='0.9*sin(2*PI*(48+40*exp(-8*t))*t)*exp(-2.6*t)+0.25*(random(0)*2-1)*exp(-40*t)':d=1.6:s=48000,lowpass=f=900,volume=1.3" },
  riser: { d: 3, graph: "aevalsrc='0.25*sin(2*PI*(180*t+70*t*t))*(t/3)+0.18*(random(0)*2-1)*(t/3)*(t/3)':d=3:s=48000,highpass=f=120,afade=t=out:st=2.85:d=0.15" },
  pop: { d: 0.15, graph: "aevalsrc='0.7*sin(2*PI*(500+900*exp(-40*t))*t)*exp(-28*t)':d=0.15:s=48000" },
  click: { d: 0.05, graph: "aevalsrc='0.8*sin(2*PI*3200*t)*exp(-260*t)':d=0.05:s=48000" },
  ding: { d: 1.6, graph: "aevalsrc='0.35*(sin(2*PI*1318.5*t)+0.45*sin(2*PI*2637*t)+0.2*sin(2*PI*3955*t))*exp(-3.2*t)':d=1.6:s=48000" },
  "ambient-bed": {
    d: 30,
    graph: "aevalsrc='0.07*(sin(2*PI*110*t)+sin(2*PI*130.81*t)+0.8*sin(2*PI*164.81*t)+0.5*sin(2*PI*220*t)+0.3*sin(2*PI*329.63*t))*(0.75+0.25*sin(2*PI*0.13*t))':d=30:s=48000,lowpass=f=1800,aecho=0.8:0.7:120|260:0.35|0.25,afade=t=in:d=3,afade=t=out:st=27:d=3",
  },
  "pulse-bed": {
    d: 30,
    graph: "aevalsrc='0.45*sin(2*PI*(52+60*exp(-25*mod(t,0.5)))*t)*exp(-9*mod(t,0.5))+0.12*sin(2*PI*110*t)*lt(mod(t,0.25),0.18)+0.05*(random(0)*2-1)*exp(-60*mod(t+0.25,0.5))+0.04*(sin(2*PI*220*t)+sin(2*PI*277.18*t)+sin(2*PI*329.63*t))':d=30:s=48000,lowpass=f=6000,afade=t=in:d=1,afade=t=out:st=28.5:d=1.5",
  },
  "tension-bed": {
    d: 30,
    graph: "aevalsrc='0.22*sin(2*PI*55*t)+0.18*sin(2*PI*58.3*t)+0.06*sin(2*PI*233*t)*(0.5+0.5*sin(2*PI*0.25*t))+0.04*(random(0)*2-1)':d=30:s=48000,lowpass=f=1200,afade=t=in:d=3,afade=t=out:st=27:d=3",
  },
};

/** Generate SFX/music beds once and register them as media items. Returns sfxId -> mediaId. */
export async function ensureSfx(): Promise<Record<string, string>> {
  const indexFile = path.join(DIRS.sfx, "index.json");
  let index: Record<string, string> = {};
  try {
    index = JSON.parse(fs.readFileSync(indexFile, "utf8"));
  } catch {}
  for (const s of SFX_LIBRARY) {
    if (index[s.id] && Media.get(index[s.id])) continue;
    const recipe = SFX_RECIPES[s.id];
    if (!recipe) continue;
    const file = path.join(DIRS.sfx, `${s.id}.wav`);
    try {
      if (!fs.existsSync(file)) await ffmpeg(["-y", "-f", "lavfi", "-i", recipe.graph, "-t", String(recipe.d), "-ac", "2", "-ar", "48000", file]);
      const m = await importFile(file, `${s.label}.wav`, "link", { provider: "generated", license: "Generated by Cutwise (royalty-free)", title: s.label }, false);
      index[s.id] = m.id;
    } catch (e) {
      console.warn(`[assets] could not generate sfx ${s.id}:`, (e as Error).message);
    }
  }
  fs.writeFileSync(indexFile, JSON.stringify(index, null, 1));
  return index;
}
