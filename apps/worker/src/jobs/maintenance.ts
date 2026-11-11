import { abortMultipart, abortStaleMultipart, deleteObject, deleteObjects, deletePrefix, listPrefix, planWithoutFiles, purgeTrash, renderFileKeys, snapshotStorage } from "@rendrr/core";
import { prisma, type Prisma } from "@rendrr/db";
import { DAY_MS, PREFIX, PREVIEW_RETENTION_DAYS, processTimeoutMs, renderLimitMs, TEMP_ORIGINAL_HOURS, type Breakdown } from "@rendrr/shared";
import { ensureAssets } from "../lib/assets";
import type { Ctx } from "../lib/job";
import { framesPrefix, queueMissingBreakdowns } from "./breakdown";

/**
 * Daily retention (the storage rules in the brief):
 *  - preview copies, audio, key frames and contact sheets: 30 days, then the video is marked "expired"
 *    (the breakdown text and transcript stay; rebuilding the preview makes new sheets)
 *  - temp originals for export: 24 hours, no matter what
 *  - preview renders: 30 days (finals and graphics stay until the user deletes them)
 *  - stuck jobs: anything "in progress" for over an hour is failed with a clear message
 *  - ready videos without a breakdown get one queued
 */
export async function cleanup() {
  const now = new Date();
  const out = { expiredVideos: 0, tempOriginals: 0, previewRenders: 0, stuckRenders: 0, stuckVideos: 0, breakdownsQueued: 0, trashVideos: 0, trashElements: 0, trashSounds: 0, trashKept: 0 };

  const expired = await prisma.video.findMany({ where: { previewExpiresAt: { lt: now }, status: { in: ["ready", "missing", "failed"] } }, include: { analysis: true } });
  for (const v of expired) {
    const frames = ((v.analysis?.keyFrames as { key: string }[]) || []).map((k) => k.key);
    await deleteObjects([v.proxyKey, v.audioKey, v.thumbKey, ...frames]);
    await deletePrefix(framesPrefix(v));
    await prisma.video.update({ where: { id: v.id }, data: { status: "expired", proxyKey: null, audioKey: null, thumbKey: null, previewSizeBytes: 0 } });
    const b = v.analysis?.breakdown as unknown as Breakdown | null;
    if (v.analysis) await prisma.footageAnalysis.update({ where: { videoId: v.id }, data: { keyFrames: [], ...(b?.frames ? { breakdown: { ...b, frames: { ...b.frames, sheets: [] } } as unknown as Prisma.InputJsonValue } : {}) } });
    out.expiredVideos++;
  }

  const oldOriginals = await prisma.tempOriginal.findMany({ where: { OR: [{ expiresAt: { lt: now } }, { createdAt: { lt: new Date(now.getTime() - TEMP_ORIGINAL_HOURS * 3600_000) } }] } });
  for (const o of oldOriginals) {
    if (!o.completed && o.uploadId) await abortMultipart(o.key, o.uploadId);
    await deleteObject(o.key).catch(() => {});
    await prisma.tempOriginal.delete({ where: { id: o.id } });
    out.tempOriginals++;
  }

  // Raw originals are never kept longer than promised, even when their database row is already gone
  // (folder or footage deleted): sweep the prefix itself, and abort uploads that never finished.
  const rawCutoff = new Date(now.getTime() - (TEMP_ORIGINAL_HOURS + 1) * 3600_000);
  try {
    const stale = (await listPrefix(PREFIX.tempRaw, 5000)).filter((o) => o.lastModified < rawCutoff).map((o) => o.key);
    await deleteObjects(stale);
    out.tempOriginals += stale.length;
    out.tempOriginals += await abortStaleMultipart(PREFIX.tempRaw, rawCutoff);
  } catch (e) {
    console.warn("[cleanup] temp-raw sweep:", (e as Error).message);
  }

  // test_graphic's clips and frames: a day.
  try {
    const tests = (await listPrefix(PREFIX.tests, 5000)).filter((o) => o.lastModified < new Date(now.getTime() - DAY_MS)).map((o) => o.key);
    await deleteObjects(tests);
  } catch (e) {
    console.warn("[cleanup] tests sweep:", (e as Error).message);
  }

  // Files sent up for renders on users' Macs: a day (the caption fonts, mac/fonts/, are kept for every Mac).
  try {
    const mac = (await listPrefix(PREFIX.mac, 5000)).filter((o) => !o.key.startsWith(`${PREFIX.mac}fonts/`) && o.lastModified < new Date(now.getTime() - DAY_MS)).map((o) => o.key);
    await deleteObjects(mac);
  } catch (e) {
    console.warn("[cleanup] mac sweep:", (e as Error).message);
  }

  const oldPreviews = await prisma.render.findMany({ where: { kind: "preview", outputKey: { not: null }, createdAt: { lt: new Date(now.getTime() - PREVIEW_RETENTION_DAYS * DAY_MS) } } });
  for (const r of oldPreviews) {
    await deleteObjects(renderFileKeys(r));
    await prisma.render.update({ where: { id: r.id }, data: { outputKey: null, framesKeys: [], sizeBytes: 0, plan: (planWithoutFiles(r.plan) ?? undefined) as never } });
    out.previewRenders++;
  }

  // Samples (render_samples): their stills and clips go when previews do.
  const oldSamples = await prisma.render.findMany({ where: { kind: "sample", status: "done", createdAt: { lt: new Date(now.getTime() - PREVIEW_RETENTION_DAYS * DAY_MS) } }, select: { id: true, framesKeys: true } });
  for (const r of oldSamples) {
    const keys = (r.framesKeys as string[]) || [];
    if (!keys.length) continue;
    await deleteObjects(keys);
    await prisma.render.update({ where: { id: r.id }, data: { framesKeys: [], sizeBytes: 0 } });
    out.previewRenders++;
  }

  Object.assign(out, await sweepStuck(now));
  out.breakdownsQueued = await queueMissingBreakdowns().catch(() => 0); // ready videos whose breakdown failed
  // The Assets page's Trash: what was deleted TRASH_DAYS ago goes for good (kept while an edit still uses it).
  const t = await purgeTrash().catch((e) => { console.warn("[maintenance] trash:", (e as Error).message); return null; });
  if (t) { out.trashVideos = t.videos; out.trashElements = t.elements; out.trashSounds = t.sounds; out.trashKept = t.kept.length; }
  return out;
}


