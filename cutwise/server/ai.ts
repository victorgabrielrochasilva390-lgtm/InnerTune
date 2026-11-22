// AI Editing Director. Always runs the free heuristic engine first (real measurements),
// then - when ANTHROPIC_API_KEY (or an `ant auth login` profile) is available - asks Claude
// to act as a senior editor: it reviews the transcript, analysis, goals and keyframes and
// returns an explained editing plan in the same Recommendation format.
import fs from "node:fs";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import type { EditGoals, MediaItem, Project, PublishingKit, Recommendation } from "../shared/types";
import { analyzeProject, type HeuristicResult } from "../shared/heuristics";
import { sentences } from "../shared/captions";
import { uid } from "../shared/defaults";
import { CLAUDE_MODEL, DIRS } from "./config";
import { SFX_LIBRARY } from "../shared/presets";

let client: Anthropic | null = null;
export function claudeAvailable(): boolean {
  return !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_PROFILE || fs.existsSync(path.join(process.env.HOME ?? "", ".config", "anthropic")));
}
function getClient() {
  if (!client) client = new Anthropic();
  return client;
}

const KINDS = ["cut", "broll", "zoom", "transition", "music", "sfx", "color", "audio", "caption", "hook", "title", "pacing"] as const;
const MOTIONS = ["none", "slowZoomIn", "slowZoomOut", "punchIn", "punchOut", "panLeft", "panRight", "shake", "kenBurns"] as const;
const TRANS = ["cut", "crossfade", "fadeBlack", "fadeWhite", "swipeLeft", "swipeRight", "swipeUp", "zoom", "blur", "whipPan", "glitch"] as const;

const RecSchema = z.object({
  kind: z.enum(KINDS),
  mediaId: z.string().nullable().optional(),
  start: z.number(),
  end: z.number(),
  title: z.string(),
  action: z.string(),
  reason: z.string(),
  effect: z.string(),
  auto: z.boolean(),
  confidence: z.number().min(0).max(1),
  sceneIndex: z.number().int().nullable().optional(),
  cutType: z.enum(["silence", "filler", "repeat", "stutter", "redundant"]).nullable().optional(),
  narration: z.string().nullable().optional(),
  visual: z.string().nullable().optional(),
  query: z.string().nullable().optional(),
  assetType: z.enum(["video", "photo", "illustration", "screenshot", "graphic", "animation", "overlay"]).nullable().optional(),
  motion: z.enum(MOTIONS).nullable().optional(),
  transitionType: z.enum(TRANS).nullable().optional(),
  mood: z.string().nullable().optional(),
  sfxId: z.string().nullable().optional(),
  text: z.string().nullable().optional(),
});

const PlanSchema = z.object({
  summary: z.string(),
  strategy: z.array(z.string()),
  recommendations: z.array(RecSchema),
  kit: z.object({
    titles: z.array(z.string()),
    hooks: z.array(z.string()),
    description: z.string(),
    chapters: z.array(z.object({ t: z.number(), title: z.string() })),
    thumbnails: z.array(z.string()),
    shorts: z.array(z.object({ start: z.number(), end: z.number(), mediaId: z.string().nullable().optional(), title: z.string(), reason: z.string() })),
    openings: z.array(z.string()),
    tags: z.array(z.string()),
  }),
});

