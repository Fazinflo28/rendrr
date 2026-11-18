// Google Drive in the Library: one Drive file linked as a video, a whole Drive folder imported as library folders (the
// same tree, its videos linked), and a folder kept in step with Drive: videos put in the Drive folder later come in on
// their own (when the folder is opened, when the AI lists or edits it, and every few minutes on the server). A sync
// only adds: a video already in the library stays where the user put it, and nothing is removed.
import { AppError, drive, enqueue, redis, type ProxyJob } from "@rendrr/core";
import { prisma, type LibraryFolder } from "@rendrr/db";
import { LIBRARY_FOLDER_MAX_DEPTH, orientationOf, type VideoKind } from "@rendrr/shared";
import { createLibraryFolder, folderTree, freeFolderName, libraryFolderFull, ownLibraryFolder } from "./libraryFolders";

const ART = ["c", "d", "e", "f", "a", "b"];
const randomArt = () => ART[Math.floor(Math.random() * ART.length)];
const stripExt = (n: string) => n.replace(/\.[^.]+$/, "");
/** The most videos one import or sync brings in (the rest come with the next sync). */
export const DRIVE_FOLDER_MAX_FILES = 200;
/** A folder is looked at again after this long when opened or listed; the server's own sweep uses DRIVE_SWEEP_AGE_MS. */
export const DRIVE_SYNC_FRESH_MS = 2 * 60_000;
export const DRIVE_SWEEP_AGE_MS = 10 * 60_000;

export async function driveConn(userId: string) {
  const c = await prisma.driveConnection.findUnique({ where: { userId } });
  if (!c || c.stub) throw new AppError("Connect Google Drive first.", 400, "drive");
  return c;
}

/** One Drive file linked as a video (its preview made by the worker), in a library folder or none. */
export async function linkDriveFile(userId: string, f: drive.DriveFile & { sampleKey?: string }, o: { stub: boolean; kind?: VideoKind | null; libraryFolderId?: string | null }) {
  await forgetRemoved(userId, [f.id]); // picked again: folder syncs may bring it back after a later delete as before
  const v = await prisma.video.create({ data: {
    userId, name: stripExt(f.name), seconds: f.seconds, sizeBytes: BigInt(f.sizeBytes || 0), originalSize: BigInt(f.sizeBytes || 0), originalName: f.name,
    orientation: f.width && f.height ? orientationOf(f.width, f.height) : "Landscape", source: "drive", driveFileId: f.id, status: "linking", art: randomArt(), kind: o.kind || "footage", libraryFolderId: o.libraryFolderId ?? null,
    sourceKey: o.stub ? f.sampleKey ?? null : null,
  } });
  await enqueue<ProxyJob>("proxy", { videoId: v.id });
  return v;
}

/** A new library folder inside `parentId`, named `name` or, when a folder next to it has that name, told apart from it
 *  ("B-roll (Client B)", "B-roll (2)"): a folder added is never mixed into another that only has the same name. */
export async function newFolder(userId: string, name: string, parentId: string | null, hint?: () => Promise<string | null>) {
  return createLibraryFolder(userId, await freeFolderName(userId, name, parentId, hint), parentId);
}

/** The library folder for a Drive folder inside `parentId`: the one linked to that same Drive folder (importing or
 *  syncing it again fills it), else a new one. Another client's Drive folder of the same name gets its own. */
async function folderFor(userId: string, node: { id: string; name: string }, parentId: string | null, hint?: () => Promise<string | null>) {
  const linked = await prisma.libraryFolder.findFirst({ where: { userId, parentId, driveFolderId: node.id }, orderBy: { createdAt: "asc" } });
  if (linked) return { folder: linked, made: false };
  const f = await newFolder(userId, node.name, parentId, hint);
  return { folder: await prisma.libraryFolder.update({ where: { id: f.id }, data: { driveFolderId: node.id } }), made: true };
}

type Walked = Awaited<ReturnType<typeof drive.walkFolder>>;
/** The user's Drive files already in the library (any folder), by Drive file id. */
/** A Drive video or folder the user deleted from the library: folder syncs leave it out from now on. */
export async function rememberRemoved(userId: string, itemId: string | null | undefined) {
  if (!itemId) return;
  await prisma.driveRemoved.upsert({ where: { userId_itemId: { userId, itemId } }, create: { userId, itemId }, update: {} });
}
/** Brought in again on purpose (picked, or its folder imported again): no longer left out. */
async function forgetRemoved(userId: string, itemIds: string[]) {
  if (itemIds.length) await prisma.driveRemoved.deleteMany({ where: { userId, itemId: { in: itemIds } } });
}
const treeIds = (n: drive.DriveTree): string[] => [n.id, ...n.files.map((f) => f.id), ...n.folders.flatMap(treeIds)];

/** The user's Drive files in the library, in the Trash too (a live one wins over a trashed one), by Drive file id. */
async function linkedFiles(userId: string) {
  const rows = await prisma.video.findMany({ where: { userId, source: "drive", status: { not: "missing" }, driveFileId: { not: null } }, select: { id: true, driveFileId: true, deletedAt: true }, orderBy: { deletedAt: { sort: "desc", nulls: "last" } } });
  return new Map(rows.map((v) => [v.driveFileId!, { id: v.id, trashed: !!v.deletedAt }]));
}

