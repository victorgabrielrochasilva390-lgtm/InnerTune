import { useMemo, useRef, useState } from "react";
import { useEditor } from "../store";
import { applyCaptionPreset, cutWordsFromVideo, editWord, importSubtitles, transcribeMedia, setTranscript } from "../actions";
import { CAPTION_PRESETS, FONTS, fontById } from "../../shared/presets";
import { captionPages, toSrt, toVtt } from "../../shared/captions";
import { formatShort, toTimeline, clipEnd } from "../../shared/timeline";
import { api } from "../api";
import { ColorInput, Empty, Icon, Section, Select, Slider, Toggle } from "./ui";
import type { CaptionStyle } from "../../shared/types";

export function CaptionsPanel() {
  const project = useEditor((s) => s.project)!;
  const media = useEditor((s) => s.media);
  const caps = useEditor((s) => s.caps);
  const playhead = useEditor((s) => s.playhead);
  const S = useEditor.getState;
  const st = project.captions.style;
  const candidates = project.mediaIds.map((id) => media[id]).filter((m) => m && m.hasAudio && Object.values(S().sfx).indexOf(m.id) < 0);
  const [mediaId, setMediaId] = useState<string>(candidates.find((m) => project.clips.some((c) => c.mediaId === m!.id))?.id ?? candidates[0]?.id ?? "");
  const available = caps?.transcription.filter((t) => t.available) ?? [];
  const [provider, setProvider] = useState(available[0]?.id ?? caps?.transcription[0]?.id ?? "local-whisper");
  const [language, setLanguage] = useState("");
  const [busy, setBusy] = useState(false);
  const [selWords, setSelWords] = useState<string[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const [find, setFind] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const transcript = project.transcripts[mediaId];

  const setStyle = (patch: Partial<CaptionStyle>, key?: string) =>
    S().commit(
      "Caption style",
      (d) => {
        Object.assign(d.captions.style, patch);
        d.captions.style.preset = "custom";
      },
      key
    );

  const run = async () => {
    if (!mediaId) return;
    setBusy(true);
    try {
      await transcribeMedia(mediaId, provider, language);
    } catch (e) {
      S().toast((e as Error).message, "error");
    } finally {
      setBusy(false);
    }
  };

  const download = (name: string, text: string) => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
    a.download = name;
    a.click();
  };

  // map words to timeline for "current word" highlighting
  const clipFor = useMemo(() => project.clips.filter((c) => c.mediaId === mediaId).sort((a, b) => a.start - b.start), [project.clips, mediaId]);
  const tlOf = (t: number) => {
    const c = clipFor.find((c) => t >= c.in && t < c.out);
    return c ? toTimeline(c, t) : null;
  };
  const words = transcript?.words ?? [];
  const shownWords = find ? words.filter((w) => w.text.toLowerCase().includes(find.toLowerCase())) : words;

  return (
    <div className="panel-body captions-panel">
      <Section title="1 · Transcribe">
        {!candidates.length ? (
          <Empty icon="mic" title="Import media with audio first" />
        ) : (
          <>
            <Select label="Media" value={mediaId} onChange={setMediaId} options={candidates.map((m) => ({ value: m!.id, label: `${m!.name}${project.transcripts[m!.id] ? " ✓" : ""}` }))} />
            <Select
              label="Engine"
              value={provider}
              onChange={setProvider}
              options={(caps?.transcription ?? []).map((t) => ({ value: t.id, label: `${t.label}${t.available ? "" : " (not configured)"}${t.free ? " · free" : ""}` }))}
            />
            <p className="muted small">{caps?.transcription.find((t) => t.id === provider)?.note}</p>
            <label className="select">
              <span className="slider-label">Language</span>
              <input className="text-input" placeholder="auto (e.g. en, pt, es)" value={language} onChange={(e) => setLanguage(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
            </label>
            <div className="row gap wrap">
              <button className="btn primary" disabled={busy || !caps?.transcription.find((t) => t.id === provider)?.available} onClick={run}>
                <Icon name="mic" /> {busy ? "Transcribing…" : "Transcribe word-by-word"}
              </button>
              <button className="btn" onClick={() => fileRef.current?.click()} data-tip="Import an existing SRT or VTT file. Word timing is approximated per cue">
                Import SRT/VTT
              </button>
              <button
                className="btn ghost"
                onClick={async () => {
                  try {
                    const t = await api.savedTranscript(mediaId);
                    setTranscript(t);
                  } catch {
                    S().toast("No saved transcript for this media", "error");
                  }
                }}
                data-tip="Reuse a transcript made earlier in another project"
              >
                Load saved
              </button>
            </div>
            {!available.length && <div className="hint">No speech-to-text engine is configured. Free option: <code>pip install faster-whisper</code> on the server machine and restart. Or set DEEPGRAM_API_KEY / GROQ_API_KEY / OPENAI_API_KEY. You can always import SRT/VTT.</div>}
            <input
              ref={fileRef}
              type="file"
              hidden
              accept=".srt,.vtt,text/vtt"
              onChange={async (e) => {
                const f = e.target.files?.[0];
                if (!f) return;
                try {
                  importSubtitles(mediaId, await f.text());
                } catch (err) {
                  S().toast((err as Error).message, "error");
                }
              }}
            />
          </>
        )}
      </Section>

      <Section title="2 · Style" right={<Toggle label="Show" checked={project.captions.enabled} onChange={(v) => S().commit(v ? "Show captions" : "Hide captions", (d) => void (d.captions.enabled = v))} />}>
        <div className="preset-grid">
          {CAPTION_PRESETS.map((p) => {
            const s = { ...st, ...p.style };
            const f = fontById(s.font ?? "montserrat-black");
            return (
              <button key={p.id} className={`cap-preset ${st.preset === p.id ? "active" : ""}`} onClick={() => applyCaptionPreset(p.id)} data-tip={p.description}>
                <span className="cap-sample" style={{ fontFamily: `"${f.css}"`, textTransform: s.uppercase ? "uppercase" : "none", background: s.background ? "rgba(0,0,0,.6)" : undefined, WebkitTextStroke: s.outline ? "1px #000" : undefined }}>
                  you <span style={{ color: s.highlightMode === "color" || s.animation === "karaoke" ? s.highlightColor : undefined, background: s.highlightMode === "box" ? s.highlightColor : undefined, padding: "0 3px", borderRadius: 3 }}>said</span> it
                </span>
                <span className="small">{p.label}</span>
              </button>
            );
          })}
        </div>
        <Select label="Font" value={st.font} onChange={(v) => setStyle({ font: v })} options={FONTS.map((f) => ({ value: f.id, label: f.label }))} />
        <Slider label="Size" value={st.size} min={24} max={160} step={1} onChange={(v) => setStyle({ size: v }, "cap-size")} />
        <ColorInput label="Text" value={st.color} onChange={(v) => setStyle({ color: v }, "cap-color")} />
        <ColorInput label="Highlight" value={st.highlightColor} onChange={(v) => setStyle({ highlightColor: v }, "cap-hl")} />
        <Select label="Highlight" value={st.highlightMode} onChange={(v) => setStyle({ highlightMode: v })} options={[{ value: "color", label: "Colour active word" }, { value: "box", label: "Box behind active word" }, { value: "none", label: "None" }]} />
        <Select label="Animation" value={st.animation} onChange={(v) => setStyle({ animation: v })} options={[{ value: "pop", label: "Pop active word" }, { value: "karaoke", label: "Karaoke sweep" }, { value: "wordByWord", label: "Reveal word by word" }, { value: "bounce", label: "Bounce in" }, { value: "fade", label: "Fade" }, { value: "none", label: "None" }]} />
        <Toggle label="UPPERCASE" checked={st.uppercase} onChange={(v) => setStyle({ uppercase: v })} />
        <Slider label="Outline" value={st.outline} min={0} max={12} step={0.5} onChange={(v) => setStyle({ outline: v }, "cap-ol")} />
        <ColorInput label="Outline" value={st.outlineColor} onChange={(v) => setStyle({ outlineColor: v }, "cap-olc")} />
        <Slider label="Shadow" value={st.shadow} min={0} max={10} step={0.5} onChange={(v) => setStyle({ shadow: v }, "cap-sh")} />
        <Toggle label="Background box" checked={st.background} onChange={(v) => setStyle({ background: v })} />
        {st.background && <Slider label="Box opacity" value={st.backgroundOpacity} min={0} max={1} onChange={(v) => setStyle({ backgroundOpacity: v }, "cap-bo")} />}
        {st.background && <ColorInput label="Box colour" value={st.backgroundColor} onChange={(v) => setStyle({ backgroundColor: v }, "cap-bc")} />}
      </Section>

      <Section title="3 · Layout & timing">
        <Slider label="Words / line" value={st.wordsPerLine} min={1} max={10} step={1} onChange={(v) => setStyle({ wordsPerLine: v })} />
        <Slider label="Lines" value={st.linesPerPage} min={1} max={3} step={1} onChange={(v) => setStyle({ linesPerPage: v })} />
        <Slider label="Max on screen" value={st.maxPageDuration} min={0.5} max={6} step={0.1} format={(v) => `${v.toFixed(1)}s`} onChange={(v) => setStyle({ maxPageDuration: v }, "cap-max")} help="Reading speed: a caption page never stays longer than this" />
        <Slider label="Min word time" value={st.minWordDuration} min={0.03} max={0.4} step={0.01} onChange={(v) => setStyle({ minWordDuration: v }, "cap-min")} />
        <Slider label="Vertical pos." value={st.positionY} min={0.05} max={0.95} onChange={(v) => setStyle({ positionY: v }, "cap-y")} />
        <Toggle label="Keep inside platform safe area" checked={st.autoSafeArea} onChange={(v) => setStyle({ autoSafeArea: v })} help="Avoids the zones covered by TikTok/Shorts/Reels buttons and captions" />
        <Slider label="Timing offset" value={st.timingOffset} min={-0.5} max={0.5} step={0.01} format={(v) => `${v >= 0 ? "+" : ""}${v.toFixed(2)}s`} onChange={(v) => setStyle({ timingOffset: v }, "cap-off")} help="Shift all captions earlier/later" />
        <div className="row gap">
          <button className="btn sm" onClick={() => download(`${project.name}.srt`, toSrt(captionPages({ ...project, captions: { ...project.captions, enabled: true } })))}>Export SRT</button>
          <button className="btn sm" onClick={() => download(`${project.name}.vtt`, toVtt(captionPages({ ...project, captions: { ...project.captions, enabled: true } })))}>Export VTT</button>
        </div>
      </Section>

      <Section title={`4 · Edit transcript${transcript ? ` (${words.length} words)` : ""}`}>
        {!transcript ? (
          <p className="muted small">Transcribe or import subtitles to edit words here.</p>
        ) : (
          <>
            <div className="hint small">
              Click a word to jump to it. Double-click to fix spelling. Shift-click to select a range, then <b>Delete from video</b> to cut it out (text-based editing).
              {transcript.approximate && " Word timings in this transcript are approximate."}
            </div>
            <div className="row gap">
              <input className="text-input grow" placeholder="Find word…" value={find} onChange={(e) => setFind(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
              <button className="btn sm danger" disabled={!selWords.length} onClick={() => (cutWordsFromVideo(mediaId, selWords), setSelWords([]))}>
                Delete from video ({selWords.length})
              </button>
            </div>
            {transcript.speakers && (
              <div className="speakers">
                {Object.entries(transcript.speakers).map(([id, name]) => (
                  <label key={id} className="row gap small">
                    <span className={`spk spk-${id}`}>{id}</span>
                    <input className="text-input" defaultValue={name} onBlur={(e) => S().commit("Rename speaker", (d) => void (d.transcripts[mediaId].speakers![id] = e.target.value))} onKeyDown={(e) => e.stopPropagation()} />
                  </label>
                ))}
              </div>
            )}
            <div className="transcript">
              {shownWords.map((w, i) => {
                const tl = tlOf((w.start + w.end) / 2);
                const active = tl !== null && playhead >= (tlOf(w.start) ?? -1) && playhead < (tlOf(w.end) ?? -1) + 0.02;
                const prev = shownWords[i - 1];
                const speakerChange = w.speaker && w.speaker !== prev?.speaker;
                return (
                  <span key={w.id}>
                    {speakerChange && <span className={`spk spk-${w.speaker}`}>{transcript.speakers?.[w.speaker!] ?? w.speaker}</span>}
                    {editing === w.id ? (
                      <input
                        autoFocus
                        className="word-edit"
                        defaultValue={w.text}
                        onBlur={(e) => {
                          if (e.target.value !== w.text) editWord(mediaId, w.id, { text: e.target.value });
                          setEditing(null);
                        }}
                        onKeyDown={(e) => {
                          e.stopPropagation();
                          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                          if (e.key === "Escape") setEditing(null);
                        }}
                      />
                    ) : (
                      <span
                        className={`word ${tl === null ? "cut" : ""} ${active ? "active" : ""} ${selWords.includes(w.id) ? "sel" : ""} ${(w.confidence ?? 1) < 0.6 ? "low" : ""}`}
                        title={`${formatShort(w.start)} – ${formatShort(w.end)}${w.confidence !== undefined ? ` · ${(w.confidence * 100).toFixed(0)}%` : ""}${tl === null ? " · removed from edit" : ""}`}
                        onClick={(e) => {
                          if (e.shiftKey && selWords.length) {
                            const a = words.findIndex((x) => x.id === selWords[0]);
                            const b = words.findIndex((x) => x.id === w.id);
                            setSelWords(words.slice(Math.min(a, b), Math.max(a, b) + 1).map((x) => x.id));
                          } else if (e.metaKey || e.ctrlKey) setSelWords(selWords.includes(w.id) ? selWords.filter((x) => x !== w.id) : [...selWords, w.id]);
                          else {
                            setSelWords([w.id]);
                            if (tl !== null) S().set({ playhead: tlOf(w.start) ?? tl });
                          }
                        }}
                        onDoubleClick={() => setEditing(w.id)}
                      >
                        {w.text}
                      </span>
                    )}{" "}
                  </span>
                );
              })}
            </div>
            {selWords.length === 1 && (
              <WordTiming mediaId={mediaId} wordId={selWords[0]} />
            )}
          </>
        )}
      </Section>
    </div>
  );
}

function WordTiming({ mediaId, wordId }: { mediaId: string; wordId: string }) {
  const w = useEditor((s) => s.project!.transcripts[mediaId]?.words.find((x) => x.id === wordId));
  if (!w) return null;
  return (
    <div className="word-timing">
      <Slider label="Start" value={w.start} min={Math.max(0, w.start - 1)} max={w.end - 0.02} step={0.01} onChange={(v) => editWord(mediaId, wordId, { start: v }, `wt-${wordId}`)} />
      <Slider label="End" value={w.end} min={w.start + 0.02} max={w.end + 1} step={0.01} onChange={(v) => editWord(mediaId, wordId, { end: v }, `wt-${wordId}`)} />
      <button
        className="btn sm ghost"
        onClick={() =>
          useEditor.getState().commit("Delete caption word", (d) => {
            const t = d.transcripts[mediaId];
            t.words = t.words.filter((x) => x.id !== wordId);
          })
        }
        data-tip="Remove this word from the captions only (the video is untouched)"
      >
        Remove from captions
      </button>
    </div>
  );
}

void clipEnd;
