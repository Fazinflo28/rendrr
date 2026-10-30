import { drive, driveSaveOf, setDriveSave, signGet, type DriveSaveJob } from "@rendrr/core";
import { prisma } from "@rendrr/db";
import { JobError } from "../lib/ffmpeg";
import type { Ctx } from "../lib/job";

/**
 * A finished final copied into the user's Google Drive, in the folder its driveSave names (save_to_drive, or
 * render_final with driveFolder once the render is done): read from storage in chunks and sent as a resumable upload.
 */
export async function driveSaveJob(ctx: Ctx): Promise<{ fileId: string }> {
  const { renderId } = ctx.job.data as DriveSaveJob;
  const r = await prisma.render.findUnique({ where: { id: renderId } });
  const d = r && driveSaveOf(r);
  if (!r || !d) throw new JobError("That final is gone.", "gone", false);
  if (r.status !== "done" || !r.outputKey) throw new JobError("The final is not ready yet.", "not-ready", false);
  if (d.state === "saved") return { fileId: d.fileId! };
  await setDriveSave(r.id, { ...d, state: "saving", percent: 0, at: Date.now() });
  let shown = 0;
  const f = await drive.uploadToDrive(r.userId, d.name, { url: await signGet(r.outputKey, 6 * 3600), size: Number(r.sizeBytes), type: "video/mp4" }, { id: d.folderId, path: d.path, driveId: d.driveId, made: [] }, (p) => {
    const pct = Math.floor(p * 100);
    if (pct - shown >= 5 && pct < 100) { shown = pct; void setDriveSave(r.id, { ...d, state: "saving", percent: pct, at: Date.now() }).catch(() => {}); }
  });
  await setDriveSave(r.id, { ...d, state: "saved", percent: 100, fileId: f.id, link: f.webViewLink || `https://drive.google.com/file/d/${f.id}/view`, error: undefined, code: undefined, at: Date.now() });
  return { fileId: f.id };
}

/** Failed for good: the render says why (Google's refusal keeps its code, so the AI can tell the user what to do). */
export async function driveSaveFailed(renderId: string, message: string, code?: string) {
  const r = await prisma.render.findUnique({ where: { id: renderId } });
  const d = r && driveSaveOf(r);
  if (r && d) await setDriveSave(r.id, { ...d, state: "failed", error: message, code, at: Date.now() });
}
