// Background job queue (proxies, analysis, transcription, renders) with progress events.
import { EventEmitter } from "node:events";
import type { Job } from "../shared/types";
import { uid } from "../shared/defaults";

export const bus = new EventEmitter();
bus.setMaxListeners(100);

const jobs = new Map<string, Job>();
const controllers = new Map<string, AbortController>();
const queues: Record<string, { running: number; limit: number; pending: (() => void)[] }> = {
  heavy: { running: 0, limit: 1 }, // renders
  medium: { running: 0, limit: 2 }, // proxies / analysis
  light: { running: 0, limit: 3 }, // network calls
} as any;
for (const q of Object.values(queues)) q.pending = [];

export type JobCtx = {
  job: Job;
  signal: AbortSignal;
  progress: (p: number, message?: string) => void;
};

export function listJobs(): Job[] {
  return [...jobs.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, 100);
}

export function getJob(id: string) {
  return jobs.get(id);
}

function emit(job: Job) {
  job.updatedAt = Date.now();
  bus.emit("job", { ...job });
}

export function startJob(
  init: Pick<Job, "type"> & Partial<Pick<Job, "mediaId" | "projectId" | "message">>,
  lane: "heavy" | "medium" | "light",
  fn: (ctx: JobCtx) => Promise<unknown>
): Job {
  const job: Job = { id: uid("job"), status: "queued", progress: 0, createdAt: Date.now(), updatedAt: Date.now(), ...init };
  jobs.set(job.id, job);
  const ac = new AbortController();
  controllers.set(job.id, ac);
  emit(job);
  const q = queues[lane];
  const exec = async () => {
    q.running++;
    if (ac.signal.aborted) {
      q.running--;
      return next();
    }
    job.status = "running";
    emit(job);
    let lastEmit = 0;
    try {
      job.result = await fn({
        job,
        signal: ac.signal,
        progress: (p, message) => {
          job.progress = Math.max(0, Math.min(1, p));
          if (message) job.message = message;
          const now = Date.now();
          if (now - lastEmit > 250) {
            lastEmit = now;
            emit(job);
          }
        },
      });
      job.status = "done";
      job.progress = 1;
    } catch (e: any) {
      if (ac.signal.aborted) {
        job.status = "cancelled";
        job.message = "Cancelled";
      } else {
        job.status = "error";
        job.error = String(e?.message ?? e).slice(0, 2000);
        console.error(`[job ${job.type}]`, e);
      }
    } finally {
      controllers.delete(job.id);
      q.running--;
      emit(job);
      next();
    }
  };
  const next = () => {
    if (q.running < q.limit && q.pending.length) q.pending.shift()!();
  };
  q.pending.push(exec);
  next();
  return job;
}

export function cancelJob(id: string): boolean {
  const ac = controllers.get(id);
  const job = jobs.get(id);
  if (!ac || !job) return false;
  ac.abort();
  if (job.status === "queued") {
    job.status = "cancelled";
    emit(job);
  }
  return true;
}

/** wait for a job to finish (used to chain analysis after proxy, etc.) */
export function waitJob(id: string): Promise<Job> {
  return new Promise((resolve) => {
    const j = jobs.get(id);
    if (j && ["done", "error", "cancelled"].includes(j.status)) return resolve(j);
    const h = (u: Job) => {
      if (u.id === id && ["done", "error", "cancelled"].includes(u.status)) {
        bus.off("job", h);
        resolve(u);
      }
    };
    bus.on("job", h);
  });
}
