// SQLite (built into Node >= 22.5, no native build step) for projects, media and versions.
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { DATA_DIR } from "./config";
import type { MediaItem, Project } from "../shared/types";

export const db = new DatabaseSync(path.join(DATA_DIR, "cutwise.db"));
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, data TEXT NOT NULL,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, thumb TEXT
  );
  CREATE TABLE IF NOT EXISTS project_versions (
    id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL, data TEXT NOT NULL,
    created_at INTEGER NOT NULL, kind TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_versions ON project_versions(project_id, created_at);
  CREATE TABLE IF NOT EXISTS media (
    id TEXT PRIMARY KEY, data TEXT NOT NULL, created_at INTEGER NOT NULL
  );
`);

export const Projects = {
  list(): { id: string; name: string; createdAt: number; updatedAt: number; thumb: string | null; duration: number; clips: number }[] {
    const rows = db.prepare("SELECT id, name, created_at, updated_at, thumb, data FROM projects ORDER BY updated_at DESC").all() as any[];
    return rows.map((r) => {
      let duration = 0;
      let clips = 0;
      try {
        const p = JSON.parse(r.data) as Project;
        clips = p.clips.length;
        for (const c of p.clips) duration = Math.max(duration, c.start + (c.out - c.in) / c.speed);
      } catch {}
      return { id: r.id, name: r.name, createdAt: r.created_at, updatedAt: r.updated_at, thumb: r.thumb, duration, clips };
    });
  },
  get(id: string): Project | undefined {
    const r = db.prepare("SELECT data FROM projects WHERE id = ?").get(id) as any;
    return r ? (JSON.parse(r.data) as Project) : undefined;
  },
  save(p: Project, kind: "autosave" | "manual" | "create" = "autosave", thumb?: string) {
    const data = JSON.stringify(p);
    const exists = db.prepare("SELECT 1 FROM projects WHERE id = ?").get(p.id);
    if (exists) db.prepare("UPDATE projects SET name = ?, data = ?, updated_at = ?, thumb = COALESCE(?, thumb) WHERE id = ?").run(p.name, data, p.updatedAt, thumb ?? null, p.id);
    else db.prepare("INSERT INTO projects (id, name, data, created_at, updated_at, thumb) VALUES (?, ?, ?, ?, ?, ?)").run(p.id, p.name, data, p.createdAt, p.updatedAt, thumb ?? null);
    // version history: every manual save, and at most one autosave snapshot per 5 minutes
    const last = db.prepare("SELECT created_at FROM project_versions WHERE project_id = ? ORDER BY created_at DESC LIMIT 1").get(p.id) as any;
    if (kind !== "autosave" || !last || Date.now() - last.created_at > 5 * 60_000) {
      db.prepare("INSERT INTO project_versions (project_id, data, created_at, kind) VALUES (?, ?, ?, ?)").run(p.id, data, Date.now(), kind);
      db.prepare("DELETE FROM project_versions WHERE project_id = ? AND id NOT IN (SELECT id FROM project_versions WHERE project_id = ? ORDER BY created_at DESC LIMIT 40)").run(p.id, p.id);
    }
  },
  versions(id: string) {
    return (db.prepare("SELECT id, created_at, kind FROM project_versions WHERE project_id = ? ORDER BY created_at DESC").all(id) as any[]).map((r) => ({ id: r.id, createdAt: r.created_at, kind: r.kind }));
  },
  version(id: string, versionId: number): Project | undefined {
    const r = db.prepare("SELECT data FROM project_versions WHERE project_id = ? AND id = ?").get(id, versionId) as any;
    return r ? JSON.parse(r.data) : undefined;
  },
  delete(id: string) {
    db.prepare("DELETE FROM projects WHERE id = ?").run(id);
    db.prepare("DELETE FROM project_versions WHERE project_id = ?").run(id);
  },
};

export const Media = {
  all(): MediaItem[] {
    return (db.prepare("SELECT data FROM media ORDER BY created_at DESC").all() as any[]).map((r) => JSON.parse(r.data));
  },
  get(id: string): MediaItem | undefined {
    const r = db.prepare("SELECT data FROM media WHERE id = ?").get(id) as any;
    return r ? JSON.parse(r.data) : undefined;
  },
  put(m: MediaItem) {
    db.prepare("INSERT INTO media (id, data, created_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data").run(m.id, JSON.stringify(m), m.createdAt);
  },
  update(id: string, patch: Partial<MediaItem>): MediaItem | undefined {
    const m = Media.get(id);
    if (!m) return;
    const next = { ...m, ...patch };
    Media.put(next);
    return next;
  },
  delete(id: string) {
    db.prepare("DELETE FROM media WHERE id = ?").run(id);
  },
};