// JSON schema handed to structured outputs (kept flat; optional fields are nullable).
const nul = (t: object) => ({ anyOf: [t, { type: "null" }] });
const str = { type: "string" };
const PLAN_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "strategy", "recommendations", "kit"],
  properties: {
    summary: str,
    strategy: { type: "array", items: str },
    recommendations: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["kind", "mediaId", "start", "end", "title", "action", "reason", "effect", "auto", "confidence", "sceneIndex", "cutType", "narration", "visual", "query", "assetType", "motion", "transitionType", "mood", "sfxId", "text"],
        properties: {
          kind: { type: "string", enum: KINDS },
          mediaId: nul(str),
          start: { type: "number" },
          end: { type: "number" },
          title: str,
          action: str,
          reason: str,
          effect: str,
          auto: { type: "boolean" },
          confidence: { type: "number" },
          sceneIndex: nul({ type: "integer" }),
          cutType: nul({ type: "string", enum: ["silence", "filler", "repeat", "stutter", "redundant"] }),
          narration: nul(str),
          visual: nul(str),
          query: nul(str),
          assetType: nul({ type: "string", enum: ["video", "photo", "illustration", "screenshot", "graphic", "animation", "overlay"] }),
          motion: nul({ type: "string", enum: MOTIONS }),
          transitionType: nul({ type: "string", enum: TRANS }),
          mood: nul(str),
          sfxId: nul(str),
          text: nul(str),
        },
      },
    },
    kit: {
      type: "object",
      additionalProperties: false,
      required: ["titles", "hooks", "description", "chapters", "thumbnails", "shorts", "openings", "tags"],
      properties: {
        titles: { type: "array", items: str },
        hooks: { type: "array", items: str },
        description: str,
        chapters: { type: "array", items: { type: "object", additionalProperties: false, required: ["t", "title"], properties: { t: { type: "number" }, title: str } } },
        thumbnails: { type: "array", items: str },
        shorts: {
          type: "array",
          items: { type: "object", additionalProperties: false, required: ["start", "end", "mediaId", "title", "reason"], properties: { start: { type: "number" }, end: { type: "number" }, mediaId: nul(str), title: str, reason: str } },
        },
        openings: { type: "array", items: str },
        tags: { type: "array", items: str },
      },
    },
  },
};

const SYSTEM = `You are a senior video editor and YouTube/short-form retention strategist working inside a non-destructive editor.
You receive measured analysis (silences, scene cuts, loudness, exposure), a word-timestamped transcript and the creator's goals.
Produce an editing plan as JSON.

Principles:
- Preserve meaning and context. Never cut information the viewer needs just to make the video shorter. Mark anything debatable auto=false.
- Every recommendation must say WHAT to change (action), WHERE (mediaId + start/end in SOURCE seconds of that media), WHY (reason, referring to the actual words or measurements), the expected EFFECT, and whether it is safe to auto-apply.
- auto=true only for mechanical, low-risk changes (dead air, obvious fillers or stutters, loudness normalisation, captions). Creative choices are auto=false.
- Be restrained. Effects, zooms, transitions and SFX serve the story; hard cuts are the default. Do not overuse.
- B-roll: for each scene where a visual would help, describe a concrete, licensable visual (not a copyrighted work), a 2-4 word stock search query, the narration it supports and why it is relevant. Use sceneIndex.
- Music and SFX must never mask dialogue. SFX ids available: ${SFX_LIBRARY.map((s) => s.id).join(", ")}.
- Cut ranges must align with word boundaries from the transcript (use word start/end times) and must not overlap other cuts.
- Time values are seconds in the source media referenced by mediaId (chapters and shorts use timeline seconds for chapters, source seconds + mediaId for shorts).
- Write in the language of the transcript for titles/hooks/description; write explanations in English unless the notes ask otherwise.`;

export interface DirectorResult extends HeuristicResult {
  source: "heuristic" | "claude";
  model?: string;
}

export async function runDirector(project: Project, media: Record<string, MediaItem>, goals: EditGoals, opts: { useClaude: boolean; useVision: boolean }): Promise<DirectorResult> {
  const base = analyzeProject(project, media, goals);
  if (!opts.useClaude || !claudeAvailable()) {
    if (opts.useClaude) base.warnings.push("Claude is not configured (set ANTHROPIC_API_KEY). Showing the free built-in analysis.");
    return { ...base, source: "heuristic" };
  }
  try {
    const plan = await askClaude(project, media, goals, base, opts.useVision);
    // keep the mechanical, measurement-based cuts from the heuristic engine; Claude supplies the creative plan
    const mechanical = base.recommendations.filter((r) => r.kind === "cut" && ["silence", "filler", "stutter"].includes(r.payload?.cutType ?? ""));
    const claudeRecs = plan.recommendations.filter((r) => !(r.kind === "cut" && ["silence", "filler", "stutter"].includes(r.payload?.cutType ?? "")));
    return {
      recommendations: [...mechanical, ...claudeRecs],
      kit: plan.kit,
      summary: plan.summary,
      strategy: plan.strategy,
      warnings: base.warnings,
      source: "claude",
      model: CLAUDE_MODEL,
    };
  } catch (e: any) {
    let msg = e?.message ?? String(e);
    if (e instanceof Anthropic.AuthenticationError) msg = "Anthropic API key was rejected.";
    else if (e instanceof Anthropic.RateLimitError) msg = "Anthropic rate limit hit - try again shortly.";
    else if (e instanceof Anthropic.APIConnectionError) msg = "Could not reach the Anthropic API.";
    base.warnings.push(`Claude plan failed (${msg}). Showing the free built-in analysis instead.`);
    return { ...base, source: "heuristic" };
  }
}

