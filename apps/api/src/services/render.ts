import { chapterProblems, chaptersText, type Chapter } from "@rendrr/shared";
import { AppError, enqueue, publishRender, readRender, sealLatestVersion, signGet, type RenderJob } from "@rendrr/core";
import { prisma, type Render } from "@rendrr/db";
import { FINAL_DRIVE_STEPS, FINAL_RENDER_STEPS, fmtSize, PREVIEW_STEPS, qualityLabel, renderTimeoutMs } from "@rendrr/shared";
import { getOwnedProject } from "./projects";
import { samplesView } from "./samples";

export function stepsFor(kind: "preview" | "final", source: string, sample: boolean): string[] {
  if (kind === "preview") return [...PREVIEW_STEPS];
  return source === "drive" && !sample ? [...FINAL_DRIVE_STEPS] : [...FINAL_RENDER_STEPS];
}

/** Starts a render. Local footage needs its original once for a final (code "need-original", as the UI expects). */
export async function startRender(userId: string, projectId: string, kind: "preview" | "final", opts: { version?: number } = {}) {
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
  const version = opts.version ?? (await sealLatestVersion(projectId));
  const exists = await prisma.projectVersion.findUnique({ where: { projectId_v: { projectId, v: version } } });
  if (!exists) throw new AppError(`Version ${version} does not exist.`, 400);
  // Asking again while the same version is already rendering joins that render.
  const running = await prisma.render.findFirst({ where: { projectId, kind, version, status: { in: ["queued", "running"] }, createdAt: { gt: new Date(Date.now() - renderTimeoutMs(kind, video.seconds) - 60_000) } } });
  if (running) return running;

  const steps = stepsFor(kind, video.source, video.sample);
  // Phase 7: the final's quality from its version's export settings (its time limit follows it); HDR is learnt by the
  // worker from the original and added then.
  const ex = (exists.timeline as unknown as { timeline?: { export?: { resolution?: string; codec?: string } } })?.timeline?.export;
  const quality = kind === "final" ? qualityLabel({ resolution: ex?.resolution, codec: ex?.codec, hdr: !!video.hdr && ((ex as { hdr?: string })?.hdr ?? "keep") === "keep" }) : "540p";
  const r = await prisma.render.create({ data: { projectId, userId, kind, version, status: "queued", steps, quality } });
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
  const ext = (r.outputKey?.match(/\.(\w+)$/)?.[1] ?? "mp4").toLowerCase();
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
