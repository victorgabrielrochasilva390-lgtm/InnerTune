import { useEffect, useRef, useState } from "react";
import type { Track } from "../../shared/types";
import { useEditor } from "../store";
import { audioEngine } from "../engine/audio";
import { Slider, Toggle, Select } from "./ui";

function Meter({ id }: { id: string }) {
  const [lv, setLv] = useState({ rms: -100, peak: -100 });
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      setLv(audioEngine.level(id));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [id]);
  const pct = (db: number) => Math.max(0, Math.min(100, ((db + 60) / 60) * 100));
  return (
    <div className="meter" data-tip={`RMS ${lv.rms.toFixed(1)} dBFS · peak ${lv.peak.toFixed(1)} dBFS`}>
      <div className="meter-fill" style={{ height: `${pct(lv.rms)}%` }} />
      <div className={`meter-peak ${lv.peak > -1 ? "clip" : ""}`} style={{ bottom: `${pct(lv.peak)}%` }} />
    </div>
  );
}

function Strip({ track }: { track: Track }) {
  const commit = useEditor((s) => s.commit);
  const up = (label: string, fn: (t: Track) => void, key?: string) =>
    commit(
      label,
      (d) => {
        const t = d.tracks.find((x) => x.id === track.id);
        if (t) fn(t as Track);
      },
      key
    );
  const db = track.volume <= 0.001 ? "-∞" : (20 * Math.log10(track.volume)).toFixed(1);
  return (
    <div className={`strip kind-${track.kind}`}>
      <div className="strip-name" title={track.name}>
        {track.name}
      </div>
      <Select value={track.role ?? "voice"} onChange={(v) => up("Track role", (t) => (t.role = v as any))} options={[{ value: "voice", label: "Voice" }, { value: "music", label: "Music" }, { value: "sfx", label: "SFX" }]} help="Voice tracks trigger ducking; music ducks under voice" />
      <div className="fader-row">
        <input className="fader" type="range" min={0} max={2} step={0.01} value={track.volume} onChange={(e) => up("Track volume", (t) => (t.volume = Number(e.target.value)), `tv-${track.id}`)} onDoubleClick={() => up("Track volume", (t) => (t.volume = 1))} data-tip="Track volume (double-click resets to 0 dB)" />
        <Meter id={track.id} />
      </div>
      <div className="small center">{db} dB</div>
      <input className="pan" type="range" min={-1} max={1} step={0.01} value={track.pan} onChange={(e) => up("Pan", (t) => (t.pan = Number(e.target.value)), `pan-${track.id}`)} onDoubleClick={() => up("Pan", (t) => (t.pan = 0))} data-tip="Pan" />
      <div className="row gap center">
        <button className={`tbtn ${track.muted ? "on mute" : ""}`} onClick={() => up("Mute", (t) => (t.muted = !t.muted))}>M</button>
        <button className={`tbtn ${track.solo ? "on solo" : ""}`} onClick={() => up("Solo", (t) => (t.solo = !t.solo))}>S</button>
      </div>
      <div className="fx-list">
        <Toggle label="Rumble cut" checked={track.fx.highpass} onChange={(v) => up("High-pass", (t) => (t.fx.highpass = v))} help="80 Hz high-pass" />
        <Toggle label="Voice enhance" checked={track.fx.voiceEnhance} onChange={(v) => up("Voice enhance", (t) => (t.fx.voiceEnhance = v))} help="De-mud + presence boost" />
        <Toggle label="Limiter" checked={track.fx.limiter} onChange={(v) => up("Limiter", (t) => (t.fx.limiter = v))} />
        {track.role !== "voice" && <Toggle label="Duck under voice" checked={!!track.duckUnderVoice} onChange={(v) => up("Ducking", (t) => (t.duckUnderVoice = v))} help="Automatically lowers this track while someone speaks" />}
        <Slider label="Denoise*" value={track.fx.denoise} min={0} max={1} onChange={(v) => up("Noise reduction", (t) => (t.fx.denoise = v), `dn-${track.id}`)} help="FFT noise reduction, applied in export only" />
        <Slider label="Comp." value={track.fx.compressor} min={0} max={1} onChange={(v) => up("Compressor", (t) => (t.fx.compressor = v), `cp-${track.id}`)} />
        <div className="adv">
          <Slider label="Low" value={track.fx.eqLow} min={-12} max={12} step={0.5} reset={0} onChange={(v) => up("EQ", (t) => (t.fx.eqLow = v), `eql-${track.id}`)} />
          <Slider label="Mid" value={track.fx.eqMid} min={-12} max={12} step={0.5} reset={0} onChange={(v) => up("EQ", (t) => (t.fx.eqMid = v), `eqm-${track.id}`)} />
          <Slider label="High" value={track.fx.eqHigh} min={-12} max={12} step={0.5} reset={0} onChange={(v) => up("EQ", (t) => (t.fx.eqHigh = v), `eqh-${track.id}`)} />
        </div>
      </div>
    </div>
  );
}

export function Mixer() {
  const project = useEditor((s) => s.project)!;
  const media = useEditor((s) => s.media);
  const commit = useEditor((s) => s.commit);
  const tracks = project.tracks.filter((t) => t.kind !== "text");
  const clipping = project.mediaIds.map((id) => media[id]).filter((m) => m?.analysis?.clipping?.likely);
  return (
    <div className="mixer" data-tour="mixer">
      <div className="strips">
        {tracks.map((t) => (
          <Strip key={t.id} track={t} />
        ))}
        <div className="strip master">
          <div className="strip-name">MASTER</div>
          <div className="fader-row">
            <input className="fader" type="range" min={0} max={2} step={0.01} value={project.master.volume} onChange={(e) => commit("Master volume", (d) => void (d.master.volume = Number(e.target.value)), "mv")} />
            <Meter id="master" />
          </div>
          <div className="small center">{project.master.volume <= 0.001 ? "-∞" : (20 * Math.log10(project.master.volume)).toFixed(1)} dB</div>
          <Toggle label="Loudness normalise*" checked={project.master.normalize} onChange={(v) => commit("Normalize", (d) => void (d.master.normalize = v))} help="EBU R128 loudness normalisation in export" />
          <Select value={String(project.master.targetLufs)} onChange={(v) => commit("Target loudness", (d) => void (d.master.targetLufs = Number(v)))} options={[{ value: "-14", label: "-14 LUFS (YouTube, TikTok)" }, { value: "-16", label: "-16 LUFS (podcast, Apple)" }, { value: "-12", label: "-12 LUFS (loud, Reels)" }, { value: "-23", label: "-23 LUFS (broadcast)" }]} />
          <Toggle label="Limiter" checked={project.master.limiter} onChange={(v) => commit("Master limiter", (d) => void (d.master.limiter = v))} help="Prevents clipping (-1 dBTP)" />
        </div>
      </div>
      <div className="mixer-foot muted small">
        * Noise reduction and loudness normalisation are applied in the final render (FFmpeg afftdn / loudnorm). The preview plays the EQ, compression, ducking and limiter live.
        {clipping.length > 0 && <span className="err"> Clipping detected in: {clipping.map((m) => m!.name).join(", ")}.</span>}
      </div>
    </div>
  );
}

export function useMeterRef() {
  return useRef(null);
}
