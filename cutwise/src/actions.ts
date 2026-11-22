// Editing actions shared by the timeline, panels and keyboard shortcuts. Every change
// goes through store.commit/replaceProject so it is undoable and autosaved.
import type { Clip, MediaItem, Project, Recommendation, TextTemplate, Transition, TransitionType, MotionPreset, Transcript, Word } from "../shared/types";
import { makeClip, makeProject, makeTextData, makeTrack, uid } from "../shared/defaults";
import { clipDuration, clipEnd, clipsOnTrack, EPS, overwrite, rippleDeleteClips, splitAt, cutSourceRanges, rippleTrackIds, sourceRangeToTimeline, toSource, sliceProject } from "../shared/timeline";
import { applyRecommendation, ApplyError, mainTrack } from "../shared/apply";
import { ASPECTS, CAPTION_PRESETS, DEFAULT_CAPTION_STYLE, TRANSITIONS } from "../shared/presets";
import { parseSubtitles } from "../shared/captions";
import { useEditor } from "./store";
import { api, waitForJob, type PubMedia } from "./api";

const S = () => useEditor.getState();

export function trackForMedia(p: Project, m: PubMedia, preferred?: string) {
  const want = m.kind === "audio" ? "audio" : "video";
  const pref = preferred ? p.tracks.find((t) => t.id === preferred && t.kind === want) : undefined;
  if (pref) return pref;
  if (want === "video") return mainTrack(p) ?? p.tracks.find((t) => t.kind === "video")!;
  return p.tracks.find((t) => t.kind === "audio" && (m.duration > 20 ? t.role === "music" : t.role === "sfx")) ?? p.tracks.find((t) => t.kind === "audio")!;
}

export function addMedia(m: PubMedia, at?: number, trackId?: string) {
  const p = S().project;
  if (!p) return;
  if (m.status === "error") return S().toast(`${m.name} failed to import`, "error");
  const tr = trackForMedia(p, m, trackId);
  if (!tr) return;
  const dur = m.kind === "image" ? 4 : m.duration;
  const start = at ?? clipsOnTrack(p.clips, tr.id).reduce((e, c) => Math.max(e, clipEnd(c)), 0);
  const clip = makeClip({ trackId: tr.id, mediaId: m.id, start, in: 0, out: dur, label: m.name, volume: m.hasAudio ? 1 : 0, motion: { preset: m.kind === "image" ? "kenBurns" : "none", intensity: 0.5 } });
  S().commit(`Add ${m.name}`, (d) => {
    d.clips = overwrite(d.clips as Clip[], clip) as any;
    if (!d.mediaIds.includes(m.id)) d.mediaIds.push(m.id);
  });
  S().set({ selection: [clip.id] });
}

export function splitAtPlayhead() {
  const { project: p, playhead, selection } = S();
  if (!p) return;
  const locked = new Set(p.tracks.filter((t) => t.locked).map((t) => t.id));
  const targets = selection.length ? new Set(selection) : undefined;
  const tracks = new Set(p.tracks.filter((t) => !locked.has(t.id)).map((t) => t.id));
  const before = p.clips.length;
  const clips = splitAt(p.clips, playhead, tracks, targets);
  if (clips.length === before) return S().toast("Nothing to split at the playhead");
  S().replaceProject("Split", { ...p, clips });
}

export function splitClipAt(clipId: string, t: number) {
  const p = S().project;
  if (!p) return;
  S().replaceProject("Blade cut", { ...p, clips: splitAt(p.clips, t, undefined, new Set([clipId])) });
}

export function deleteSelection(ripple: boolean) {
  const { project: p, selection } = S();
  if (!p || !selection.length) return;
  const locked = new Set(p.tracks.filter((t) => t.locked).map((t) => t.id));
  const ids = new Set(p.clips.filter((c) => selection.includes(c.id) && !locked.has(c.trackId)).map((c) => c.id));
  const clips = ripple ? rippleDeleteClips(p.clips, ids) : p.clips.filter((c) => !ids.has(c.id));
  S().replaceProject(ripple ? "Ripple delete" : "Delete", { ...p, clips });
  S().set({ selection: [] });
}

export function duplicateSelection() {
  const { project: p, selection } = S();
  if (!p || !selection.length) return;
  const sel = p.clips.filter((c) => selection.includes(c.id));
  const end = Math.max(...sel.map(clipEnd));
  const start = Math.min(...sel.map((c) => c.start));
  let clips = p.clips;
  const ids: string[] = [];
  for (const c of sel) {
    const copy = { ...structuredClone(c), id: uid("clp"), start: c.start - start + end };
    ids.push(copy.id);
    clips = overwrite(clips, copy);
  }
  S().replaceProject("Duplicate", { ...p, clips });
  S().set({ selection: ids });
}

