// Free, offline editing intelligence. Works from real measurements (FFmpeg silence /
// scene / loudness / signal analysis) and the word-level transcript. It produces the same
// Recommendation objects as the Claude-powered director, so the UI treats both alike.
import type { EditGoals, MediaItem, Project, PublishingKit, Recommendation, Word, Range, MotionPreset } from "./types";
import { sentences, type Sentence } from "./captions";
import { uid } from "./defaults";
import { formatShort, sourceRangeToTimeline } from "./timeline";

const STOP = new Set(
  "a an the and or but if then so of to in on at by for with from as is are was were be been being it its this that these those i you he she we they me him her us them my your his our their what which who whom how why when where there here just very really also too not no yes do does did done have has had can could would should will shall may might must about into over under again more most some any each other such only own same than s t don now like get got going gonna wanna kind sort thing things lot okay ok yeah um uh actually basically literally right well know mean think say said see let go one two".split(
    " "
  )
);
const STRONG = /\b(secret|mistake|never|always|best|worst|how to|why|stop|free|truth|biggest|nobody|everyone|change|changed|million|thousand|percent|%|important|crazy|insane|simple|easy|hard|fail|failed|success|money|fast|faster|result|results|problem|solution|finally|instantly|warning|exactly|actually works|proven|before|after)\b/i;
const FILLER = /^(um+|uh+|uhm+|erm+|er|ah+|hmm+|mm+|mhm)[,.!?]*$/i;
const GREETING = /^(hi|hey|hello|what'?s up|welcome( back)?|good (morning|evening))\b|\bin (this|today'?s) video\b/i;

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9'%]+/g, "");

interface StyleParams {
  minSilence: number;
  zoomSpacing: number;
  brollSpacing: number;
  stretch: number;
  padding: number;
}

function styleParams(g: EditGoals): StyleParams {
  const short = g.platform !== "youtube";
  const base: Record<EditGoals["style"], StyleParams> = {
    fast: { minSilence: 0.35, zoomSpacing: 5, brollSpacing: 8, stretch: 6, padding: 0.08 },
    balanced: { minSilence: 0.6, zoomSpacing: 9, brollSpacing: 14, stretch: 10, padding: 0.12 },
    educational: { minSilence: 0.7, zoomSpacing: 10, brollSpacing: 12, stretch: 12, padding: 0.14 },
    calm: { minSilence: 1.0, zoomSpacing: 16, brollSpacing: 20, stretch: 18, padding: 0.2 },
    cinematic: { minSilence: 1.2, zoomSpacing: 14, brollSpacing: 16, stretch: 15, padding: 0.25 },
  };
  const p = { ...base[g.style] };
  if (short) {
    p.minSilence = Math.min(p.minSilence, 0.4);
    p.zoomSpacing = Math.min(p.zoomSpacing, 6);
    p.brollSpacing = Math.min(p.brollSpacing, 9);
    p.stretch = Math.min(p.stretch, 7);
    p.padding = Math.min(p.padding, 0.1);
  }
  return p;
}

