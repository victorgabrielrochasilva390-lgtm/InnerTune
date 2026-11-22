import { useEffect, useMemo, useRef, useState } from "react";
import type { Recommendation, RecKind } from "../../shared/types";
import { useEditor } from "../store";
import { adjustRec, applyMany, applyRec, createShortProject, previewRec, recTimeline, runDirector, setRecStatus } from "../actions";
import { estimateSaved } from "../../shared/apply";
import { formatShort, formatTime } from "../../shared/timeline";
import { Empty, Icon, NumberInput, Section, Select, Toggle } from "./ui";
import type { PubMedia } from "../api";

const KIND_LABEL: Record<RecKind, string> = {
  cut: "Cuts",
  broll: "B-roll",
  zoom: "Zooms",
  transition: "Transitions",
  music: "Music",
  sfx: "Sound FX",
  color: "Colour",
  audio: "Audio",
  caption: "Captions",
  hook: "Hook",
  title: "Titles",
  pacing: "Pacing",
};

export function AIPanel({ onOpenProject }: { onOpenProject: (id: string) => void }) {
  const project = useEditor((s) => s.project)!;
  const caps = useEditor((s) => s.caps);
  const jobs = useEditor((s) => s.jobs);
  const focus = useEditor((s) => s.focusRec);
  const S = useEditor.getState;
  const goals = project.ai.goals;
  const [tab, setTab] = useState<"plan" | "kit">("plan");
  const [busy, setBusy] = useState(false);
  const [useClaude, setUseClaude] = useState(!!caps?.claude.available);
  const [useVision, setUseVision] = useState(true);
  const [filter, setFilter] = useState<RecKind | "all">("all");
  const [showDone, setShowDone] = useState(false);
  useEffect(() => setUseClaude(!!caps?.claude.available), [caps?.claude.available]);

  const setGoal = (patch: Partial<typeof goals>) => S().commit("Editing goals", (d) => void Object.assign(d.ai.goals, patch), "goals");
  const recs = project.ai.recommendations;
  const pending = recs.filter((r) => r.status === "pending" || r.status === "approved");
  const counts = useMemo(() => {
    const c: Partial<Record<RecKind, number>> = {};
    for (const r of recs) if (showDone || r.status === "pending" || r.status === "approved") c[r.kind] = (c[r.kind] ?? 0) + 1;
    return c;
  }, [recs, showDone]);
  const shown = recs.filter((r) => (filter === "all" || r.kind === filter) && (showDone || r.status === "pending" || r.status === "approved"));
  const autoIds = pending.filter((r) => r.auto).map((r) => r.id);
  const cutSaving = estimateSaved(project, pending.filter((r) => r.kind === "cut"));
  const unanalysed = project.mediaIds.map((id) => S().media[id]).filter((m) => m && m.kind !== "image" && !m.analysis && project.clips.some((c) => c.mediaId === m.id));
  const running = Object.values(jobs).some((j) => j.projectId === project.id && j.type === "analysis" && (j.status === "running" || j.status === "queued"));

  const run = async () => {
    setBusy(true);
    try {
      await runDirector(useClaude, useVision);
      setTab("plan");
    } catch (e) {
      S().toast((e as Error).message, "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="panel-body ai-panel" data-tour="ai">
      <div className="tabs small-tabs">
        <button className={tab === "plan" ? "active" : ""} onClick={() => setTab("plan")}>
          Editing plan {pending.length ? `(${pending.length})` : ""}
        </button>
        <button className={tab === "kit" ? "active" : ""} onClick={() => setTab("kit")} disabled={!project.ai.kit}>
          Publishing kit
        </button>
      </div>
      {tab === "plan" && (
        <>
          <Section title="Goals" defaultOpen={!recs.length}>
            <div className="grid2">
              <label>
                Genre
                <input className="text-input" value={goals.genre} onChange={(e) => setGoal({ genre: e.target.value })} onKeyDown={(e) => e.stopPropagation()} />
              </label>
              <label>
                Audience
                <input className="text-input" value={goals.audience} onChange={(e) => setGoal({ audience: e.target.value })} onKeyDown={(e) => e.stopPropagation()} />
              </label>
              <Select label="Platform" value={goals.platform} onChange={(v) => setGoal({ platform: v })} options={[{ value: "youtube", label: "YouTube" }, { value: "shorts", label: "YouTube Shorts" }, { value: "tiktok", label: "TikTok" }, { value: "reels", label: "Instagram Reels" }, { value: "instagram", label: "Instagram feed" }]} />
              <Select label="Style" value={goals.style} onChange={(v) => setGoal({ style: v })} options={[{ value: "fast", label: "Fast-paced" }, { value: "balanced", label: "Balanced" }, { value: "educational", label: "Educational" }, { value: "calm", label: "Calm" }, { value: "cinematic", label: "Cinematic" }]} />
              <label>
                Tone
                <input className="text-input" value={goals.tone} onChange={(e) => setGoal({ tone: e.target.value })} onKeyDown={(e) => e.stopPropagation()} />
              </label>
              <label>
                Target length (s, 0 = any)
                <NumberInput value={goals.targetDuration} step={5} min={0} onChange={(v) => setGoal({ targetDuration: v })} />
              </label>
            </div>
            <textarea className="text-area" placeholder="Notes for the editor (e.g. keep the joke at 2:10, no music in the intro)" value={goals.notes} onChange={(e) => setGoal({ notes: e.target.value })} onKeyDown={(e) => e.stopPropagation()} rows={2} />
            <div className="mode-switch">
              <button className={goals.mode === "manual" ? "active" : ""} onClick={() => setGoal({ mode: "manual" })} data-tip="AI recommends; you approve every change">
                Manual mode
              </button>
              <button className={goals.mode === "automatic" ? "active" : ""} onClick={() => setGoal({ mode: "automatic" })} data-tip="Safe changes (pauses, fillers, loudness, captions) are applied automatically; creative ones still wait for you">
                Automatic mode
              </button>
            </div>
          </Section>
          <div className="ai-run">
            <Toggle label={`Use Claude (${caps?.claude.model ?? "Anthropic"})`} checked={useClaude} disabled={!caps?.claude.available} onChange={setUseClaude} help={caps?.claude.available ? "Claude reviews transcript, measurements and keyframes like a senior editor" : "Set ANTHROPIC_API_KEY on the server to enable. The free built-in engine is used otherwise"} />
            {useClaude && <Toggle label="Send scene keyframes (vision)" checked={useVision} onChange={setUseVision} />}
            {!caps?.claude.available && <p className="muted small">Running the free, offline engine (real silence / scene / loudness / transcript analysis). Add ANTHROPIC_API_KEY for deeper, content-aware plans.</p>}
            {unanalysed.length > 0 && <div className="hint small">Still analysing: {unanalysed.map((m) => m!.name).join(", ")}. Results get better once that finishes.</div>}
            <button className="btn primary big" disabled={busy || running || !project.clips.length} onClick={run} data-tour="ai-run">
              <Icon name="sparkle" /> {busy || running ? "Analysing footage…" : recs.length ? "Re-analyse & update plan" : "Analyse & build editing plan"}
            </button>
          </div>

          {project.ai.summary && (
            <Section title={`Strategy${project.ai.lastRun ? ` · ${project.ai.lastRun.source === "claude" ? "Claude" : "built-in engine"}` : ""}`}>
              <p>{project.ai.summary}</p>
              <ol className="strategy">
                {project.ai.strategy?.map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
              </ol>
              {project.ai.lastRun?.warnings.map((w, i) => (
                <div key={i} className="hint small">
                  ⚠ {w}
                </div>
              ))}
            </Section>
          )}

          {recs.length > 0 && (
            <>
              <div className="bulk">
                <button className="btn" disabled={!autoIds.length} onClick={() => S().toast(`Applied ${applyMany(autoIds, "Apply safe AI changes")} safe changes`, "success")} data-tip="Applies only recommendations marked AUTO (low-risk)">
                  <Icon name="check" /> Apply {autoIds.length} safe changes
                </button>
                <span className="muted small">Pending cuts save {cutSaving.toFixed(1)}s</span>
              </div>
              <div className="chip-row">
                <button className={`chip ${filter === "all" ? "active" : ""}`} onClick={() => setFilter("all")}>
                  All
                </button>
                {(Object.keys(counts) as RecKind[]).map((k) => (
                  <button key={k} className={`chip k-${k} ${filter === k ? "active" : ""}`} onClick={() => setFilter(k)}>
                    {KIND_LABEL[k]} {counts[k]}
                  </button>
                ))}
                <Toggle label="Show done" checked={showDone} onChange={setShowDone} />
              </div>
              <div className="rec-list">
                {shown.map((r) => (
                  <RecCard key={r.id} rec={r} focused={focus === r.id} />
                ))}
                {!shown.length && <Empty icon="check" title="Nothing left to review here" />}
              </div>
            </>
          )}
          {!recs.length && !busy && (
            <Empty icon="sparkle" title="Your AI editing director">
              Add footage to the timeline, set your goals, then build a plan. Every suggestion explains what to change, where, why and the expected effect, and you approve each one.
            </Empty>
          )}
        </>
      )}
      {tab === "kit" && project.ai.kit && <Kit onOpenProject={onOpenProject} />}
    </div>
  );
}

function RecCard({ rec: r, focused }: { rec: Recommendation; focused: boolean }) {
  const project = useEditor((s) => s.project)!;
  const media = useEditor((s) => s.media);
  const S = useEditor.getState;
  const ref = useRef<HTMLDivElement>(null);
  const [adjust, setAdjust] = useState(false);
  const [pick, setPick] = useState("");
  useEffect(() => {
    if (focused) ref.current?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [focused]);
  const tl = recTimeline(project, r);
  const needsMedia = r.kind === "broll" || (r.kind === "music" && !r.payload?.sfxId);
  const visuals = project.mediaIds.map((id) => media[id]).filter((m): m is PubMedia => !!m && (r.kind === "music" ? m.kind === "audio" : m.kind !== "audio"));
  const m = r.mediaId ? media[r.mediaId] : undefined;
  return (
    <div ref={ref} className={`rec k-${r.kind} st-${r.status} ${focused ? "focused" : ""}`}>
      <div className="rec-head">
        <span className={`kind-dot k-${r.kind}`} />
        <strong>{r.title}</strong>
        {r.auto && <span className="badge ok" data-tip="Low risk: can be applied automatically">AUTO</span>}
        {r.source === "claude" && <span className="badge">Claude</span>}
        <span className="grow" />
        <span className="conf" data-tip={`Confidence ${(r.confidence * 100).toFixed(0)}%`}>
          <span style={{ width: `${r.confidence * 100}%` }} />
        </span>
      </div>
      <div className="rec-where small">
        {r.mediaId ? (
          <>
            <b>Source</b> {formatTime(r.start, 30, false)}–{formatTime(r.end, 30, false)}
            {m ? ` (${m.name})` : ""} · <b>Timeline</b> {tl ? formatShort(tl.start) : "not in edit"}
          </>
        ) : (
          <b>Whole project</b>
        )}
        {r.payload?.savedSeconds ? ` · saves ${r.payload.savedSeconds.toFixed(1)}s` : ""}
      </div>
      <dl className="rec-body">
        <dt>Change</dt>
        <dd>{r.action}</dd>
        <dt>Why</dt>
        <dd>{r.reason}</dd>
        <dt>Effect</dt>
        <dd>{r.effect}</dd>
        {r.payload?.transcriptExcerpt && (
          <>
            <dt>Words</dt>
            <dd className="quote">“{r.payload.transcriptExcerpt}”</dd>
          </>
        )}
        {r.kind === "broll" && (
          <>
            <dt>Narration</dt>
            <dd className="quote">“{r.payload?.narration}”</dd>
            <dt>Visual</dt>
            <dd>
              {r.payload?.visual} · <i>{r.payload?.animation}</i>, {r.payload?.transition}, {r.payload?.duration?.toFixed(0)}s
            </dd>
          </>
        )}
      </dl>
      {adjust && (
        <div className="rec-adjust">
          <label className="small">
            Start <NumberInput value={r.start} step={0.05} min={0} onChange={(v) => adjustRec(r.id, { start: Math.min(v, r.end - 0.05) })} />
          </label>
          <label className="small">
            End <NumberInput value={r.end} step={0.05} min={r.start + 0.05} onChange={(v) => adjustRec(r.id, { end: v })} />
          </label>
          <button className="btn sm ghost" onClick={() => adjustRec(r.id, { start: Math.max(0, r.start - 0.1) })}>
            ◂ widen
          </button>
          <button className="btn sm ghost" onClick={() => adjustRec(r.id, { end: r.end + 0.1 })}>
            widen ▸
          </button>
        </div>
      )}
      {needsMedia && r.status !== "applied" && (
        <div className="row gap">
          <Select value={pick} onChange={setPick} options={[{ value: "", label: visuals.length ? "Choose media…" : "Import media first" }, ...visuals.map((v) => ({ value: v.id, label: v.name }))]} />
          {r.kind === "broll" && (
            <button className="btn sm" onClick={() => S().set({ leftTab: "broll", brollQuery: r.payload?.query ?? "" })}>
              <Icon name="search" size={12} /> Stock
            </button>
          )}
        </div>
      )}
      <div className="rec-actions">
        {r.status === "applied" ? (
          <span className="ok small">✓ Applied (undo with Ctrl+Z)</span>
        ) : r.status === "rejected" ? (
          <>
            <span className="muted small">Rejected</span>
            <button className="btn sm ghost" onClick={() => setRecStatus(r.id, "pending")}>
              Restore
            </button>
          </>
        ) : (
          <>
            <button className="btn sm" onClick={() => previewRec(r)} disabled={!tl && !!r.mediaId} data-tip={r.kind === "cut" ? "Plays the moment with the cut skipped" : "Jump to and play this moment"}>
              <Icon name="play" size={11} /> Preview
            </button>
            <button className="btn sm primary" disabled={needsMedia && !pick} onClick={() => applyRec(r.id, pick ? media[pick] : undefined)}>
              <Icon name="check" size={12} /> Apply
            </button>
            <button className="btn sm ghost" onClick={() => setRecStatus(r.id, "rejected")}>
              <Icon name="x" size={12} /> Reject
            </button>
            {r.mediaId && r.end > r.start && (
              <button className="btn sm ghost" onClick={() => setAdjust(!adjust)}>
                Adjust
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function Copy({ text }: { text: string }) {
  return (
    <button className="btn sm ghost" onClick={() => (navigator.clipboard?.writeText(text), useEditor.getState().toast("Copied"))}>
      Copy
    </button>
  );
}

function Kit({ onOpenProject }: { onOpenProject: (id: string) => void }) {
  const kit = useEditor((s) => s.project!.ai.kit!);
  const S = useEditor.getState;
  const chapters = kit.chapters.map((c) => `${formatShort(c.t).replace(/\.\d$/, "")} ${c.title}`).join("\n");
  return (
    <div className="kit">
      <Section title="Titles">
        {kit.titles.map((t, i) => (
          <div key={i} className="kit-row">
            <span className="grow">{t}</span>
            <Copy text={t} />
          </div>
        ))}
      </Section>
      <Section title="Hooks & opening variations">
        {kit.hooks.map((t, i) => (
          <div key={i} className="kit-row">
            <span className="grow quote">“{t}”</span>
            <Copy text={t} />
          </div>
        ))}
        {kit.openings.map((t, i) => (
          <div key={`o${i}`} className="kit-row small">
            <span className="grow">▸ {t}</span>
          </div>
        ))}
      </Section>
      <Section title="Description">
        <pre className="desc">{kit.description}</pre>
        <Copy text={kit.description} />
      </Section>
      <Section title="Chapters">
        {kit.chapters.map((c, i) => (
          <div key={i} className="kit-row clickable" onClick={() => S().set({ playhead: c.t })}>
            <code>{formatShort(c.t)}</code>
            <span className="grow">{c.title}</span>
          </div>
        ))}
        {kit.chapters.length > 0 && <Copy text={chapters} />}
        {kit.chapters.length > 0 && kit.chapters.length < 3 && <p className="muted small">YouTube needs at least 3 chapters, the first at 0:00, each at least 10s long.</p>}
      </Section>
      <Section title="Thumbnail concepts">
        <ul>
          {kit.thumbnails.map((t, i) => (
            <li key={i}>{t}</li>
          ))}
        </ul>
        <p className="muted small">Tip: find the frame you want, then use “Export current frame” under the viewer.</p>
      </Section>
      <Section title="Short-form clips">
        {kit.shorts.map((s, i) => (
          <div key={i} className="short-item">
            <div>
              <strong>{s.title}</strong>
              <div className="muted small">
                {formatShort(s.start)}–{formatShort(s.end)} ({(s.end - s.start).toFixed(0)}s) · {s.reason}
              </div>
            </div>
            <button
              className="btn sm primary"
              onClick={async () => {
                try {
                  const np = await createShortProject(s);
                  if (np) {
                    S().toast("Vertical short project created", "success");
                    onOpenProject(np.id);
                  }
                } catch (e) {
                  S().toast((e as Error).message, "error");
                }
              }}
            >
              Create 9:16 short
            </button>
          </div>
        ))}
        {!kit.shorts.length && <p className="muted small">No self-contained 20–55s segment found yet.</p>}
      </Section>
      {kit.tags && kit.tags.length > 0 && (
        <Section title="Tags">
          <div className="chip-row">
            {kit.tags.map((t) => (
              <span key={t} className="chip">
                {t}
              </span>
            ))}
          </div>
          <Copy text={kit.tags.join(", ")} />
        </Section>
      )}
    </div>
  );
}
