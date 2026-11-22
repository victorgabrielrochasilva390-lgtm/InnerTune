// Pure, non-destructive timeline operations. They never touch media files; they only
// rewrite clip in/out/start values. All functions return new arrays (immutability keeps
// undo/redo cheap through structural sharing).
import type { Clip, Project, Track, Range, Word } from "./types";
import { uid } from "./defaults";

export const EPS = 1e-4;

export function clipDuration(c: Clip): number {
  return Math.max(0, (c.out - c.in) / (c.speed || 1));
}

export function clipEnd(c: Clip): number {
  return c.start + clipDuration(c);
}

export function projectDuration(p: Pick<Project, "clips">): number {
  let d = 0;
  for (const c of p.clips) d = Math.max(d, clipEnd(c));
  return d;
}

/** timeline time -> source time for a media clip */
export function toSource(c: Clip, t: number): number {
  return c.in + (t - c.start) * c.speed;
}

/** source time -> timeline time */
export function toTimeline(c: Clip, s: number): number {
  return c.start + (s - c.in) / c.speed;
}

export function clipsOnTrack(clips: Clip[], trackId: string): Clip[] {
  return clips.filter((c) => c.trackId === trackId).sort((a, b) => a.start - b.start);
}

export function activeClipsAt(clips: Clip[], t: number): Clip[] {
  return clips.filter((c) => t >= c.start - EPS && t < clipEnd(c) - EPS);
}

/** Split a clip at timeline time t. Returns [left, right] or null when t is outside. */
export function splitClip(c: Clip, t: number): [Clip, Clip] | null {
  if (t <= c.start + EPS || t >= clipEnd(c) - EPS) return null;
  const s = toSource(c, t);
  const left: Clip = { ...c, out: s, fadeOut: 0, transitionOut: undefined };
  const right: Clip = { ...c, id: uid("clp"), start: t, in: s, fadeIn: 0, transitionIn: undefined, keyframes: shiftKeyframes(c, t - c.start) };
  left.keyframes = c.keyframes.filter((k) => k.t <= t - c.start + EPS);
  return [left, right];
}

function shiftKeyframes(c: Clip, offset: number) {
  return c.keyframes.filter((k) => k.t >= offset - EPS).map((k) => ({ ...k, t: k.t - offset }));
}

export function splitAt(clips: Clip[], t: number, trackIds?: Set<string>, onlyIds?: Set<string>): Clip[] {
  const out: Clip[] = [];
  for (const c of clips) {
    if ((trackIds && !trackIds.has(c.trackId)) || (onlyIds && !onlyIds.has(c.id))) {
      out.push(c);
      continue;
    }
    const r = splitClip(c, t);
    if (r) out.push(r[0], r[1]);
    else out.push(c);
  }
  return out;
}

/**
 * Remove [t0,t1) from the given tracks and shift everything after it left
 * (ripple delete). Clips spanning the range are trimmed / split.
 */
export function rippleDeleteRange(clips: Clip[], t0: number, t1: number, trackIds: Set<string>): Clip[] {
  const len = t1 - t0;
  if (len <= EPS) return clips;
  let next = splitAt(splitAt(clips, t0, trackIds), t1, trackIds);
  const result: Clip[] = [];
  for (const c of next) {
    if (!trackIds.has(c.trackId)) {
      result.push(c);
      continue;
    }
    const e = clipEnd(c);
    if (c.start >= t0 - EPS && e <= t1 + EPS) continue; // inside: removed
    if (c.start >= t1 - EPS) result.push({ ...c, start: Math.max(0, c.start - len) });
    else result.push(c);
  }
  return result;
}

/** Delete clips and close the gaps they leave on their own tracks. */
export function rippleDeleteClips(clips: Clip[], ids: Set<string>): Clip[] {
  let result = clips.slice();
  const targets = clips.filter((c) => ids.has(c.id)).sort((a, b) => b.start - a.start);
  for (const t of targets) {
    const len = clipDuration(t);
    result = result
      .filter((c) => c.id !== t.id)
      .map((c) => (c.trackId === t.trackId && c.start >= t.start + EPS ? { ...c, start: Math.max(0, c.start - len) } : c));
  }
  return result;
}

/** Insert space at time t on given tracks (used for insert edits). */
export function rippleInsert(clips: Clip[], t: number, len: number, trackIds: Set<string>): Clip[] {
  const split = splitAt(clips, t, trackIds);
  return split.map((c) => (trackIds.has(c.trackId) && c.start >= t - EPS ? { ...c, start: c.start + len } : c));
}

/** Map a source range on media M to timeline ranges through clips on the given track(s). */
export function sourceRangeToTimeline(clips: Clip[], mediaId: string, r: Range, trackIds?: Set<string>): Range[] {
  const out: Range[] = [];
  for (const c of clips) {
    if (c.mediaId !== mediaId || (trackIds && !trackIds.has(c.trackId))) continue;
    const s = Math.max(r.start, c.in);
    const e = Math.min(r.end, c.out);
    if (e - s > EPS) out.push({ start: toTimeline(c, s), end: toTimeline(c, e) });
  }
  return mergeRanges(out);
}

