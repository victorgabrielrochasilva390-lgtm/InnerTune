import { useEffect, useState } from "react";
import { api, type ProjectSummary } from "../api";
import { formatShort } from "../../shared/timeline";
import { Empty, Icon, IconButton } from "./ui";
import { useEditor } from "../store";

export function ProjectsScreen({ onOpen }: { onOpen: (id: string) => void }) {
  const [list, setList] = useState<ProjectSummary[] | null>(null);
  const [name, setName] = useState("");
  const [aspect, setAspect] = useState("16:9");
  const [err, setErr] = useState<string | null>(null);
  const caps = useEditor((s) => s.caps);
  const load = () => api.projects().then(setList).catch((e) => setErr(e.message));
  useEffect(() => {
    load();
  }, []);
  const create = async () => {
    const p = await api.createProject(name.trim() || "Untitled project", aspect);
    onOpen(p.id);
  };
  return (
    <div className="projects">
      <header className="projects-head">
        <div className="logo big">
          <span className="logo-mark">▶</span> Cutwise <span className="logo-sub">Studio</span>
        </div>
        <p className="muted">AI-assisted video editing: multitrack timeline, word-level captions, explained AI edits, B-roll suggestions, mixing, grading and export.</p>
      </header>
      {err && <div className="err">Cannot reach the Cutwise server ({err}). Start it with <code>npm run dev</code>.</div>}
      <section className="new-project">
        <h3>New project</h3>
        <div className="row gap wrap">
          <input className="text-input" placeholder="Project name" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && create()} />
          {[
            ["16:9", "YouTube"],
            ["9:16", "Shorts / TikTok / Reels"],
            ["1:1", "Square"],
            ["4:5", "Instagram portrait"],
          ].map(([a, l]) => (
            <button key={a} className={`aspect-btn ${aspect === a ? "active" : ""}`} onClick={() => setAspect(a)}>
              <span className={`ar ar-${a.replace(":", "x")}`} />
              <span>
                {a}
                <br />
                <span className="muted small">{l}</span>
              </span>
            </button>
          ))}
          <button className="btn primary big" onClick={create}>
            <Icon name="plus" /> Create
          </button>
        </div>
      </section>
      <section>
        <h3>Recent projects</h3>
        {list && !list.length && <Empty icon="folder" title="No projects yet">Create your first project above.</Empty>}
        <div className="project-grid">
          {list?.map((p) => (
            <div key={p.id} className="project-card" onClick={() => onOpen(p.id)}>
              <div className="pthumb" style={p.thumb ? { backgroundImage: `url(${p.thumb})` } : undefined}>
                {!p.thumb && <Icon name="film" size={28} />}
              </div>
              <div className="pmeta">
                <strong>{p.name}</strong>
                <span className="muted small">
                  {formatShort(p.duration)} · {p.clips} clips · {new Date(p.updatedAt).toLocaleString()}
                </span>
              </div>
              <div className="pactions" onClick={(e) => e.stopPropagation()}>
                <IconButton icon="duplicate" label="Duplicate" onClick={() => api.duplicateProject(p.id).then(load)} />
                <IconButton icon="trash" label="Delete" onClick={() => confirm(`Delete "${p.name}"? Media files are kept.`) && api.deleteProject(p.id).then(load)} />
              </div>
            </div>
          ))}
        </div>
      </section>
      {caps && (
        <section className="caps">
          <h3>Services on this machine</h3>
          <div className="caps-grid">
            <div>
              <b>Rendering</b>
              <div className="small muted">{caps.ffmpeg}</div>
            </div>
            <div>
              <b>AI director</b>
              <div className="small">{caps.claude.available ? `✓ Claude (${caps.claude.model})` : "Built-in engine (free). Set ANTHROPIC_API_KEY for Claude"}</div>
            </div>
            <div>
              <b>Transcription</b>
              {caps.transcription.map((t) => (
                <div key={t.id} className="small">
                  {t.available ? "✓" : "○"} {t.label} {t.free && <span className="badge">free</span>}
                </div>
              ))}
            </div>
            <div>
              <b>Stock media</b>
              {caps.stock.map((t) => (
                <div key={t.id} className="small">
                  {t.available ? "✓" : "○"} {t.label}
                </div>
              ))}
            </div>
          </div>
        </section>
      )}
    </div>
  );
}
