// Turns an approved Recommendation into concrete, undoable timeline edits.
import type { Clip, MediaItem, Project, Recommendation, Track } from "./types";
import { makeClip, makeTrack } from "./defaults";
import { clipEnd, cutSourceRanges, sourceRangeToTimeline, splitAt, rippleInsert, rippleTrackIds, EPS, clipsOnTrack } from "./timeline";
import { CAPTION_PRESETS, DEFAULT_CAPTION_STYLE } from "./presets";

export interface ApplyOptions {
  brollMedia?: MediaItem; // chosen asset for a B-roll / music recommendation
  sfxMedia?: MediaItem;
}

export class ApplyError extends Error {}

export function mainTrack(p: Project): Track | undefined {
  return p.tracks.find((t) => t.id === p.captions.sourceTrackId) ?? p.tracks.find((t) => t.kind === "video");
}

function ensureTrack(p: Project, kind: Track["kind"], role: Track["role"] | undefined, name: string, above?: string): [Project, Track] {
  let t = p.tracks.find((x) => x.kind === kind && (role === undefined || x.role === role) && (kind !== "video" || x.id !== mainTrack(p)?.id));
  if (t) return [p, t];
  t = makeTrack(kind, name, role ? { role } : {});
  const tracks = p.tracks.slice();
  const idx = above ? tracks.findIndex((x) => x.id === above) : -1;
  if (idx >= 0) tracks.splice(idx, 0, t);
  else tracks.push(t);
  return [{ ...p, tracks }, t];
}

/** Avoid creating sliver clips: move split points onto nearby existing edit points. */
function snapToEdits(p: Project, trackId: string, r: { start: number; end: number }) {
  const edges = clipsOnTrack(p.clips, trackId).flatMap((c) => [c.start, clipEnd(c)]);
  const snapOne = (t: number) => {
    let best = t;
    let d = 0.5;
    for (const e of edges) if (Math.abs(e - t) < d) {
      d = Math.abs(e - t);
      best = e;
    }
    return best;
  };
  const start = snapOne(r.start);
  const end = snapOne(r.end);
  return end - start > 0.3 ? { start, end } : r;
}

/** Find free space on a track; if occupied, returns undefined. */
function free(p: Project, trackId: string, start: number, end: number): boolean {
  return !p.clips.some((c) => c.trackId === trackId && c.start < end - EPS && clipEnd(c) > start + EPS);
}