/**
 * Puts a walked Drive tree into the Library under `parentId`. moveExisting: a video already in the library is moved
 * into its folder, and one in the Trash brought back into it (an import: the user asked for this folder); a sync
 * leaves both where they are.
 */
async function place(userId: string, walked: Walked, parentId: string | null, o: { stub: boolean; kind?: VideoKind | null; moveExisting: boolean; root?: LibraryFolder; hint?: () => Promise<string | null> }) {
  const linked = await linkedFiles(userId);
  let added = 0, moved = 0, made = 0, restored = 0;
  const put = async (node: drive.DriveTree, parent: string | null, root: boolean): Promise<string> => {
    const { folder, made: isNew } = root && o.root ? { folder: o.root, made: false } : await folderFor(userId, node, parent, root ? o.hint : undefined);
    if (isNew) made++;
    for (const f of node.files) {
      const have = linked.get(f.id);
      if (have?.trashed) {
        if (o.moveExisting) { await prisma.video.update({ where: { id: have.id }, data: { deletedAt: null, libraryFolderId: folder.id } }); have.trashed = false; restored++; }
        continue;
      }
      if (have) {
        if (o.moveExisting) { await prisma.video.update({ where: { id: have.id }, data: { libraryFolderId: folder.id } }); moved++; }
        continue;
      }
      const full = o.stub ? await drive.getFile(userId, f.id, true) : f; // the fake Drive keeps its sample file on the file
      const v = await linkDriveFile(userId, full ?? f, { stub: o.stub, kind: o.kind, libraryFolderId: folder.id });
      linked.set(f.id, { id: v.id, trashed: false }); added++;
    }
    for (const sub of node.folders) await put(sub, folder.id, false);
    return folder.id;
  };
  const topId = await put(walked.tree, parentId, true);
  return { topId, added, moved, made, restored };
}

/**
 * A whole Drive folder: a library folder of its own named after it (another client's folder of the same name gets its
 * own: "B-roll (Client B)"; the same Drive folder imported again fills the one it made), every video in it linked, its
 * folders made the same way down (up to 200 videos and the library's depth). A video already in the library is moved
 * into its folder, not linked twice, and one in the Trash comes back into it. The folder stays linked to Drive: new
 * videos put there later come in by themselves.
 */
export async function importDriveFolder(userId: string, b: { folderId: string; driveId?: string; name?: string; kind?: VideoKind | null; libraryFolderId?: string | null; subfolders?: boolean }) {
  const conn = await driveConn(userId);
  const parent = b.libraryFolderId ? await ownLibraryFolder(userId, b.libraryFolderId) : null;
  const depthLeft = LIBRARY_FOLDER_MAX_DEPTH - (parent ? (await folderTree(userId)).depth(parent) : 0);
  if (depthLeft < 1) throw new AppError("That folder is as deep as folders go. Import into a folder higher up.", 400, "too-deep");
  const name = (b.name || "").trim() || (await drive.folderName(userId, b.folderId, conn.stub));
  const walked = await drive.walkFolder(userId, { id: b.folderId, name, driveId: b.driveId }, conn.stub, { maxDepth: b.subfolders === false ? 1 : depthLeft, maxFiles: DRIVE_FOLDER_MAX_FILES });
  if (!walked.files) throw new AppError(`"${name}" has no videos${b.subfolders === false || !walked.folders ? "" : ", its folders neither"}.`, 400, "folder-empty");
  await forgetRemoved(userId, treeIds(walked.tree)); // imported on purpose: what was deleted from it before comes back
  const r = await place(userId, walked, parent?.id ?? null, { stub: conn.stub, kind: b.kind, moveExisting: true, hint: () => drive.parentFolderName(userId, b.folderId, conn.stub) });
  await prisma.libraryFolder.update({ where: { id: r.topId }, data: { driveFolderId: b.folderId, driveId: b.driveId ?? null, driveKind: b.kind ?? "footage", driveSubfolders: b.subfolders !== false, driveSyncedAt: new Date() } });
  return { folder: await libraryFolderFull(userId, r.topId), added: r.added, moved: r.moved, restored: r.restored, folders: r.made, truncated: walked.truncated };
}

/** The import a folder belongs to: itself or the nearest folder above it that was imported from Drive (its subfolders
 *  sync with it). */
async function syncRoot(userId: string, f: LibraryFolder): Promise<LibraryFolder | null> {
  if (f.driveFolderId && f.driveKind) return f;
  const t = await folderTree(userId);
  for (let p = t.parentOf(f); p; p = t.parentOf(p)) if (p.driveFolderId && p.driveKind) return p;
  return null;
}

export type SyncResult = { folderId: string; name: string; added: number; folders: number; truncated: boolean; skipped?: "fresh" | "busy" | "no-drive" | "gone"; error?: string };

