import fs from "node:fs";
import path from "node:path";
import express from "express";
import multer from "multer";
import type { EditGoals, ExportSettings, MediaItem, Project } from "../shared/types";
import { makeProject, uid } from "../shared/defaults";
import { DATA_DIR, DIRS, PORT, ROOT, CLAUDE_MODEL } from "./config";
import { Media, Projects } from "./db";
import { bus, cancelJob, getJob, listJobs, startJob } from "./jobs";
import { checkMissing, importFile, processMedia, publicMedia, relink } from "./media";
import { analyzeMedia } from "./analysis";
import { providers, transcribe } from "./transcribe";
import { claudeAvailable, runDirector } from "./ai";
import { downloadStock, searchStock, stockProviders, type StockResult } from "./stock";
import { ensureFonts, ensureLuts, ensureSfx, lutPath } from "./assets";
import { renderProject } from "./render";
import { analyzeReframe } from "./reframe";
import { ffmpegVersion } from "./ffmpeg";

const app = express();
app.use(express.json({ limit: "50mb" }));
const upload = multer({ dest: DIRS.tmp });
const TRANSCRIPTS = path.join(DATA_DIR, "transcripts");
fs.mkdirSync(TRANSCRIPTS, { recursive: true });

type Req = express.Request<Record<string, string>>;
const wrap = (fn: (req: Req, res: express.Response) => Promise<unknown> | unknown) => async (req: Req, res: express.Response) => {
  try {
    const out = await fn(req, res);
    if (!res.headersSent) res.json(out ?? { ok: true });
  } catch (e: any) {
    console.error(e);
    if (!res.headersSent) res.status(e?.status ?? 400).json({ error: String(e?.message ?? e) });
  }
};
const notFound = (what: string) => Object.assign(new Error(`${what} not found`), { status: 404 });

// ------------------------------------------------------------------ status

let sfxIndex: Record<string, string> = {};
app.get(
  "/api/capabilities",
  wrap(async () => ({
    ffmpeg: await ffmpegVersion(),
    transcription: await providers(),
    claude: { available: claudeAvailable(), model: CLAUDE_MODEL },
    stock: stockProviders(),
  }))
);

app.get("/api/events", (req, res) => {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  res.write("retry: 2000\n\n");
  const onJob = (job: unknown) => res.write(`event: job\ndata: ${JSON.stringify(job)}\n\n`);
  bus.on("job", onJob);
  const ping = setInterval(() => res.write(": ping\n\n"), 15000);
  req.on("close", () => {
    bus.off("job", onJob);
    clearInterval(ping);
  });
});

app.get("/api/jobs", wrap(() => listJobs()));
app.get("/api/jobs/:id", wrap((req) => getJob(req.params.id) ?? Promise.reject(notFound("job"))));
app.post("/api/jobs/:id/cancel", wrap((req) => ({ ok: cancelJob(req.params.id) })));

// ------------------------------------------------------------------ projects

app.get("/api/projects", wrap(() => Projects.list()));
app.post(
  "/api/projects",
  wrap((req) => {
    const p = makeProject(String(req.body?.name || "Untitled project"), String(req.body?.aspect || "16:9"));
    Projects.save(p, "create");
    return p;
  })
);
app.get("/api/projects/:id", wrap((req) => Projects.get(req.params.id) ?? Promise.reject(notFound("project"))));
app.put(
  "/api/projects/:id",
  wrap((req) => {
    const p = req.body as Project;
    if (!p || p.id !== req.params.id || !Array.isArray(p.clips)) throw new Error("invalid project payload");
    p.updatedAt = Date.now();
    Projects.save(p, req.query.kind === "manual" ? "manual" : "autosave", typeof req.body.thumb === "string" ? undefined : undefined);
    return { ok: true, updatedAt: p.updatedAt };
  })
);
app.post(
  "/api/projects/:id/thumb",
  wrap((req) => {
    const p = Projects.get(req.params.id);
    if (!p) throw notFound("project");
    const data = String(req.body?.dataUrl ?? "");
    const mt = /^data:image\/jpeg;base64,(.+)$/.exec(data);
    if (!mt) throw new Error("expected jpeg data url");
    const file = path.join(DIRS.thumbs, `project-${p.id}.jpg`);
    fs.writeFileSync(file, Buffer.from(mt[1], "base64"));
    Projects.save(p, "autosave", `/files/thumbs/project-${p.id}.jpg?${Date.now()}`);
    return { ok: true };
  })
);
app.post(
  "/api/projects/:id/duplicate",
  wrap((req) => {
    const p = Projects.get(req.params.id);
    if (!p) throw notFound("project");
    const copy: Project = { ...structuredClone(p), id: uid("prj"), name: `${p.name} (copy)`, createdAt: Date.now(), updatedAt: Date.now() };
    Projects.save(copy, "create");
    return copy;
  })
);
app.delete("/api/projects/:id", wrap((req) => Projects.delete(req.params.id)));
app.get("/api/projects/:id/versions", wrap((req) => Projects.versions(req.params.id)));
app.get("/api/projects/:id/versions/:vid", wrap((req) => Projects.version(req.params.id, Number(req.params.vid)) ?? Promise.reject(notFound("version"))));

