// Builds the FFmpeg command that renders a project. Pure function: the same model the
// browser preview draws is turned into a filter graph (one layer per clip, composited
// with time-windowed overlays, then text/captions via libass, plus a full audio mix).
import type { Clip, ColorGrade, ExportSettings, MediaItem, Project, Track, Transition, VisualFx } from "../shared/types";
import { clipDuration, clipEnd, EPS, splitAt, projectDuration } from "../shared/timeline";
import { motionExpr, needsOverlap } from "../shared/motion";

export interface RenderPlan {
  args: string[];
  filterGraph: string;
  duration: number;
  inputs: string[];
}

export interface RenderOptions {
  assPath?: string;
  fontsDir: string;
  lutPath: (id: string) => string | undefined;
  outPath: string;
  filterScriptPath: string;
}

const n = (v: number) => (Math.abs(v) < 1e-9 ? "0" : Number(v.toFixed(6)).toString());
const escPath = (p: string) => p.replace(/\\/g, "/").replace(/:/g, "\\:").replace(/'/g, "\\'");

export { sliceProject } from "../shared/timeline";
import { sliceProject } from "../shared/timeline";

export function gradeFilters(g: ColorGrade, fx: VisualFx, outH: number, lutPath: (id: string) => string | undefined, u = ""): string[] {
  const f: string[] = [];
  if (Math.abs(g.exposure) > 1e-3) f.push(`exposure=exposure=${n(g.exposure)}`);
  if (Math.abs(g.contrast) > 1e-3 || Math.abs(g.saturation - 1) > 1e-3) f.push(`eq=contrast=${n(1 + g.contrast)}:saturation=${n(g.saturation)}`);
  if (Math.abs(g.temperature) > 1e-3) f.push(`colortemperature=temperature=${g.temperature > 0 ? 3000 : 10000}:mix=${n(Math.min(1, Math.abs(g.temperature) * 0.5))}:pl=0.5`);
  const cb = {
    rs: g.lift.r * 0.6,
    gs: g.lift.g * 0.6,
    bs: g.lift.b * 0.6,
    rm: g.gamma.r * 0.6 + g.tint * 0.06,
    gm: g.gamma.g * 0.6 - g.tint * 0.1,
    bm: g.gamma.b * 0.6 + g.tint * 0.06,
    rh: g.gain.r * 0.6,
    gh: g.gain.g * 0.6,
    bh: g.gain.b * 0.6,
  };
  if (Object.values(cb).some((v) => Math.abs(v) > 1e-3)) f.push("colorbalance=" + Object.entries(cb).map(([k, v]) => `${k}=${n(Math.max(-1, Math.min(1, v)))}`).join(":"));
  const c = g.curve.slice() as number[];
  c[1] += g.shadows * 0.08;
  c[3] += g.highlights * 0.08;
  if (c.some((v, i) => Math.abs(v - i * 0.25) > 1e-3)) f.push(`curves=master='${c.map((v, i) => `${n(i * 0.25)}/${n(Math.max(0, Math.min(1, v)))}`).join(" ")}'`);
  if (g.lutId) {
    const lp = lutPath(g.lutId);
    if (lp) {
      if (g.lutIntensity >= 0.999) f.push(`lut3d=file='${escPath(lp)}':interp=tetrahedral`);
      else f.push(`split[lA${u}][lB${u}];[lB${u}]lut3d=file='${escPath(lp)}':interp=tetrahedral[lC${u}];[lA${u}][lC${u}]blend=all_mode=normal:all_opacity=${n(g.lutIntensity)}`);
    }
  }
  const k = outH / 1080;
  if (fx.sharpen > 0.01) f.push(`unsharp=5:5:${n(fx.sharpen * 1.2)}:5:5:0`);
  if (fx.blur > 0.05) f.push(`gblur=sigma=${n((fx.blur * k) / 2)}`);
  if (fx.glow > 0.01) f.push(`split[gA${u}][gB${u}];[gB${u}]gblur=sigma=${n(18 * k)}[gC${u}];[gA${u}][gC${u}]blend=all_mode=screen:all_opacity=${n(fx.glow * 0.6)}`);
  if (fx.vignette > 0.01) f.push(`vignette=angle=${n(0.25 + fx.vignette * 0.85)}`);
  if (fx.grain > 0.01) f.push(`noise=alls=${Math.round(fx.grain * 28)}:allf=t`);
  return f;
}

/** Chain atempo filters (each stage accepts 0.5..2). */
function atempo(speed: number): string[] {
  const out: string[] = [];
  let s = speed;
  while (s > 2) {
    out.push("atempo=2");
    s /= 2;
  }
  while (s < 0.5) {
    out.push("atempo=0.5");
    s /= 0.5;
  }
  if (Math.abs(s - 1) > 1e-3) out.push(`atempo=${n(s)}`);
  return out;
}

function trackFx(t: Track): string[] {
  const f: string[] = [];
  const fx = t.fx;
  if (fx.highpass) f.push("highpass=f=80");
  if (fx.denoise > 0.01) f.push(`afftdn=nr=${n(6 + fx.denoise * 30)}:nf=-50:tn=1`);
  if (fx.voiceEnhance) f.push("equalizer=f=250:t=q:w=1.2:g=-3", "equalizer=f=3500:t=q:w=1:g=3", "treble=g=1.5:f=10000");
  if (Math.abs(fx.eqLow) > 0.05) f.push(`bass=g=${n(fx.eqLow)}:f=120`);
  if (Math.abs(fx.eqMid) > 0.05) f.push(`equalizer=f=1500:t=q:w=1:g=${n(fx.eqMid)}`);
  if (Math.abs(fx.eqHigh) > 0.05) f.push(`treble=g=${n(fx.eqHigh)}:f=8000`);
  if (fx.compressor > 0.01) f.push(`acompressor=threshold=${n(0.25 - fx.compressor * 0.18)}:ratio=${n(2 + fx.compressor * 4)}:attack=10:release=180:makeup=${n(1 + fx.compressor * 2)}`);
  if (fx.limiter) f.push("alimiter=limit=0.89:level=false");
  if (Math.abs(t.volume - 1) > 1e-3) f.push(`volume=${n(t.volume)}`);
  if (Math.abs(t.pan) > 0.01) f.push(`pan=stereo|c0=${n(Math.min(1, 1 - t.pan))}*c0|c1=${n(Math.min(1, 1 + t.pan))}*c1`);
  return f;
}

export function buildRenderPlan(projectIn: Project, media: Record<string, MediaItem>, exp: ExportSettings, opts: RenderOptions): RenderPlan {
  const project = exp.range ? sliceProject(projectIn, exp.range.start, exp.range.end) : projectIn;
  const OW = exp.width;
  const OH = exp.height;
  const FPS = exp.fps;
  const duration = Math.max(0.1, projectDuration(project));
  const inputs: string[][] = [];
  const graph: string[] = [];
  const addInput = (args: string[]) => {
    inputs.push(args);
    return inputs.length - 1;
  };

  addInput(["-f", "lavfi", "-i", `color=c=${project.settings.background.replace("#", "0x")}:s=${OW}x${OH}:r=${FPS}:d=${n(duration)}`]);
  let vcur = "[0:v]";
  let vi = 0;
  const nextV = () => `[v${++vi}]`;

  const soloActive = project.tracks.some((t) => t.solo);
  const audible = (t: Track) => !t.muted && (!soloActive || t.solo) && t.volume > 0;
  const audioByTrack = new Map<string, string[]>();
  const postFx: string[] = [];

  // draw order: video tracks bottom (end of list) -> top (start of list)
  const videoTracks = project.tracks.filter((t) => t.kind === "video").reverse();
  const audioOnlyTracks = project.tracks.filter((t) => t.kind === "audio");

  const clipInputs = new Map<string, { idx: number; srcDur: number; tail: number }>();

  const prepareInput = (c: Clip, tail: number) => {
    const m = media[c.mediaId!];
    if (!m) throw new Error(`Clip "${c.label ?? c.id}" references media that no longer exists.`);
    if (m.missing) throw new Error(`Media "${m.name}" is offline (file missing). Relink it before exporting.`);
    const dur = clipDuration(c);
    if (m.kind === "image") {
      const idx = addInput(["-loop", "1", "-framerate", String(FPS), "-t", n(dur + tail), "-i", m.path]);
      clipInputs.set(c.id, { idx, srcDur: dur, tail });
      return idx;
    }
    const want = (c.out - c.in) + tail * c.speed;
    const avail = Math.max(0, m.duration - c.in);
    const idx = addInput(["-ss", n(c.in), "-t", n(Math.min(want, avail + 0.05)), "-i", m.path]);
    clipInputs.set(c.id, { idx, srcDur: dur, tail });
    return idx;
  };

  for (const track of videoTracks) {
    const clips = project.clips.filter((c) => c.trackId === track.id && c.kind === "media" && c.mediaId).sort((a, b) => a.start - b.start);
    clips.forEach((c, i) => {
      const m = media[c.mediaId!];
      const next = clips[i + 1];
      const nextAdj = next && Math.abs(next.start - clipEnd(c)) < 0.02 ? next : undefined;
      const outgoing: Transition | undefined = nextAdj?.transitionIn;
      const tail = needsOverlap(outgoing) ? outgoing!.duration : 0;
      const idx = prepareInput(c, tail);
      const dur = clipDuration(c);

      // ---------------- video layer
      if (!track.hidden && m && (m.hasVideo || m.kind === "image")) {
        const chain: string[] = [];
        const start = c.start;
        if (m.kind === "image") chain.push(`setpts=PTS-STARTPTS+${n(start)}/TB`);
        else chain.push(`setpts=(PTS-STARTPTS)/${n(c.speed)}+${n(start)}/TB`);
        chain.push(`fps=${FPS}`);
        // pad with the last frame if the source runs out before the end of the clip (+ tail)
        if (m.kind !== "image") {
          const srcAvail = (m.duration - c.in) / c.speed;
          const need = dur + tail;
          if (srcAvail < need - 0.02) chain.push(`tpad=stop_mode=clone:stop_duration=${n(need - srcAvail + 0.1)}`);
        }
        chain.push(...gradeFilters(c.color, c.fx, OH, opts.lutPath, c.id.replace(/\W/g, "")));
        const sw = m.width || OW;
        const sh = m.height || OH;
        const fitS = Math.min(OW / sw, OH / sh);
        const fillS = Math.max(OW / sw, OH / sh);
        const s = c.transform.fit === "fill" ? fillS : fitS;
        const BW = sw * s;
        const BH = sh * s;
        const mo = motionExpr(c, outgoing);
        if (mo.animated) chain.push(`scale=w='max(2,trunc(${n(BW)}*${mo.scale}/2)*2)':h='max(2,trunc(${n(BH)}*${mo.scale}/2)*2)':eval=frame:flags=bicubic`);
        else {
          const sc = c.transform.scale;
          chain.push(`scale=${Math.max(2, Math.round((BW * sc) / 2) * 2)}:${Math.max(2, Math.round((BH * sc) / 2) * 2)}:flags=bicubic`);
        }
        chain.push("format=yuva420p");
        const hasRot = Math.abs(c.transform.rotation) > 0.01 || c.keyframes.some((k) => Math.abs(k.rotation) > 0.01);
        if (hasRot) chain.push(`rotate=a='(${mo.rotation})*PI/180':ow='hypot(iw,ih)':oh='hypot(iw,ih)':c=none`);
        if (c.transform.opacity < 0.999) chain.push(`colorchannelmixer=aa=${n(c.transform.opacity)}`);
        if (mo.opacityAnimated) chain.push(`geq=lum='lum(X,Y)':cb='cb(X,Y)':cr='cr(X,Y)':a='alpha(X,Y)*clip(${mo.opacity.replace(/\bt\b/g, "T")},0,1)'`);
        // transition fades (alpha) - slides are handled by motion
        const tin = c.transitionIn;
        if (tin && tin.duration > 0 && ["crossfade", "zoom", "blur", "glitch"].includes(tin.type)) chain.push(`fade=t=in:st=${n(start)}:d=${n(tin.duration)}:alpha=1`);
        if (tin && (tin.type === "fadeBlack" || tin.type === "fadeWhite")) chain.push(`fade=t=in:st=${n(start)}:d=${n(tin.duration / 2)}:alpha=1`);
        if (outgoing && (outgoing.type === "fadeBlack" || outgoing.type === "fadeWhite")) chain.push(`fade=t=out:st=${n(start + dur - outgoing.duration / 2)}:d=${n(outgoing.duration / 2)}:alpha=1`);
        const tout = c.transitionOut;
        if (tout && tout.duration > 0 && !["swipeLeft", "swipeRight", "swipeUp", "whipPan", "cut"].includes(tout.type)) chain.push(`fade=t=out:st=${n(start + dur - tout.duration)}:d=${n(tout.duration)}:alpha=1`);

        const end = start + dur + tail;
        const lbl = `[l${c.id.replace(/\W/g, "")}]`;
        // blurred background fill (vertical reframing of landscape footage, etc.)
        if (c.transform.fit === "blurFill") {
          const bg = `[b${c.id.replace(/\W/g, "")}]`;
          const fg = `[f${c.id.replace(/\W/g, "")}]`;
          graph.push(`[${idx}:v]${chain.slice(0, 2).join(",")},split[bs${vi}]${fg}`);
          graph.push(
            `[bs${vi}]scale=${Math.ceil(sw * fillS / 2) * 2}:${Math.ceil(sh * fillS / 2) * 2},crop=${OW}:${OH},gblur=sigma=${n(30 * OH / 1080)},eq=brightness=-0.06:saturation=0.9,format=yuva420p${tin && tin.duration > 0 && tin.type !== "cut" ? `,fade=t=in:st=${n(start)}:d=${n(tin.duration)}:alpha=1` : ""}${tout && tout.duration > 0 ? `,fade=t=out:st=${n(start + dur - tout.duration)}:d=${n(tout.duration)}:alpha=1` : ""}${bg}`
          );
          const o1 = nextV();
          graph.push(`${vcur}${bg}overlay=x=0:y=0:enable='between(t,${n(start)},${n(end)})':eof_action=pass${o1}`);
          vcur = o1;
          graph.push(`${fg}${chain.slice(2).join(",")}${lbl}`);
        } else graph.push(`[${idx}:v]${chain.join(",")}${lbl}`);
        const o = nextV();
        const xE = mo.animated ? `(W-w)/2+(${mo.x})*W` : `(W-w)/2+${n(c.transform.x)}*W`;
        const yE = mo.animated ? `(H-h)/2+(${mo.y})*H` : `(H-h)/2+${n(c.transform.y)}*H`;
        graph.push(`${vcur}${lbl}overlay=x='${xE}':y='${yE}':eval=${mo.animated ? "frame" : "init"}:enable='between(t,${n(start)},${n(end)})':eof_action=pass${o}`);
        vcur = o;

        // whole-frame transition effects
        if (tin && tin.duration > 0) {
          const a = n(start - (needsOverlap(tin) ? 0 : 0));
          const b = n(start + tin.duration);
          if (tin.type === "blur") postFx.push(`gblur=sigma=${n(14 * tin.intensity * (OH / 1080) + 4)}:enable='between(t,${a},${b})'`);
          if (tin.type === "whipPan") postFx.push(`gblur=sigma=${n(40 * (OH / 1080))}:sigmaV=0.01:enable='between(t,${a},${b})'`);
          if (tin.type === "glitch") postFx.push(`rgbashift=rh=${Math.round(12 * tin.intensity * OW / 1920 + 4)}:bh=-${Math.round(12 * tin.intensity * OW / 1920 + 4)}:enable='between(t,${a},${b})'`, `noise=alls=40:allf=t:enable='between(t,${a},${b})'`);
          if (tin.type === "fadeWhite") {
            const wi = addInput(["-f", "lavfi", "-i", `color=c=white:s=${OW}x${OH}:r=${FPS}:d=${n(tin.duration)}`]);
            const wl = `[w${c.id.replace(/\W/g, "")}]`;
            graph.push(`[${wi}:v]format=yuva420p,fade=t=in:st=0:d=${n(tin.duration / 2)}:alpha=1,fade=t=out:st=${n(tin.duration / 2)}:d=${n(tin.duration / 2)}:alpha=1,setpts=PTS-STARTPTS+${n(start - tin.duration / 2)}/TB${wl}`);
            const o2 = nextV();
            graph.push(`${vcur}${wl}overlay=enable='between(t,${n(start - tin.duration / 2)},${n(start + tin.duration / 2)})':eof_action=pass${o2}`);
            vcur = o2;
          }
        }
      }

      // ---------------- audio of the clip
      if (m?.hasAudio && audible(track) && c.volume > 0.001) addClipAudio(c, idx, tail, outgoing, track.id);
    });
    adjustmentLayers(track);
  }

  function adjustmentLayers(track: Track) {
    if (track.hidden) return;
    for (const c of project.clips.filter((c) => c.trackId === track.id && c.kind === "adjustment")) {
      const u = c.id.replace(/\W/g, "");
      const f = gradeFilters(c.color, c.fx, OH, opts.lutPath, u);
      if (!f.length) continue;
      const s0 = c.start;
      const e0 = clipEnd(c);
      // grade a copy of the composite and show it only inside the layer's time window
      const o = nextV();
      graph.push(`${vcur}split[ja${u}][jb${u}];[jb${u}]${f.join(",")},format=yuva420p${c.transform.opacity < 0.999 ? `,colorchannelmixer=aa=${n(c.transform.opacity)}` : ""}[jc${u}];[ja${u}][jc${u}]overlay=enable='between(t,${n(s0)},${n(e0)})'${o}`);
      vcur = o;
    }
  }

  function addClipAudio(c: Clip, idx: number, tail: number, outgoing: Transition | undefined, trackId: string) {
    const dur = clipDuration(c);
    const a: string[] = ["aresample=48000", "aformat=sample_fmts=fltp:channel_layouts=stereo", "asetpts=PTS-STARTPTS", ...atempo(c.speed)];
    if (Math.abs(c.volume - 1) > 1e-3) a.push(`volume=${n(c.volume)}`);
    const fin = Math.max(0.012, c.fadeIn, c.transitionIn && needsOverlap(c.transitionIn) ? c.transitionIn.duration : 0);
    a.push(`afade=t=in:st=0:d=${n(Math.min(fin, dur / 2))}`);
    const total = dur + tail;
    const fout = Math.max(0.012, c.fadeOut, tail);
    a.push(`afade=t=out:st=${n(Math.max(0, total - Math.min(fout, total / 2)))}:d=${n(Math.min(fout, total / 2))}`);
    a.push(`atrim=0:${n(total)}`);
    a.push(`adelay=${Math.round(c.start * 1000)}:all=1`);
    const lbl = `[a${c.id.replace(/\W/g, "")}]`;
    graph.push(`[${idx}:a]${a.join(",")}${lbl}`);
    if (!audioByTrack.has(trackId)) audioByTrack.set(trackId, []);
    audioByTrack.get(trackId)!.push(lbl);
  }

  for (const track of audioOnlyTracks) {
    if (!audible(track)) continue;
    for (const c of project.clips.filter((c) => c.trackId === track.id && c.mediaId).sort((a, b) => a.start - b.start)) {
      const m = media[c.mediaId!];
      if (!m?.hasAudio || c.volume <= 0.001) continue;
      const idx = prepareInput(c, 0);
      addClipAudio(c, idx, 0, undefined, track.id);
    }
  }

  // ---------------- post effects, text and captions
  const post = [...postFx];
  if (opts.assPath) post.push(`ass=filename='${escPath(opts.assPath)}':fontsdir='${escPath(opts.fontsDir)}'`);
  post.push("format=yuv420p");
  graph.push(`${vcur}${post.join(",")}[vout]`);

  // ---------------- audio mix: per-track bus -> fx -> ducking -> master
  const trackOut: { id: string; role?: string; label: string; duck: boolean }[] = [];
  for (const [tid, labels] of audioByTrack) {
    const t = project.tracks.find((x) => x.id === tid)!;
    const fx = trackFx(t);
    const lbl = `[t${tid.replace(/\W/g, "")}]`;
    const mix = labels.length > 1 ? `${labels.join("")}amix=inputs=${labels.length}:normalize=0:dropout_transition=0` : `${labels[0]}anull`;
    graph.push(`${mix}${fx.length ? "," + fx.join(",") : ""}${lbl}`);
    trackOut.push({ id: tid, role: t.role ?? (t.kind === "video" ? "voice" : "music"), label: lbl, duck: !!t.duckUnderVoice });
  }
  const voices = trackOut.filter((t) => t.role === "voice");
  const ducked = trackOut.filter((t) => t.duck && t.role !== "voice");
  const finalInputs: string[] = [];
  if (voices.length && ducked.length) {
    const vbus = "[vbus]";
    graph.push(`${voices.map((v) => v.label).join("")}${voices.length > 1 ? `amix=inputs=${voices.length}:normalize=0:dropout_transition=0` : "anull"},asplit=${ducked.length + 1}${["[vmain]", ...ducked.map((_, i) => `[vsc${i}]`)].join("")}`);
    finalInputs.push("[vmain]");
    ducked.forEach((d, i) => {
      const out = `[dk${i}]`;
      graph.push(`${d.label}[vsc${i}]sidechaincompress=threshold=0.02:ratio=10:attack=25:release=450:makeup=1${out}`);
      finalInputs.push(out);
    });
    void vbus;
  } else voices.forEach((v) => finalInputs.push(v.label));
  for (const t of trackOut) if (!voices.includes(t) && !(voices.length && ducked.includes(t))) finalInputs.push(t.label);

  let audioOut = "[aout]";
  if (finalInputs.length) {
    const master: string[] = [];
    if (Math.abs(project.master.volume - 1) > 1e-3) master.push(`volume=${n(project.master.volume)}`);
    if (project.master.normalize) master.push(`loudnorm=I=${n(project.master.targetLufs)}:TP=-1.5:LRA=11`);
    if (project.master.limiter) master.push("alimiter=limit=0.89:level=false");
    master.push(`aresample=${exp.sampleRate}`, `apad=whole_dur=${n(duration)}`);
    graph.push(`${finalInputs.join("")}${finalInputs.length > 1 ? `amix=inputs=${finalInputs.length}:normalize=0:dropout_transition=0,` : ""}${master.join(",")}${audioOut}`);
  } else {
    const si = addInput(["-f", "lavfi", "-i", `anullsrc=r=${exp.sampleRate}:cl=stereo`]);
    graph.push(`[${si}:a]atrim=0:${n(duration)}${audioOut}`);
  }

  const filterGraph = graph.join(";\n");
  const args: string[] = ["-y"];
  for (const i of inputs) args.push(...i);
  args.push("-filter_complex_script", opts.filterScriptPath, "-map", "[vout]", "-map", audioOut);
  if (exp.codec === "h265") args.push("-c:v", "libx265", "-tag:v", "hvc1");
  else args.push("-c:v", "libx264", "-profile:v", "high");
  args.push("-preset", "medium", "-b:v", `${exp.videoBitrateKbps}k`, "-maxrate", `${Math.round(exp.videoBitrateKbps * 1.5)}k`, "-bufsize", `${exp.videoBitrateKbps * 2}k`);
  args.push("-pix_fmt", "yuv420p", "-r", String(FPS), "-c:a", "aac", "-b:a", `${exp.audioBitrateKbps}k`, "-ar", String(exp.sampleRate), "-t", n(duration), "-movflags", "+faststart", "-progress", "pipe:1", "-nostats", opts.outPath);
  return { args, filterGraph, duration, inputs: inputs.map((i) => i[i.length - 1]) };
}