/**
 * A linked folder brought up to date with its Drive folder: the videos put there since come in, new Drive folders
 * become library folders. `fresh`: a folder looked at less than that long ago is left alone (opening the Library,
 * listing it for the AI). One sync of a folder at a time.
 */
export async function syncDriveFolder(userId: string, libraryFolderId: string, o: { fresh?: number } = {}): Promise<SyncResult> {
  const f0 = await ownLibraryFolder(userId, libraryFolderId);
  const f = await syncRoot(userId, f0);
  if (!f?.driveFolderId) throw new AppError(`"${f0.name}" is not linked to a Google Drive folder (only folders imported from Drive are).`, 400, "not-linked");
  const out: SyncResult = { folderId: f.id, name: f.name, added: 0, folders: 0, truncated: false };
  if (o.fresh && f.driveSyncedAt && Date.now() - f.driveSyncedAt.getTime() < o.fresh) return { ...out, skipped: "fresh" };
  const conn = await prisma.driveConnection.findUnique({ where: { userId } });
  if (!conn || conn.stub) return { ...out, skipped: "no-drive" };
  const lock = `drive-sync:${f.id}`;
  if (!(await redis().set(lock, "1", "PX", 5 * 60_000, "NX"))) return { ...out, skipped: "busy" };
  try {
    const t = await folderTree(userId);
    const depthLeft = LIBRARY_FOLDER_MAX_DEPTH - t.depth(f) + 1;
    const walked = await drive.walkFolder(userId, { id: f.driveFolderId, name: f.name, driveId: f.driveId ?? undefined }, conn.stub, { maxDepth: f.driveSubfolders ? Math.max(1, depthLeft) : 1, maxFiles: 2000 });
    // Only the new ones count against the limit: a folder of 300 videos already in keeps syncing its new ones.
    const linked = await linkedFiles(userId);
    // Videos and folders the user deleted from the library stay out: a sync never brings them back.
    const removed = new Set((await prisma.driveRemoved.findMany({ where: { userId }, select: { itemId: true } })).map((x) => x.itemId));
    let room = DRIVE_FOLDER_MAX_FILES;
    const take = () => (room > 0 ? (room--, true) : false);
    const trim = (n: drive.DriveTree): drive.DriveTree => ({ ...n, files: n.files.filter((x) => linked.has(x.id) || (!removed.has(x.id) && take())), folders: n.folders.filter((x) => !removed.has(x.id)).map(trim) });
    const tree = trim(walked.tree);
    const r = await place(userId, { ...walked, tree }, f.parentId, { stub: conn.stub, kind: (f.driveKind as VideoKind | null) ?? "footage", moveExisting: false, root: f });
    await prisma.libraryFolder.update({ where: { id: f.id }, data: { driveSyncedAt: new Date() } });
    return { ...out, added: r.added, folders: r.made, truncated: walked.truncated || room <= 0 };
  } catch (e) {
    // Drive said the folder is gone (deleted, or no longer shared): kept as it is, said once.
    const msg = (e as Error).message || "";
    if (/not ?found|404/i.test(msg)) return { ...out, skipped: "gone", error: "The Google Drive folder is gone or no longer shared with you." };
    throw e;
  } finally { await redis().del(lock).catch(() => {}); }
}

/** Every linked folder of a user (or of every user) not synced for `age`: brought up to date, one after another. */
export async function syncStaleDriveFolders(o: { userId?: string; age: number; limit?: number }): Promise<SyncResult[]> {
  const before = new Date(Date.now() - o.age);
  const roots = await prisma.libraryFolder.findMany({
    where: { ...(o.userId ? { userId: o.userId } : {}), driveFolderId: { not: null }, driveKind: { not: null }, OR: [{ driveSyncedAt: null }, { driveSyncedAt: { lt: before } }], user: { drive: { is: { stub: false } } } },
    orderBy: { driveSyncedAt: { sort: "asc", nulls: "first" } }, take: o.limit ?? 50, select: { id: true, userId: true },
  });
  const out: SyncResult[] = [];
  for (const r of roots) {
    try { out.push(await syncDriveFolder(r.userId, r.id)); }
    catch (e) {
      out.push({ folderId: r.id, name: "", added: 0, folders: 0, truncated: false, error: (e as Error).message.slice(0, 200) });
      // A folder that cannot be synced is not looked at again on every sweep.
      await prisma.libraryFolder.update({ where: { id: r.id }, data: { driveSyncedAt: new Date() } }).catch(() => {});
    }
  }
  return out;
}

/** What a sync did, in a few words for the AI and the editor. */
export const syncText = (s: SyncResult) => s.error ? `Google Drive: ${s.error}` : s.skipped === "no-drive" ? "Google Drive is not connected, so the folder was not checked for new videos." : s.added || s.folders ? `${s.added} new ${s.added === 1 ? "video" : "videos"} from its Google Drive folder${s.folders ? ` (${s.folders} new ${s.folders === 1 ? "folder" : "folders"})` : ""}${s.truncated ? "; more come with the next sync" : ""}.` : "";