// ------------------------------------------------------------------ media

app.get(
  "/api/media",
  wrap((req) => {
    const ids = typeof req.query.ids === "string" && req.query.ids ? new Set(req.query.ids.split(",")) : null;
    return Media.all()
      .filter((m) => !ids || ids.has(m.id))
      .map((m) => publicMedia(checkMissing(m)));
  })
);
app.get("/api/media/:id", wrap((req) => publicMedia(checkMissing(Media.get(req.params.id) ?? (() => { throw notFound("media"); })()))));

app.post(
  "/api/media/upload",
  upload.array("files", 50),
  wrap(async (req) => {
    const files = (req.files as Express.Multer.File[]) ?? [];
    const out = [];
    for (const f of files) {
      try {
        const m = await importFile(f.path, f.originalname, "move", { provider: "upload" });
        out.push(publicMedia(m));
      } catch (e: any) {
        fs.rmSync(f.path, { force: true });
        out.push({ error: `${f.originalname}: ${e.message}` });
      }
    }
    return out;
  })
);

app.post(
  "/api/media/link",
  wrap(async (req) => {
    const p = String(req.body?.path ?? "");
    if (!path.isAbsolute(p) || !fs.existsSync(p) || !fs.statSync(p).isFile()) throw new Error("Provide an absolute path to an existing file on the server machine.");
    return publicMedia(await importFile(p, path.basename(p), "link", { provider: "linked" }));
  })
);

app.post(
  "/api/media/:id/relink",
  upload.single("file"),
  wrap(async (req) => {
    if (req.file) return publicMedia(await relink(req.params.id, req.file.path, "move"));
    const p = String(req.body?.path ?? "");
    if (!path.isAbsolute(p) || !fs.existsSync(p)) throw new Error("File not found");
    return publicMedia(await relink(req.params.id, p, "link"));
  })
);

app.delete(
  "/api/media/:id",
  wrap((req) => {
    const m = Media.get(req.params.id);
    if (!m) throw notFound("media");
    const used = Projects.list().filter((p) => Projects.get(p.id)?.clips.some((c) => c.mediaId === m.id));
    if (used.length && req.query.force !== "1") throw new Error(`Used in: ${used.map((u) => u.name).join(", ")}`);
    Media.delete(m.id);
    // originals that we own (uploads) are removed; linked files are never touched
    if (m.path.startsWith(DIRS.media)) fs.rmSync(m.path, { force: true });
    if (m.proxyPath) fs.rmSync(m.proxyPath, { force: true });
    return { ok: true };
  })
);

app.post("/api/media/:id/process", wrap((req) => processMedia(req.params.id, true)));
app.post(
  "/api/media/:id/analyze",
  wrap((req) => {
    if (!Media.get(req.params.id)) throw notFound("media");
    return startJob({ type: "analysis", mediaId: req.params.id, message: "Analysing" }, "medium", (ctx) => analyzeMedia(req.params.id, ctx));
  })
);
app.post(
  "/api/media/:id/transcribe",
  wrap((req) => {
    const id = req.params.id;
    if (!Media.get(id)) throw notFound("media");
    const provider = String(req.body?.provider ?? "local-whisper");
    const language = req.body?.language ? String(req.body.language) : undefined;
    return startJob({ type: "transcribe", mediaId: id, message: `Transcribing (${provider})` }, "light", async (ctx) => {
      const t = await transcribe(id, provider, language, ctx);
      fs.writeFileSync(path.join(TRANSCRIPTS, `${id}.json`), JSON.stringify(t));
      return t;
    });
  })
);
app.get(
  "/api/media/:id/transcript",
  wrap((req) => {
    const f = path.join(TRANSCRIPTS, `${path.basename(req.params.id)}.json`);
    if (!fs.existsSync(f)) throw notFound("transcript");
    return JSON.parse(fs.readFileSync(f, "utf8"));
  })
);
app.post(
  "/api/media/:id/reframe",
  wrap((req) => {
    const m = Media.get(req.params.id);
    if (!m) throw notFound("media");
    return startJob({ type: "reframe", mediaId: m.id, message: "Finding the subject" }, "medium", (ctx) => analyzeReframe(m, ctx));
  })
);

// ------------------------------------------------------------------ AI

