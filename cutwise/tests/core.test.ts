import { describe, expect, it } from "vitest";
import { makeClip, makeProject, uid } from "../shared/defaults";
import { clipEnd, cutSourceRanges, overwrite, projectDuration, rippleDeleteRange, sourceRangeToTimeline, splitClip, timelineWords, sliceProject } from "../shared/timeline";
import { buildAss, layoutCaptionPages, parseSubtitles, toSrt, captionPages, sentences } from "../shared/captions";
import { analyzeProject } from "../shared/heuristics";
import { applyRecommendation, ApplyError } from "../shared/apply";
import { motionAt, motionExpr } from "../shared/motion";
import { DEFAULT_CAPTION_STYLE } from "../shared/presets";
import { buildRenderPlan } from "../server/renderGraph";
import type { MediaItem, Project, Word } from "../shared/types";

const media = (id: string, duration: number, extra: Partial<MediaItem> = {}): MediaItem => ({
  id,
  name: `${id}.mp4`,
  kind: "video",
  path: `/tmp/${id}.mp4`,
  duration,
  width: 1920,
  height: 1080,
  fps: 30,
  hasAudio: true,
  hasVideo: true,
  size: 1,
  createdAt: 0,
  source: { provider: "upload" },
  status: "ready",
  ...extra,
});

function words(text: string, start: number, end: number): Word[] {
  const toks = text.split(" ");
  const d = (end - start) / toks.length;
  return toks.map((t, i) => ({ id: uid("w"), text: t, start: start + i * d, end: start + (i + 0.9) * d }));
}

function project(dur = 20): { p: Project; main: string } {
  const p = makeProject("t");
  const main = p.tracks.find((t) => t.name.startsWith("V1"))!.id;
  p.clips.push(makeClip({ trackId: main, mediaId: "m1", in: 0, out: dur }));
  return { p, main };
}

describe("timeline", () => {
  it("splits a clip keeping source continuity", () => {
    const c = makeClip({ trackId: "t", start: 2, in: 5, out: 15 });
    const [a, b] = splitClip(c, 6)!;
    expect(a.out).toBeCloseTo(9);
    expect(b.in).toBeCloseTo(9);
    expect(b.start).toBe(6);
    expect(clipEnd(b)).toBeCloseTo(12);
  });

  it("ripple deletes a range across tracks", () => {
    const { p, main } = project(20);
    const other = p.tracks.find((t) => t.name.startsWith("V2"))!.id;
    p.clips.push(makeClip({ trackId: other, start: 12, in: 0, out: 3 }));
    const clips = rippleDeleteRange(p.clips, 5, 8, new Set([main, other]));
    expect(projectDuration({ clips })).toBeCloseTo(17);
    const broll = clips.find((c) => c.trackId === other)!;
    expect(broll.start).toBeCloseTo(9);
  });

  it("maps source ranges through cuts (AI cuts stay valid after other cuts)", () => {
    const { p, main } = project(20);
    p.clips = cutSourceRanges(p, "m1", [{ start: 2, end: 4 }], main);
    expect(projectDuration(p)).toBeCloseTo(18);
    const tl = sourceRangeToTimeline(p.clips, "m1", { start: 10, end: 11 });
    expect(tl[0].start).toBeCloseTo(8);
    p.clips = cutSourceRanges(p, "m1", [{ start: 10, end: 11 }], main);
    expect(projectDuration(p)).toBeCloseTo(17);
  });

  it("overwrite trims what a moved clip covers", () => {
    const a = makeClip({ trackId: "t", start: 0, in: 0, out: 10 });
    const b = makeClip({ trackId: "t", start: 4, in: 0, out: 2 });
    const res = overwrite([a], b);
    expect(res.length).toBe(3);
    expect(res.filter((c) => c.trackId === "t").map((c) => [c.start, clipEnd(c)]).sort((x, y) => x[0] - y[0])).toEqual([
      [0, 4],
      [4, 6],
      [6, 10],
    ]);
  });

  it("slices a project to a range for short exports", () => {
    const { p } = project(20);
    const s = sliceProject(p, 5, 9);
    expect(projectDuration(s)).toBeCloseTo(4);
    expect(s.clips[0].in).toBeCloseTo(5);
  });
});

