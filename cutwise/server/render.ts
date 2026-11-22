import fs from "node:fs";
import path from "node:path";
import type { ExportSettings, MediaItem, Project } from "../shared/types";
import { buildAss } from "../shared/captions";
import { DIRS } from "./config";
import { ffmpeg, FfmpegError, tail } from "./ffmpeg";
import { Media } from "./db";
import { lutPath } from "./assets";
import { buildRenderPlan, sliceProject } from "./renderGraph";
import type { JobCtx } from "./jobs";

export async function renderProject(project: Project, exp: ExportSettings, ctx: JobCtx) {
  const media: Record<string, MediaItem> = {};
  for (const c of project.clips) if (c.mediaId && !media[c.mediaId]) {
    const m = Media.get(c.mediaId);
    if (m) media[c.mediaId] = { ...m, missing: !fs.existsSync(m.path) };
  }
  if (!project.clips.length) throw new Error("The timeline is empty - add some clips before exporting.");
  const safe = (exp.fileName || project.name || "export").replace(/[^\w\- ]+/g, "").trim().slice(0, 80) || "export";
  const outPath = path.join(DIRS.exports, `${safe}-${Date.now().toString(36)}.mp4`);
  const work = path.join(DIRS.tmp, `render-${ctx.job.id}`);
  fs.mkdirSync(work, { recursive: true });
  try {
    // captions / titles are laid out in the output resolution so nothing is stretched
    const sliced = exp.range ? sliceProject(project, exp.range.start, exp.range.end) : project;
    const forAss: Project = { ...sliced, settings: { ...sliced.settings, width: exp.width, height: exp.height } };
    const hasText = forAss.clips.some((c) => c.kind === "text") || (exp.burnCaptions && forAss.captions.enabled);
    let assPath: string | undefined;
    if (hasText) {
      assPath = path.join(work, "overlay.ass");
      fs.writeFileSync(assPath, buildAss({ ...forAss, captions: { ...forAss.captions, enabled: forAss.captions.enabled && exp.burnCaptions } }, { includeCaptions: exp.burnCaptions }));
    }
    const filterScriptPath = path.join(work, "graph.txt");
    const plan = buildRenderPlan(sliced, media, { ...exp, range: undefined }, { assPath, fontsDir: DIRS.fonts, lutPath, outPath, filterScriptPath });
    fs.writeFileSync(filterScriptPath, plan.filterGraph);
    ctx.progress(0.01, "Rendering");
    try {
      await ffmpeg(plan.args, {
        signal: ctx.signal,
        collectStdout: false,
        onStdout: (d) => {
          const mt = /out_time_us=(\d+)/.exec(d.toString());
          if (mt) {
            const t = Number(mt[1]) / 1e6;
            ctx.progress(Math.min(0.99, t / plan.duration), `Rendering ${t.toFixed(1)}s / ${plan.duration.toFixed(1)}s`);
          }
        },
      });
    } catch (e) {
      fs.rmSync(outPath, { force: true });
      if (e instanceof FfmpegError && !ctx.signal.aborted) {
        fs.writeFileSync(path.join(DIRS.exports, `last-error.log`), `${plan.args.join(" ")}\n\n${plan.filterGraph}\n\n${e.stderr}`);
        throw new Error(`Render failed: ${tail(e.stderr, 4)} (full log: data/exports/last-error.log)`);
      }
      throw e;
    }
    const size = fs.statSync(outPath).size;
    return { file: path.basename(outPath), url: `/files/exports/${path.basename(outPath)}`, size, duration: plan.duration };
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}