export function mergeRanges(rs: Range[]): Range[] {
  const sorted = rs.slice().sort((a, b) => a.start - b.start);
  const out: Range[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r.start <= last.end + EPS) last.end = Math.max(last.end, r.end);
    else out.push({ ...r });
  }
  return out;
}

/** Tracks that should ripple together when content is removed from the main story. */
export function rippleTrackIds(tracks: Track[]): Set<string> {
  return new Set(tracks.filter((t) => !t.locked).map((t) => t.id));
}

/** Remove a list of source ranges of one media from the timeline (AI cuts). */
export function cutSourceRanges(project: Project, mediaId: string, ranges: Range[], mainTrackId?: string): Clip[] {
  const main = mainTrackId ? new Set([mainTrackId]) : undefined;
  const tl = mergeRanges(ranges.flatMap((r) => sourceRangeToTimeline(project.clips, mediaId, r, main)));
  const tracks = rippleTrackIds(project.tracks);
  let clips = project.clips;
  for (const r of tl.sort((a, b) => b.start - a.start)) clips = rippleDeleteRange(clips, r.start, r.end, tracks);
  return clips;
}

/** Snap candidate positions: clip edges, playhead, markers. */
export function snapPoints(project: Project, exclude: Set<string>, playhead: number): number[] {
  const pts = [0, playhead];
  for (const c of project.clips) if (!exclude.has(c.id)) pts.push(c.start, clipEnd(c));
  for (const m of project.markers) pts.push(m.t);
  return pts;
}

export function snap(t: number, points: number[], threshold: number): number {
  let best = t;
  let bestD = threshold;
  for (const p of points) {
    const d = Math.abs(p - t);
    if (d < bestD) {
      bestD = d;
      best = p;
    }
  }
  return best;
}

/** Does a clip overlap others on the same track? */
export function overlaps(clips: Clip[], c: Clip): boolean {
  return clips.some((o) => o.id !== c.id && o.trackId === c.trackId && o.start < clipEnd(c) - EPS && clipEnd(o) > c.start + EPS);
}

/** Resolve overlaps on a track after a move by trimming/removing what the moved clip covers (overwrite edit). */
export function overwrite(clips: Clip[], moved: Clip): Clip[] {
  const t0 = moved.start;
  const t1 = clipEnd(moved);
  const track = new Set([moved.trackId]);
  const others = clips.filter((c) => c.id !== moved.id);
  let split = splitAt(splitAt(others, t0, track), t1, track);
  split = split.filter((c) => !(c.trackId === moved.trackId && c.start >= t0 - EPS && clipEnd(c) <= t1 + EPS));
  return [...split, moved];
}

/** Words of a transcript that are visible on the timeline, mapped to timeline time. */
export interface TimelineWord extends Word {
  tStart: number;
  tEnd: number;
  clipId: string;
}

export function timelineWords(project: Project, trackId?: string): TimelineWord[] {
  const tid = trackId ?? project.captions.sourceTrackId ?? project.tracks.find((t) => t.kind === "video")?.id;
  const out: TimelineWord[] = [];
  const clips = project.clips.filter((c) => c.trackId === tid && c.mediaId).sort((a, b) => a.start - b.start);
  // Also include audio-track voice clips so podcasts / voice-overs get captions.
  const voiceTracks = new Set(project.tracks.filter((t) => t.kind === "audio" && t.role === "voice").map((t) => t.id));
  const voiceClips = project.clips.filter((c) => voiceTracks.has(c.trackId) && c.mediaId);
  for (const c of [...clips, ...voiceClips]) {
    const tr = project.transcripts[c.mediaId!];
    if (!tr) continue;
    for (const w of tr.words) {
      const mid = (w.start + w.end) / 2;
      if (mid < c.in || mid >= c.out) continue;
      const s = Math.max(w.start, c.in);
      const e = Math.min(w.end, c.out);
      out.push({ ...w, tStart: toTimeline(c, s), tEnd: toTimeline(c, e), clipId: c.id });
    }
  }
  out.sort((a, b) => a.tStart - b.tStart);
  // remove duplicates if the same media is both on video and a voice track at the same time
  return out.filter((w, i) => i === 0 || !(Math.abs(w.tStart - out[i - 1].tStart) < 0.01 && w.id === out[i - 1].id));
}

export function formatTime(t: number, fps = 30, withFrames = true): string {
  const sign = t < 0 ? "-" : "";
  t = Math.abs(t);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = Math.floor(t % 60);
  const f = Math.floor((t - Math.floor(t)) * fps + 1e-6);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${sign}${pad(h)}:${pad(m)}:${pad(s)}${withFrames ? ":" + pad(f) : ""}`;
}

export function formatShort(t: number): string {
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${String(m).padStart(2, "0")}:${s.toFixed(1).padStart(4, "0")}`;
}

/** Restrict a project to a timeline range and shift it to start at 0. */
export function sliceProject(p: Project, start: number, end: number): Project {
  let clips = splitAt(splitAt(p.clips, start), end);
  clips = clips.filter((c) => c.start >= start - EPS && clipEnd(c) <= end + EPS).map((c) => ({ ...c, start: c.start - start }));
  return { ...p, clips, markers: p.markers.filter((m) => m.t >= start && m.t <= end).map((m) => ({ ...m, t: m.t - start })) };
}