export function updateClip(id: string, label: string, fn: (c: Clip) => void, key?: string) {
  S().commit(
    label,
    (d) => {
      const c = d.clips.find((x) => x.id === id);
      if (c) fn(c as Clip);
    },
    key
  );
}

export function updateSelected(label: string, fn: (c: Clip) => void, key?: string) {
  const sel = S().selection;
  S().commit(
    label,
    (d) => {
      for (const c of d.clips) if (sel.includes(c.id)) fn(c as Clip);
    },
    key
  );
}

export function addText(template: TextTemplate, text?: string) {
  const p = S().project;
  if (!p) return;
  let tr = p.tracks.find((t) => t.kind === "text");
  const t0 = S().playhead;
  const dur = template === "progressBar" ? Math.max(3, clipEnd(p.clips.reduce((a, c) => (clipEnd(c) > clipEnd(a) ? c : a), p.clips[0] ?? makeClip({ trackId: "", out: 3 }))) - t0) : 3;
  S().commit(`Add ${template}`, (d) => {
    if (!tr) {
      tr = makeTrack("text", "T1 · Titles");
      d.tracks.unshift(tr as any);
    }
    // find a free text track at this time, or create one
    let target = d.tracks.find((t) => t.kind === "text" && !d.clips.some((c) => c.trackId === t.id && c.start < t0 + dur && clipEnd(c as Clip) > t0));
    if (!target) {
      target = makeTrack("text", `T${d.tracks.filter((t) => t.kind === "text").length + 1} · Text`) as any;
      d.tracks.unshift(target as any);
    }
    const c = makeClip({ trackId: target!.id, kind: "text", start: t0, in: 0, out: dur, text: makeTextData(template, text) });
    d.clips.push(c as any);
    queueMicrotask(() => S().set({ selection: [c.id] }));
  });
}

export function addAdjustmentLayer() {
  const p = S().project;
  if (!p) return;
  const t0 = S().playhead;
  S().commit("Add adjustment layer", (d) => {
    let target = d.tracks.find((t) => t.kind === "video" && t.name.includes("Adjust"));
    if (!target) {
      target = makeTrack("video", "Adjustment", { role: undefined }) as any;
      const idx = d.tracks.findIndex((t) => t.kind === "video");
      d.tracks.splice(Math.max(0, idx), 0, target as any);
    }
    const c = makeClip({ trackId: target!.id, kind: "adjustment", start: t0, in: 0, out: 5, label: "Adjustment" });
    d.clips.push(c as any);
    queueMicrotask(() => S().set({ selection: [c.id], workspace: "color" }));
  });
}

export function setTransition(clipIds: string[], type: TransitionType, which: "in" | "out" = "in") {
  const def = TRANSITIONS.find((t) => t.id === type)!;
  const tr: Transition | undefined = type === "cut" ? undefined : { type, duration: def.defaultDuration, intensity: 0.6 };
  S().commit(`Transition: ${def.label}`, (d) => {
    for (const c of d.clips) if (clipIds.includes(c.id)) {
      const cap = clipDuration(c as Clip) / 2;
      const t2 = tr ? { ...tr, duration: Math.min(tr.duration, cap) } : undefined;
      if (which === "in") c.transitionIn = t2;
      else c.transitionOut = t2;
    }
  });
}

export function setMotion(clipIds: string[], preset: MotionPreset) {
  S().commit(`Motion: ${preset}`, (d) => {
    for (const c of d.clips) if (clipIds.includes(c.id)) c.motion = { preset, intensity: c.motion.intensity || 0.5 };
  });
}

// ------------------------------------------------------------------ aspect + reframing

export async function setAspect(aspect: string, mode: "fit" | "fill" | "blurFill" | "smart") {
  const p = S().project;
  if (!p) return;
  const size = ASPECTS[aspect];
  const vertical = size.height > size.width;
  S().commit(`Aspect ${aspect}`, (d) => {
    d.settings.width = size.width;
    d.settings.height = size.height;
    d.settings.aspect = aspect;
    d.ai.goals.platform = vertical ? (d.ai.goals.platform === "youtube" ? "shorts" : d.ai.goals.platform) : "youtube";
    for (const c of d.clips) {
      if (c.kind !== "media") continue;
      const tr = d.tracks.find((t) => t.id === c.trackId);
      if (tr?.kind !== "video") continue;
      c.transform.fit = mode === "smart" ? "fill" : mode;
      c.transform.x = 0;
    }
    d.captions.style.positionY = vertical ? 0.7 : 0.85;
    d.captions.style.autoSafeArea = true;
  });
  if (mode === "smart") await smartReframe();
}

