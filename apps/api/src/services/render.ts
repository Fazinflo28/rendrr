import { chapterProblems, chaptersText, macOriginalOf, type Chapter } from "@rendrr/shared";
import { AppError, enqueue, macForRender, publishRender, queue, readRender, redis, RENDER_QUEUES, renderQueueOf, sealLatestVersion, signGet, type RenderJob } from "@rendrr/core";
import { prisma, type Render } from "@rendrr/db";
import { bestResolution, FINAL_DRIVE_STEPS, FINAL_RENDER_STEPS, fmtSize, isFourKQuality, isSoundFormat, PREVIEW_STEPS, qualityLabel, SOUND_QUALITY, type ExportFormat } from "@rendrr/shared";
import { getOwnedProject } from "./projects";
import { samplesView } from "./samples";
import { assertMay } from "./billing";
import { pickTarget, renderWhere } from "./macExport";

export function stepsFor(kind: "preview" | "final", source: string, sample: boolean): string[] {
  if (kind === "preview") return [...PREVIEW_STEPS];
  return source === "drive" && !sample ? [...FINAL_DRIVE_STEPS] : [...FINAL_RENDER_STEPS];
}

/** The video's original is kept on one of the user's computers, that computer's Rendrr app is open and can make the
 *  final now, and the render may go there (target: none, or that computer; "cloud" or another computer cannot read it). */
export async function originalOnMac(userId: string, video: { macOriginal?: unknown }, target?: string | null): Promise<boolean> {
  const mo = macOriginalOf(video);
  if (!mo || target === "cloud") return false;
  if (target && mo.deviceId && target !== mo.deviceId) return false;
  const m = await macForRender(userId, [], mo.deviceId ?? target ?? null);
  return !!m.info && !m.why && (mo.deviceId ? m.info.id === mo.deviceId : (!mo.device || !m.info.device || mo.device === m.info.device));
}

/** Where the web app asks a render to be made (its Export window's "Render on"): a computer's id or name, or "cloud";
 *  nothing: the computer picked earlier, the only one, else the best one free. A computer not there is refused. */
export async function targetFromApp(userId: string, device: unknown): Promise<string | null> {
  if (typeof device !== "string" || !device.trim()) { const p = await pickTarget(userId, null, { tool: "the export" }); return p.ask ? null : p.target; }
  const pick = await pickTarget(userId, device, { tool: "the export" });
  if (pick.ask) throw new AppError(pick.ask.replace(/ Nothing was rendered.*$/, ""), 409, "device");
  return pick.target;
}

