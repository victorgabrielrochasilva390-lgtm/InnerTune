import { useRef } from "react";
import type { Clip, ColorGrade, RGB } from "../../shared/types";
import { useEditor } from "../store";
import { updateClip, setTransition } from "../actions";
import { BUILTIN_LUTS, COLOR_PRESETS, FONTS, MOTION_PRESETS, NEUTRAL_GRADE, TEXT_TEMPLATES, TRANSITIONS } from "../../shared/presets";
import { clipDuration, formatShort } from "../../shared/timeline";
import { api } from "../api";
import { ColorInput, Empty, Icon, NumberInput, Section, Select, Slider, Toggle } from "./ui";
import { useEffect, useState } from "react";

export function Inspector() {
  const project = useEditor((s) => s.project)!;
  const selection = useEditor((s) => s.selection);
  const media = useEditor((s) => s.media);
  const playhead = useEditor((s) => s.playhead);
  const clip = project.clips.find((c) => c.id === selection[0]);
  if (!clip) return <ProjectSettings />;
  const m = clip.mediaId ? media[clip.mediaId] : undefined;
  const track = project.tracks.find((t) => t.id === clip.trackId);
  const up = (label: string, fn: (c: Clip) => void, key?: string) => updateClip(clip.id, label, fn, key);
  const dur = clipDuration(clip);
  const local = playhead - clip.start;
  const isVisual = clip.kind !== "text" && track?.kind === "video";

  return (
    <div className="panel-body inspector" data-tour="inspector">
      <div className="insp-title">
        <strong>{clip.kind === "text" ? "Text layer" : clip.kind === "adjustment" ? "Adjustment layer" : clip.label ?? m?.name}</strong>
        <span className="muted small">
          {track?.name} · {formatShort(clip.start)} → {formatShort(clip.start + dur)}
          {selection.length > 1 ? ` · ${selection.length} selected` : ""}
        </span>
      </div>
      {m?.source.license && (
        <div className="license small">
          <Icon name="link" size={12} /> {m.source.provider}: {m.source.license}
          {m.source.author ? ` · ${m.source.author}` : ""} {m.source.url && <a href={m.source.url} target="_blank" rel="noreferrer">source</a>}
        </div>
      )}

      <Section title="Timing">
        <div className="grid2">
          <label>Start <NumberInput value={clip.start} step={1 / project.settings.fps} min={0} onChange={(v) => up("Move clip", (c) => (c.start = v))} /></label>
          <label>Duration <NumberInput value={dur} step={1 / project.settings.fps} min={0.04} onChange={(v) => up("Clip duration", (c) => (c.out = c.in + v * c.speed))} /></label>
          {clip.kind === "media" && m?.kind !== "image" && (
            <>
              <label>Source in <NumberInput value={clip.in} step={0.04} min={0} max={clip.out - 0.04} onChange={(v) => up("Source in", (c) => (c.in = v))} /></label>
              <label>Source out <NumberInput value={clip.out} step={0.04} min={clip.in + 0.04} max={m?.duration} onChange={(v) => up("Source out", (c) => (c.out = v))} /></label>
            </>
          )}
        </div>
        {clip.kind === "media" && m?.kind !== "image" && (
          <Slider label="Speed" value={clip.speed} min={0.25} max={4} step={0.05} format={(v) => `${v.toFixed(2)}x`} reset={1} onChange={(v) => up("Speed", (c) => (c.speed = v), "speed")} help="Speed ramp (audio pitch is preserved in export)" />
        )}
      </Section>

      {clip.kind === "text" && clip.text && <TextProps clip={clip} />}

      {isVisual && clip.kind === "media" && (
        <Section title="Transform">
          <Select label="Framing" value={clip.transform.fit} onChange={(v) => up("Framing", (c) => (c.transform.fit = v))} options={[{ value: "fit", label: "Fit (letterbox)" }, { value: "fill", label: "Fill (crop)" }, { value: "blurFill", label: "Fit + blurred background" }]} />
          <Slider label="Scale" value={clip.transform.scale} min={0.1} max={4} reset={1} onChange={(v) => up("Scale", (c) => (c.transform.scale = v), "scale")} />
          <Slider label="Position X" value={clip.transform.x} min={-1} max={1} reset={0} onChange={(v) => up("Position", (c) => (c.transform.x = v), "posx")} />
          <Slider label="Position Y" value={clip.transform.y} min={-1} max={1} reset={0} onChange={(v) => up("Position", (c) => (c.transform.y = v), "posy")} />
          <Slider label="Rotation" value={clip.transform.rotation} min={-180} max={180} step={0.5} reset={0} onChange={(v) => up("Rotation", (c) => (c.transform.rotation = v), "rot")} />
          <Slider label="Opacity" value={clip.transform.opacity} min={0} max={1} reset={1} onChange={(v) => up("Opacity", (c) => (c.transform.opacity = v), "op")} />
        </Section>
      )}

      {isVisual && clip.kind === "media" && (
        <Section title="Camera motion">
          <Select label="Preset" value={clip.motion.preset} onChange={(v) => up("Motion", (c) => (c.motion.preset = v))} options={MOTION_PRESETS.map((x) => ({ value: x.id, label: x.label }))} />
          <Slider label="Intensity" value={clip.motion.intensity} min={0} max={1} onChange={(v) => up("Motion intensity", (c) => (c.motion.intensity = v), "moi")} />
          <div className="adv">
            <div className="row gap">
              <strong className="small">Keyframes</strong>
              <span className="grow" />
              <button
                className="btn sm"
                disabled={local < 0 || local > dur}
                onClick={() =>
                  up("Add keyframe", (c) => {
                    c.keyframes = c.keyframes.filter((k) => Math.abs(k.t - local) > 0.02);
                    c.keyframes.push({ t: Math.max(0, local), scale: 1, x: 0, y: 0, rotation: 0, opacity: 1, ease: "easeInOut" });
                    c.keyframes.sort((a, b) => a.t - b.t);
                  })
                }
                data-tip="Adds a keyframe at the playhead. Keyframes multiply the base transform"
              >
                + Keyframe at playhead
              </button>
            </div>
            {clip.keyframes.map((k, i) => (
              <div key={i} className="kf">
                <span className="small">@{k.t.toFixed(2)}s</span>
                <label className="small">scale <NumberInput value={k.scale} step={0.05} onChange={(v) => up("Keyframe", (c) => (c.keyframes[i].scale = v), `kf${i}s`)} width={52} /></label>
                <label className="small">x <NumberInput value={k.x} step={0.01} onChange={(v) => up("Keyframe", (c) => (c.keyframes[i].x = v), `kf${i}x`)} width={52} /></label>
                <label className="small">y <NumberInput value={k.y} step={0.01} onChange={(v) => up("Keyframe", (c) => (c.keyframes[i].y = v), `kf${i}y`)} width={52} /></label>
                <label className="small">rot <NumberInput value={k.rotation} step={1} onChange={(v) => up("Keyframe", (c) => (c.keyframes[i].rotation = v), `kf${i}r`)} width={48} /></label>
                <label className="small">op <NumberInput value={k.opacity} step={0.05} min={0} max={1} onChange={(v) => up("Keyframe", (c) => (c.keyframes[i].opacity = v), `kf${i}o`)} width={48} /></label>
                <button className="tbtn" onClick={() => up("Delete keyframe", (c) => c.keyframes.splice(i, 1))}>
                  ✕
                </button>
              </div>
            ))}
          </div>
        </Section>
      )}

      {(isVisual || clip.kind === "adjustment") && (
        <Section title="Transitions">
          <TransitionEdit clip={clip} which="in" />
          {track && project.tracks.filter((t) => t.kind === "video").indexOf(track) < project.tracks.filter((t) => t.kind === "video").length - 1 && <TransitionEdit clip={clip} which="out" />}
        </Section>
      )}

      {(isVisual || clip.kind === "adjustment") && (
        <Section title="Effects">
          <Slider label="Blur" value={clip.fx.blur} min={0} max={40} step={0.5} reset={0} onChange={(v) => up("Blur", (c) => (c.fx.blur = v), "blur")} />
          <Slider label="Sharpen" value={clip.fx.sharpen} min={0} max={2} reset={0} onChange={(v) => up("Sharpen", (c) => (c.fx.sharpen = v), "sharp")} />
          <Slider label="Vignette" value={clip.fx.vignette} min={0} max={1} reset={0} onChange={(v) => up("Vignette", (c) => (c.fx.vignette = v), "vig")} />
          <Slider label="Film grain" value={clip.fx.grain} min={0} max={1} reset={0} onChange={(v) => up("Grain", (c) => (c.fx.grain = v), "grain")} />
          <Slider label="Glow" value={clip.fx.glow} min={0} max={1} reset={0} onChange={(v) => up("Glow", (c) => (c.fx.glow = v), "glow")} />
          <button className="btn sm" onClick={() => useEditor.getState().set({ workspace: "color" })}>
            <Icon name="palette" size={13} /> Colour grade…
          </button>
        </Section>
      )}

      {clip.kind === "media" && m?.hasAudio && (
        <Section title="Audio">
          <Slider label="Volume" value={clip.volume} min={0} max={2} reset={1} format={(v) => (v <= 0.001 ? "-∞ dB" : `${(20 * Math.log10(v)).toFixed(1)} dB`)} onChange={(v) => up("Clip volume", (c) => (c.volume = v), "vol")} />
          <Slider label="Fade in" value={clip.fadeIn} min={0} max={Math.min(10, dur / 2)} reset={0} format={(v) => `${v.toFixed(2)}s`} onChange={(v) => up("Fade in", (c) => (c.fadeIn = v), "fi")} />
          <Slider label="Fade out" value={clip.fadeOut} min={0} max={Math.min(10, dur / 2)} reset={0} format={(v) => `${v.toFixed(2)}s`} onChange={(v) => up("Fade out", (c) => (c.fadeOut = v), "fo")} />
        </Section>
      )}
    </div>
  );
}