/** Run saliency-based subject finding and centre every scene on the subject. */
export async function smartReframe() {
  const p = S().project;
  if (!p) return;
  const main = mainTrack(p);
  if (!main) return;
  const mids = [...new Set(p.clips.filter((c) => c.trackId === main.id && c.mediaId).map((c) => c.mediaId!))];
  S().toast("Finding subjects for smart reframing…");
  const results: Record<string, { scenes: { start: number; end: number; x: number }[] }> = {};
  for (const id of mids) {
    const m = S().media[id];
    if (!m || !m.hasVideo) continue;
    const job = await api.reframe(id);
    results[id] = await waitForJob(job.id);
  }
  const cur = S().project!;
  let clips = cur.clips;
  const W = cur.settings.width;
  const H = cur.settings.height;
  // split main-track clips at scene boundaries so each scene gets its own framing
  for (const id of Object.keys(results))
    for (const sc of results[id].scenes)
      for (const c of clips.filter((c) => c.trackId === main.id && c.mediaId === id)) {
        if (sc.start > c.in + 0.3 && sc.start < c.out - 0.3) clips = splitAt(clips, c.start + (sc.start - c.in) / c.speed, undefined, new Set([c.id]));
      }
  clips = clips.map((c) => {
    if (c.trackId !== main.id || !c.mediaId || !results[c.mediaId]) return c;
    const m = S().media[c.mediaId];
    const mid = (c.in + c.out) / 2;
    const sc = results[c.mediaId].scenes.find((s) => mid >= s.start && mid < s.end) ?? results[c.mediaId].scenes[0];
    if (!sc || !m) return c;
    const fill = Math.max(W / m.width, H / m.height);
    const scaledW = m.width * fill * c.transform.scale;
    const maxOff = (scaledW - W) / 2 / W;
    const x = Math.max(-maxOff, Math.min(maxOff, ((0.5 - sc.x) * scaledW) / W));
    return { ...c, transform: { ...c.transform, fit: "fill" as const, x } };
  });
  S().replaceProject("Smart reframe", { ...cur, clips });
  S().toast("Smart reframing applied: each scene is centred on its subject", "success");
}

// ------------------------------------------------------------------ transcripts & captions

export async function transcribeMedia(mediaId: string, provider: string, language?: string) {
  const job = await api.transcribe(mediaId, provider, language || undefined);
  const t = await waitForJob<Transcript>(job.id);
  setTranscript(t);
  S().toast(`Transcribed ${t.words.length} words`, "success");
  return t;
}

export function setTranscript(t: Transcript) {
  S().commit("Transcript", (d) => {
    d.transcripts[t.mediaId] = t as any;
    if (!d.captions.enabled) d.captions.enabled = true;
  });
}

export function importSubtitles(mediaId: string, text: string) {
  const words = parseSubtitles(text);
  if (!words.length) throw new Error("No cues found in that file");
  setTranscript({ mediaId, provider: "srt-import", approximate: true, words });
  S().toast(`Imported ${words.length} words (timings approximated per cue)`, "success");
}

export function editWord(mediaId: string, wordId: string, patch: Partial<Word>, key?: string) {
  S().commit(
    "Edit caption",
    (d) => {
      const w = d.transcripts[mediaId]?.words.find((x) => x.id === wordId);
      if (w) Object.assign(w, patch);
    },
    key
  );
}

/** Text-based editing: remove the selected words from the video itself (ripple cut). */
export function cutWordsFromVideo(mediaId: string, wordIds: string[]) {
  const p = S().project;
  if (!p) return;
  const tr = p.transcripts[mediaId];
  if (!tr) return;
  const sel = tr.words.filter((w) => wordIds.includes(w.id));
  if (!sel.length) return;
  const ranges = [];
  for (const w of sel) {
    const i = tr.words.indexOf(w);
    const prevEnd = tr.words[i - 1]?.end ?? w.start;
    const nextStart = tr.words[i + 1]?.start ?? w.end;
    ranges.push({ start: Math.max(prevEnd, w.start - 0.03), end: Math.min(nextStart, w.end + 0.03) });
  }
  S().replaceProject(`Cut ${sel.length} word(s)`, { ...p, clips: cutSourceRanges(p, mediaId, ranges, mainTrack(p)?.id) });
}

