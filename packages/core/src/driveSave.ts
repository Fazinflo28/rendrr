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

/** A final's file type in Drive, from its storage key (a GIF, sound only or ProRes are not MP4s). */
export const FINAL_TYPES: Record<string, string> = { mp4: "video/mp4", gif: "image/gif", m4a: "audio/mp4", wav: "audio/wav", mov: "video/quicktime" };
export function finalType(outputKey: string | null | undefined): { ext: string; type: string } {
  const ext = (outputKey?.match(/\.(\w+)$/)?.[1] ?? "mp4").toLowerCase();
  return { ext, type: FINAL_TYPES[ext] ?? "application/octet-stream" };
}
/** The name with the file's real extension ("Promo final v3.mp4" for a GIF becomes "Promo final v3.gif"). */
export function withExt(name: string, ext: string): string {
  const stem = name.replace(/\.(mp4|gif|m4a|wav|mov)$/i, "");
  return `${stem}.${ext}`;
}

/** Starts the copy of a finished final. Asking again for the same folder and name while a copy is queued or running
 *  joins it (an AI checking on progress, a double click), so the file lands in Drive once. */
export async function queueDriveSave(renderId: string, d: DriveSave) {
  const r = await prisma.render.findUnique({ where: { id: renderId }, select: { driveSave: true } });
  const cur = r && driveSaveOf(r);
  const stem = (n: string) => n.replace(/\.(mp4|gif|m4a|wav|mov)$/i, "");
  const same = cur && cur.folderId === d.folderId && stem(cur.name) === stem(d.name);
  if (same && (cur.state === "queued" || cur.state === "saving") && Date.now() - cur.at < 30 * 60_000) return;
  await setDriveSave(renderId, { ...d, state: "queued", percent: 0, error: undefined, code: undefined, at: Date.now() });
  await enqueue<DriveSaveJob>("drive", { renderId }, { jobId: `drive-${renderId}-${Date.now()}` });
}
