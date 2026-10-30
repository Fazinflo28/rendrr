import { env, newRedis, queue, type GraphicJob, type MaintenanceJob } from "@rendrr/core";
import { prisma } from "@rendrr/db";
import { deepTimeoutMs, matteAllowanceMs, matteTimeoutMs, processTimeoutMs, QUEUES, renderTimeoutMs, styleTimeoutMs } from "@rendrr/shared";
import { Worker, type Job } from "bullmq";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { availableParallelism } from "node:os";
import { analyzeJob } from "./jobs/analyze";
import { breakdownJob, queueMissingBreakdowns } from "./jobs/breakdown";
import { canvasJob } from "./jobs/canvas";
import { soundJob } from "./jobs/sound";
import { deepFailed, deepJob, queueMissingDeep } from "./jobs/deep";
import { driveSaveFailed, driveSaveJob } from "./jobs/driveSave";
import { graphicFailed, graphicJob } from "./jobs/graphic";
import { heardFailed, heardJob } from "./jobs/heard";
import { snapshotJob } from "./jobs/snapshot";
import { styleFailed, styleJob } from "./jobs/style";
import { testGraphicJob } from "./jobs/testGraphic";
import { matteJob } from "./jobs/matte";
import { framesJob } from "./jobs/frames";
import { maintenanceJob } from "./jobs/maintenance";
import { proxyJob } from "./jobs/proxy";
import { renderFailed, renderJob } from "./jobs/render";
import { cpuBudget, filterThreads } from "./lib/ffmpeg";
import { BROWSER_SLOTS, closeIdleBrowsers, GRAPHIC_WORKERS, recordLimitMs } from "./lib/graphics";
import { guarded } from "./lib/job";

env(); // fail fast on missing settings
// Python's maths libraries (OpenBLAS) start a thread per CPU of the host (48 on Railway), not of the container (6),
// and the container's thread limit counts every one: the scripts this worker starts use what the container has.
for (const k of ["OPENBLAS_NUM_THREADS", "OMP_NUM_THREADS"]) process.env[k] ??= String(cpuBudget());

const videoFailed = async (job: Job, message: string) => {
  const id = (job.data as { videoId?: string }).videoId;
  if (!id) return;
  const v = await prisma.video.findUnique({ where: { id } });
  if (v && v.status !== "missing") await prisma.video.update({ where: { id }, data: { status: "failed", error: message, step: null, progress: null } });
};
const videoUser = async (job: Job) => (await prisma.video.findUnique({ where: { id: (job.data as { videoId: string }).videoId }, select: { userId: true } }))?.userId ?? null;
const renderUser = async (job: Job) => (await prisma.render.findUnique({ where: { id: (job.data as { renderId: string }).renderId }, select: { userId: true } }))?.userId ?? null;

// Limits that grow with the footage (see renderTimeoutMs / processTimeoutMs).
const videoLimit = async (job: Job) => processTimeoutMs((await prisma.video.findUnique({ where: { id: (job.data as { videoId: string }).videoId }, select: { seconds: true } }))?.seconds ?? 0);
const deepLimit = async (job: Job) => deepTimeoutMs((await prisma.video.findUnique({ where: { id: (job.data as { videoId: string }).videoId }, select: { seconds: true } }))?.seconds ?? 0);
const renderLimit = async (job: Job) => {
  const r = await prisma.render.findUnique({ where: { id: (job.data as { renderId: string }).renderId }, select: { kind: true, quality: true, project: { select: { timeline: true, video: { select: { seconds: true } } } } } });
  return renderTimeoutMs(r?.kind === "preview" ? "preview" : "final", r?.project.video.seconds ?? 0, r?.quality) + matteAllowanceMs(r?.project.timeline) + 60_000;
};
// A custom graphic's limit grows with its length and size (see recordLimitMs).
const graphicLimit = async (job: Job) => {
  const g = await prisma.graphic.findUnique({ where: { id: (job.data as { graphicId: string }).graphicId }, select: { durationSec: true, width: true, height: true } });
  return Math.max(QUEUES.graphic.timeoutMs, recordLimitMs(g?.durationSec ?? 0, g?.width, g?.height) + 60_000);
};

