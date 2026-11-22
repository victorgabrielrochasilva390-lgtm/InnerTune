// Camera motion, keyframes and transition envelopes. Two implementations of the same
// math live here: `motionAt` (numbers, used by the browser preview) and `motionExpr`
// (FFmpeg expression strings, used by the renderer) so preview and export match.
import type { Clip, Keyframe, Transition } from "./types";
import { clipDuration } from "./timeline";

export interface MotionState {
  scale: number;
  x: number; // fraction of canvas width
  y: number; // fraction of canvas height
  rotation: number; // degrees
  opacity: number;
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const smooth = (e: number) => e * e * (3 - 2 * e);

function presetAt(c: Clip, local: number, dur: number): MotionState {
  const I = c.motion.intensity;
  const u = dur > 0 ? clamp01(local / dur) : 0;
  const s: MotionState = { scale: 1, x: 0, y: 0, rotation: 0, opacity: 1 };
  switch (c.motion.preset) {
    case "slowZoomIn":
      s.scale = 1 + 0.15 * I * u;
      break;
    case "slowZoomOut":
      s.scale = 1 + 0.15 * I * (1 - u);
      break;
    case "punchIn":
      s.scale = 1 + 0.25 * I;
      break;
    case "punchOut":
      s.scale = 1 + 0.25 * I * (1 - smooth(clamp01(local / 0.35)));
      break;
    case "panLeft":
      s.scale = 1 + 0.12 * I;
      s.x = 0.05 * I * (1 - 2 * u);
      break;
    case "panRight":
      s.scale = 1 + 0.12 * I;
      s.x = -0.05 * I * (1 - 2 * u);
      break;
    case "kenBurns":
      s.scale = 1 + 0.14 * I * u;
      s.x = 0.03 * I * u;
      s.y = -0.02 * I * u;
      break;
    case "shake":
      s.scale = 1 + 0.04 * I;
      s.x = 0.006 * I * Math.sin(local * 43) + 0.004 * I * Math.sin(local * 71);
      s.y = 0.006 * I * Math.sin(local * 37 + 1);
      break;
  }
  return s;
}

function keyframeAt(kfs: Keyframe[], local: number): MotionState {
  const id: MotionState = { scale: 1, x: 0, y: 0, rotation: 0, opacity: 1 };
  if (!kfs.length) return id;
  const k = kfs.slice().sort((a, b) => a.t - b.t);
  if (local <= k[0].t) return pick(k[0]);
  if (local >= k[k.length - 1].t) return pick(k[k.length - 1]);
  for (let i = 0; i < k.length - 1; i++) {
    const a = k[i];
    const b = k[i + 1];
    if (local >= a.t && local <= b.t) {
      let e = (local - a.t) / Math.max(1e-6, b.t - a.t);
      if (b.ease === "easeInOut") e = smooth(e);
      return {
        scale: a.scale + (b.scale - a.scale) * e,
        x: a.x + (b.x - a.x) * e,
        y: a.y + (b.y - a.y) * e,
        rotation: a.rotation + (b.rotation - a.rotation) * e,
        opacity: a.opacity + (b.opacity - a.opacity) * e,
      };
    }
  }
  return id;
}

const pick = (k: Keyframe): MotionState => ({ scale: k.scale, x: k.x, y: k.y, rotation: k.rotation, opacity: k.opacity });

/** Transition-in envelope for the incoming clip. */
export function transitionInAt(tr: Transition | undefined, local: number): MotionState {
  const s: MotionState = { scale: 1, x: 0, y: 0, rotation: 0, opacity: 1 };
  if (!tr || tr.type === "cut" || tr.duration <= 0 || local >= tr.duration) return s;
  const p = smooth(clamp01(local / tr.duration));
  switch (tr.type) {
    case "crossfade":
    case "blur":
    case "glitch":
      s.opacity = p;
      break;
    case "zoom":
      s.opacity = p;
      s.scale = 1 + 0.3 * tr.intensity * (1 - p);
      break;
    case "fadeBlack":
    case "fadeWhite":
      s.opacity = clamp01(local / (tr.duration / 2));
      break;
    case "swipeLeft":
    case "whipPan":
      s.x = 1 - p;
      break;
    case "swipeRight":
      s.x = -(1 - p);
      break;
    case "swipeUp":
      s.y = 1 - p;
      break;
  }
  return s;
}

/** Transition-out envelope (overlay clips, and the outgoing side of dip transitions). */
export function transitionOutAt(tr: Transition | undefined, local: number, dur: number): MotionState {
  const s: MotionState = { scale: 1, x: 0, y: 0, rotation: 0, opacity: 1 };
  if (!tr || tr.type === "cut" || tr.duration <= 0) return s;
  const remain = dur - local;
  if (remain >= tr.duration) return s;
  const p = smooth(clamp01(1 - remain / tr.duration)); // 0 -> 1 towards the end
  switch (tr.type) {
    case "swipeLeft":
    case "whipPan":
      s.x = -p;
      break;
    case "swipeRight":
      s.x = p;
      break;
    case "swipeUp":
      s.y = -p;
      break;
    case "zoom":
      s.scale = 1 + 0.3 * tr.intensity * p;
      s.opacity = 1 - p;
      break;
    default:
      s.opacity = 1 - p;
  }
  return s;
}

/** Does the incoming transition need the previous clip to keep playing under it? */
export function needsOverlap(tr?: Transition): boolean {
  return !!tr && tr.duration > 0 && ["crossfade", "zoom", "blur", "glitch", "swipeLeft", "swipeRight", "swipeUp", "whipPan"].includes(tr.type);
}

function outgoingAt(tr: Transition | undefined, local: number, dur: number) {
  const r = { x: 0, y: 0 };
  if (!tr || local <= dur || tr.duration <= 0) return r;
  const p = smooth(clamp01((local - dur) / tr.duration));
  if (tr.type === "swipeLeft" || tr.type === "whipPan") r.x = -p;
  else if (tr.type === "swipeRight") r.x = p;
  else if (tr.type === "swipeUp") r.y = -p;
  return r;
}

/** Combined motion for a clip at local time (seconds from clip start). */
export function motionAt(c: Clip, local: number, outgoing?: Transition): MotionState {
  const dur = clipDuration(c);
  const p = presetAt(c, local, dur);
  const k = keyframeAt(c.keyframes, local);
  const ti = transitionInAt(c.transitionIn, local);
  const to = transitionOutAt(c.transitionOut, local, dur);
  // dip transitions fade the outgoing clip during the last half of the transition
  let dip = 1;
  if (outgoing && (outgoing.type === "fadeBlack" || outgoing.type === "fadeWhite")) {
    const half = outgoing.duration / 2;
    dip = clamp01((dur - local) / Math.max(1e-6, half));
  }
  // push transitions move the outgoing clip out while it plays its tail under the next clip
  const og = outgoingAt(outgoing, local, dur);
  return {
    scale: c.transform.scale * p.scale * k.scale * ti.scale * to.scale,
    x: c.transform.x + p.x + k.x + ti.x + to.x + og.x,
    y: c.transform.y + p.y + k.y + ti.y + to.y + og.y,
    rotation: c.transform.rotation + k.rotation,
    opacity: clamp01(c.transform.opacity * k.opacity * ti.opacity * to.opacity * dip),
  };
}

// ------------------------------------------------------------ FFmpeg expressions

const num = (v: number) => (Math.abs(v) < 1e-9 ? "0" : Number(v.toFixed(6)).toString());

function clampE(e: string) {
  return `clip(${e},0,1)`;
}
function smoothE(e: string) {
  return `(${e})*(${e})*(3-2*(${e}))`;
}

function presetExpr(c: Clip, L: string, dur: number) {
  const I = c.motion.intensity;
  const u = clampE(`${L}/${num(Math.max(dur, 1e-3))}`);
  const r = { scale: "1", x: "0", y: "0" };
  switch (c.motion.preset) {
    case "slowZoomIn":
      r.scale = `(1+${num(0.15 * I)}*${u})`;
      break;
    case "slowZoomOut":
      r.scale = `(1+${num(0.15 * I)}*(1-${u}))`;
      break;
    case "punchIn":
      r.scale = num(1 + 0.25 * I);
      break;
    case "punchOut":
      r.scale = `(1+${num(0.25 * I)}*(1-${smoothE(clampE(`${L}/0.35`))}))`;
      break;
    case "panLeft":
      r.scale = num(1 + 0.12 * I);
      r.x = `(${num(0.05 * I)}*(1-2*${u}))`;
      break;
    case "panRight":
      r.scale = num(1 + 0.12 * I);
      r.x = `(${num(-0.05 * I)}*(1-2*${u}))`;
      break;
    case "kenBurns":
      r.scale = `(1+${num(0.14 * I)}*${u})`;
      r.x = `(${num(0.03 * I)}*${u})`;
      r.y = `(${num(-0.02 * I)}*${u})`;
      break;
    case "shake":
      r.scale = num(1 + 0.04 * I);
      r.x = `(${num(0.006 * I)}*sin(${L}*43)+${num(0.004 * I)}*sin(${L}*71))`;
      r.y = `(${num(0.006 * I)}*sin(${L}*37+1))`;
      break;
  }
  return r;
}

function keyframeExpr(kfs: Keyframe[], L: string, prop: keyof Omit<Keyframe, "t" | "ease">): string {
  if (!kfs.length) return prop === "scale" || prop === "opacity" ? "1" : "0";
  const k = kfs.slice().sort((a, b) => a.t - b.t);
  let expr = num(k[k.length - 1][prop]);
  for (let i = k.length - 2; i >= 0; i--) {
    const a = k[i];
    const b = k[i + 1];
    let e = clampE(`(${L}-${num(a.t)})/${num(Math.max(1e-6, b.t - a.t))}`);
    if (b.ease === "easeInOut") e = smoothE(e);
    const seg = `(${num(a[prop])}+${num(b[prop] - a[prop])}*${e})`;
    expr = `if(lt(${L},${num(b.t)}),${seg},${expr})`;
  }
  return `if(lt(${L},${num(k[0].t)}),${num(k[0][prop])},${expr})`;
}

function transInExpr(tr: Transition | undefined, L: string) {
  const r = { scale: "1", x: "0", y: "0" };
  if (!tr || tr.duration <= 0) return r;
  const p = smoothE(clampE(`${L}/${num(tr.duration)}`));
  switch (tr.type) {
    case "zoom":
      r.scale = `(1+${num(0.3 * tr.intensity)}*(1-${p}))`;
      break;
    case "swipeLeft":
    case "whipPan":
      r.x = `(1-${p})`;
      break;
    case "swipeRight":
      r.x = `(-(1-${p}))`;
      break;
    case "swipeUp":
      r.y = `(1-${p})`;
      break;
  }
  return r;
}

function transOutExpr(tr: Transition | undefined, L: string, dur: number) {
  const r = { scale: "1", x: "0", y: "0" };
  if (!tr || tr.duration <= 0) return r;
  const p = smoothE(clampE(`1-(${num(dur)}-${L})/${num(tr.duration)}`));
  switch (tr.type) {
    case "swipeLeft":
    case "whipPan":
      r.x = `(-${p})`;
      break;
    case "swipeRight":
      r.x = p;
      break;
    case "swipeUp":
      r.y = `(-${p})`;
      break;
    case "zoom":
      r.scale = `(1+${num(0.3 * tr.intensity)}*${p})`;
      break;
  }
  return r;
}

/**
 * FFmpeg expressions for scale multiplier and x/y offsets (canvas fractions) of a clip,
 * written in terms of the global frame time `t`. Opacity is handled with fade filters.
 */
export function motionExpr(c: Clip, outgoing?: Transition): { scale: string; x: string; y: string; rotation: string; animated: boolean; opacity: string; opacityAnimated: boolean } {
  const L = `(t-${num(c.start)})`;
  const dur = clipDuration(c);
  const p = presetExpr(c, L, dur);
  const ti = transInExpr(c.transitionIn, L);
  const to = transOutExpr(c.transitionOut, L, dur);
  const kS = keyframeExpr(c.keyframes, L, "scale");
  const kX = keyframeExpr(c.keyframes, L, "x");
  const kY = keyframeExpr(c.keyframes, L, "y");
  const kR = keyframeExpr(c.keyframes, L, "rotation");
  const kO = keyframeExpr(c.keyframes, L, "opacity");
  let ogx = "0";
  let ogy = "0";
  if (outgoing && outgoing.duration > 0 && ["swipeLeft", "whipPan", "swipeRight", "swipeUp"].includes(outgoing.type)) {
    const p2 = smoothE(clampE(`(${L}-${num(dur)})/${num(outgoing.duration)}`));
    if (outgoing.type === "swipeRight") ogx = p2;
    else if (outgoing.type === "swipeUp") ogy = `(-${p2})`;
    else ogx = `(-${p2})`;
  }
  const scale = `(${num(c.transform.scale)}*${p.scale}*${kS}*${ti.scale}*${to.scale})`;
  const x = `(${num(c.transform.x)}+${p.x}+${kX}+${ti.x}+${to.x}+${ogx})`;
  const y = `(${num(c.transform.y)}+${p.y}+${kY}+${ti.y}+${to.y}+${ogy})`;
  const rotation = `(${num(c.transform.rotation)}+${kR})`;
  const animated = c.motion.preset !== "none" || c.keyframes.length > 1 || !!c.transitionIn || !!c.transitionOut || ogx !== "0" || ogy !== "0";
  const opacityAnimated = c.keyframes.some((k) => k.opacity !== 1);
  return { scale, x, y, rotation, animated, opacity: kO, opacityAnimated };
}