app.post(
  "/api/ai/direct",
  wrap((req) => {
    const project = req.body?.project as Project;
    const goals = (req.body?.goals ?? project?.ai?.goals) as EditGoals;
    if (!project || !goals) throw new Error("project and goals required");
    const media: Record<string, MediaItem> = {};
    for (const m of Media.all()) media[m.id] = m;
    return startJob({ type: "analysis", projectId: project.id, message: req.body?.useClaude ? "Claude is reviewing your footage" : "Analysing footage" }, "light", (ctx) => {
      ctx.progress(0.1);
      return runDirector(project, media, goals, { useClaude: !!req.body?.useClaude, useVision: !!req.body?.useVision });
    });
  })
);

// ------------------------------------------------------------------ stock + sfx

app.get(
  "/api/stock/search",
  wrap((req) => searchStock(String(req.query.provider ?? "openverse"), String(req.query.q ?? ""), (req.query.type as any) ?? "photo", req.query.orientation as any))
);
app.post(
  "/api/stock/import",
  wrap((req) => {
    const r = req.body as StockResult;
    if (!r?.downloadUrl) throw new Error("missing stock item");
    return startJob({ type: "stock-import", message: `Downloading ${r.provider} asset` }, "light", async (ctx) => {
      const d = await downloadStock(r, ctx.signal);
      return publicMedia(await importFile(d.file, d.name, "move", d.source, false));
    });
  })
);
app.get("/api/sfx", wrap(() => sfxIndex));

// user LUTs (.cube) - stored next to the built-in ones
app.get("/api/luts", wrap(() => fs.readdirSync(DIRS.luts).filter((f) => f.endsWith(".cube")).map((f) => f.replace(/\.cube$/, ""))));
app.post(
  "/api/luts",
  upload.single("file"),
  wrap((req) => {
    if (!req.file) throw new Error("no file");
    const text = fs.readFileSync(req.file.path, "utf8");
    fs.rmSync(req.file.path, { force: true });
    if (!/LUT_3D_SIZE\s+\d+/.test(text)) throw new Error("Only 3D .cube LUTs are supported");
    const id = "user-" + path.basename(req.file.originalname, path.extname(req.file.originalname)).replace(/[^\w-]+/g, "-").slice(0, 40);
    fs.writeFileSync(path.join(DIRS.luts, `${id}.cube`), text);
    return { id };
  })
);

// ------------------------------------------------------------------ render

app.post(
  "/api/render",
  wrap((req) => {
    const project = req.body?.project as Project;
    const settings = req.body?.settings as ExportSettings;
    if (!project || !settings) throw new Error("project and settings required");
    return startJob({ type: "render", projectId: project.id, message: "Queued for render" }, "heavy", (ctx) => renderProject(project, settings, ctx));
  })
);

// ------------------------------------------------------------------ files

app.get("/files/media/:id/:variant", (req, res) => {
  const m = Media.get(req.params.id);
  if (!m) return res.status(404).end();
  const file = req.params.variant === "preview" && m.proxyPath && fs.existsSync(m.proxyPath) ? m.proxyPath : m.path;
  if (!fs.existsSync(file)) return res.status(410).json({ error: "media offline" });
  res.sendFile(file, { headers: { "Cache-Control": "private, max-age=3600" } });
});
app.get("/files/luts/:id.cube", (req, res) => {
  const p = lutPath(path.basename(req.params.id));
  if (!p) return res.status(404).end();
  res.sendFile(p);
});
app.use("/files/thumbs", express.static(DIRS.thumbs, { maxAge: "1h" }));
app.use("/files/waveforms", express.static(DIRS.waveforms, { maxAge: "1h" }));
app.use("/files/exports", express.static(DIRS.exports, { setHeaders: (res) => res.setHeader("Content-Disposition", "attachment") }));
app.use("/fonts", express.static(DIRS.fonts, { maxAge: "1d" }));

// production: serve the built client
const dist = path.join(ROOT, "dist");
if (fs.existsSync(dist)) {
  app.use(express.static(dist));
  app.get(/^\/(?!api|files|fonts).*/, (_req, res) => res.sendFile(path.join(dist, "index.html")));
}

async function main() {
  ensureFonts();
  ensureLuts();
  // interrupted jobs from a crash leave temporary files behind; clean them up
  for (const f of fs.readdirSync(DIRS.tmp)) fs.rmSync(path.join(DIRS.tmp, f), { recursive: true, force: true });
  const host = process.env.HOST ?? "127.0.0.1";
  app.listen(PORT, host, () => console.log(`Cutwise server on http://${host}:${PORT}  (data: ${DATA_DIR})`));
  // media that was processing during a crash gets re-processed
  for (const m of Media.all()) if (m.status === "processing") processMedia(m.id, !m.analysis);
  sfxIndex = await ensureSfx();
}
main();
