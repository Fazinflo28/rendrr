import { chapterProblems, chaptersText, type Chapter } from "@rendrr/shared";
import { AppError, enqueue, publishRender, queue, readRender, redis, sealLatestVersion, signGet, type RenderJob } from "@rendrr/core";
import { prisma, type Render } from "@rendrr/db";
import { bestResolution, FINAL_DRIVE_STEPS, FINAL_RENDER_STEPS, fmtSize, PREVIEW_STEPS, qualityLabel } from "@rendrr/shared";
import { getOwnedProject } from "./projects";
import { samplesView } from "./samples";

export function stepsFor(kind: "preview" | "final", source: string, sample: boolean): string[] {
  if (kind === "preview") return [...PREVIEW_STEPS];
  return source === "drive" && !sample ? [...FINAL_DRIVE_STEPS] : [...FINAL_RENDER_STEPS];
}

/** Starts a render. Local footage needs its original once for a final (code "need-original", as the UI expects). */
export async function startRender(userId: string, projectId: string, kind: "preview" | "final", opts: { version?: number; by?: string; best?: boolean } = {}) {
  const p = await getOwnedProject(userId, projectId);
  const video = await prisma.video.findUniqueOrThrow({ where: { id: p.videoId } });
  if (kind === "preview" && (!video.proxyKey || video.status === "expired")) {
    throw new AppError("The preview copy of this footage expired. Rebuild it from your Library, then render again.", 409, "expired");
  }
  if (kind === "final" && video.source === "local" && !video.sample) {
    const orig = await prisma.tempOriginal.findFirst({ where: { projectId, videoId: video.id, completed: true, expiresAt: { gt: new Date() } } });
    if (!orig) throw new AppError("Full quality needs your original file once.", 409, "need-original");
  }
  if (kind === "final" && video.status === "missing") {
    throw new AppError("We could not reach your Drive file. Reconnect it and try again.", 409, "drive");
  }
  // Best quality: the highest resolution the footage fills in the edit's shape, a finer encode (the worker reads "best"
  // in the quality label). A best final and a standard one of the same version are different renders.
  const best = kind === "final" && !!opts.best;
  const version = opts.version ?? (await sealLatestVersion(projectId));
  const exists = await prisma.projectVersion.findUnique({ where: { projectId_v: { projectId, v: version } } });
  if (!exists) throw new AppError(`Version ${version} does not exist.`, 400);
  const steps = stepsFor(kind, video.source, video.sample);
  // Phase 7: the final's quality from its version's export settings (its time limit follows it); HDR is learnt by the
  // worker from the original and added then.
  const ex = (exists.timeline as unknown as { timeline?: { export?: { resolution?: string; codec?: string } } })?.timeline?.export;
  const resolution = best && (ex?.resolution === "4k" || bestResolution(p.aspect, video.width, video.height) === "4k") ? "4k" : best ? "1080p" : ex?.resolution;
  const quality = kind === "final" ? qualityLabel({ resolution, codec: ex?.codec, hdr: !!video.hdr && ((ex as { hdr?: string })?.hdr ?? "keep") === "keep", best }) : "540p";
  // Asking again while the same version is already waiting or rendering joins that render, however long it has been
  // going (the stuck-work sweep ends one that died). One request at a time per edit and kind: two quick clicks, or a
  // click and the AI's render at once, make one render, not two.
  const made = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"render:" + projectId + ":" + kind}))`;
    const running = await tx.render.findFirst({ where: { projectId, kind, version, status: { in: ["queued", "running"] }, ...(kind === "final" ? { quality: best ? { contains: "best" } : { not: { contains: "best" } } } : {}) }, orderBy: { createdAt: "desc" } });
    if (running) return { r: running, joined: true };
    return { r: await tx.render.create({ data: { projectId, userId, kind, version, status: "queued", steps, quality, by: opts.by ?? "user" } }), joined: false };
  });
  if (made.joined) return made.r;
  const r = made.r;
  // Review states (In review, Changes requested, Approved) stay put while rendering; the render has its own progress.
  // A finished final still moves the edit to "Final ready", as in the UI.
  const reviewState = ["In review", "Changes requested", "Approved"].includes(p.status);
  if (version === p.currentVersion && !reviewState) await prisma.project.update({ where: { id: projectId }, data: { status: "Rendering" } });
  await publishRender(r.id, { status: "queued", step: 0, steps, percent: 0 });
  await enqueue<RenderJob>("render", { renderId: r.id }, { jobId: r.id });
  return r;
}

export async function renderResult(r: Render) {
  const project = await prisma.project.findUnique({ where: { id: r.projectId } });
  const video = project ? await prisma.video.findUnique({ where: { id: project.videoId } }) : null;
  // Phase 12: the file's own extension (a GIF, sound only, ProRes with alpha) and its captions and chapters.
  // Before the file exists (render_final with driveFolder names the Drive copy at once), the edit's export format says it.
  const fmt = (project?.timeline as { export?: { format?: string } } | null)?.export?.format;
  const planned = ({ gif: "gif", audio: "m4a", wav: "wav", overlay: "mov" } as Record<string, string>)[fmt || ""] || "mp4";
  const ext = (r.outputKey?.match(/\.(\w+)$/)?.[1] ?? (r.kind === "final" ? planned : "mp4")).toLowerCase();
  const stem = `${(project?.name || "rendrr").replace(/[^\w\- ]+/g, "").trim() || "rendrr"} ${r.kind === "final" ? "final" : "preview"} v${r.version}`;
  const fileName = `${stem}.${ext}`;
  const url = r.outputKey ? await signGet(r.outputKey, 6 * 3600) : null;
  const meta = (r.plan as { files?: Record<string, string>; chapters?: Chapter[]; outputSeconds?: number } | null) ?? {};
  const files: Record<string, string> = {};
  for (const [k, key] of Object.entries(meta.files ?? {})) files[k] = await signGet(key, 6 * 3600, { download: k === "chapters" ? `${stem} chapters.txt` : `${stem}.${k}` });
  const chapters = meta.chapters?.length ? chaptersText(meta.chapters) : null;
  const chapterNote = meta.chapters?.length ? chapterProblems(meta.chapters, meta.outputSeconds ?? r.seconds) : [];
  const downloadUrl = r.outputKey ? await signGet(r.outputKey, 6 * 3600, { download: fileName }) : null;
  const frames = await Promise.all(((r.framesKeys as string[]) || []).slice(0, 5).map((k) => signGet(k, 3600)));
  const source = video?.source || "drive";
  const note = r.kind === "final" ? (source === "drive" && !video?.sample ? "Final ready. Original file deleted from our servers." : video?.sample ? "Final ready." : "Final ready. Your original was deleted from our servers.") : undefined;
  // How long the render took (work only: from the worker's start to the file being ready).
  const renderSeconds = r.startedAt && r.finishedAt ? Math.round((r.finishedAt.getTime() - r.startedAt.getTime()) / 100) / 10 : null;
  return { renderId: r.id, url, downloadUrl, fileName, files, chapters, chapterNote, ext, quality: r.quality || (r.kind === "final" ? "1080p" : "540p"), size: fmtSize(r.sizeBytes), seconds: r.seconds, renderSeconds, source, note, version: r.version, frames, steps: (r.steps as string[]) || [] };
}

export async function renderStatus(r: Render) {
  const live = await readRender(r.id);
  const steps = (r.steps as string[]) || [];
  const base = live || { status: r.status as "queued", step: r.step, steps, percent: r.progress };
  return {
    id: r.id, kind: r.kind, projectId: r.projectId, version: r.version,
    status: r.status === "done" || r.status === "failed" ? r.status : base.status,
    step: base.step, steps: base.steps.length ? base.steps : steps, percent: r.status === "done" ? 100 : base.percent, etaSec: r.status === "done" || r.status === "failed" ? null : base.etaSec ?? null,
    error: r.error ?? base.error ?? undefined, code: r.errorCode ?? base.code ?? undefined,
    result: r.status === "done" ? (r.kind === "sample" ? { renderId: r.id, samples: await samplesView(r.userId, r.id) } : await renderResult(r)) : undefined,
  };
}

/** Redis channel the worker listens on: "render:<id>" stops that render's job where it stands (worker lib/job.ts). */
export const STOP_CHANNEL = "rendrr:stop";

/**
 * "Stop export": a render still waiting leaves the queue; a running one is told to stop on the worker. Either way it
 * ends now as failed with code "stopped" (the app closes its window on that), and the edit goes back to the status
 * its finished renders give it. A render that already ended is left as it is.
 */
export async function stopRender(r: Render) {
  if (r.status === "done" || r.status === "failed") return { stopped: false, status: r.status };
  const job = await queue("render").getJob(r.id).catch(() => null);
  if (job && ((await job.isWaiting().catch(() => false)) || (await job.isDelayed().catch(() => false)))) await job.remove().catch(() => {});
  const error = "You stopped this export.";
  // Only while it is still waiting or running: one that finished a moment ago stays finished.
  const hit = await prisma.render.updateMany({ where: { id: r.id, status: { in: ["queued", "running"] } }, data: { status: "failed", error, errorCode: "stopped", finishedAt: new Date() } });
  if (!hit.count) return { stopped: false, status: (await prisma.render.findUnique({ where: { id: r.id }, select: { status: true } }))?.status ?? r.status };
  await redis().publish(STOP_CHANNEL, `render:${r.id}`);
  const p = await prisma.project.findUnique({ where: { id: r.projectId }, select: { id: true, status: true } });
  if (p && p.status === "Rendering") {
    const done = await prisma.render.findMany({ where: { projectId: p.id, status: "done", kind: { not: "sample" } }, select: { kind: true } });
    const status = done.some((x) => x.kind === "final") ? "Final ready" : done.length || r.kind === "final" ? "Preview ready" : "Draft";
    await prisma.project.update({ where: { id: p.id }, data: { status } });
  }
  await publishRender(r.id, { status: "failed", step: 0, steps: (r.steps as string[]) || [], percent: 0, error, code: "stopped" });
  return { stopped: true, status: "failed" };
}