export function applyCaptionPreset(id: string) {
  const preset = CAPTION_PRESETS.find((x) => x.id === id) ?? CAPTION_PRESETS[0];
  S().commit(`Caption style: ${preset.label}`, (d) => {
    const vertical = d.settings.height > d.settings.width;
    d.captions.enabled = true;
    d.captions.style = { ...DEFAULT_CAPTION_STYLE, ...preset.style, preset: preset.id, positionY: vertical ? Math.min(0.72, preset.style.positionY ?? 0.7) : preset.style.positionY ?? 0.82 } as any;
  });
}

// ------------------------------------------------------------------ AI recommendations

function mediaFull(): Record<string, MediaItem> {
  return S().media as unknown as Record<string, MediaItem>;
}

export async function runDirector(useClaude: boolean, useVision: boolean) {
  const p = S().project;
  if (!p) return;
  const job = await api.direct(p, useClaude, useVision);
  const res = await waitForJob<{ recommendations: Recommendation[]; kit: any; summary: string; strategy: string[]; warnings: string[]; source: "heuristic" | "claude"; model?: string }>(job.id);
  S().commit("AI editing plan", (d) => {
    d.ai.recommendations = res.recommendations as any;
    d.ai.kit = res.kit;
    d.ai.summary = res.summary;
    d.ai.strategy = res.strategy;
    d.ai.lastRun = { at: Date.now(), source: res.source, model: res.model, warnings: res.warnings };
  });
  if (p.ai.goals.mode === "automatic") {
    const auto = res.recommendations.filter((r) => r.auto);
    const n = applyMany(auto.map((r) => r.id), "AI auto-edit");
    S().toast(`Automatic mode: applied ${n} safe changes. Everything else is waiting for your approval.`, "success");
  } else S().toast(`${res.recommendations.length} recommendations ready${res.source === "claude" ? " (Claude)" : ""}`, "success");
  return res;
}

async function mediaForRec(r: Recommendation, chosen?: PubMedia): Promise<PubMedia | undefined> {
  if (chosen) return chosen;
  if ((r.kind === "sfx" || r.kind === "music") && r.payload?.sfxId) {
    const id = S().sfx[r.payload.sfxId];
    if (id) {
      if (!S().media[id]) await S().refreshMedia([id]);
      return S().media[id];
    }
  }
  return undefined;
}

export async function applyRec(id: string, chosen?: PubMedia) {
  const p = S().project;
  const r = p?.ai.recommendations.find((x) => x.id === id);
  if (!p || !r) return;
  try {
    const m = await mediaForRec(r, chosen);
    const next = applyRecommendation(S().project!, r, { brollMedia: m as any, sfxMedia: m as any });
    next.ai = { ...next.ai, recommendations: next.ai.recommendations.map((x) => (x.id === id ? { ...x, status: "applied" as const } : x)) };
    S().replaceProject(`AI: ${r.title}`, next);
  } catch (e) {
    S().toast((e as Error).message, e instanceof ApplyError ? "info" : "error");
  }
}

/** Apply several recommendations as a single undo step. Returns how many were applied. */
export function applyMany(ids: string[], label: string): number {
  let p = S().project;
  if (!p) return 0;
  let n = 0;
  for (const id of ids) {
    const r = p.ai.recommendations.find((x) => x.id === id);
    if (!r || r.status === "applied" || r.status === "rejected") continue;
    try {
      p = applyRecommendation(p, r, {});
      p = { ...p, ai: { ...p.ai, recommendations: p.ai.recommendations.map((x) => (x.id === id ? { ...x, status: "applied" as const } : x)) } };
      n++;
    } catch {}
  }
  if (n) S().replaceProject(label, p);
  return n;
}

export function setRecStatus(id: string, status: Recommendation["status"]) {
  S().commit(status === "rejected" ? "Reject suggestion" : "Update suggestion", (d) => {
    const r = d.ai.recommendations.find((x) => x.id === id);
    if (r) r.status = status;
  });
}

export function adjustRec(id: string, patch: Partial<Recommendation>) {
  S().commit(
    "Adjust suggestion",
    (d) => {
      const r = d.ai.recommendations.find((x) => x.id === id);
      if (r) {
        Object.assign(r, patch);
        if (r.kind === "cut" && r.payload) r.payload.savedSeconds = r.end - r.start;
      }
    },
    `adj-${id}`
  );
}