function TransitionEdit({ clip, which }: { clip: Clip; which: "in" | "out" }) {
  const tr = which === "in" ? clip.transitionIn : clip.transitionOut;
  const up = (fn: (c: Clip) => void, key?: string) => updateClip(clip.id, "Transition", fn, key);
  return (
    <div className="trans-edit">
      <Select label={which === "in" ? "In" : "Out (overlay)"} value={tr?.type ?? "cut"} onChange={(v) => setTransition([clip.id], v as any, which)} options={TRANSITIONS.map((t) => ({ value: t.id, label: t.label }))} />
      {tr && (
        <>
          <Slider label="Duration" value={tr.duration} min={0.05} max={Math.min(3, clipDuration(clip) / 2)} format={(v) => `${v.toFixed(2)}s`} onChange={(v) => up((c) => ((which === "in" ? c.transitionIn! : c.transitionOut!).duration = v), `trd-${which}`)} />
          <Slider label="Intensity" value={tr.intensity} min={0} max={1} onChange={(v) => up((c) => ((which === "in" ? c.transitionIn! : c.transitionOut!).intensity = v), `tri-${which}`)} />
        </>
      )}
    </div>
  );
}

function TextProps({ clip }: { clip: Clip }) {
  const d = clip.text!;
  const up = (label: string, fn: (c: Clip) => void, key?: string) => updateClip(clip.id, label, fn, key);
  return (
    <>
      <Section title="Text">
        <Select label="Template" value={d.template} onChange={(v) => up("Template", (c) => (c.text!.template = v))} options={TEXT_TEMPLATES.map((t) => ({ value: t.id, label: t.label }))} />
        {!["arrow", "highlightBox", "progressBar"].includes(d.template) && (
          <textarea className="text-area" value={d.text} onChange={(e) => up("Edit text", (c) => (c.text!.text = e.target.value), "txt")} onKeyDown={(e) => e.stopPropagation()} rows={2} />
        )}
        {d.template === "lowerThird" && <input className="text-input" placeholder="Subtitle / role" value={d.subtitle ?? ""} onChange={(e) => up("Edit subtitle", (c) => (c.text!.subtitle = e.target.value), "sub")} onKeyDown={(e) => e.stopPropagation()} />}
        <Select label="Font" value={d.style.font} onChange={(v) => up("Font", (c) => (c.text!.style.font = v))} options={FONTS.map((f) => ({ value: f.id, label: f.label }))} />
        <Slider label="Size" value={d.style.size} min={16} max={240} step={1} onChange={(v) => up("Text size", (c) => (c.text!.style.size = v), "tsz")} />
        <ColorInput label="Colour" value={d.style.color} onChange={(v) => up("Text colour", (c) => (c.text!.style.color = v), "tc")} />
        <ColorInput label="Accent / box" value={d.style.accent} onChange={(v) => up("Accent", (c) => (c.text!.style.accent = v), "ta")} />
        <Toggle label="Background box" checked={d.style.background} onChange={(v) => up("Text box", (c) => (c.text!.style.background = v))} />
        <Toggle label="UPPERCASE" checked={d.style.uppercase} onChange={(v) => up("Uppercase", (c) => (c.text!.style.uppercase = v))} />
        <Slider label="Outline" value={d.style.outline} min={0} max={16} step={0.5} onChange={(v) => up("Outline", (c) => (c.text!.style.outline = v), "tol")} />
        <Slider label="Shadow" value={d.style.shadow} min={0} max={12} step={0.5} onChange={(v) => up("Shadow", (c) => (c.text!.style.shadow = v), "tsh")} />
      </Section>
      <Section title="Position & animation">
        <Slider label="X" value={d.x} min={0} max={1} onChange={(v) => up("Text position", (c) => (c.text!.x = v), "tx")} />
        <Slider label="Y" value={d.y} min={0} max={1} onChange={(v) => up("Text position", (c) => (c.text!.y = v), "ty")} />
        {["arrow", "highlightBox", "progressBar"].includes(d.template) && (
          <>
            <Slider label="Width" value={d.w} min={0.02} max={1} onChange={(v) => up("Shape size", (c) => (c.text!.w = v), "tw")} />
            <Slider label="Height" value={d.h} min={0.005} max={1} step={0.005} onChange={(v) => up("Shape size", (c) => (c.text!.h = v), "th")} />
          </>
        )}
        <Slider label="Rotation" value={d.rotation} min={-180} max={180} step={1} onChange={(v) => up("Rotate text", (c) => (c.text!.rotation = v), "tr")} />
        <Select label="Animate in" value={d.animIn} onChange={(v) => up("Animation", (c) => (c.text!.animIn = v))} options={[{ value: "pop", label: "Pop" }, { value: "fade", label: "Fade" }, { value: "slideUp", label: "Slide up" }, { value: "slideLeft", label: "Slide in" }, { value: "none", label: "None" }]} />
        <Select label="Animate out" value={d.animOut} onChange={(v) => up("Animation", (c) => (c.text!.animOut = v))} options={[{ value: "fade", label: "Fade" }, { value: "none", label: "None" }]} />
      </Section>
    </>
  );
}