export function keywords(text: string, n = 3): string[] {
  const counts = new Map<string, number>();
  for (const raw of text.split(/\s+/)) {
    const w = raw.replace(/[^A-Za-z0-9'-]/g, "");
    const l = w.toLowerCase();
    if (l.length < 4 || STOP.has(l)) continue;
    const bonus = /^[A-Z]/.test(w) ? 1.5 : 1;
    counts.set(l, (counts.get(l) ?? 0) + bonus * Math.min(2, l.length / 5));
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map((e) => e[0]);
}

function energyAt(m: MediaItem, s: number, e: number): number {
  const pts = m.analysis?.energy.filter((p) => p.t >= s && p.t <= e) ?? [];
  if (!pts.length) return -30;
  return pts.reduce((a, p) => a + p.rms, 0) / pts.length;
}

export function importance(sen: Sentence, m?: MediaItem, medianEnergy = -30): number {
  let score = 0;
  const n = sen.words.length;
  if (/\d/.test(sen.text)) score += 1.2;
  if (/\?$/.test(sen.text.trim())) score += 0.8;
  if (/!$/.test(sen.text.trim())) score += 0.6;
  const strong = sen.text.match(new RegExp(STRONG, "gi"));
  score += Math.min(2, (strong?.length ?? 0) * 0.7);
  if (n >= 6 && n <= 22) score += 0.6;
  if (n < 4) score -= 0.8;
  if (GREETING.test(sen.text)) score -= 1.2;
  if (m) score += Math.max(-1, Math.min(1.5, (energyAt(m, sen.start, sen.end) - medianEnergy) / 4));
  return score;
}

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = xs.slice().sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

function similarity(a: Sentence, b: Sentence): number {
  const A = a.words.map((w) => norm(w.text)).filter(Boolean);
  const B = b.words.map((w) => norm(w.text)).filter(Boolean);
  if (!A.length || !B.length) return 0;
  const sa = new Set(A);
  const sb = new Set(B);
  let inter = 0;
  for (const x of sa) if (sb.has(x)) inter++;
  const jacc = inter / (sa.size + sb.size - inter);
  let prefix = 0;
  while (prefix < Math.min(A.length, B.length) && A[prefix] === B[prefix]) prefix++;
  const prefixScore = prefix >= 3 ? 0.4 + Math.min(0.5, prefix * 0.08) : 0;
  return Math.max(jacc, prefixScore);
}

export interface HeuristicResult {
  recommendations: Recommendation[];
  kit: PublishingKit;
  summary: string;
  strategy: string[];
  warnings: string[];
}

function rec(p: Omit<Recommendation, "id" | "status" | "source">): Recommendation {
  return { id: uid("rec"), status: "pending", source: "heuristic", ...p };
}

export function analyzeProject(project: Project, media: Record<string, MediaItem>, goals: EditGoals): HeuristicResult {
  const P = styleParams(goals);
  const recs: Recommendation[] = [];
  const warnings: string[] = [];
  const strategy: string[] = [];
  const main = project.tracks.find((t) => t.kind === "video" && project.clips.some((c) => c.trackId === t.id)) ?? project.tracks.find((t) => t.kind === "video");
  const mediaIds = [...new Set(project.clips.filter((c) => c.mediaId && media[c.mediaId] && (c.trackId === main?.id || project.tracks.find((t) => t.id === c.trackId)?.role === "voice")).map((c) => c.mediaId!))];
  let allSentences: { s: Sentence; m: MediaItem }[] = [];
  let totalSilence = 0;
  let totalDur = 0;
  let wordsCount = 0;

  for (const mid of mediaIds) {
    const m = media[mid];
    const a = m.analysis;
    const tr = project.transcripts[mid];
    const words: Word[] = tr?.words ?? [];
    wordsCount += words.length;
    totalDur += m.duration;
    if (!a) warnings.push(`"${m.name}" has not been analysed yet - silence, scene and loudness suggestions are limited.`);
    if (!tr) warnings.push(`"${m.name}" has no transcript - filler, repetition, caption and B-roll suggestions need one.`);
    const medE = median(a?.energy.map((e) => e.rms) ?? []);
    const sens = sentences(words);
    allSentences.push(...sens.map((s) => ({ s, m })));

    // ---------------------------------------------- 1. silences / pauses
    const gaps: Range[] = [];
    for (const s of a?.silences ?? []) gaps.push({ ...s });
    for (let i = 1; i < words.length; i++) {
      const g = words[i].start - words[i - 1].end;
      if (g >= P.minSilence) gaps.push({ start: words[i - 1].end, end: words[i].start });
    }
    if (words.length) {
      if (words[0].start > 0.6) gaps.push({ start: 0, end: words[0].start });
      const last = words[words.length - 1].end;
      if (m.duration - last > 0.8) gaps.push({ start: last, end: m.duration });
    }
    const merged = mergeGaps(gaps);
    for (const g of merged) {
      const head = g.start <= 0.01;
      const tail = g.end >= m.duration - 0.01;
      // never cut through a spoken word
      let s = g.start + (head ? 0 : P.padding);
      let e = g.end - (tail ? 0 : P.padding);
      for (const w of words) {
        if (w.end > s && w.start < e) {
          if ((w.start + w.end) / 2 < (s + e) / 2) s = Math.max(s, w.end + 0.03);
          else e = Math.min(e, w.start - 0.03);
        }
      }
      const len = e - s;
      if (len < Math.max(0.25, P.minSilence - 2 * P.padding)) continue;
      totalSilence += len;
      const visualChange = a?.scenes.some((t) => t > s && t < e);
      recs.push(
        rec({
          kind: "cut",
          mediaId: mid,
          start: s,
          end: e,
          title: head ? "Trim dead air at the start" : tail ? "Trim dead air at the end" : `Remove ${len.toFixed(1)}s pause`,
          action: `Remove ${len.toFixed(1)} seconds (${formatShort(s)} – ${formatShort(e)})`,
          reason: visualChange
            ? "Pause in speech. There is a visual change inside it, so preview first."
            : head
              ? "Nothing is said before the first word. Viewers decide in the first seconds."
              : `Pause of ${len.toFixed(1)}s with no speech or meaningful visual change.`,
          effect: "Tighter pacing and better retention. Natural breathing room is kept on both sides.",
          auto: !visualChange && len >= 0.5,
          confidence: visualChange ? 0.55 : Math.min(0.95, 0.6 + len / 4),
          payload: { savedSeconds: len, cutType: "silence" },
        })
      );
    }

    // ---------------------------------------------- 2. fillers + stutters
    for (let i = 0; i < words.length; i++) {
      const w = words[i];
      if (FILLER.test(w.text.trim())) {
        const prevEnd = words[i - 1]?.end ?? w.start;
        const nextStart = words[i + 1]?.start ?? w.end;
        const s = Math.max(prevEnd, w.start - 0.04);
        const e = Math.min(nextStart, w.end + 0.04);
        recs.push(
          rec({
            kind: "cut",
            mediaId: mid,
            start: s,
            end: e,
            title: `Remove filler "${w.text}"`,
            action: `Cut the filler word at ${formatShort(w.start)}`,
            reason: `"${w.text}" carries no information and makes the delivery sound hesitant.`,
            effect: "More confident delivery. The meaning does not change.",
            auto: true,
            confidence: 0.85,
            payload: { savedSeconds: e - s, cutType: "filler", transcriptExcerpt: context(words, i) },
          })
        );
      }
      const next = words[i + 1];
      if (next && norm(w.text) && norm(w.text) === norm(next.text) && next.start - w.end < 0.6 && !/^(very|really|no|so|bye|ha)$/.test(norm(w.text))) {
        recs.push(
          rec({
            kind: "cut",
            mediaId: mid,
            start: w.start,
            end: next.start,
            title: `Fix stutter "${w.text} ${next.text}"`,
            action: `Remove the repeated word at ${formatShort(w.start)}`,
            reason: "The word is repeated straight away, which is a verbal stumble.",
            effect: "Smoother delivery.",
            auto: true,
            confidence: 0.8,
            payload: { savedSeconds: next.start - w.start, cutType: "stutter", transcriptExcerpt: context(words, i) },
          })
        );
      }
    }

    // ---------------------------------------------- 3. retakes / false starts / repeated sentences
    for (let i = 0; i < sens.length; i++) {
      for (let j = i + 1; j <= Math.min(sens.length - 1, i + 3); j++) {
        const a1 = sens[i];
        const b1 = sens[j];
        if (b1.start - a1.end > 25) break;
        const sim = similarity(a1, b1);
        const fragment = a1.words.length < 7 && !/[.?!]$/.test(a1.text.trim()) && similarity(a1, b1) > 0.3;
        if (sim >= 0.6 || fragment) {
          // keep the later take (usually the corrected one); remove everything from the earlier take up to the retake
          const end = j === i + 1 ? b1.start : sens[j - 1].end;
          recs.push(
            rec({
              kind: "cut",
              mediaId: mid,
              start: a1.start,
              end,
              title: fragment ? "Remove false start" : "Remove earlier take of repeated sentence",
              action: `Remove ${formatShort(a1.start)} – ${formatShort(end)} and keep the retake at ${formatShort(b1.start)}`,
              reason: fragment
                ? `"${trunc(a1.text)}" is abandoned and then restarted as "${trunc(b1.text)}".`
                : `The same point is said twice (${Math.round(sim * 100)}% similar). The later take is usually the clean one.`,
              effect: "Removes a recording mistake and keeps the content and its meaning.",
              auto: false,
              confidence: Math.min(0.9, 0.45 + sim / 2),
              payload: { savedSeconds: end - a1.start, cutType: "repeat", transcriptExcerpt: `${trunc(a1.text)} ⟶ ${trunc(b1.text)}` },
            })
          );
          break;
        }
      }
    }

    // ---------------------------------------------- 4. greeting-heavy opening
    const first = sens[0];
    if (first && GREETING.test(first.text) && first.end < 12 && sens.length > 4) {
      recs.push(
        rec({
          kind: "cut",
          mediaId: mid,
          start: first.start,
          end: sens[1]?.start ?? first.end,
          title: "Tighten the greeting",
          action: `Remove the generic intro "${trunc(first.text, 60)}"`,
          reason: "A generic greeting at the start is where the biggest share of viewers leave. Get to the value first.",
          effect: "Higher retention in the first 10 seconds. You can say hello after the hook.",
          auto: false,
          confidence: 0.6,
          payload: { savedSeconds: (sens[1]?.start ?? first.end) - first.start, cutType: "redundant", transcriptExcerpt: first.text },
        })
      );
    }

    // ---------------------------------------------- 5. key moments -> punch-in zooms / SFX
    const scored = sens.map((s) => ({ s, score: importance(s, m, medE) })).filter((x) => x.s.end - x.s.start > 1);
    const zoomCands = scored.filter((x) => x.score >= 1.6).sort((a, b) => b.score - a.score);
    const placed: number[] = [];
    let zi = 0;
    for (const z of zoomCands) {
      if (placed.some((t) => Math.abs(t - z.s.start) < P.zoomSpacing)) continue;
      placed.push(z.s.start);
      const preset: MotionPreset = zi++ % 3 === 2 ? "slowZoomIn" : "punchIn";
      recs.push(
        rec({
          kind: "zoom",
          mediaId: mid,
          start: z.s.start,
          end: z.s.end,
          title: preset === "punchIn" ? "Punch-in on key line" : "Slow push-in for emphasis",
          action: `${preset === "punchIn" ? "Punch in 15%" : "Slow zoom in"} during "${trunc(z.s.text, 70)}"`,
          reason: `This is one of the strongest statements (${reasonFor(z.s)}). A framing change here adds emphasis and resets attention.`,
          effect: "Emphasises the point and breaks visual monotony without distracting.",
          auto: false,
          confidence: Math.min(0.9, 0.4 + z.score / 6),
          payload: { motion: preset, intensity: preset === "punchIn" ? 0.6 : 0.6 },
        })
      );
    }
    scored
      .slice()
      .sort((a, b) => b.score - a.score)
      .slice(0, 2)
      .filter((x) => x.score >= 2.2)
      .forEach((x) =>
        recs.push(
          rec({
            kind: "sfx",
            mediaId: mid,
            start: x.s.start,
            end: x.s.start + 1.2,
            title: "Subtle impact under key statement",
            action: `Place a low "impact" at ${formatShort(x.s.start)} at -18 dB`,
            reason: `"${trunc(x.s.text, 60)}" is a headline moment. A controlled low-end hit underlines it.`,
            effect: "The moment lands harder. Keep it quiet so it never masks the voice.",
            auto: false,
            confidence: 0.5,
            payload: { sfxId: "impact" },
          })
        )
      );

    // ---------------------------------------------- 6. B-roll, scene by scene
    let lastBroll = -Infinity;
    let scene = 1;
    for (const s of sens) {
      while (a?.scenes && scene - 1 < a.scenes.length && a.scenes[scene - 1] < s.start) scene++;
      if (s.start < 3 || s.start - lastBroll < P.brollSpacing || s.words.length < 5) continue;
      const kw = keywords(s.text, 3);
      if (kw.length < 1) continue;
      lastBroll = s.start;
      const screen = /\b(app|website|screen|click|button|dashboard|software|tool|settings|page|browser)\b/i.test(s.text);
      const stat = /\d|percent|%/i.test(s.text);
      const assetType = screen ? "screenshot" : stat ? "graphic" : "video";
      const dur = Math.max(3, Math.min(5, s.end - s.start));
      const visual = screen
        ? `Screen recording or screenshot of the ${kw.join(" / ")} being described`
        : stat
          ? `Animated stat / infographic that shows the number mentioned ("${trunc(s.text, 50)}")`
          : `Footage that shows ${kw.join(", ")}`;
      recs.push(
        rec({
          kind: "broll",
          mediaId: mid,
          start: s.start,
          end: s.start + dur,
          sceneIndex: scene,
          title: `Scene ${String(scene).padStart(2, "0")} - supporting visual`,
          action: `Insert a ${dur.toFixed(0)}s ${assetType === "video" ? "supporting clip" : assetType} at ${formatShort(s.start)}`,
          reason: `The narration talks about ${kw.map((k) => `"${k}"`).join(", ")}. Showing it reinforces the point and covers a long stretch of the same shot.`,
          effect: "Better comprehension and a pattern interrupt that holds attention.",
          auto: false,
          confidence: 0.55,
          payload: {
            narration: s.text,
            visual,
            query: kw.slice(0, 2).join(" "),
            assetType,
            duration: dur,
            animation: assetType === "video" ? "slowZoomIn" : "kenBurns",
            transition: "crossfade",
          },
        })
      );
    }

    // ---------------------------------------------- 7. engagement drops (long static stretches)
    const changes = [...(a?.scenes ?? []), ...placed, ...recs.filter((r) => r.kind === "broll" && r.mediaId === mid).map((r) => r.start)].sort((x, y) => x - y);
    let prev = words[0]?.start ?? 0;
    for (const t of [...changes, m.duration]) {
      if (t - prev > P.stretch * 1.8) {
        const mid1 = prev + (t - prev) / 2;
        recs.push(
          rec({
            kind: "pacing",
            mediaId: mid,
            start: prev,
            end: t,
            title: "Possible engagement drop",
            action: `Add a visual change near ${formatShort(mid1)} (punch-in, B-roll or on-screen text)`,
            reason: `${(t - prev).toFixed(0)}s with no visual change. Attention often drops on long static shots.`,
            effect: "Pattern interrupts help viewers keep watching.",
            auto: false,
            confidence: 0.5,
            payload: { motion: "punchIn", intensity: 0.5 },
          })
        );
      }
      prev = t;
    }

    // ---------------------------------------------- 8. transitions at major breaks
    for (const g of merged.filter((g) => g.end - g.start > 1.6 && g.start > 1 && g.end < m.duration - 1)) {
      const scenic = a?.scenes.some((t) => Math.abs(t - g.end) < 2);
      if (!scenic) continue;
      const type = goals.style === "cinematic" || goals.style === "calm" ? "fadeBlack" : "crossfade";
      recs.push(
        rec({
          kind: "transition",
          mediaId: mid,
          start: g.end,
          end: g.end + 0.5,
          title: type === "fadeBlack" ? "Chapter break: fade through black" : "Soften scene change",
          action: `Use a ${type === "fadeBlack" ? "0.8s fade to black" : "0.4s crossfade"} at ${formatShort(g.end)}`,
          reason: "A long pause plus a visual scene change marks a topic shift. A soft transition tells viewers a new section has started.",
          effect: "Clearer structure. Everywhere else stays on hard cuts so the edit stays clean.",
          auto: false,
          confidence: 0.45,
          payload: { transitionType: type },
        })
      );
    }

    // ---------------------------------------------- 9. audio
    const L = a?.loudness;
    if (L && Math.abs(L.integrated - project.master.targetLufs) > 1.5) {
      recs.push(
        rec({
          kind: "audio",
          mediaId: mid,
          start: 0,
          end: m.duration,
          title: "Normalize loudness",
          action: `Normalize the mix from ${L.integrated.toFixed(1)} LUFS to ${project.master.targetLufs} LUFS`,
          reason: L.integrated < project.master.targetLufs ? "The audio is quieter than the platform standard, so viewers will turn it up or leave." : "The audio is louder than the platform standard, so the platform will turn it down and it may distort.",
          effect: "Consistent, platform-ready loudness.",
          auto: true,
          confidence: 0.9,
          payload: { master: { normalize: true, limiter: true } },
        })
      );
    }
    if (a?.noiseFloorDb !== undefined && a.noiseFloorDb > -58 && m.hasAudio) {
      const strength = Math.min(0.85, Math.max(0.25, (a.noiseFloorDb + 62) / 25));
      recs.push(
        rec({
          kind: "audio",
          mediaId: mid,
          start: 0,
          end: m.duration,
          title: "Reduce background noise",
          action: `Apply noise reduction at ${Math.round(strength * 100)}% plus a rumble filter on the voice track`,
          reason: `The noise floor is about ${a.noiseFloorDb.toFixed(0)} dBFS, which is audible hiss or room noise during pauses.`,
          effect: "Cleaner, more professional voice. Too much reduction sounds watery, so preview it.",
          auto: false,
          confidence: 0.7,
          payload: { fx: { denoise: strength, highpass: true }, trackRole: "voice" },
        })
      );
    }
    if (words.length > 20) {
      recs.push(
        rec({
          kind: "audio",
          mediaId: mid,
          start: 0,
          end: m.duration,
          title: "Voice enhancement chain",
          action: "Enable high-pass, presence EQ and gentle compression on the voice",
          reason: "This is speech-led content. A broadcast-style chain evens out the level and improves clarity on phone speakers.",
          effect: "Clearer, more even dialogue that is easy to hear over music.",
          auto: false,
          confidence: 0.75,
          payload: { fx: { highpass: true, voiceEnhance: true, compressor: 0.5 }, trackRole: "voice" },
        })
      );
    }
    if (a?.clipping?.likely) {
      warnings.push(`"${m.name}" has clipped audio peaks (${a.clipping.peakDb.toFixed(1)} dBFS). A limiter prevents more distortion, but already-clipped samples cannot be fully restored.`);
      recs.push(
        rec({
          kind: "audio",
          mediaId: mid,
          start: 0,
          end: m.duration,
          title: "Clipping detected",
          action: "Enable the limiter and lower the voice track by 3 dB",
          reason: `Peaks reach ${a.clipping.peakDb.toFixed(1)} dBFS, which is digital clipping.`,
          effect: "Stops further distortion in the export.",
          auto: true,
          confidence: 0.8,
          payload: { fx: { limiter: true }, trackRole: "voice" },
        })
      );
    }

    // ---------------------------------------------- 10. colour
    const v = a?.visual;
    if (v && m.hasVideo) {
      const grade: Record<string, number> = {};
      const why: string[] = [];
      if (v.brightness < 85) {
        grade.exposure = Math.min(0.7, (100 - v.brightness) / 60);
        grade.shadows = 0.15;
        why.push(`the image is underexposed (average luma ${v.brightness.toFixed(0)}/255)`);
      } else if (v.brightness > 175) {
        grade.exposure = -Math.min(0.6, (v.brightness - 160) / 60);
        grade.highlights = -0.2;
        why.push(`highlights look bright (average luma ${v.brightness.toFixed(0)}/255)`);
      }
      if (v.saturation < 22) {
        grade.saturation = 1.15;
        why.push("colours look flat or washed out");
      } else if (v.saturation > 85) {
        grade.saturation = 0.9;
        why.push("colours are oversaturated, which can make skin look unnatural");
      }
      if (!why.length) {
        grade.contrast = 0.06;
        grade.saturation = 1.05;
        why.push("the exposure is fine. A light contrast lift adds polish");
      }
      recs.push(
        rec({
          kind: "color",
          mediaId: mid,
          start: 0,
          end: m.duration,
          title: "Colour correction",
          action: `Apply ${Object.entries(grade).map(([k, val]) => `${k} ${val > 0 && k !== "saturation" ? "+" : ""}${val.toFixed(2)}`).join(", ")}`,
          reason: `${why.join(" and ")}. These changes are kept small so skin tones stay natural.`,
          effect: "Cleaner, more balanced image that looks the same from shot to shot.",
          auto: false,
          confidence: 0.65,
          payload: { grade },
        })
      );
      const ps = v.perScene;
      if (ps.length > 2) {
        const bs = ps.map((p) => p.brightness);
        const spread = Math.max(...bs) - Math.min(...bs);
        if (spread > 45) warnings.push(`Brightness varies a lot between scenes in "${m.name}" (spread ${spread.toFixed(0)}). Consider matching shots in the Color workspace.`);
      }
    }
  }

  // ---------------------------------------------- 11. captions / music / hook (project-wide)
  const hasWords = wordsCount > 0;
  if (hasWords && !project.captions.enabled) {
    const preset = goals.platform === "youtube" ? "clean-box" : "bold-pop";
    recs.push(
      rec({
        kind: "caption",
        start: 0,
        end: 0,
        title: "Add word-by-word captions",
        action: `Turn on captions with the "${preset}" preset`,
        reason: goals.platform === "youtube" ? "Captions improve accessibility and help viewers who watch muted." : "Most short-form video is watched without sound. Animated captions are expected.",
        effect: "Higher watch time and accessibility.",
        auto: true,
        confidence: 0.9,
        payload: { captionPreset: preset },
      })
    );
  }
  const musicTrack = project.tracks.find((t) => t.role === "music");
  const hasMusic = musicTrack && project.clips.some((c) => c.trackId === musicTrack.id);
  const mood = goals.style === "fast" ? "energetic" : goals.style === "cinematic" ? "tension" : "atmospheric";
  if (!hasMusic && totalDur > 0) {
    recs.push(
      rec({
        kind: "music",
        start: 0,
        end: 0,
        title: `Background music (${mood})`,
        action: `Add a ${mood} music bed at about -24 dB under the voice, with automatic ducking`,
        reason: `The ${goals.style} style and the "${goals.tone}" tone suit ${mood} music. A quiet bed fills pauses and sets the mood.`,
        effect: "More energy and polish. Ducking keeps the dialogue clear.",
        auto: false,
        confidence: 0.55,
        payload: { mood, sfxId: mood === "energetic" ? "pulse-bed" : mood === "tension" ? "tension-bed" : "ambient-bed" },
      })
    );
  }

  const medianAll = median(allSentences.map((x) => energyAt(x.m, x.s.start, x.s.end)));
  const ranked = allSentences.map((x) => ({ ...x, score: importance(x.s, x.m, medianAll) })).sort((a, b) => b.score - a.score);
  const hook = ranked.find((x) => x.s.start > 5 && x.s.end - x.s.start > 1.5 && x.s.end - x.s.start < 12);
  if (hook && hook.score > 1.2) {
    recs.push(
      rec({
        kind: "hook",
        mediaId: hook.m.id,
        start: hook.s.start,
        end: hook.s.end,
        title: "Use a stronger opening hook",
        action: `Copy "${trunc(hook.s.text, 80)}" (${formatShort(hook.s.start)}) to the very start as a cold open`,
        reason: `This is the most compelling line (${reasonFor(hook.s)}), but it only comes at ${formatShort(hook.s.start)}. Opening with it gives viewers a reason to stay.`,
        effect: "Stronger first 5 seconds. The original stays in place, so no context is lost.",
        auto: false,
        confidence: 0.6,
        payload: { transcriptExcerpt: hook.s.text },
      })
    );
  }

  // ---------------------------------------------- 12. target duration (redundant sections)
  const autoSaved = recs.filter((r) => r.kind === "cut" && r.auto).reduce((n, r) => n + (r.payload?.savedSeconds ?? 0), 0);
  const tlDur = project.clips.reduce((d, c) => Math.max(d, c.start + (c.out - c.in) / c.speed), 0);
  if (goals.targetDuration > 0 && tlDur - autoSaved > goals.targetDuration * 1.05) {
    let excess = tlDur - autoSaved - goals.targetDuration;
    const low = ranked
      .slice()
      .reverse()
      .filter((x) => x.score < 0.3 && !/\d/.test(x.s.text) && x.s.words.length > 3);
    let n = 0;
    for (const x of low) {
      if (excess <= 0 || n > 12) break;
      const len = x.s.end - x.s.start;
      excess -= len;
      n++;
      recs.push(
        rec({
          kind: "cut",
          mediaId: x.m.id,
          start: x.s.start,
          end: x.s.end,
          title: "Optional: trim low-impact sentence",
          action: `Remove "${trunc(x.s.text, 70)}" (${len.toFixed(1)}s) to get closer to your ${Math.round(goals.targetDuration)}s target`,
          reason: "This sentence has the lowest information density (no numbers, few key terms, low emphasis). Check that it is not needed for context.",
          effect: "Gets closer to the target length. Approve it only if the meaning is kept.",
          auto: false,
          confidence: 0.35,
          payload: { savedSeconds: len, cutType: "redundant", transcriptExcerpt: x.s.text },
        })
      );
    }
    strategy.push(`To hit ${Math.round(goals.targetDuration)}s, ${n} low-impact sentences are flagged as optional cuts. They are never applied automatically.`);
  }

  // map to timeline & drop recs that fall outside the edit
  const live = recs.filter((r) => !r.mediaId || r.kind === "audio" || r.kind === "color" || r.kind === "hook" || sourceRangeToTimeline(project.clips, r.mediaId, r).length > 0);

  const cuts = live.filter((r) => r.kind === "cut");
  strategy.unshift(
    `Remove ${cuts.length} pauses, fillers and mistakes (about ${cuts.reduce((n, r) => n + (r.payload?.savedSeconds ?? 0), 0).toFixed(1)}s). The ${cuts.filter((c) => c.auto).length} safe ones can be applied automatically.`,
    `Pacing style: ${goals.style}. Pauses over ${P.minSilence}s are removed, with a visual change about every ${P.zoomSpacing}-${P.brollSpacing}s.`,
    `${live.filter((r) => r.kind === "broll").length} B-roll opportunities and ${live.filter((r) => r.kind === "zoom").length} emphasis zooms, spaced so they never feel overused.`,
    hasWords ? "Word-level captions in a platform-appropriate style." : "Transcribe the footage to unlock captions, filler removal and B-roll matching.",
    "Audio: voice clarity chain, noise reduction where needed, loudness normalisation, music ducked under speech."
  );

  const summary = `Analysed ${mediaIds.length} clip${mediaIds.length === 1 ? "" : "s"} (${formatShort(totalDur)} of footage, ${wordsCount} words). Found ${totalSilence.toFixed(1)}s of removable pauses, ${cuts.filter((c) => c.payload?.cutType === "filler" || c.payload?.cutType === "stutter").length} fillers/stutters and ${cuts.filter((c) => c.payload?.cutType === "repeat").length} possible retakes.`;

  return { recommendations: live, kit: buildKit(project, ranked, media), summary, strategy, warnings };
}

function mergeGaps(gs: Range[]): Range[] {
  const s = gs.slice().sort((a, b) => a.start - b.start);
  const out: Range[] = [];
  for (const g of s) {
    const l = out[out.length - 1];
    if (l && g.start <= l.end + 0.05) l.end = Math.max(l.end, g.end);
    else out.push({ ...g });
  }
  return out;
}

function context(words: Word[], i: number): string {
  return words
    .slice(Math.max(0, i - 4), i + 5)
    .map((w) => w.text)
    .join(" ");
}

function trunc(s: string, n = 48): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

function reasonFor(s: Sentence): string {
  const r: string[] = [];
  if (/\d/.test(s.text)) r.push("it has a concrete number");
  if (/\?$/.test(s.text.trim())) r.push("it asks a question");
  const m = s.text.match(STRONG);
  if (m) r.push(`it uses the strong word "${m[0].toLowerCase()}"`);
  if (!r.length) r.push("the delivery is emphatic");
  return r.join(", ");
}

function buildKit(project: Project, ranked: { s: Sentence; m: MediaItem; score: number }[], media: Record<string, MediaItem>): PublishingKit {
  const all = ranked.map((r) => r.s.text).join(" ");
  const kw = keywords(all, 6);
  const K = (i: number) => (kw[i] ? kw[i][0].toUpperCase() + kw[i].slice(1) : "This");
  const best = ranked.slice(0, 3).map((r) => r.s);
  const chron = ranked.slice().sort((a, b) => a.s.start - b.s.start);
  // chapters: split into ~equal topic blocks at sentence boundaries, at least 10s apart
  const chapters: { t: number; title: string }[] = [];
  const mainClips = project.clips.filter((c) => c.mediaId).sort((a, b) => a.start - b.start);
  const total = project.clips.reduce((d, c) => Math.max(d, c.start + (c.out - c.in) / c.speed), 0);
  const nCh = Math.max(3, Math.min(8, Math.round(total / 90)));
  if (total >= 30 && chron.length) {
    for (let i = 0; i < nCh; i++) {
      const target = (total / nCh) * i;
      const sens = chron.filter((x) => {
        const tl = sourceRangeToTimeline(mainClips, x.m.id, x.s)[0];
        return tl && tl.start >= target;
      });
      const block = sens.slice(0, 6).map((x) => x.s.text).join(" ");
      const k = keywords(block, 2);
      const t = i === 0 ? 0 : (sourceRangeToTimeline(mainClips, sens[0]?.m.id ?? "", sens[0]?.s ?? { start: 0, end: 0 })[0]?.start ?? target);
      if (chapters.length && t - chapters[chapters.length - 1].t < 10) continue;
      chapters.push({ t, title: i === 0 ? "Intro" : k.length ? k.map((x) => x[0].toUpperCase() + x.slice(1)).join(" & ") : `Part ${i + 1}` });
    }
  }
  // shorts: 20-55s windows with the highest score density
  const shorts: PublishingKit["shorts"] = [];
  for (const mId of new Set(chron.map((x) => x.m.id))) {
    const ss = chron.filter((x) => x.m.id === mId);
    const windows: { start: number; end: number; score: number; text: string }[] = [];
    for (let i = 0; i < ss.length; i++) {
      let score = 0;
      for (let j = i; j < ss.length; j++) {
        score += ss[j].score;
        const len = ss[j].s.end - ss[i].s.start;
        if (len > 55) break;
        if (len >= 20) windows.push({ start: ss[i].s.start, end: ss[j].s.end, score: score / Math.sqrt(len), text: ss[i].s.text });
      }
    }
    windows.sort((a, b) => b.score - a.score);
    for (const w of windows) {
      if (shorts.length >= 3) break;
      if (shorts.some((s) => s.start < w.end && w.start < s.end)) continue;
      shorts.push({ start: w.start, end: w.end, mediaId: mId, title: trunc(w.text, 60), reason: "Self-contained stretch with the highest density of strong statements. Opens on a complete sentence." });
    }
  }
  return {
    titles: [`How ${K(0)} Really Works`, `${K(0)}: What Nobody Tells You About ${K(1)}`, `I Tried ${K(0)} So You Don't Have To`, `The ${K(0)} Mistake Everyone Makes`, `${K(0)} in ${Math.max(1, Math.round(total / 60))} Minutes`],
    hooks: best.map((s) => s.text),
    description: `${chron.slice(0, 2).map((x) => x.s.text).join(" ")}\n\nIn this video: ${kw.join(", ")}.\n\n${chapters.map((c) => `${formatShort(c.t).replace(/\.\d$/, "")} ${c.title}`).join("\n")}`,
    chapters,
    thumbnails: [
      `Close-up of your face with a strong expression + 2-3 word text: "${K(0).toUpperCase()}?!"`,
      `Before/after split screen about ${kw[0] ?? "the topic"} with a bold red arrow`,
      `Key object (${kw[1] ?? kw[0] ?? "the subject"}) on a bright contrasting background, large number or claim from the video`,
    ],
    shorts,
    openings: [
      best[0] ? `Cold open: start with "${trunc(best[0].text, 90)}" then cut to the intro.` : "Cold open with your strongest line.",
      `Question first: "Have you ever wondered about ${kw[0] ?? "this"}?" over B-roll, then answer.`,
      `Result first: show the outcome or payoff in the first 3 seconds, then explain how you got there.`,
    ],
    tags: kw,
  };
}
