import { abortMultipart, deleteObject, deleteObjects } from "@rendrr/core";
import { prisma } from "@rendrr/db";
import { DAY_MS, PREVIEW_RETENTION_DAYS, TEMP_ORIGINAL_HOURS } from "@rendrr/shared";
import { ensureAssets } from "../lib/assets";
import type { Ctx } from "../lib/job";

/**
 * Daily retention (the storage rules in the brief):
 *  - preview copies, audio and key frames: 30 days, then the video is marked "expired"
 *  - temp originals for export: 24 hours, no matter what
 *  - preview renders: 30 days (finals and graphics stay until the user deletes them)
 *  - stuck jobs: anything "in progress" for over an hour is failed with a clear message
 */
export async function cleanup() {
  const now = new Date();
  const out = { expiredVideos: 0, tempOriginals: 0, previewRenders: 0, stuckRenders: 0, stuckVideos: 0 };

  const expired = await prisma.video.findMany({ where: { previewExpiresAt: { lt: now }, status: { in: ["ready", "missing", "failed"] } }, include: { analysis: true } });
  for (const v of expired) {
    const frames = ((v.analysis?.keyFrames as { key: string }[]) || []).map((k) => k.key);
    await deleteObjects([v.proxyKey, v.audioKey, v.thumbKey, ...frames]);
    await prisma.video.update({ where: { id: v.id }, data: { status: "expired", proxyKey: null, audioKey: null, thumbKey: null, previewSizeBytes: 0 } });
    if (v.analysis) await prisma.footageAnalysis.update({ where: { videoId: v.id }, data: { keyFrames: [] } });
    out.expiredVideos++;
  }

  const oldOriginals = await prisma.tempOriginal.findMany({ where: { OR: [{ expiresAt: { lt: now } }, { createdAt: { lt: new Date(now.getTime() - TEMP_ORIGINAL_HOURS * 3600_000) } }] } });
  for (const o of oldOriginals) {
    if (!o.completed && o.uploadId) await abortMultipart(o.key, o.uploadId);
    await deleteObject(o.key).catch(() => {});
    await prisma.tempOriginal.delete({ where: { id: o.id } });
    out.tempOriginals++;
  }

  const oldPreviews = await prisma.render.findMany({ where: { kind: "preview", outputKey: { not: null }, createdAt: { lt: new Date(now.getTime() - PREVIEW_RETENTION_DAYS * DAY_MS) } } });
  for (const r of oldPreviews) {
    await deleteObjects([r.outputKey, ...((r.framesKeys as string[]) || [])]);
    await prisma.render.update({ where: { id: r.id }, data: { outputKey: null, framesKeys: [], sizeBytes: 0 } });
    out.previewRenders++;
  }

  const hourAgo = new Date(now.getTime() - 3600_000);
  const stuck = await prisma.render.updateMany({ where: { status: { in: ["queued", "running"] }, createdAt: { lt: hourAgo } }, data: { status: "failed", error: "Render did not finish. Nothing was lost. Try again.", finishedAt: now } });
  out.stuckRenders = stuck.count;
  await prisma.project.updateMany({ where: { status: "Rendering", updatedAt: { lt: hourAgo } }, data: { status: "Draft" } });
  const stuckV = await prisma.video.updateMany({ where: { status: { in: ["linking", "preview", "processing"] }, updatedAt: { lt: hourAgo } }, data: { status: "failed", error: "Processing stopped before it finished. Press Retry." } });
  out.stuckVideos = stuckV.count;
  return out;
}

export async function maintenanceJob(ctx: Ctx) {
  const task = (ctx.job.data as { task?: string }).task;
  if (task === "ensure-assets") return ensureAssets();
  const r = await cleanup();
  console.log("[maintenance] cleanup", JSON.stringify(r));
  return r;
}