async function askClaude(project: Project, media: Record<string, MediaItem>, goals: EditGoals, base: HeuristicResult, vision: boolean) {
  const used = [...new Set(project.clips.map((c) => c.mediaId).filter((id): id is string => !!id && !!media[id]))];
  const parts: Anthropic.Beta.Messages.BetaContentBlockParam[] = [];
  const lines: string[] = [];
  lines.push(`# Goals\n${JSON.stringify(goals, null, 1)}`);
  lines.push(`# Timeline\nCanvas ${project.settings.width}x${project.settings.height} @${project.settings.fps}fps. Clips on timeline:\n${project.clips
    .filter((c) => c.mediaId)
    .map((c) => `- ${media[c.mediaId!]?.name ?? c.mediaId} [mediaId ${c.mediaId}] source ${c.in.toFixed(2)}-${c.out.toFixed(2)}s at timeline ${c.start.toFixed(2)}s (track ${project.tracks.find((t) => t.id === c.trackId)?.name})`)
    .join("\n")}`);
  for (const id of used) {
    const m = media[id];
    const a = m.analysis;
    lines.push(`\n# Media ${m.name} (mediaId ${id}, ${m.kind}, ${m.duration.toFixed(1)}s, ${m.width}x${m.height})`);
    if (a) {
      lines.push(`Loudness: ${a.loudness ? `${a.loudness.integrated} LUFS, true peak ${a.loudness.truePeak} dBTP` : "n/a"}; noise floor ${a.noiseFloorDb ?? "n/a"} dBFS; clipping ${a.clipping?.likely ? "yes" : "no"}`);
      lines.push(`Exposure avg luma ${a.visual?.brightness.toFixed(0) ?? "n/a"}/255, saturation ${a.visual?.saturation.toFixed(0) ?? "n/a"}`);
      lines.push(`Scene cuts (s): ${a.scenes.map((s) => s.toFixed(2)).join(", ") || "none"}`);
      lines.push(`Silences (s): ${a.silences.map((s) => `${s.start.toFixed(2)}-${s.end.toFixed(2)}`).join(", ") || "none"}`);
      const loud = a.energy.filter((e, i, arr) => i % 4 === 0).map((e) => `${e.t.toFixed(0)}:${e.rms.toFixed(0)}`);
      lines.push(`Energy dBFS every 2s (t:rms): ${loud.join(" ")}`);
    }
    const tr = project.transcripts[id];
    if (tr) {
      lines.push(`Transcript (sentence index [start-end] text; word timings follow each sentence as word@start):`);
      for (const s of sentences(tr.words)) {
        lines.push(`${s.index} [${s.start.toFixed(2)}-${s.end.toFixed(2)}]${s.words[0].speaker ? ` (${s.words[0].speaker})` : ""} ${s.text}`);
        lines.push(`   ${s.words.map((w) => `${w.text}@${w.start.toFixed(2)}`).join(" ")}`);
      }
    } else lines.push("No transcript available.");
    if (vision && a?.keyframes?.length) {
      for (const kf of a.keyframes.slice(0, 8)) {
        const file = path.join(DIRS.thumbs, path.basename(kf.url));
        if (!fs.existsSync(file)) continue;
        parts.push({ type: "text", text: `Keyframe of mediaId ${id} at ${kf.t.toFixed(2)}s:` });
        parts.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: fs.readFileSync(file).toString("base64") } });
      }
    }
  }
  lines.push(`\n# Baseline from the measurement engine (you may keep, refine, or drop; mechanical silence/filler cuts are already handled, do not repeat them)\n${base.recommendations
    .filter((r) => !(r.kind === "cut" && ["silence", "filler", "stutter"].includes(r.payload?.cutType ?? "")))
    .map((r) => `- ${r.kind} ${r.mediaId ?? ""} ${r.start.toFixed(2)}-${r.end.toFixed(2)}: ${r.action}`)
    .join("\n")}`);
  lines.push(
    "\nReturn the complete plan: content-aware cuts (repeats, false starts, redundant sections), the hook, scene-by-scene B-roll, emphasis zooms, transitions, music mood, SFX, colour and audio notes, captions preset if relevant, plus the publishing kit (titles, hooks, description, chapters with timeline seconds starting at 0, thumbnail concepts, 1-3 short-form clips, opening variations, tags)."
  );
  parts.unshift({ type: "text", text: lines.join("\n") });

  const anthropic = getClient();
  const request = {
    model: CLAUDE_MODEL,
    max_tokens: 64000,
    betas: ["server-side-fallback-2026-07-01" as const],
    fallbacks: "default" as const,
    system: SYSTEM,
    output_config: { effort: "high" as const, format: { type: "json_schema" as const, schema: PLAN_JSON_SCHEMA } },
    messages: [{ role: "user" as const, content: parts }],
  };
  const stream = anthropic.beta.messages.stream(request);
  const msg = await stream.finalMessage();
  if (msg.stop_reason === "refusal") throw new Error("Claude declined this request");
  if (msg.stop_reason === "max_tokens") throw new Error("Plan was cut off (max tokens)");
  const text = msg.content.map((b) => (b.type === "text" ? b.text : "")).join("");
  const parsed = PlanSchema.parse(JSON.parse(text));
  const recs: Recommendation[] = parsed.recommendations
    .map((r) => {
      const m = r.mediaId ? media[r.mediaId] : undefined;
      const dur = m?.duration ?? Infinity;
      const start = Math.max(0, Math.min(r.start, dur));
      const end = Math.max(start, Math.min(r.end, dur));
      return {
        id: uid("rec"),
        kind: r.kind,
        mediaId: m ? m.id : undefined,
        start,
        end,
        title: r.title,
        action: r.action,
        reason: r.reason,
        effect: r.effect,
        auto: r.auto && ["cut", "audio", "caption"].includes(r.kind),
        confidence: r.confidence,
        status: "pending" as const,
        source: "claude" as const,
        sceneIndex: r.sceneIndex ?? undefined,
        payload: {
          cutType: r.cutType ?? undefined,
          savedSeconds: r.kind === "cut" ? end - start : undefined,
          narration: r.narration ?? undefined,
          visual: r.visual ?? undefined,
          query: r.query ?? undefined,
          assetType: r.assetType ?? undefined,
          duration: r.kind === "broll" ? Math.max(2, Math.min(8, end - start || 4)) : undefined,
          animation: r.kind === "broll" ? (r.motion ?? "slowZoomIn") : undefined,
          transition: r.kind === "broll" ? "crossfade" : undefined,
          motion: r.kind === "zoom" || r.kind === "pacing" ? (r.motion ?? "punchIn") : undefined,
          intensity: 0.6,
          transitionType: r.transitionType ?? undefined,
          mood: r.mood ?? undefined,
          sfxId: r.sfxId && SFX_LIBRARY.some((s) => s.id === r.sfxId) ? r.sfxId : undefined,
          text: r.text ?? undefined,
          captionPreset: r.kind === "caption" ? (goals.platform === "youtube" ? "clean-box" : "bold-pop") : undefined,
        },
      } satisfies Recommendation;
    })
    .filter((r) => r.end > r.start || ["caption", "music", "audio", "color"].includes(r.kind));
  // colour / audio recommendations from Claude carry no numeric payload; reuse the measured ones
  for (const r of recs) {
    if (r.kind === "color") r.payload = { ...r.payload, grade: base.recommendations.find((b) => b.kind === "color" && b.mediaId === r.mediaId)?.payload?.grade ?? { contrast: 0.06, saturation: 1.05 } };
    if (r.kind === "audio") r.payload = { ...r.payload, ...(base.recommendations.find((b) => b.kind === "audio" && b.mediaId === r.mediaId)?.payload ?? { fx: { highpass: true, voiceEnhance: true, compressor: 0.5 }, trackRole: "voice" }) };
  }
  const kit: PublishingKit = { ...parsed.kit, shorts: parsed.kit.shorts.map((s) => ({ ...s, mediaId: s.mediaId ?? undefined })) };
  return { recommendations: recs, kit, summary: parsed.summary, strategy: parsed.strategy };
}
