// Web Audio mixer for the preview: per-track EQ / compressor / gain / pan, ducking,
// master limiter and level meters. FFT noise reduction and loudness normalisation are
// export-only (FFmpeg afftdn / loudnorm) - the UI says so.
import type { Project, Track } from "../../shared/types";

interface TrackBus {
  input: GainNode;
  hp: BiquadFilterNode;
  low: BiquadFilterNode;
  mid: BiquadFilterNode;
  high: BiquadFilterNode;
  deMud: BiquadFilterNode;
  presence: BiquadFilterNode;
  comp: DynamicsCompressorNode;
  gain: GainNode;
  pan: StereoPannerNode;
  duck: GainNode;
  meter: AnalyserNode;
}

export class AudioEngine {
  ctx: AudioContext | null = null;
  master!: GainNode;
  limiter!: DynamicsCompressorNode;
  masterMeter!: AnalyserNode;
  buses = new Map<string, TrackBus>();
  sources = new WeakMap<HTMLMediaElement, { node: MediaElementAudioSourceNode; gain: GainNode; trackId: string }>();

  ensure(): AudioContext {
    if (!this.ctx) {
      const ctx = new AudioContext({ latencyHint: "interactive" });
      this.ctx = ctx;
      this.master = ctx.createGain();
      this.limiter = ctx.createDynamicsCompressor();
      this.limiter.threshold.value = -1;
      this.limiter.ratio.value = 20;
      this.limiter.attack.value = 0.002;
      this.limiter.release.value = 0.1;
      this.masterMeter = ctx.createAnalyser();
      this.masterMeter.fftSize = 1024;
      this.master.connect(this.limiter).connect(this.masterMeter).connect(ctx.destination);
    }
    if (this.ctx.state === "suspended") this.ctx.resume().catch(() => {});
    return this.ctx;
  }

  bus(track: Track): TrackBus {
    const ctx = this.ensure();
    let b = this.buses.get(track.id);
    if (!b) {
      const biq = (type: BiquadFilterType, f: number, q = 1) => {
        const n = ctx.createBiquadFilter();
        n.type = type;
        n.frequency.value = f;
        n.Q.value = q;
        return n;
      };
      b = {
        input: ctx.createGain(),
        hp: biq("highpass", 10, 0.7),
        low: biq("lowshelf", 120),
        mid: biq("peaking", 1500, 1),
        high: biq("highshelf", 8000),
        deMud: biq("peaking", 250, 1.2),
        presence: biq("peaking", 3500, 1),
        comp: ctx.createDynamicsCompressor(),
        gain: ctx.createGain(),
        pan: ctx.createStereoPanner(),
        duck: ctx.createGain(),
        meter: ctx.createAnalyser(),
      };
      b.meter.fftSize = 1024;
      b.input.connect(b.hp).connect(b.low).connect(b.mid).connect(b.high).connect(b.deMud).connect(b.presence).connect(b.comp).connect(b.gain).connect(b.pan).connect(b.duck).connect(this.master);
      b.duck.connect(b.meter);
      this.buses.set(track.id, b);
    }
    return b;
  }

  connect(el: HTMLMediaElement, track: Track) {
    const ctx = this.ensure();
    let s = this.sources.get(el);
    if (!s) {
      const node = ctx.createMediaElementSource(el);
      const gain = ctx.createGain();
      node.connect(gain);
      s = { node, gain, trackId: "" };
      this.sources.set(el, s);
    }
    if (s.trackId !== track.id) {
      s.gain.disconnect();
      s.gain.connect(this.bus(track).input);
      s.trackId = track.id;
    }
    return s.gain;
  }

  /** Apply track settings (mute/solo/volume/pan/fx) and ducking amount. */
  update(p: Project, voiceActive: boolean) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const solo = p.tracks.some((x) => x.solo);
    for (const tr of p.tracks) {
      const b = this.buses.get(tr.id);
      if (!b) continue;
      const fx = tr.fx;
      const audible = !tr.muted && (!solo || tr.solo);
      b.gain.gain.setTargetAtTime(audible ? tr.volume : 0, t, 0.02);
      b.pan.pan.setTargetAtTime(tr.pan, t, 0.02);
      b.hp.frequency.setTargetAtTime(fx.highpass ? 80 : 10, t, 0.02);
      b.low.gain.setTargetAtTime(fx.eqLow, t, 0.02);
      b.mid.gain.setTargetAtTime(fx.eqMid, t, 0.02);
      b.high.gain.setTargetAtTime(fx.eqHigh + (fx.voiceEnhance ? 1.5 : 0), t, 0.02);
      b.deMud.gain.setTargetAtTime(fx.voiceEnhance ? -3 : 0, t, 0.02);
      b.presence.gain.setTargetAtTime(fx.voiceEnhance ? 3 : 0, t, 0.02);
      if (fx.compressor > 0.01) {
        b.comp.threshold.value = -12 - fx.compressor * 15;
        b.comp.ratio.value = 2 + fx.compressor * 4;
        b.comp.knee.value = 6;
      } else {
        b.comp.threshold.value = 0;
        b.comp.ratio.value = 1;
      }
      const duck = tr.duckUnderVoice && tr.role !== "voice" && voiceActive ? 0.3 : 1;
      b.duck.gain.setTargetAtTime(duck, t, duck < 1 ? 0.05 : 0.25);
    }
    this.master.gain.setTargetAtTime(p.master.volume, t, 0.02);
    this.limiter.threshold.value = p.master.limiter ? -1 : 0;
    this.limiter.ratio.value = p.master.limiter ? 20 : 1;
  }

  level(trackId: string | "master"): { rms: number; peak: number } {
    const a = trackId === "master" ? this.masterMeter : this.buses.get(trackId)?.meter;
    if (!a) return { rms: -100, peak: -100 };
    const buf = new Float32Array(a.fftSize);
    a.getFloatTimeDomainData(buf);
    let sum = 0;
    let peak = 0;
    for (const v of buf) {
      sum += v * v;
      peak = Math.max(peak, Math.abs(v));
    }
    const rms = Math.sqrt(sum / buf.length);
    return { rms: rms > 0 ? 20 * Math.log10(rms) : -100, peak: peak > 0 ? 20 * Math.log10(peak) : -100 };
  }
}

export const audioEngine = new AudioEngine();
