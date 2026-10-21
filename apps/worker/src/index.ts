import { env, newRedis, queue, type MaintenanceJob } from "@rendrr/core";
import { prisma } from "@rendrr/db";
import { processTimeoutMs, QUEUES, renderTimeoutMs } from "@rendrr/shared";
import { Worker, type Job } from "bullmq";
import { createServer } from "node:http";
import { analyzeJob } from "./jobs/analyze";
import { graphicFailed, graphicJob } from "./jobs/graphic";
import { framesJob } from "./jobs/frames";
import { maintenanceJob } from "./jobs/maintenance";
import { proxyJob } from "./jobs/proxy";
import { renderFailed, renderJob } from "./jobs/render";
import { guarded } from "./lib/job";

env(); // fail fast on missing settings

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
const renderLimit = async (job: Job) => {
  const r = await prisma.render.findUnique({ where: { id: (job.data as { renderId: string }).renderId }, select: { kind: true, project: { select: { video: { select: { seconds: true } } } } } });
  return renderTimeoutMs(r?.kind === "preview" ? "preview" : "final", r?.project.video.seconds ?? 0) + 60_000;
};

const conc = (name: string, d: number) => Math.max(1, Math.floor(Number(process.env[`CONCURRENCY_${name.toUpperCase()}`]) || d));
const workers = [
  new Worker(QUEUES.proxy.name, guarded("proxy", videoLimit, "Making the preview", proxyJob, videoFailed, videoUser), { connection: newRedis(), concurrency: conc("proxy", 2), lockDuration: 60_000 }),
  new Worker(QUEUES.analyze.name, guarded("analyze", videoLimit, "Processing", analyzeJob, videoFailed, videoUser), { connection: newRedis(), concurrency: conc("analyze", 2), lockDuration: 60_000 }),
  new Worker(QUEUES.render.name, guarded("render", renderLimit, "The render", renderJob, (job, msg, code) => renderFailed((job.data as { renderId: string }).renderId, msg, code), renderUser), { connection: newRedis(), concurrency: conc("render", 1), lockDuration: 60_000 }),
  new Worker(QUEUES.graphic.name, guarded("graphic", QUEUES.graphic.timeoutMs, "The graphic", graphicJob, (job, msg) => graphicFailed((job.data as { graphicId: string }).graphicId, msg)), { connection: newRedis(), concurrency: conc("graphic", 1), lockDuration: 60_000 }),
  new Worker(QUEUES.frames.name, guarded("frames", QUEUES.frames.timeoutMs, "Taking frames", framesJob, async () => {}), { connection: newRedis(), concurrency: conc("frames", 2), lockDuration: 60_000 }),
  new Worker(QUEUES.maintenance.name, guarded("maintenance", QUEUES.maintenance.timeoutMs, "Cleanup", maintenanceJob, async () => {}), { connection: newRedis(), concurrency: 1, lockDuration: 120_000 }),
];
for (const w of workers) w.on("error", (e) => console.error(`[${w.name}] worker error:`, e.message));

// Daily cleanup at 03:15 UTC, plus built-in media check on every start.
await queue("maintenance").upsertJobScheduler("daily-cleanup", { pattern: "15 3 * * *" }, { name: "maintenance", data: { task: "cleanup" } satisfies MaintenanceJob });
await queue("maintenance").add("maintenance", { task: "ensure-assets" } satisfies MaintenanceJob, { removeOnComplete: true, removeOnFail: 50, attempts: 2 });

// Tiny health endpoint so Railway can tell the worker is alive.
const port = Number(process.env.PORT || 8080);
createServer(async (_req, res) => {
  const counts = await Promise.all(Object.keys(QUEUES).map(async (q) => [q, await queue(q as keyof typeof QUEUES).getJobCounts("active", "waiting", "failed")])).catch(() => []);
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ ok: true, service: "rendrr-worker", queues: Object.fromEntries(counts as [string, unknown][]) }));
}).listen(port, () => console.log(`[worker] up, health on :${port}`));

const stop = async () => { await Promise.all(workers.map((w) => w.close())); await prisma.$disconnect(); process.exit(0); };
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