describe("captions", () => {
  it("groups words into pages respecting words-per-line and pauses", () => {
    const { p } = project(20);
    p.transcripts.m1 = { mediaId: "m1", provider: "manual", words: [...words("one two three four five", 0, 2), ...words("six seven", 4, 5)] };
    const tw = timelineWords(p);
    const pages = layoutCaptionPages(tw, { ...DEFAULT_CAPTION_STYLE, wordsPerLine: 3, linesPerPage: 1 });
    expect(pages.map((pg) => pg.words.length)).toEqual([3, 2, 2]);
    expect(pages[2].start).toBeCloseTo(4);
  });

  it("captions follow cuts made on the timeline", () => {
    const { p, main } = project(20);
    p.captions.enabled = true;
    p.transcripts.m1 = { mediaId: "m1", provider: "manual", words: [...words("hello there", 1, 2), ...words("after the cut", 10, 11)] };
    p.clips = cutSourceRanges(p, "m1", [{ start: 3, end: 9 }], main);
    const pages = captionPages(p);
    const last = pages[pages.length - 1];
    expect(last.start).toBeCloseTo(4, 1);
  });

  it("builds ASS with highlighted active word and text layers", () => {
    const { p } = project(10);
    p.captions.enabled = true;
    p.transcripts.m1 = { mediaId: "m1", provider: "manual", words: words("this is great", 0, 1.5) };
    const ass = buildAss(p, { includeCaptions: true });
    expect(ass).toContain("PlayResX: 1920");
    expect(ass).toMatch(/Dialogue: 1,0:00:00\.00,.*THIS/);
    expect(ass).toContain("\\c&H000AD6FF"); // highlight colour #ffd60a in ASS BGR order
  });

  it("parses SRT into approximate word timings and exports SRT", () => {
    const w = parseSubtitles("1\n00:00:01,000 --> 00:00:03,000\nHello big world\n");
    expect(w.length).toBe(3);
    expect(w[0].start).toBeCloseTo(1);
    expect(w[2].end).toBeLessThanOrEqual(3);
    const srt = toSrt([{ start: 1, end: 2, lines: [[{ text: "Hi", start: 1, end: 2, wordId: "a" }]], words: [] }]);
    expect(srt).toContain("00:00:01,000 --> 00:00:02,000");
  });
});

describe("AI heuristics", () => {
  it("finds silences, fillers, stutters and retakes with explanations", () => {
    const { p } = project(30);
    p.transcripts.m1 = {
      mediaId: "m1",
      provider: "manual",
      words: [...words("Um, so the the biggest mistake is simple.", 0.5, 4), ...words("Here is the secret to fixing it.", 8, 10), ...words("Here is the secret to fixing it fast.", 10.5, 13)],
    };
    const m = media("m1", 30, { analysis: { analyzedAt: 0, silences: [{ start: 4.1, end: 7.9 }], scenes: [], energy: [], loudness: { integrated: -20, truePeak: -3, lra: 5, threshold: -30 }, noiseFloorDb: -50 } });
    const r = analyzeProject(p, { m1: m }, p.ai.goals);
    const cuts = r.recommendations.filter((x) => x.kind === "cut");
    expect(cuts.some((c) => c.payload?.cutType === "silence" && c.start > 4 && c.end < 8)).toBe(true);
    expect(cuts.some((c) => c.payload?.cutType === "filler")).toBe(true);
    expect(cuts.some((c) => c.payload?.cutType === "stutter")).toBe(true);
    expect(cuts.some((c) => c.payload?.cutType === "repeat")).toBe(true);
    expect(r.recommendations.some((x) => x.kind === "audio" && x.title.includes("Normalize"))).toBe(true);
    for (const rec of r.recommendations) {
      expect(rec.reason.length).toBeGreaterThan(10);
      expect(rec.effect.length).toBeGreaterThan(5);
      expect(rec.action.length).toBeGreaterThan(5);
    }
    // never cuts through a word
    const all = p.transcripts.m1.words;
    for (const c of cuts.filter((c) => c.payload?.cutType === "silence")) for (const w of all) expect(w.end <= c.start + 1e-6 || w.start >= c.end - 1e-6).toBe(true);
    expect(sentences(all).length).toBe(3);
  });

  it("applies recommendations as concrete edits", () => {
    const { p } = project(30);
    const rec = { id: "r", kind: "cut" as const, mediaId: "m1", start: 5, end: 8, title: "", action: "", reason: "", effect: "", auto: true, confidence: 1, status: "pending" as const, source: "heuristic" as const };
    const next = applyRecommendation(p, rec);
    expect(projectDuration(next)).toBeCloseTo(27);
    expect(() => applyRecommendation(p, { ...rec, kind: "broll" })).toThrow(ApplyError);
    const zoomed = applyRecommendation(p, { ...rec, kind: "zoom", payload: { motion: "punchIn" } });
    expect(zoomed.clips.filter((c) => c.motion.preset === "punchIn").length).toBe(1);
  });
});