/** Timeline position of a recommendation (or null when it is no longer in the edit). */
export function recTimeline(p: Project, r: Recommendation) {
  if (!r.mediaId) return r.end > r.start ? { start: r.start, end: r.end } : null;
  const main = mainTrack(p);
  const t = sourceRangeToTimeline(p.clips, r.mediaId, r, main ? new Set([main.id]) : undefined);
  if (t.length) return { start: t[0].start, end: t[t.length - 1].end };
  // cut regions disappear from the timeline once applied: report where the cut point is
  for (const c of p.clips) if (c.mediaId === r.mediaId && c.trackId === main?.id && c.in >= r.end - 0.05 && c.in <= r.end + 0.5) return { start: c.start, end: c.start };
  return null;
}

/** Preview a recommendation: play from a little before it (skipping a proposed cut). */
export function previewRec(r: Recommendation) {
  const p = S().project;
  if (!p) return;
  const tl = recTimeline(p, r);
  if (!tl) return S().toast("This moment is not on the timeline any more");
  S().set({ previewSkip: r.kind === "cut" && r.status !== "applied" ? [tl] : null, playhead: Math.max(0, tl.start - 2), playing: true, focusRec: r.id });
}

// ------------------------------------------------------------------ shorts

export async function createShortProject(short: { start: number; end: number; mediaId?: string; title: string }) {
  const p = S().project;
  if (!p) return;
  let clips: Clip[];
  if (short.mediaId) {
    const main = mainTrack(p);
    const tl = sourceRangeToTimeline(p.clips, short.mediaId, short, main ? new Set([main.id]) : undefined);
    if (tl.length) clips = sliceProject(p, tl[0].start, tl[tl.length - 1].end).clips;
    else {
      const np0 = makeProject("tmp");
      clips = [makeClip({ trackId: np0.tracks.find((t) => t.kind === "video")!.id, mediaId: short.mediaId, in: short.start, out: short.end })];
    }
  } else clips = sliceProject(p, short.start, short.end).clips;
  const np = await api.createProject(`Short: ${short.title.slice(0, 40)}`, "9:16");
  // map tracks by kind/order
  const map = new Map<string, string>();
  for (const kind of ["video", "audio", "text"] as const) {
    const src = p.tracks.filter((t) => t.kind === kind);
    const dst = np.tracks.filter((t) => t.kind === kind);
    src.forEach((t, i) => {
      if (!dst[i]) {
        const nt = makeTrack(kind, t.name);
        np.tracks.push(nt);
        dst.push(nt);
      }
      map.set(t.id, dst[i].id);
    });
  }
  if (!short.mediaId || !clips[0]?.trackId || !map.has(clips[0].trackId)) map.set(clips[0]?.trackId ?? "", np.tracks.find((t) => t.kind === "video")!.id);
  np.clips = clips.map((c) => ({ ...c, id: uid("clp"), trackId: map.get(c.trackId) ?? c.trackId, transform: c.kind === "media" ? { ...c.transform, fit: "fill" as const, x: 0 } : c.transform }));
  np.transcripts = p.transcripts;
  np.captions = { ...p.captions, enabled: true, sourceTrackId: map.get(p.captions.sourceTrackId ?? "") ?? np.captions.sourceTrackId, style: { ...DEFAULT_CAPTION_STYLE, ...(CAPTION_PRESETS.find((c) => c.id === "bold-pop")!.style), positionY: 0.7 } };
  np.mediaIds = [...p.mediaIds];
  np.master = p.master;
  await api.saveProject(np, "manual");
  return np;
}

export function goToNextEdit(dir: 1 | -1) {
  const { project: p, playhead } = S();
  if (!p) return;
  const pts = [...new Set(p.clips.flatMap((c) => [c.start, clipEnd(c)]))].sort((a, b) => a - b);
  const t = dir > 0 ? pts.find((x) => x > playhead + EPS) : [...pts].reverse().find((x) => x < playhead - EPS);
  if (t !== undefined) S().seek(t);
}

export function sourceTimeAtPlayhead(): { mediaId: string; t: number } | null {
  const { project: p, playhead } = S();
  if (!p) return null;
  const main = mainTrack(p);
  const c = p.clips.find((c) => c.trackId === main?.id && c.mediaId && playhead >= c.start && playhead < clipEnd(c));
  return c ? { mediaId: c.mediaId!, t: toSource(c, playhead) } : null;
}

export { rippleTrackIds };