/**
 * Stuck work, every ten minutes (and in the daily cleanup). A running render is judged against its own limit (the
 * same renderLimitMs the worker gives it, plus a margin); a queued one only after six hours, since it may simply wait
 * behind others. Edits left on "Rendering" with nothing rendering go back to what their renders say. Footage, a
 * reference being measured and a graphic being recorded that stopped fail with a way to try again.
 */
export async function sweepStuck(now = new Date()) {
  const out = { stuckRenders: 0, stuckVideos: 0, stuckStyles: 0, stuckGraphics: 0 };
  const hourAgo = new Date(now.getTime() - 3600_000);
  const active = await prisma.render.findMany({ where: { status: { in: ["queued", "running"] } }, select: { id: true, kind: true, quality: true, status: true, createdAt: true, startedAt: true, project: { select: { timeline: true, video: { select: { seconds: true } } } } } });
  const dead = active.filter((r) => r.status === "running"
    ? now.getTime() - (r.startedAt ?? r.createdAt).getTime() > renderLimitMs(r.kind === "final" ? "final" : "preview", r.project.video.seconds, r.quality, r.project.timeline) + 15 * 60_000
    : now.getTime() - r.createdAt.getTime() > 6 * 3600_000);
  if (dead.length) await prisma.render.updateMany({ where: { id: { in: dead.map((r) => r.id) }, status: { in: ["queued", "running"] } }, data: { status: "failed", error: "Render did not finish. Nothing was lost. Try again.", finishedAt: now } });
  out.stuckRenders = dead.length;
  for (const p of await prisma.project.findMany({ where: { status: "Rendering", updatedAt: { lt: hourAgo } }, select: { id: true } })) {
    if (await prisma.render.count({ where: { projectId: p.id, status: { in: ["queued", "running"] } } })) continue;
    const done = await prisma.render.findMany({ where: { projectId: p.id, status: "done", kind: { not: "sample" } }, select: { kind: true } });
    await prisma.project.update({ where: { id: p.id }, data: { status: done.some((x) => x.kind === "final") ? "Final ready" : done.length ? "Preview ready" : "Draft" } });
  }
  // Footage: server-side steps that stopped fail with Retry; a browser-side preview whose tab went away is paused
  // (Resume continues it). Long footage gets longer before it counts as stuck.
  const stuckVideos = await prisma.video.findMany({ where: { status: { in: ["linking", "preview", "previewing", "uploading", "processing"] }, updatedAt: { lt: hourAgo } }, select: { id: true, status: true, source: true, sample: true, seconds: true, updatedAt: true } });
  for (const v of stuckVideos) {
    if (now.getTime() - v.updatedAt.getTime() < 2 * processTimeoutMs(v.seconds) + 30 * 60_000) continue;
    const browserSide = v.source === "local" && !v.sample && (v.status === "previewing" || v.status === "uploading");
    await prisma.video.update({ where: { id: v.id }, data: browserSide ? { status: "paused" } : { status: "failed", error: "Processing stopped before it finished. Press Retry." } });
    out.stuckVideos++;
  }
  // A reference still "measuring" after three hours, a graphic still recording after two: failed, so asking again
  // starts it again (each otherwise answers "still working" for ever).
  out.stuckStyles = (await prisma.styleFile.updateMany({ where: { status: "measuring", updatedAt: { lt: new Date(now.getTime() - 3 * 3600_000) } }, data: { status: "failed", error: "Measuring stopped before it finished. Ask again." } })).count;
  out.stuckGraphics = (await prisma.graphic.updateMany({ where: { status: { in: ["queued", "rendering"] }, changedAt: { lt: new Date(now.getTime() - 2 * 3600_000) } }, data: { status: "failed", error: "The recording stopped before it finished. Try it again." } })).count;
  return out;
}

export async function maintenanceJob(ctx: Ctx) {
  const task = (ctx.job.data as { task?: string }).task;
  if (task === "ensure-assets") return ensureAssets();
  if (task === "stuck") { const r = await sweepStuck(); if (Object.values(r).some(Boolean)) console.log("[maintenance] stuck", JSON.stringify(r)); return r; }
  if (task === "storage") { const n = await snapshotStorage(); return { users: n }; }
  const r = await cleanup();
  console.log("[maintenance] cleanup", JSON.stringify(r));
  // Each user's storage today: the storage bill (Starter, over 10 GB) and the storage cost in the admin panel.
  const users = await snapshotStorage().catch((e) => { console.warn("[maintenance] storage snapshot:", (e as Error).message); return 0; });
  return { ...r, storageSnapshots: users };
}