describe("preview / export parity", () => {
  // evaluate the FFmpeg expression in JS and compare with the preview maths
  const evalExpr = (e: string, t: number) =>
    new Function("t", "clip", "IF", "lt", "sin", "max", "trunc", `return ${e.replace(/\bif\(/g, "IF(")};`)(
      t,
      (v: number, a: number, b: number) => Math.max(a, Math.min(b, v)),
      (c: number, a: number, b: number) => (c ? a : b),
      (a: number, b: number) => (a < b ? 1 : 0),
      Math.sin,
      Math.max,
      Math.trunc
    );

  it("motion presets, keyframes and transitions match", () => {
    for (const preset of ["slowZoomIn", "punchOut", "panLeft", "kenBurns", "shake"] as const) {
      const c = makeClip({ trackId: "t", start: 3, in: 0, out: 6, motion: { preset, intensity: 0.7 }, transitionIn: { type: "zoom", duration: 0.5, intensity: 0.6 }, keyframes: [
        { t: 0, scale: 1, x: 0, y: 0, rotation: 0, opacity: 1, ease: "linear" },
        { t: 4, scale: 1.3, x: 0.1, y: -0.05, rotation: 10, opacity: 1, ease: "easeInOut" },
      ] });
      const ex = motionExpr(c);
      for (const local of [0, 0.2, 1.1, 2.5, 5.9]) {
        const m = motionAt(c, local);
        expect(evalExpr(ex.scale, 3 + local)).toBeCloseTo(m.scale, 4);
        expect(evalExpr(ex.x, 3 + local)).toBeCloseTo(m.x, 4);
        expect(evalExpr(ex.y, 3 + local)).toBeCloseTo(m.y, 4);
        expect(evalExpr(ex.rotation, 3 + local)).toBeCloseTo(m.rotation, 4);
      }
    }
  });
});

describe("render graph", () => {
  it("builds overlays, transitions, grading, captions and the audio mix", () => {
    const { p, main } = project(10);
    const music = p.tracks.find((t) => t.role === "music")!.id;
    p.clips[0].out = 5;
    p.clips.push(makeClip({ trackId: main, mediaId: "m1", start: 5, in: 6, out: 10, transitionIn: { type: "crossfade", duration: 0.5, intensity: 0.5 }, color: { ...p.clips[0].color, exposure: 0.5, lutId: "mono", lutIntensity: 0.5 } }));
    p.clips.push(makeClip({ trackId: music, mediaId: "m2", start: 0, in: 0, out: 9 }));
    const plan = buildRenderPlan(p, { m1: media("m1", 20), m2: media("m2", 60, { kind: "audio", hasVideo: false }) }, { preset: "x", width: 1280, height: 720, fps: 30, videoBitrateKbps: 4000, codec: "h264", audioBitrateKbps: 192, sampleRate: 48000, burnCaptions: true, fileName: "x" }, { assPath: "/tmp/a.ass", fontsDir: "/tmp/f", lutPath: (id) => `/luts/${id}.cube`, outPath: "/tmp/o.mp4", filterScriptPath: "/tmp/g.txt" });
    expect(plan.filterGraph).toContain("fade=t=in:st=5:d=0.5:alpha=1");
    expect(plan.filterGraph).toContain("exposure=exposure=0.5");
    expect(plan.filterGraph).toContain("lut3d=file='/luts/mono.cube'");
    expect(plan.filterGraph).toContain("sidechaincompress");
    expect(plan.filterGraph).toContain("loudnorm=I=-14");
    expect(plan.filterGraph).toContain("ass=filename='/tmp/a.ass'");
    // the outgoing clip keeps playing for the crossfade (0.5s tail)
    expect(plan.args.join(" ")).toContain("-ss 0 -t 5.5");
    expect(plan.duration).toBeCloseTo(9);
  });
});
