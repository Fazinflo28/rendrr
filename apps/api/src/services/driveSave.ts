import { AppError, drive, driveSaveOf, features, queueDriveSave, rememberPreset, setDriveSave, withExt, type DriveSave } from "@rendrr/core";
import { prisma, type Render } from "@rendrr/db";
import { formatFile, type ExportFormat } from "@rendrr/shared";
import { renderResult } from "./render";

// A final saved into the user's Google Drive, in the folder they named (save_to_drive, render_final driveFolder): the
// folder is found (or made) and checked when asked, so a wrong name or a refused folder is said at once; the copy
// runs on the worker when the final is ready.

const WEB = () => (process.env.PUBLIC_WEB_URL || "").replace(/\/$/, "");

/** What the AI tells the user when Google refuses a folder (Rendrr's access adds files only to folders it made). */
export const allowSavingText = () =>
  `Rendrr's Google Drive access lets it add files only to folders it made itself. To save into the user's own folders, the user allows it once in Rendrr: Settings › Google Drive › Allow saving to my folders (${WEB()}/settings). Until then, save to My Drive (no driveFolder) or into a new folder at the top of My Drive (a new name with createFolders: true).`;

/** The Drive folder to save into, found, made when asked, and checked: Google is asked whether Rendrr may add a file there. */
export async function driveTarget(userId: string, folder: string | undefined, create: boolean | undefined) {
  if (!features().drive) throw new AppError("Saving to Google Drive is not switched on in Rendrr yet (it needs Google keys).", 409, "drive-off");
  const conn = await prisma.driveConnection.findUnique({ where: { userId } });
  if (!conn || conn.stub) throw new AppError(`Google Drive is not connected. The user connects it once in Rendrr: Settings › Google Drive › Connect (${WEB()}/settings).`, 409, "drive");
  const t = await drive.resolveFolder(userId, folder, { create });
  await drive.checkCanSave(userId, t);
  return t;
}

/** "Cold Outreaching final v19.mp4" by default; a name the user gave gets the final's extension (the worker sets the
 *  real one from the file when it saves: a GIF or sound-only final is not an .mp4). */
export const fileNameFor = (given: string | undefined, fallback: string) => {
  const n = (given || "").replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 180);
  const ext = fallback.match(/\.(\w+)$/)?.[1] || "mp4";
  return n ? withExt(n, ext) : fallback;
};

/** Asks for the copy: now when the final is done, else when it finishes. */
export async function askDriveSave(r: Render, t: drive.DriveTarget, name: string) {
  const d: DriveSave = { state: "waiting", folderId: t.id, ...(t.driveId ? { driveId: t.driveId } : {}), path: t.path, name, ...(t.made.length ? { made: t.made } : {}), at: Date.now() };
  if (r.status === "done") await queueDriveSave(r.id, d);
  else await setDriveSave(r.id, d);
  // Client presets (#24): the edit's folder remembers this Drive folder for its next finals.
  const p = await prisma.project.findUnique({ where: { id: r.projectId }, select: { folderId: true } }).catch(() => null);
  if (p) await rememberPreset(p.folderId, { drive: { folderId: t.id, path: t.path } });
  return d;
}

/** The copy's state as one line for the AI ("" when none was asked). */
export function driveLine(r: Render): string {
  const d = driveSaveOf(r);
  if (!d) return "";
  const where = `Google Drive › ${d.path}`;
  const made = d.made?.length ? ` (made ${d.made.map((x) => `"${x}"`).join(", ")})` : "";
  if (d.state === "waiting") return `When the final is done, Rendrr saves it to ${where} as "${d.name}"${made}.`;
  if (d.state === "queued") return `Saving to ${where} as "${d.name}"${made}: starting. get_render shows when it is there.`;
  if (d.state === "saving") return `Saving to ${where} as "${d.name}": ${d.percent ?? 0}%. get_render shows when it is there.`;
  if (d.state === "saved") return `Saved to ${where}/${d.name}${made}: ${d.link}`;
  return `Saving to ${where} failed: ${d.error || "unknown error"}${d.code === "drive-write" ? `\n${allowSavingText()}` : " Try save_to_drive again."}`;
}

/** The latest finished final of an edit (a version when given). */
export async function latestFinal(userId: string, projectId: string, version?: number, format?: string) {
  // A file type asked for: renders from before it was kept are told by their file's extension.
  const ext = format ? formatFile(format as ExportFormat).ext : null;
  const of = format ? { OR: [{ format }, { format: null, outputKey: { endsWith: `.${ext}` } }] } : {};
  return prisma.render.findFirst({ where: { projectId, userId, kind: "final", status: "done", outputKey: { not: null }, ...(version ? { version } : {}), ...of }, orderBy: { createdAt: "desc" } });
}

export { renderResult };
