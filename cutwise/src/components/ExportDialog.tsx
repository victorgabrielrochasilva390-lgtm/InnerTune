import { useState } from "react";
import type { ExportSettings, Job } from "../../shared/types";
import { EXPORT_PRESETS, ASPECTS } from "../../shared/presets";
import { projectDuration, formatShort } from "../../shared/timeline";
import { useEditor } from "../store";
import { api, waitForJob } from "../api";
import { setAspect } from "../actions";
import { Modal, NumberInput, Progress, Select, Toggle, fmtBytes, Icon } from "./ui";

export function ExportDialog({ onClose }: { onClose: () => void }) {
  const project = useEditor((s) => s.project)!;
  const inOut = useEditor((s) => s.inOut);
  const S = useEditor.getState;
  const initial = EXPORT_PRESETS.find((p) => p.aspect === project.settings.aspect) ?? EXPORT_PRESETS[0];
  const [settings, setSettings] = useState<ExportSettings>({ ...initial, preset: initial.preset, fps: project.settings.fps, burnCaptions: true, fileName: project.name });
  const [rangeMode, setRangeMode] = useState<"all" | "inout">("all");
  const [job, setJob] = useState<Job | null>(null);
  const [result, setResult] = useState<{ url: string; size: number; file: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const preset = EXPORT_PRESETS.find((p) => p.preset === settings.preset);
  const targetAspect = preset?.aspect ?? `${settings.width}:${settings.height}`;
  const projAR = project.settings.width / project.settings.height;
  const outAR = settings.width / settings.height;
  const mismatch = Math.abs(projAR - outAR) > 0.02;
  const duration = projectDuration(project);
  const hasInOut = inOut.in !== null && inOut.out !== null && inOut.out > inOut.in;
  const missing = project.clips.filter((c) => c.mediaId && S().media[c.mediaId]?.missing);

  const start = async () => {
    setError(null);
    setResult(null);
    const s: ExportSettings = { ...settings, range: rangeMode === "inout" && hasInOut ? { start: inOut.in!, end: inOut.out! } : undefined };
    try {
      const j = await api.render(project, s);
      setJob(j);
      const r = await waitForJob<{ url: string; size: number; file: string }>(j.id, setJob);
      setResult(r);
      S().toast("Export finished", "success");
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const running = job && (job.status === "running" || job.status === "queued");
  return (
    <Modal title="Export video" onClose={onClose} wide>
      <div className="export-grid">
        <div>
          <h4>Platform preset</h4>
          <div className="preset-list">
            {EXPORT_PRESETS.map((p) => (
              <button key={p.preset} className={`preset-btn ${settings.preset === p.preset ? "active" : ""}`} onClick={() => setSettings({ ...settings, ...p, fps: settings.fps })}>
                <span className={`ar ar-${p.aspect.replace(":", "x")}`} />
                <span>
                  <strong>{p.label}</strong>
                  <span className="muted small">
                    {" "}
                    {p.width}×{p.height} · {p.aspect}
                  </span>
                </span>
              </button>
            ))}
          </div>
        </div>
        <div>
          <h4>Settings</h4>
          <div className="grid2">
            <label>
              Width <NumberInput value={settings.width} step={2} min={128} max={7680} onChange={(v) => setSettings({ ...settings, width: Math.round(v / 2) * 2, preset: "custom" })} />
            </label>
            <label>
              Height <NumberInput value={settings.height} step={2} min={128} max={4320} onChange={(v) => setSettings({ ...settings, height: Math.round(v / 2) * 2, preset: "custom" })} />
            </label>
            <Select label="Frame rate" value={String(settings.fps)} onChange={(v) => setSettings({ ...settings, fps: Number(v) })} options={["24", "25", "30", "50", "60"].map((v) => ({ value: v, label: `${v} fps` }))} />
            <Select label="Codec" value={settings.codec} onChange={(v) => setSettings({ ...settings, codec: v })} options={[{ value: "h264", label: "H.264 (most compatible)" }, { value: "h265", label: "H.265 / HEVC (smaller)" }]} />
            <label>
              Video kbps <NumberInput value={settings.videoBitrateKbps} step={500} min={500} max={200000} onChange={(v) => setSettings({ ...settings, videoBitrateKbps: v })} />
            </label>
            <Select label="Audio" value={String(settings.audioBitrateKbps)} onChange={(v) => setSettings({ ...settings, audioBitrateKbps: Number(v) })} options={["128", "192", "256", "320"].map((v) => ({ value: v, label: `AAC ${v} kbps` }))} />
            <Select label="Sample rate" value={String(settings.sampleRate)} onChange={(v) => setSettings({ ...settings, sampleRate: Number(v) })} options={[{ value: "44100", label: "44.1 kHz" }, { value: "48000", label: "48 kHz" }]} />
            <label>
              File name
              <input className="text-input" value={settings.fileName} onChange={(e) => setSettings({ ...settings, fileName: e.target.value })} onKeyDown={(e) => e.stopPropagation()} />
            </label>
          </div>
          <Toggle label="Burn in captions" checked={settings.burnCaptions} onChange={(v) => setSettings({ ...settings, burnCaptions: v })} help="Uncheck to export a clean video and upload SRT/VTT separately" />
          <Select label="Range" value={rangeMode} onChange={(v) => setRangeMode(v)} options={[{ value: "all", label: `Whole timeline (${formatShort(duration)})` }, { value: "inout", label: hasInOut ? `In → Out (${formatShort(inOut.in!)}–${formatShort(inOut.out!)})` : "In → Out (set with I / O keys)" }]} />
          {mismatch && (
            <div className="hint">
              The project is {project.settings.aspect}; this preset is {targetAspect}. Exporting now letterboxes the picture. Convert the project instead:
              <div className="row gap wrap" style={{ marginTop: 6 }}>
                {ASPECTS[targetAspect] && (
                  <>
                    <button className="btn sm primary" onClick={() => setAspect(targetAspect, "smart")} data-tip="Crops to the new aspect and centres each scene on its subject (saliency tracking)">
                      Smart reframe to {targetAspect}
                    </button>
                    <button className="btn sm" onClick={() => setAspect(targetAspect, "blurFill")}>Fit + blurred background</button>
                    <button className="btn sm ghost" onClick={() => setAspect(targetAspect, "fill")}>Centre crop</button>
                  </>
                )}
              </div>
            </div>
          )}
          {missing.length > 0 && <div className="err small">{missing.length} clip(s) use offline media. Relink them in the Media panel before exporting.</div>}
        </div>
      </div>
      <div className="export-foot">
        {job && running && (
          <>
            <Progress value={job.progress} label={job.message ?? job.status} />
            <button className="btn danger" onClick={() => api.cancelJob(job.id)}>
              Cancel render
            </button>
          </>
        )}
        {error && <div className="err">{error}</div>}
        {result && (
          <div className="ok">
            ✓ Done · {fmtBytes(result.size)}{" "}
            <a className="btn primary" href={result.url} download>
              <Icon name="export" /> Download {result.file}
            </a>
          </div>
        )}
        {!running && (
          <button className="btn primary big" onClick={start} disabled={!project.clips.length || missing.length > 0}>
            <Icon name="export" /> {result ? "Export again" : "Start export"}
          </button>
        )}
      </div>
      <p className="muted small">Renders on the server with FFmpeg from your original files (not the preview proxies). The originals are never modified.</p>
    </Modal>
  );
}