// A reference's limit grows with its length (styleTimeoutMs).
const styleRow = (job: Job) => prisma.styleFile.findUnique({ where: { id: (job.data as { styleFileId: string }).styleFileId }, select: { userId: true, videoId: true } });
const styleLimit = async (job: Job) => { const r = await styleRow(job); const v = r?.videoId ? await prisma.video.findUnique({ where: { id: r.videoId }, select: { seconds: true } }) : null; return styleTimeoutMs(v?.seconds ?? 0); };
const styleUser = async (job: Job) => (await styleRow(job))?.userId ?? null;

const conc = (name: string, d: number) => Math.max(1, Math.floor(Number(process.env[`CONCURRENCY_${name.toUpperCase()}`]) || d));
const workers = [
  new Worker(QUEUES.proxy.name, guarded("proxy", videoLimit, "Making the preview", proxyJob, videoFailed, videoUser), { connection: newRedis(), concurrency: conc("proxy", 2), lockDuration: 60_000 }),
  new Worker(QUEUES.analyze.name, guarded("analyze", videoLimit, "Processing", analyzeJob, videoFailed, videoUser), { connection: newRedis(), concurrency: conc("analyze", 2), lockDuration: 60_000 }),
  new Worker(QUEUES.render.name, guarded("render", renderLimit, "The render", renderJob, (job, msg, code) => renderFailed((job.data as { renderId: string }).renderId, msg, code), renderUser), { connection: newRedis(), concurrency: conc("render", 1), lockDuration: 60_000 }),
  new Worker(QUEUES.graphic.name, guarded("graphic", graphicLimit, "The graphic", graphicJob, (job, msg) => graphicFailed(job.data as GraphicJob, msg)), { connection: newRedis(), concurrency: conc("graphic", 1), lockDuration: 60_000 }),
  new Worker(QUEUES.frames.name, guarded("frames", QUEUES.frames.timeoutMs, "Taking frames", framesJob, async () => {}), { connection: newRedis(), concurrency: conc("frames", 2), lockDuration: 60_000 }),
  new Worker(QUEUES.breakdown.name, guarded("breakdown", videoLimit, "Reading the frames", breakdownJob, async () => {}), { connection: newRedis(), concurrency: conc("breakdown", 1), lockDuration: 60_000 }),
  new Worker(QUEUES.deep.name, guarded("deep", deepLimit, "Measuring the footage", deepJob, (job, msg) => deepFailed((job.data as { videoId: string }).videoId, msg), videoUser), { connection: newRedis(), concurrency: conc("deep", 1), lockDuration: 60_000 }),
  new Worker(QUEUES.heard.name, guarded("heard", QUEUES.heard.timeoutMs, "Transcribing the preview", heardJob, (job, msg) => heardFailed((job.data as { renderId: string }).renderId, msg), renderUser), { connection: newRedis(), concurrency: conc("heard", 2), lockDuration: 60_000 }),
  // test_graphic (and the library's preview frames and icon sheets): its own queue so a render or a long recording
  // does not hold it up.
  new Worker(QUEUES.test.name, guarded("test", async (job) => ((job.data as { kind?: string }).kind === "sound" ? 15 * 60_000 : QUEUES.test.timeoutMs), "Testing the graphic", (ctx): Promise<unknown> => { const k = (ctx.job.data as { kind?: string }).kind; return k === "snapshot" ? snapshotJob(ctx) : k === "canvas" ? canvasJob(ctx) : k === "sound" ? soundJob(ctx) : testGraphicJob(ctx); }, async () => {}), { connection: newRedis(), concurrency: conc("test", 2), lockDuration: 60_000 }),
  // analyze_reference: a reference video measured into a style file.
  new Worker(QUEUES.style.name, guarded("style", styleLimit, "Measuring the reference", styleJob, (job, msg) => styleFailed((job.data as { styleFileId: string }).styleFileId, msg), styleUser), { connection: newRedis(), concurrency: conc("style", 1), lockDuration: 60_000 }),
  // A finished final copied into the user's Google Drive (save_to_drive, render_final driveFolder).
  new Worker(QUEUES.drive.name, guarded("drive", QUEUES.drive.timeoutMs, "Saving to Google Drive", driveSaveJob, (job, msg, code) => driveSaveFailed((job.data as { renderId: string }).renderId, msg, code), renderUser), { connection: newRedis(), concurrency: conc("drive", 2), lockDuration: 60_000 }),
  // remove_background: blocks of a video's matte, made ahead of the render (one at a time; a render makes two at once).
  new Worker(QUEUES.matte.name, guarded("matte", matteTimeoutMs(1), "Cutting out the person", matteJob, async () => {}), { connection: newRedis(), concurrency: conc("matte", 1), lockDuration: 60_000 }),
  new Worker(QUEUES.maintenance.name, guarded("maintenance", QUEUES.maintenance.timeoutMs, "Cleanup", maintenanceJob, async () => {}), { connection: newRedis(), concurrency: 1, lockDuration: 120_000 }),
];
for (const w of workers) w.on("error", (e) => console.error(`[${w.name}] worker error:`, e.message));