function ProjectSettings() {
  const project = useEditor((s) => s.project)!;
  const commit = useEditor((s) => s.commit);
  return (
    <div className="panel-body">
      <Empty icon="cursor" title="Nothing selected">
        Select a clip to edit its properties. Shortcuts: <kbd>S</kbd> split, <kbd>Del</kbd> delete, <kbd>Space</kbd> play.
      </Empty>
      <Section title="Project">
        <div className="muted small">
          Canvas {project.settings.width}×{project.settings.height} · {project.settings.aspect}
        </div>
        <Select label="Frame rate" value={String(project.settings.fps)} onChange={(v) => commit("Frame rate", (d) => void (d.settings.fps = Number(v)))} options={["24", "25", "30", "50", "60"].map((v) => ({ value: v, label: `${v} fps` }))} />
        <ColorInput label="Background" value={project.settings.background} onChange={(v) => commit("Background", (d) => void (d.settings.background = v), "bg")} />
      </Section>
    </div>
  );
}

// ---------------------------------------------------------------------------- Colour workspace

function Wheel({ label, value, onChange }: { label: string; value: RGB; onChange: (v: RGB) => void }) {
  // a colour wheel puck: angle = hue, distance = strength; maps to RGB offsets
  const ref = useRef<HTMLDivElement>(null);
  const toXY = (v: RGB) => {
    const x = (v.r - (v.g + v.b) / 2) * 1.0;
    const y = ((v.g - v.b) * Math.sqrt(3)) / 2;
    return { x: x / 0.5, y: -y / 0.5 };
  };
  const fromXY = (x: number, y: number): RGB => {
    const ang = Math.atan2(-y, x);
    const mag = Math.min(1, Math.hypot(x, y)) * 0.5;
    const r = Math.cos(ang) * mag;
    const g = Math.cos(ang - (2 * Math.PI) / 3) * mag;
    const b = Math.cos(ang + (2 * Math.PI) / 3) * mag;
    return { r, g, b };
  };
  const p = toXY(value);
  const drag = (e: React.PointerEvent) => {
    const el = ref.current!;
    const r = el.getBoundingClientRect();
    const mv = (ev: PointerEvent) => {
      const x = ((ev.clientX - r.left) / r.width) * 2 - 1;
      const y = ((ev.clientY - r.top) / r.height) * 2 - 1;
      onChange(fromXY(x, y));
    };
    mv(e.nativeEvent);
    const up = () => window.removeEventListener("pointermove", mv);
    window.addEventListener("pointermove", mv);
    window.addEventListener("pointerup", up, { once: true });
  };
  return (
    <div className="wheel-wrap">
      <div className="wheel" ref={ref} onPointerDown={drag} onDoubleClick={() => onChange({ r: 0, g: 0, b: 0 })} data-tip={`${label}: drag to tint, double-click to reset`}>
        <div className="puck" style={{ left: `${50 + Math.max(-1, Math.min(1, p.x)) * 50}%`, top: `${50 + Math.max(-1, Math.min(1, p.y)) * 50}%` }} />
      </div>
      <span className="small">{label}</span>
    </div>
  );
}