/** Starts a render. Local footage needs its original once for a final (code "need-original", as the UI expects), unless it is kept on the user's Mac and that Mac makes the final. */
export async function startRender(userId: string, projectId: string, kind: "preview" | "final", opts: { version?: number; by?: string; best?: boolean; target?: string | null; format?: ExportFormat } = {}) {
  const p = await getOwnedProject(userId, projectId);
  const video = await prisma.video.findUniqueOrThrow({ where: { id: p.videoId } });
  if (kind === "preview" && (!video.proxyKey || video.status === "expired")) {
    throw new AppError("The preview copy of this footage expired. Rebuild it from your Library, then render again.", 409, "expired");
  }
  if (kind === "final" && video.source === "local" && !video.sample) {
    const orig = await prisma.tempOriginal.findFirst({ where: { projectId, videoId: video.id, completed: true, expiresAt: { gt: new Date() } } });
    // The original kept on the user's Mac: the final is made there (the Mac app open, able, and the same Mac).
    if (!orig && !(await originalOnMac(userId, video, opts.target))) throw new AppError("Full quality needs your original file once.", 409, "need-original");
  }
  if (kind === "final" && video.status === "missing") {
    throw new AppError("We could not reach your Drive file. Reconnect it and try again.", 409, "drive");
  }
  const version = opts.version ?? (await sealLatestVersion(projectId));
  const exists = await prisma.projectVersion.findUnique({ where: { projectId_v: { projectId, v: version } } });
  if (!exists) throw new AppError(`Version ${version} does not exist.`, 400);
  const steps = stepsFor(kind, video.source, video.sample);
  // Phase 7: the final's quality from its version's export settings (its time limit follows it); HDR is learnt by the
  // worker from the original and added then.
  const ex = (exists.timeline as unknown as { timeline?: { export?: { resolution?: string; codec?: string; format?: ExportFormat } } })?.timeline?.export;
  // The final's file type: one asked for this export only (render_final format: sound only, the edit unchanged), else
  // the version's export setting. Sound has no picture size, so it is never a best or 4K export.
  const format: ExportFormat | null = kind === "final" ? opts.format ?? ex?.format ?? "mp4" : null;
  const sound = isSoundFormat(format);
  // Best quality: the highest resolution the footage fills in the edit's shape, a finer encode (the worker reads "best"
  // in the quality label). A best final and a standard one of the same version are different renders.
  const best = kind === "final" && !!opts.best && !sound;
  const resolution = best && (ex?.resolution === "4k" || bestResolution(p.aspect, video.width, video.height) === "4k") ? "4k" : best ? "1080p" : ex?.resolution;
  const quality = kind !== "final" ? "540p" : sound ? SOUND_QUALITY[format as "audio" | "wav"] : qualityLabel({ resolution, codec: ex?.codec, hdr: !!video.hdr && ((ex as { hdr?: string })?.hdr ?? "keep") === "keep", best });
  // Billing: the plan must have room for this export (or preview). Gallery renders are Rendrr's own.
  if (opts.by !== "gallery") await assertMay(userId, { metric: kind === "final" ? "export" : "preview", minutes: (p.outputSeconds || video.seconds || 60) / 60, fourK: kind === "final" && isFourKQuality(quality) });
  // Asking again while the same version is already waiting or rendering joins that render, however long it has been
  // going (the stuck-work sweep ends one that died). One request at a time per edit and kind: two quick clicks, or a
  // click and the AI's render at once, make one render, not two.
  const made = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"render:" + projectId + ":" + kind}))`;
    // A final joins only one of the same file type (a sound-only export never stands in for the video, nor the reverse).
    const running = await tx.render.findFirst({ where: { projectId, kind, version, status: { in: ["queued", "running"] }, ...(kind === "final" ? { quality: best ? { contains: "best" } : { not: { contains: "best" } }, format } : {}) }, orderBy: { createdAt: "desc" } });
    if (running) return { r: running, joined: true };
    return { r: await tx.render.create({ data: { projectId, userId, kind, version, status: "queued", steps, quality, format, by: opts.by ?? "user", target: opts.target ?? null } }), joined: false };
  });
  if (made.joined) return made.r;
  const r = made.r;
  // Review states (In review, Changes requested, Approved) stay put while rendering; the render has its own progress.
  // A finished final still moves the edit to "Final ready", as in the UI.
  const reviewState = ["In review", "Changes requested", "Approved"].includes(p.status);
  if (version === p.currentVersion && !reviewState) await prisma.project.update({ where: { id: projectId }, data: { status: "Rendering" } });
  await publishRender(r.id, { status: "queued", step: 0, steps, percent: 0 });
  await enqueue<RenderJob>(renderQueueOf(kind), { renderId: r.id }, { jobId: r.id });
  return r;
}

export async function renderResult(r: Render) {
  const project = await prisma.project.findUnique({ where: { id: r.projectId } });
  const video = project ? await prisma.video.findUnique({ where: { id: project.videoId } }) : null;
  // Phase 12: the file's own extension (a GIF, sound only, ProRes with alpha) and its captions and chapters.
  // Before the file exists (render_final with driveFolder names the Drive copy at once), the edit's export format says it.
  const fmt = r.format ?? (project?.timeline as { export?: { format?: string } } | null)?.export?.format;
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
    // Where it is made (the user's Mac while its Rendrr app makes it, else Rendrr's cloud server) and where the file goes.
    where: renderWhere(r, live),
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
  for (const q of RENDER_QUEUES) {
    const job = await queue(q).getJob(r.id).catch(() => null);
    if (job && ((await job.isWaiting().catch(() => false)) || (await job.isDelayed().catch(() => false)) || (await job.isPrioritized?.().catch(() => false)))) await job.remove().catch(() => {});
  }
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