// Daily cleanup at 03:15 UTC, plus built-in media check on every start.
await queue("maintenance").upsertJobScheduler("daily-cleanup", { pattern: "15 3 * * *" }, { name: "maintenance", data: { task: "cleanup" } satisfies MaintenanceJob });
await queue("maintenance").add("maintenance", { task: "ensure-assets" } satisfies MaintenanceJob, { removeOnComplete: true, removeOnFail: 50, attempts: 2 });

// Ready videos without a breakdown (analysed before breakdowns existed, or the breakdown failed): make them now.
// The API applies database changes when it starts, which can be after this worker starts: keep trying for a while.
void (async () => {
  for (let i = 0; i < 20; i++) {
    try {
      const n = await queueMissingBreakdowns(); if (n) console.log(`[worker] breakdown queued for ${n} earlier videos`);
      const d = await queueMissingDeep(); if (d) console.log(`[worker] deeper measurements queued for ${d} earlier videos`);
      return;
    }
    catch { await new Promise((r) => setTimeout(r, 30_000)); }
  }
})();

// Tiny health endpoint so Railway can tell the worker is alive.
const port = Number(process.env.PORT || 8080);
createServer(async (_req, res) => {
  const counts = await Promise.all(Object.keys(QUEUES).map(async (q) => [q, await queue(q as keyof typeof QUEUES).getJobCounts("active", "waiting", "failed")])).catch(() => []);
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ ok: true, service: "rendrr-worker", queues: Object.fromEntries(counts as [string, unknown][]) }));
}).listen(port, () => {
  // The CPUs FFmpeg sees and the container's thread limit, which a render's thread count has to stay under.
  const pids = (() => { try { return readFileSync("/sys/fs/cgroup/pids.max", "utf8").trim(); } catch { return "?"; } })();
  const align = existsSync(process.env.ALIGN_MODEL || "/opt/models/wav2vec2/model_quantized.onnx") ? "wav2vec2 ready" : "wav2vec2 MISSING (word edges from the sound only)";
  console.log(`[worker] up, health on :${port}; cpus ${availableParallelism()}, pids.max ${pids}, filter threads ${filterThreads()}, graphics browsers ${GRAPHIC_WORKERS} (${BROWSER_SLOTS} in all), ${align}`);
});

const stop = async () => { await Promise.all(workers.map((w) => w.close())); await closeIdleBrowsers().catch(() => {}); await prisma.$disconnect(); process.exit(0); };
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