function Curve({ value, onChange }: { value: number[]; onChange: (v: number[]) => void }) {
  const W = 220;
  const H = 160;
  const ref = useRef<SVGSVGElement>(null);
  const drag = (i: number) => (e: React.PointerEvent) => {
    e.preventDefault();
    const r = ref.current!.getBoundingClientRect();
    const mv = (ev: PointerEvent) => {
      const y = 1 - (ev.clientY - r.top) / r.height;
      const next = value.slice();
      next[i] = Math.max(0, Math.min(1, y));
      onChange(next);
    };
    const up = () => window.removeEventListener("pointermove", mv);
    window.addEventListener("pointermove", mv);
    window.addEventListener("pointerup", up, { once: true });
  };
  const pts = value.map((v, i) => [(i / (value.length - 1)) * W, H - v * H]);
  return (
    <svg ref={ref} className="curve" width={W} height={H} viewBox={`0 0 ${W} ${H}`} onDoubleClick={() => onChange([0, 0.25, 0.5, 0.75, 1])}>
      <line x1={0} y1={H} x2={W} y2={0} className="diag" />
      {[0.25, 0.5, 0.75].map((g) => (
        <g key={g}>
          <line x1={g * W} y1={0} x2={g * W} y2={H} className="grid" />
          <line x1={0} y1={g * H} x2={W} y2={g * H} className="grid" />
        </g>
      ))}
      <polyline points={pts.map((p) => p.join(",")).join(" ")} className="line" />
      {pts.map((p, i) => (
        <circle key={i} cx={p[0]} cy={p[1]} r={6} onPointerDown={drag(i)} />
      ))}
    </svg>
  );
}

