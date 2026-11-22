// Real-time preview compositor. Draws the same layer model the FFmpeg renderer uses:
// video/image layers (with motion, transitions, grading), adjustment layers, text layers
// and word-level captions; plays audio through the Web Audio mixer.
import type { Clip, MediaItem, Project, Transition } from "../../shared/types";
import { clipDuration, clipEnd, timelineWords, EPS } from "../../shared/timeline";
import { motionAt, needsOverlap } from "../../shared/motion";
import { type CaptionPage } from "../../shared/captions";
import { Grader, isNeutral } from "./grade";
import { drawCaptions, drawTextClip } from "./text";
import { audioEngine } from "./audio";
import type { PubMedia } from "../api";

type M = PubMedia | MediaItem;

interface Slot {
  el: HTMLVideoElement | HTMLAudioElement;
  clipId: string | null;
  mediaId: string;
}

export interface DrawOptions {
  compare: "off" | "original" | "split";
  pages: CaptionPage[];
  captionsOn: boolean;
}

export class Compositor {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  grader = new Grader();
  slots = new Map<string, Slot>();
  images = new Map<string, HTMLImageElement>();
  scratch = document.createElement("canvas");
  requestDraw: () => void = () => {};

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d", { alpha: false })!;
    this.grader.onChange = () => this.requestDraw();
  }

  destroy() {
    for (const s of this.slots.values()) {
      s.el.pause();
      s.el.removeAttribute("src");
      s.el.load();
    }
    this.slots.clear();
  }

  private slotKey(trackId: string, mediaId: string, parity: number) {
    return `${trackId}:${mediaId}:${parity}`;
  }

  private slotFor(trackId: string, m: M, parity: number): Slot {
    const key = this.slotKey(trackId, m.id, parity);
    let s = this.slots.get(key);
    if (!s) {
      const el = m.kind === "video" ? document.createElement("video") : document.createElement("audio");
      el.preload = "auto";
      el.src = (m as PubMedia).previewUrl ?? `/files/media/${m.id}/preview`;
      if (el instanceof HTMLVideoElement) el.playsInline = true;
      el.addEventListener("seeked", () => this.requestDraw());
      el.addEventListener("loadeddata", () => this.requestDraw());
      s = { el, clipId: null, mediaId: m.id };
      this.slots.set(key, s);
    }
    return s;
  }

  private image(m: M): HTMLImageElement {
    let img = this.images.get(m.id);
    if (!img) {
      img = new Image();
      img.src = (m as PubMedia).fileUrl ?? `/files/media/${m.id}/original`;
      img.onload = () => this.requestDraw();
      this.images.set(m.id, img);
    }
    return img;
  }

  /** Clips per track with their outgoing transition (next adjacent clip's transitionIn). */
  private layout(p: Project) {
    const out: { clip: Clip; parity: number; outgoing?: Transition; tail: number }[] = [];
    for (const tr of p.tracks) {
      const cs = p.clips.filter((c) => c.trackId === tr.id && c.kind === "media").sort((a, b) => a.start - b.start);
      cs.forEach((c, i) => {
        const next = cs[i + 1];
        const outgoing = next && Math.abs(next.start - clipEnd(c)) < 0.02 ? next.transitionIn : undefined;
        out.push({ clip: c, parity: i % 2, outgoing, tail: needsOverlap(outgoing) ? outgoing!.duration : 0 });
      });
    }
    return out;
  }

  /** Keep media elements in sync with the playhead; returns whether any voice is speaking. */
  sync(p: Project, media: Record<string, M>, t: number, playing: boolean): boolean {
    const used = new Set<Slot>();
    const fps = p.settings.fps;
    const tracks = new Map(p.tracks.map((x) => [x.id, x]));
    let voiceActive = false;
    let clipVoice = false;
    const items = this.layout(p);
    for (const it of items) {
      const c = it.clip;
      const m = c.mediaId ? media[c.mediaId] : undefined;
      if (!m || m.kind === "image" || m.missing) continue;
      const tr = tracks.get(c.trackId)!;
      const end = clipEnd(c) + it.tail;
      const active = t >= c.start - EPS && t < end;
      const upcoming = !active && c.start > t && c.start - t < 1.5;
      if (!active && !upcoming) continue;
      const s = this.slotFor(c.trackId, m, it.parity);
      if (used.has(s)) continue;
      used.add(s);
      const el = s.el;
      if (active) {
        const expected = Math.min(c.in + (t - c.start) * c.speed, m.duration - 0.02);
        if (s.clipId !== c.id) {
          s.clipId = c.id;
          el.currentTime = expected;
        }
        el.playbackRate = c.speed;
        const atEnd = c.in + (t - c.start) * c.speed >= m.duration - 0.03;
        if (playing && !atEnd) {
          if (el.paused) {
            el.currentTime = expected;
            el.play().catch(() => {});
          } else if (Math.abs(el.currentTime - expected) > 0.3) el.currentTime = expected;
        } else {
          if (!el.paused) el.pause();
          if (Math.abs(el.currentTime - expected) > 0.5 / fps) el.currentTime = expected;
        }
        // audio
        if (m.hasAudio) {
          const g = audioEngine.connect(el, tr);
          const local = t - c.start;
          const dur = clipDuration(c);
          let env = 1;
          const fin = Math.max(0.012, c.fadeIn, c.transitionIn && needsOverlap(c.transitionIn) ? c.transitionIn.duration : 0);
          const fout = Math.max(0.012, c.fadeOut, it.tail);
          const total = dur + it.tail;
          if (local < fin) env = Math.min(env, local / fin);
          if (total - local < fout) env = Math.min(env, (total - local) / fout);
          const v = playing ? c.volume * Math.max(0, env) : 0;
          if (audioEngine.ctx) g.gain.setTargetAtTime(v, audioEngine.ctx.currentTime, 0.01);
          if (tr.role === "voice" && c.volume > 0.05 && !tr.muted) clipVoice = true;
        }
      } else if (upcoming && s.clipId !== c.id && !items.some((o) => o.clip.id === s.clipId && t < clipEnd(o.clip) + o.tail && t >= o.clip.start)) {
        // pre-roll: seek the next clip's element so the cut plays without a stall
        s.clipId = c.id;
        el.pause();
        el.currentTime = c.in;
      }
    }
    for (const s of this.slots.values()) if (!used.has(s) && !s.el.paused) s.el.pause();
    // voice activity for ducking: words being spoken right now
    const words = timelineWords(p);
    if (words.length) voiceActive = words.some((w) => t >= w.tStart - 0.15 && t <= w.tEnd + 0.25);
    else voiceActive = clipVoice; // no transcript: duck whenever a voice clip plays
    audioEngine.update(p, voiceActive);
    return voiceActive;
  }

  draw(p: Project, media: Record<string, M>, t: number, opt: DrawOptions) {
    const { ctx, canvas } = this;
    const W = canvas.width;
    const H = canvas.height;
    ctx.save();
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
    ctx.filter = "none";
    ctx.fillStyle = p.settings.background;
    ctx.fillRect(0, 0, W, H);
    const items = this.layout(p);
    const byTrack = new Map<string, typeof items>();
    for (const it of items) {
      if (!byTrack.has(it.clip.trackId)) byTrack.set(it.clip.trackId, []);
      byTrack.get(it.clip.trackId)!.push(it);
    }
    const videoTracks = p.tracks.filter((x) => x.kind === "video").reverse();
    const post: { type: Transition["type"]; p: number; intensity: number }[] = [];
    for (const tr of videoTracks) {
      if (tr.hidden) continue;
      for (const it of byTrack.get(tr.id) ?? []) {
        const c = it.clip;
        const end = clipEnd(c) + it.tail;
        if (t < c.start - EPS || t >= end) continue;
        const m = c.mediaId ? media[c.mediaId] : undefined;
        if (!m || (!m.hasVideo && m.kind !== "image")) continue;
        let src: CanvasImageSource | null = null;
        let sw = m.width;
        let sh = m.height;
        if (m.kind === "image") {
          const img = this.image(m);
          if (img.complete && img.naturalWidth) {
            src = img;
            sw = img.naturalWidth;
            sh = img.naturalHeight;
          }
        } else {
          const s = this.slots.get(this.slotKey(c.trackId, m.id, it.parity));
          if (s && s.clipId === c.id && s.el instanceof HTMLVideoElement && s.el.readyState >= 2) {
            src = s.el;
            sw = s.el.videoWidth || sw;
            sh = s.el.videoHeight || sh;
          }
        }
        if (!src) continue;
        this.drawLayer(c, src, sw, sh, t - c.start, it.outgoing, opt.compare, t);
        const tin = c.transitionIn;
        if (tin && tin.duration > 0 && t - c.start < tin.duration && ["blur", "whipPan", "glitch", "fadeWhite"].includes(tin.type)) post.push({ type: tin.type, p: (t - c.start) / tin.duration, intensity: tin.intensity });
      }
      // adjustment layers on this track grade everything drawn so far
      for (const c of p.clips.filter((c) => c.trackId === tr.id && c.kind === "adjustment")) {
        if (t < c.start || t >= clipEnd(c) || opt.compare === "original") continue;
        if (isNeutral(c.color, c.fx) && c.fx.blur < 0.05) continue;
        const graded = this.grader.apply(canvas, W, H, c.color, c.fx, t);
        if (graded) {
          ctx.globalAlpha = c.transform.opacity;
          if (c.fx.blur > 0.05) ctx.filter = `blur(${(c.fx.blur * H) / 1080 / 2}px)`;
          ctx.drawImage(graded, 0, 0, W, H);
          ctx.filter = "none";
          ctx.globalAlpha = 1;
        }
      }
    }
    for (const fx of post) this.postEffect(fx.type, fx.p, fx.intensity);
    this.whiteFlash(p, t);
    // text tracks: lower in the list first, so higher tracks draw on top
    const textTracks = p.tracks.filter((x) => x.kind === "text" && !x.hidden).reverse();
    for (const tr of textTracks) for (const c of p.clips) if (c.trackId === tr.id && c.kind === "text" && t >= c.start && t < clipEnd(c)) drawTextClip(ctx, c, t - c.start, W, H);
    if (opt.captionsOn) drawCaptions(ctx, opt.pages, t, p.captions.style, W, H);
    ctx.restore();
  }

  private drawLayer(c: Clip, src: CanvasImageSource, sw: number, sh: number, local: number, outgoing: Transition | undefined, compare: DrawOptions["compare"], t: number) {
    const { ctx, canvas } = this;
    const W = canvas.width;
    const H = canvas.height;
    const mo = motionAt(c, local, outgoing);
    if (mo.opacity <= 0.001) return;
    const fit = Math.min(W / sw, H / sh);
    const fill = Math.max(W / sw, H / sh);
    const s = c.transform.fit === "fill" ? fill : fit;
    const bw = sw * s * mo.scale;
    const bh = sh * s * mo.scale;
    ctx.save();
    ctx.globalAlpha = mo.opacity;
    if (c.transform.fit === "blurFill") {
      ctx.filter = `blur(${(30 * H) / 1080}px) brightness(0.94) saturate(0.9)`;
      const cw = sw * fill;
      const ch = sh * fill;
      ctx.drawImage(src, (W - cw) / 2, (H - ch) / 2, cw, ch);
      ctx.filter = "none";
    }
    const neutral = isNeutral(c.color, c.fx) || compare === "original";
    let img: CanvasImageSource = src;
    if (!neutral) {
      const gw = Math.max(2, Math.min(Math.round(bw), Math.round(W * 1.5), sw));
      const gh = Math.max(2, Math.round((gw * sh) / sw));
      const g = this.grader.apply(src as TexImageSource, gw, gh, c.color, c.fx, t);
      if (g) img = g;
    }
    ctx.translate(W / 2 + mo.x * W, H / 2 + mo.y * H);
    if (mo.rotation) ctx.rotate((mo.rotation * Math.PI) / 180);
    const blur = compare === "original" ? 0 : c.fx.blur;
    if (blur > 0.05) ctx.filter = `blur(${(blur * H) / 1080 / 2}px)`;
    if (img !== src && compare === "split") {
      // before / after split: graded on the right half of the frame
      ctx.drawImage(src, -bw / 2, -bh / 2, bw, bh);
      ctx.save();
      ctx.beginPath();
      ctx.rect(W / 2 - (W / 2 + mo.x * W), -H, W, H * 3);
      ctx.clip();
      ctx.drawImage(img, -bw / 2, -bh / 2, bw, bh);
      ctx.restore();
    } else ctx.drawImage(img, -bw / 2, -bh / 2, bw, bh);
    if (c.fx.glow > 0.01 && compare !== "original") {
      ctx.filter = `blur(${(18 * H) / 1080}px)`;
      ctx.globalCompositeOperation = "screen";
      ctx.globalAlpha = mo.opacity * c.fx.glow * 0.6;
      ctx.drawImage(img, -bw / 2, -bh / 2, bw, bh);
    }
    ctx.restore();
  }

  private postEffect(type: Transition["type"], p: number, intensity: number) {
    const { ctx, canvas, scratch } = this;
    const W = canvas.width;
    const H = canvas.height;
    if (scratch.width !== W || scratch.height !== H) {
      scratch.width = W;
      scratch.height = H;
    }
    const sctx = scratch.getContext("2d")!;
    sctx.drawImage(canvas, 0, 0);
    ctx.save();
    if (type === "blur") {
      ctx.filter = `blur(${((14 * intensity + 4) * H) / 1080}px)`;
      ctx.drawImage(scratch, 0, 0);
    } else if (type === "whipPan") {
      ctx.globalAlpha = 0.25;
      for (let i = -3; i <= 3; i++) ctx.drawImage(scratch, (i * W) / 60, 0);
    } else if (type === "glitch") {
      const off = ((12 * intensity + 4) * W) / 1920;
      ctx.globalCompositeOperation = "screen";
      ctx.globalAlpha = 0.6;
      ctx.drawImage(scratch, off, 0);
      ctx.drawImage(scratch, -off, 0);
      ctx.globalCompositeOperation = "source-over";
      ctx.globalAlpha = 1;
      for (let i = 0; i < 6; i++) {
        const y = Math.random() * H;
        const h = (Math.random() * H) / 20;
        ctx.drawImage(scratch, 0, y, W, h, (Math.random() - 0.5) * off * 4, y, W, h);
      }
    } else if (type === "fadeWhite") {
      void p;
    }
    ctx.restore();
  }

  /** White flash for fade-to-white transitions, drawn on top of layers. */
  whiteFlash(p: Project, t: number) {
    for (const c of p.clips) {
      const tr = c.transitionIn;
      if (!tr || tr.type !== "fadeWhite" || tr.duration <= 0) continue;
      const half = tr.duration / 2;
      const d = Math.abs(t - c.start);
      if (d < half) {
        this.ctx.save();
        this.ctx.globalAlpha = 1 - d / half;
        this.ctx.fillStyle = "#fff";
        this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
        this.ctx.restore();
      }
    }
  }
}
