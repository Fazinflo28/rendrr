import { prisma, type Prisma } from "@rendrr/db";
import { enqueue, type DriveSaveJob } from "./queue";

/**
 * A final's copy into the user's Google Drive, on its render: waiting (for the final to finish), queued, saving (with
 * percent), saved (the file's id and link) or failed (why, and a code: drive-write when Google refused the folder).
 */
export type DriveSave = {
  state: "waiting" | "queued" | "saving" | "saved" | "failed";
  folderId: string; driveId?: string; path: string; name: string; made?: string[];
  percent?: number; fileId?: string; link?: string; error?: string; code?: string; at: number;
};

export const driveSaveOf = (r: { driveSave: unknown }): DriveSave | null => (r.driveSave && typeof r.driveSave === "object" ? (r.driveSave as DriveSave) : null);

export async function setDriveSave(renderId: string, d: DriveSave) {
  await prisma.render.update({ where: { id: renderId }, data: { driveSave: d as unknown as Prisma.InputJsonValue } });
}

/** Starts the copy of a finished final (one job per render: asking again while it runs joins it). */
export async function queueDriveSave(renderId: string, d: DriveSave) {
  await setDriveSave(renderId, { ...d, state: "queued", percent: 0, error: undefined, code: undefined, at: Date.now() });
  await enqueue<DriveSaveJob>("drive", { renderId }, { jobId: `drive-${renderId}-${Date.now()}` });
}