export function ColorPanel() {
  const project = useEditor((s) => s.project)!;
  const selection = useEditor((s) => s.selection);
  const compare = useEditor((s) => s.compare);
  const clipboard = useEditor((s) => s.colorClipboard);
  const S = useEditor.getState;
  const [luts, setLuts] = useState<string[]>([]);
  const lutFile = useRef<HTMLInputElement>(null);
  useEffect(() => {
    api.luts().then(setLuts).catch(() => {});
  }, []);
  const clip = project.clips.find((c) => c.id === selection[0] && c.kind !== "text");
  if (!clip) return <div className="panel-body"><Empty icon="palette" title="Select a video clip or adjustment layer to grade" /></div>;
  const g = clip.color;
  const setG = (patch: Partial<ColorGrade>, key?: string) =>
    S().commit(
      "Colour",
      (d) => {
        for (const c of d.clips) if (selection.includes(c.id)) Object.assign(c.color, patch);
      },
      key
    );
  const userLuts = luts.filter((l) => !BUILTIN_LUTS.some((b) => b.id === l));
  return (
    <div className="panel-body color-panel">
      <div className="row gap wrap">
        <Select value={compare} onChange={(v) => S().set({ compare: v })} options={[{ value: "off", label: "Graded" }, { value: "original", label: "Original (before)" }, { value: "split", label: "Split before / after" }]} help="Before / after comparison in the viewer" />
        <button className="btn sm" onClick={() => (S().set({ colorClipboard: { color: g, fx: clip.fx } }), S().toast("Grade copied"))}>Copy</button>
        <button className="btn sm" disabled={!clipboard} onClick={() => S().commit("Paste grade", (d) => { for (const c of d.clips) if (selection.includes(c.id)) { c.color = structuredClone(clipboard!.color) as any; c.fx = { ...clipboard!.fx }; } })}>Paste</button>
        <button className="btn sm" disabled={!clip.mediaId} onClick={() => S().commit("Match grade to all clips of this source", (d) => { for (const c of d.clips) if (c.mediaId === clip.mediaId) c.color = structuredClone(g) as any; })} data-tip="Copy this grade to every clip from the same source for consistency">
          Apply to same source
        </button>
        <button className="btn sm ghost" onClick={() => setG(structuredClone(NEUTRAL_GRADE))}>Reset</button>
      </div>
      <Section title="Looks">
        <div className="chip-row">
          {COLOR_PRESETS.map((p) => (
            <button key={p.id} className="chip" onClick={() => setG({ ...structuredClone(NEUTRAL_GRADE), ...p.grade })}>
              {p.label}
            </button>
          ))}
        </div>
      </Section>
      <Section title="Primary">
        <Slider label="Exposure" value={g.exposure} min={-2} max={2} reset={0} format={(v) => `${v >= 0 ? "+" : ""}${v.toFixed(2)} EV`} onChange={(v) => setG({ exposure: v }, "exp")} />
        <Slider label="Contrast" value={g.contrast} min={-1} max={1} reset={0} onChange={(v) => setG({ contrast: v }, "con")} />
        <Slider label="Highlights" value={g.highlights} min={-1} max={1} reset={0} onChange={(v) => setG({ highlights: v }, "hi")} />
        <Slider label="Shadows" value={g.shadows} min={-1} max={1} reset={0} onChange={(v) => setG({ shadows: v }, "sh")} />
        <Slider label="Saturation" value={g.saturation} min={0} max={2} reset={1} onChange={(v) => setG({ saturation: v }, "sat")} />
        <Slider label="Temperature" value={g.temperature} min={-1} max={1} reset={0} help="White balance: cool ← → warm" onChange={(v) => setG({ temperature: v }, "temp")} />
        <Slider label="Tint" value={g.tint} min={-1} max={1} reset={0} help="green ← → magenta" onChange={(v) => setG({ tint: v }, "tint")} />
      </Section>
      <Section title="Colour wheels" adv>
        <div className="wheels">
          <Wheel label="Lift (shadows)" value={g.lift} onChange={(v) => setG({ lift: v }, "lift")} />
          <Wheel label="Gamma (mids)" value={g.gamma} onChange={(v) => setG({ gamma: v }, "gamma")} />
          <Wheel label="Gain (highlights)" value={g.gain} onChange={(v) => setG({ gain: v }, "gain")} />
        </div>
      </Section>
      <Section title="Curve (master)" adv>
        <Curve value={g.curve} onChange={(v) => setG({ curve: v as any }, "curve")} />
        <p className="muted small">Drag points. Double-click to reset.</p>
      </Section>
      <Section title="LUT">
        <Select label="LUT" value={g.lutId ?? ""} onChange={(v) => setG({ lutId: v || undefined })} options={[{ value: "", label: "None" }, ...BUILTIN_LUTS.map((l) => ({ value: l.id, label: l.label })), ...userLuts.map((l) => ({ value: l, label: l.replace(/^user-/, "★ ") }))]} />
        {g.lutId && <Slider label="Intensity" value={g.lutIntensity} min={0} max={1} reset={1} onChange={(v) => setG({ lutIntensity: v }, "luti")} />}
        <button className="btn sm" onClick={() => lutFile.current?.click()}>Import .cube LUT</button>
        <input
          ref={lutFile}
          type="file"
          accept=".cube"
          hidden
          onChange={async (e) => {
            const f = e.target.files?.[0];
            if (!f) return;
            try {
              const { id } = await api.uploadLut(f);
              setLuts(await api.luts());
              setG({ lutId: id, lutIntensity: 1 });
            } catch (err) {
              S().toast((err as Error).message, "error");
            }
          }}
        />
      </Section>
      <p className="muted small">The preview uses a GPU approximation of the export filters (FFmpeg exposure / eq / colortemperature / colorbalance / curves / lut3d). Final colours can differ slightly.</p>
    </div>
  );
}
