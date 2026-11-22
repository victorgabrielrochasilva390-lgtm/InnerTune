import type { Job, MediaItem, Project, ServerCapabilities, Transcript } from "../shared/types";

export type PubMedia = Omit<MediaItem, "path" | "proxyPath"> & { fileUrl: string; previewUrl: string; hasProxy: boolean };

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(path, init);
  const ct = r.headers.get("content-type") ?? "";
  const body = ct.includes("json") ? await r.json() : await r.text();
  if (!r.ok) throw new Error(typeof body === "object" && body && "error" in body ? String((body as any).error) : `${r.status} ${r.statusText}`);
  return body as T;
}
const json = (method: string, body: unknown): RequestInit => ({ method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

export interface ProjectSummary {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  thumb: string | null;
  duration: number;
  clips: number;
}

export const api = {
  capabilities: () => req<ServerCapabilities>("/api/capabilities"),
  projects: () => req<ProjectSummary[]>("/api/projects"),
  createProject: (name: string, aspect: string) => req<Project>("/api/projects", json("POST", { name, aspect })),
  project: (id: string) => req<Project>(`/api/projects/${id}`),
  saveProject: (p: Project, kind: "autosave" | "manual") => req<{ ok: boolean; updatedAt: number }>(`/api/projects/${p.id}?kind=${kind}`, json("PUT", p)),
  saveThumb: (id: string, dataUrl: string) => req(`/api/projects/${id}/thumb`, json("POST", { dataUrl })),
  duplicateProject: (id: string) => req<Project>(`/api/projects/${id}/duplicate`, { method: "POST" }),
  deleteProject: (id: string) => req(`/api/projects/${id}`, { method: "DELETE" }),
  versions: (id: string) => req<{ id: number; createdAt: number; kind: string }[]>(`/api/projects/${id}/versions`),
  version: (id: string, vid: number) => req<Project>(`/api/projects/${id}/versions/${vid}`),
  media: (ids?: string[]) => req<PubMedia[]>(`/api/media${ids ? `?ids=${ids.join(",")}` : ""}`),
  mediaOne: (id: string) => req<PubMedia>(`/api/media/${id}`),
  upload: (files: File[], onProgress?: (p: number) => void) =>
    new Promise<(PubMedia | { error: string })[]>((resolve, reject) => {
      const fd = new FormData();
      files.forEach((f) => fd.append("files", f));
      const x = new XMLHttpRequest();
      x.open("POST", "/api/media/upload");
      x.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total);
      x.onload = () => (x.status < 300 ? resolve(JSON.parse(x.responseText)) : reject(new Error(JSON.parse(x.responseText).error ?? x.statusText)));
      x.onerror = () => reject(new Error("Upload failed"));
      x.send(fd);
    }),
  linkMedia: (path: string) => req<PubMedia>("/api/media/link", json("POST", { path })),
  relinkUpload: (id: string, file: File) => {
    const fd = new FormData();
    fd.append("file", file);
    return req<PubMedia>(`/api/media/${id}/relink`, { method: "POST", body: fd });
  },
  relinkPath: (id: string, path: string) => req<PubMedia>(`/api/media/${id}/relink`, json("POST", { path })),
  deleteMedia: (id: string, force = false) => req(`/api/media/${id}${force ? "?force=1" : ""}`, { method: "DELETE" }),
  analyze: (id: string) => req<Job>(`/api/media/${id}/analyze`, { method: "POST" }),
  transcribe: (id: string, provider: string, language?: string) => req<Job>(`/api/media/${id}/transcribe`, json("POST", { provider, language })),
  savedTranscript: (id: string) => req<Transcript>(`/api/media/${id}/transcript`),
  reframe: (id: string) => req<Job>(`/api/media/${id}/reframe`, { method: "POST" }),
  direct: (project: Project, useClaude: boolean, useVision: boolean) => req<Job>("/api/ai/direct", json("POST", { project, goals: project.ai.goals, useClaude, useVision })),
  stockSearch: (provider: string, q: string, type: string, orientation?: string) =>
    req<any[]>(`/api/stock/search?provider=${provider}&q=${encodeURIComponent(q)}&type=${type}${orientation ? `&orientation=${orientation}` : ""}`),
  stockImport: (item: unknown) => req<Job>("/api/stock/import", json("POST", item)),
  sfx: () => req<Record<string, string>>("/api/sfx"),
  luts: () => req<string[]>("/api/luts"),
  uploadLut: (file: File) => {
    const fd = new FormData();
    fd.append("file", file);
    return req<{ id: string }>("/api/luts", { method: "POST", body: fd });
  },
  render: (project: Project, settings: unknown) => req<Job>("/api/render", json("POST", { project, settings })),
  cancelJob: (id: string) => req(`/api/jobs/${id}/cancel`, { method: "POST" }),
  job: (id: string) => req<Job>(`/api/jobs/${id}`),
  jobs: () => req<Job[]>("/api/jobs"),
};

type JobListener = (j: Job) => void;
const listeners = new Set<JobListener>();
let es: EventSource | null = null;
export function onJob(fn: JobListener) {
  listeners.add(fn);
  if (!es) {
    es = new EventSource("/api/events");
    es.addEventListener("job", (e) => {
      const j = JSON.parse((e as MessageEvent).data) as Job;
      listeners.forEach((l) => l(j));
    });
  }
  return () => {
    listeners.delete(fn);
  };
}

/** Resolve when a job finishes (rejects on error / cancel). */
export function waitForJob<T = unknown>(id: string, onProgress?: (j: Job) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (j: Job) => {
      if (done) return;
      onProgress?.(j);
      if (j.status === "done") {
        done = true;
        off();
        resolve(j.result as T);
      } else if (j.status === "error" || j.status === "cancelled") {
        done = true;
        off();
        reject(new Error(j.error ?? j.status));
      }
    };
    const off = onJob((j) => j.id === id && finish(j));
    api.job(id).then(finish).catch(() => {});
  });
}

const peakCache = new Map<string, Promise<Uint8Array>>();
export function loadPeaks(url: string): Promise<Uint8Array> {
  if (!peakCache.has(url)) peakCache.set(url, fetch(url).then(async (r) => new Uint8Array(await r.arrayBuffer())));
  return peakCache.get(url)!;
}
