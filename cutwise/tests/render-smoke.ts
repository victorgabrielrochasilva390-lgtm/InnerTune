// Manual smoke test: builds a project exercising most features and renders it through the API.
// usage: npx tsx tests/render-smoke.ts  (server must be running)
import { makeProject, makeClip, makeTextData, uid } from "../shared/defaults";
import { cutSourceRanges } from "../shared/timeline";
import { applyRecommendation } from "../shared/apply";
import { analyzeProject } from "../shared/heuristics";
import { CAPTION_PRESETS, DEFAULT_CAPTION_STYLE } from "../shared/presets";
import type { MediaItem, Project, Word } from "../shared/types";

const API = "http://localhost:8787";
const j = async (path: string, init?: RequestInit) => {
  const r = await fetch(API + path, { headers: { "Content-Type": "application/json" }, ...init });
  const body = await r.json();
  if (!r.ok) throw new Error(JSON.stringify(body));
  return body;
};

const media: MediaItem[] = await j("/api/media");
const talk = media.find((m) => m.name === "talk.mp4")!;
const broll = media.find((m) => m.name === "broll.mp4")!;
const photo = media.find((m) => m.name === "photo.png")!;
const sfx = await j("/api/sfx");
const vertical = process.argv.includes("--vertical");
let p: Project = makeProject("Smoke test", vertical ? "9:16" : "16:9");
const v1 = p.tracks.find((t) => t.name.startsWith("V1"))!;
const v2 = p.tracks.find((t) => t.name.startsWith("V2"))!;
const t1 = p.tracks.find((t) => t.kind === "text")!;
const a3 = p.tracks.find((t) => t.name.startsWith("A3"))!;

// synthetic word timings for the flite speech (approximate, for caption testing)
const text1 = "Hello and welcome back. Um, today I will show you the biggest mistake people make with video editing.";
const text2 = "Here is the secret. It takes only five minutes. Here is the secret. It only takes five minutes to fix your audio.";
const mk = (t: string, s: number, e: number): Word[] => {
  const toks = t.split(" ");
  const d = (e - s) / toks.length;
  return toks.map((w, i) => ({ id: uid("w"), text: w, start: s + i * d, end: s + (i + 0.85) * d }));
};
p.transcripts[talk.id] = { mediaId: talk.id, provider: "manual", words: [...mk(text1, 0.3, 5.7), ...mk(text2, 8.9, 15.1)] };
p.clips.push(makeClip({ trackId: v1.id, mediaId: talk.id, in: 0, out: talk.duration, label: "talk" }));
p.mediaIds = [talk.id, broll.id, photo.id];

const goals = { ...p.ai.goals, style: "fast" as const, platform: vertical ? ("shorts" as const) : ("youtube" as const) };
const res = analyzeProject(p, { [talk.id]: talk, [broll.id]: broll, [photo.id]: photo }, goals);
console.log(res.summary);
for (const r of res.recommendations) console.log(`  [${r.kind}${r.auto ? "*" : ""}] ${r.title} ${r.start.toFixed(2)}-${r.end.toFixed(2)} :: ${r.reason.slice(0, 90)}`);
// apply all auto + a selection of others
for (const r of res.recommendations) {
  try {
    if (r.auto || ["zoom", "transition"].includes(r.kind)) p = applyRecommendation(p, r);
    if (r.kind === "broll") p = applyRecommendation(p, r, { brollMedia: broll });
    if (r.kind === "music") p = applyRecommendation(p, r, { brollMedia: media.find((m) => m.id === sfx[r.payload?.sfxId ?? "ambient-bed"]) });
  } catch (e) {
    console.log("   skip", r.kind, (e as Error).message);
  }
}
// photo with ken burns at the end of V2 + title + whoosh + LUT
const total = p.clips.reduce((d, c) => Math.max(d, c.start + (c.out - c.in) / c.speed), 0);
p.clips.push(makeClip({ trackId: v2.id, mediaId: photo.id, start: total - 3, in: 0, out: 2.5, transform: { fit: "blurFill", scale: 1, x: 0, y: 0, rotation: 0, opacity: 1, cropX: 0 }, motion: { preset: "kenBurns", intensity: 0.8 }, transitionIn: { type: "zoom", duration: 0.4, intensity: 0.6 }, transitionOut: { type: "crossfade", duration: 0.3, intensity: 0.5 } }));
p.clips.push(makeClip({ trackId: t1.id, kind: "text", start: 0.2, in: 0, out: 2.5, text: makeTextData("title", "THE BIGGEST MISTAKE") }));
p.clips.push(makeClip({ trackId: t1.id, kind: "text", start: 3, in: 0, out: 3, text: makeTextData("lowerThird", "Cutwise Studio") }));
p.clips.push(makeClip({ trackId: t1.id, kind: "text", start: 0, in: 0, out: total, text: makeTextData("progressBar") }));
p.clips.push(makeClip({ trackId: a3.id, mediaId: sfx["whoosh"], start: 2.8, in: 0, out: 0.9, volume: 0.5 }));
p.clips = p.clips.map((c) => (c.trackId === v1.id ? { ...c, color: { ...c.color, lutId: "teal-orange", lutIntensity: 0.6, exposure: 0.1 }, fx: { ...c.fx, vignette: 0.4 } } : c));
const preset = CAPTION_PRESETS.find((c) => c.id === (process.argv[2] ?? "bold-pop")) ?? CAPTION_PRESETS[0];
p.captions = { ...p.captions, enabled: true, style: { ...DEFAULT_CAPTION_STYLE, ...preset.style } };
console.log("clips:", p.clips.map((c) => `${p.tracks.find((t) => t.id === c.trackId)?.name}:${c.start.toFixed(2)}+${((c.out - c.in) / c.speed).toFixed(2)} ${c.motion.preset} ${c.transitionIn?.type ?? ""}`).join("\n  "));

const job = await j("/api/render", { method: "POST", body: JSON.stringify({ project: p, settings: { preset: "test", width: vertical ? 720 : 1280, height: vertical ? 1280 : 720, fps: 30, videoBitrateKbps: 4000, codec: "h264", audioBitrateKbps: 192, sampleRate: 48000, burnCaptions: true, fileName: "smoke" } }) });
for (;;) {
  await new Promise((r) => setTimeout(r, 1000));
  const s = await j(`/api/jobs/${job.id}`);
  process.stdout.write(`\r${s.status} ${(s.progress * 100).toFixed(0)}% ${s.message ?? ""}   `);
  if (["done", "error", "cancelled"].includes(s.status)) {
    console.log("\n", s.error ?? s.result);
    break;
  }
}