export function applyRecommendation(p: Project, r: Recommendation, opts: ApplyOptions = {}): Project {
  const main = mainTrack(p);
  const tlRanges = r.mediaId ? sourceRangeToTimeline(p.clips, r.mediaId, r, main ? new Set([main.id]) : undefined) : [{ start: r.start, end: r.end }];
  switch (r.kind) {
    case "cut": {
      if (!r.mediaId) throw new ApplyError("Cut has no media reference");
      return { ...p, clips: cutSourceRanges(p, r.mediaId, [r], main?.id) };
    }
    case "zoom":
    case "pacing": {
      if (!tlRanges.length || !main) throw new ApplyError("This moment is no longer on the timeline");
      let range = tlRanges[0];
      if (r.kind === "pacing") {
        const mid = (range.start + range.end) / 2;
        range = { start: mid, end: Math.min(range.end, mid + 4) };
      }
      const ids = new Set([main.id]);
      range = snapToEdits(p, main.id, range);
      let clips = splitAt(splitAt(p.clips, range.start, ids), range.end, ids);
      clips = clips.map((c) =>
        c.trackId === main.id && c.start >= range.start - EPS && clipEnd(c) <= range.end + EPS
          ? { ...c, motion: { preset: r.payload?.motion ?? "punchIn", intensity: r.payload?.intensity ?? 0.6 }, linkedTo: r.id }
          : c
      );
      return { ...p, clips };
    }
    case "transition": {
      if (!main) throw new ApplyError("No main track");
      const t = tlRanges[0]?.start ?? r.start;
      const type = r.payload?.transitionType ?? "crossfade";
      const duration = type === "fadeBlack" ? 0.8 : 0.4;
      // find the clip edge closest to t on the main track; split there if needed
      let clips = p.clips;
      const onMain = clipsOnTrack(clips, main.id);
      let target: Clip | undefined = onMain
        .filter((c) => Math.abs(c.start - t) < 0.75 && c.start > EPS)
        .sort((a, b) => Math.abs(a.start - t) - Math.abs(b.start - t))[0];
      if (!target) {
        clips = splitAt(clips, t, new Set([main.id]));
        target = clipsOnTrack(clips, main.id).find((c) => Math.abs(c.start - t) < EPS);
      }
      if (!target) throw new ApplyError("Could not find a cut point for this transition");
      const tid = target.id;
      return { ...p, clips: clips.map((c) => (c.id === tid ? { ...c, transitionIn: { type, duration, intensity: 0.6 } } : c)) };
    }
    case "broll": {
      const m = opts.brollMedia;
      if (!m) throw new ApplyError("Choose or upload a visual for this B-roll suggestion first");
      const at = tlRanges[0]?.start ?? r.start;
      const dur = r.payload?.duration ?? 4;
      let [p2, track] = ensureTrack(p, "video", undefined, "V2 · B-roll", main?.id);
      if (!free(p2, track.id, at, at + dur)) {
        // add an extra overlay track rather than overwrite existing B-roll
        track = makeTrack("video", `V${p2.tracks.filter((t) => t.kind === "video").length + 1} · B-roll`);
        p2 = { ...p2, tracks: [track, ...p2.tracks] };
      }
      const srcDur = m.kind === "image" ? dur : Math.min(dur, m.duration);
      const clip = makeClip({
        trackId: track.id,
        mediaId: m.id,
        start: at,
        in: 0,
        out: srcDur,
        volume: 0,
        transform: { fit: "fill", scale: 1, x: 0, y: 0, rotation: 0, opacity: 1, cropX: 0 },
        motion: { preset: r.payload?.animation ?? "slowZoomIn", intensity: 0.5 },
        transitionIn: { type: r.payload?.transition ?? "crossfade", duration: 0.4, intensity: 0.5 },
        transitionOut: { type: "crossfade", duration: 0.35, intensity: 0.5 },
        label: m.name,
        linkedTo: r.id,
      });
      return { ...p2, clips: [...p2.clips, clip], mediaIds: p2.mediaIds.includes(m.id) ? p2.mediaIds : [...p2.mediaIds, m.id] };
    }
    case "music":
    case "sfx": {
      const m = r.kind === "music" ? opts.brollMedia ?? opts.sfxMedia : opts.sfxMedia ?? opts.brollMedia;
      if (!m) throw new ApplyError("Choose an audio file for this suggestion first");
      const role = r.kind === "music" ? "music" : "sfx";
      const [p2, track] = ensureTrack(p, "audio", role, role === "music" ? "A2 · Music" : "A3 · SFX");
      const total = p2.clips.reduce((d, c) => Math.max(d, clipEnd(c)), 0);
      const at = r.kind === "music" ? 0 : (tlRanges[0]?.start ?? r.start);
      const len = r.kind === "music" ? Math.min(m.duration, Math.max(1, total)) : m.duration;
      const clips: Clip[] = [];
      if (r.kind === "music" && m.duration > 0) {
        // loop the bed to cover the whole edit
        for (let s = 0; s < Math.max(total, 1) - EPS; s += m.duration) {
          clips.push(makeClip({ trackId: track.id, mediaId: m.id, start: s, in: 0, out: Math.min(m.duration, total - s), volume: 0.35, fadeIn: s === 0 ? 1.5 : 0.3, fadeOut: 1.5, label: m.name, linkedTo: r.id }));
        }
      } else clips.push(makeClip({ trackId: track.id, mediaId: m.id, start: at, in: 0, out: len, volume: r.kind === "sfx" ? 0.5 : 0.35, label: m.name, linkedTo: r.id }));
      const tracks = p2.tracks.map((t) => (t.id === track.id && role === "music" ? { ...t, duckUnderVoice: true } : t));
      return { ...p2, tracks, clips: [...p2.clips, ...clips], mediaIds: p2.mediaIds.includes(m.id) ? p2.mediaIds : [...p2.mediaIds, m.id] };
    }
    case "color": {
      const g = r.payload?.grade ?? {};
      return { ...p, clips: p.clips.map((c) => (c.mediaId === r.mediaId ? { ...c, color: { ...c.color, ...g } } : c)) };
    }
    case "audio": {
      let next = p;
      if (r.payload?.master) next = { ...next, master: { ...next.master, ...r.payload.master } };
      if (r.payload?.fx) {
        const role = r.payload.trackRole ?? "voice";
        const ids = new Set(next.clips.filter((c) => c.mediaId === r.mediaId).map((c) => c.trackId));
        next = { ...next, tracks: next.tracks.map((t) => ((t.role === role && t.kind !== "text" && (ids.has(t.id) || !r.mediaId)) || ids.has(t.id) ? { ...t, fx: { ...t.fx, ...r.payload!.fx } } : t)) };
      }
      return next;
    }
    case "caption": {
      const preset = CAPTION_PRESETS.find((x) => x.id === r.payload?.captionPreset) ?? CAPTION_PRESETS[0];
      return { ...p, captions: { ...p.captions, enabled: true, style: { ...DEFAULT_CAPTION_STYLE, ...preset.style, preset: preset.id, positionY: p.settings.height > p.settings.width ? 0.7 : preset.style.positionY ?? 0.82 } } };
    }
    case "hook": {
      if (!r.mediaId || !main) throw new ApplyError("Hook needs a source clip");
      const len = r.end - r.start;
      const tracks = rippleTrackIds(p.tracks);
      let clips = rippleInsert(p.clips, 0, len, tracks);
      const src = p.clips.find((c) => c.mediaId === r.mediaId && c.trackId === main.id);
      const hookClip = makeClip({
        ...(src ? { transform: src.transform, color: src.color, fx: src.fx } : {}),
        trackId: main.id,
        mediaId: r.mediaId,
        start: 0,
        in: r.start,
        out: r.end,
        motion: { preset: "punchIn", intensity: 0.4 },
        label: "Cold open",
        linkedTo: r.id,
      });
      clips = [...clips, hookClip];
      // the clip after the hook gets a quick swipe so the cold open reads as a teaser
      const after = clips.filter((c) => c.trackId === main.id && Math.abs(c.start - len) < EPS && c.id !== hookClip.id)[0];
      if (after) clips = clips.map((c) => (c.id === after.id ? { ...c, transitionIn: { type: "whipPan", duration: 0.25, intensity: 0.6 } } : c));
      return { ...p, clips };
    }
    case "title": {
      const [p2, track] = ensureTrack(p, "text", undefined, "T1 · Titles");
      return {
        ...p2,
        clips: [
          ...p2.clips,
          makeClip({
            trackId: track.id,
            kind: "text",
            start: tlRanges[0]?.start ?? r.start,
            in: 0,
            out: Math.max(1.5, r.end - r.start),
            text: {
              template: r.payload?.template ?? "title",
              text: r.payload?.text ?? r.title,
              x: 0.5,
              y: 0.45,
              w: 0.3,
              h: 0.1,
              rotation: 0,
              style: { font: "montserrat-black", size: 110, color: "#ffffff", accent: "#7b2ff7", background: false, outline: 4, shadow: 2, uppercase: true },
              animIn: "pop",
              animOut: "fade",
            },
            linkedTo: r.id,
          }),
        ],
      };
    }
  }
}

/** Timeline duration saved if all given cut recommendations were applied. */
export function estimateSaved(p: Project, recs: Recommendation[]): number {
  const main = mainTrack(p);
  let n = 0;
  for (const r of recs) if (r.kind === "cut" && r.mediaId) for (const t of sourceRangeToTimeline(p.clips, r.mediaId, r, main ? new Set([main.id]) : undefined)) n += t.end - t.start;
  return n;
}
