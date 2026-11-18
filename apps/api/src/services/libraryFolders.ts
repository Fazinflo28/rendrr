// Library folders: the user keeps videos of one kind together (all the parts of a course, a client's interviews),
// folders inside folders (a course, then a folder per module), and can send a whole folder to a new edit. A folder only
// groups videos; deleting one moves what is in it up a level, so no video is lost.
import { AppError, notFound } from "@rendrr/core";
import { prisma, type LibraryFolder, type Video } from "@rendrr/db";
import { LIBRARY_FOLDER_MAX_DEPTH, LIBRARY_FOLDER_MAX_VIDEOS } from "@rendrr/shared";
import { createProject } from "./projects";

/** Name order that reads like a person would sort ("Part 2" before "Part 10"). */
const nameCmp = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
export const byName = (a: { name: string; createdAt: Date }, b: { name: string; createdAt: Date }) => nameCmp(a.name, b.name) || a.createdAt.getTime() - b.createdAt.getTime();

/** Every folder of the user, with each one's place in the tree. */
export async function folderTree(userId: string) {
  const all = await prisma.libraryFolder.findMany({ where: { userId } });
  const byId = new Map(all.map((f) => [f.id, f]));
  const kids = new Map<string | null, LibraryFolder[]>();
  for (const f of all) {
    const p = f.parentId && byId.has(f.parentId) ? f.parentId : null; // a parent that is gone: treat as the top
    kids.set(p, [...(kids.get(p) ?? []), f]);
  }
  for (const list of kids.values()) list.sort(byName);
  const parentOf = (f: LibraryFolder) => (f.parentId && byId.has(f.parentId) ? byId.get(f.parentId)! : null);
  const chain = (f: LibraryFolder): LibraryFolder[] => { const out = [f]; const seen = new Set([f.id]); let p = parentOf(f); while (p && !seen.has(p.id)) { out.unshift(p); seen.add(p.id); p = parentOf(p); } return out; };
  const path = (f: LibraryFolder) => chain(f).map((x) => x.name).join(" / ");
  const depth = (f: LibraryFolder) => chain(f).length; // 1 at the top
  const childrenOf = (id: string | null) => kids.get(id) ?? [];
  /** The folder and every folder inside it, the folder first, then each subfolder in name order, depth first. */
  const subtree = (f: LibraryFolder): LibraryFolder[] => [f, ...childrenOf(f.id).flatMap(subtree)];
  const height = (f: LibraryFolder): number => 1 + Math.max(0, ...childrenOf(f.id).map(height));
  return { all, byId, childrenOf, path, depth, subtree, height, parentOf };
}
type Tree = Awaited<ReturnType<typeof folderTree>>;

export async function listLibraryFolders(userId: string) {
  const t = await folderTree(userId);
  const stats = await prisma.video.groupBy({ by: ["libraryFolderId"], where: { userId, libraryFolderId: { not: null }, kind: { not: "canvas" }, deletedAt: null }, _count: { _all: true }, _sum: { seconds: true } });
  const by = new Map(stats.map((s) => [s.libraryFolderId, { count: s._count._all, seconds: s._sum.seconds ?? 0 }]));
  const out = t.all.map((f) => {
    const own = by.get(f.id) ?? { count: 0, seconds: 0 };
    const tot = t.subtree(f).reduce((a, x) => { const s = by.get(x.id); return s ? { count: a.count + s.count, seconds: a.seconds + s.seconds } : a; }, { count: 0, seconds: 0 });
    return libraryFolderOut(f, t, own, tot);
  });
  return out.sort((a, b) => nameCmp(a.path, b.path));
}

export function libraryFolderOut(f: LibraryFolder, t?: Tree, own = { count: 0, seconds: 0 }, total = own) {
  return {
    id: f.id, name: f.name, parentId: (t ? t.parentOf(f)?.id : f.parentId) ?? null, path: t ? t.path(f) : f.name,
    count: own.count, seconds: Math.round(own.seconds * 100) / 100, folders: t ? t.childrenOf(f.id).length : 0,
    total: total.count, totalSeconds: Math.round(total.seconds * 100) / 100, updated: f.updatedAt.getTime(),
    // Imported from a Google Drive folder (kept in step with it): the import's top folder says when it was last looked at.
    drive: f.driveFolderId ? { top: !!f.driveKind, syncedAt: f.driveSyncedAt ? f.driveSyncedAt.getTime() : null } : null,
  };
}
export async function libraryFolderFull(userId: string, id: string) {
  return (await listLibraryFolders(userId)).find((x) => x.id === id)!;
}

export async function ownLibraryFolder(userId: string, id: string): Promise<LibraryFolder> {
  const f = await prisma.libraryFolder.findUnique({ where: { id } });
  if (!f || f.userId !== userId) throw notFound("That folder is not in your library any more.");
  return f;
}

/** A folder by its id, its path ("Course / Module 1" or "Course/Module 1") or its name (the connector lets Claude say
 *  any). A name two folders share is refused, naming both paths. */
export async function findLibraryFolder(userId: string, ref: string): Promise<LibraryFolder | null> {
  const r = ref.trim();
  const byId = await prisma.libraryFolder.findUnique({ where: { id: r } });
  if (byId && byId.userId === userId) return byId;
  const t = await folderTree(userId);
  const parts = r.split("/").map((x) => x.trim()).filter(Boolean);
  if (parts.length > 1) {
    let level: LibraryFolder | null = null;
    for (const p of parts) { const next: LibraryFolder | undefined = t.childrenOf(level ? level.id : null).find((f) => f.name.toLowerCase() === p.toLowerCase()); if (!next) return null; level = next; }
    return level;
  }
  const same = t.all.filter((f) => f.name.toLowerCase() === r.toLowerCase());
  if (same.length > 1) throw new AppError(`More than one folder is called "${r}": ${same.map((f) => `"${t.path(f)}"`).join(", ")}. Say which with its path or id.`, 400, "ambiguous-folder");
  return same[0] ?? null;
}

async function checkSiblingName(userId: string, name: string, parentId: string | null, except?: string) {
  const same = await prisma.libraryFolder.findFirst({ where: { userId, parentId, name: { equals: name, mode: "insensitive" }, ...(except ? { id: { not: except } } : {}) } });
  if (same) throw new AppError(`${parentId ? "That folder already has a folder" : "You already have a folder"} called "${same.name}".`, 409, "folder-exists");
}

export async function createLibraryFolder(userId: string, name: string, parentId?: string | null): Promise<LibraryFolder> {
  const n = name.trim();
  const parent = parentId ? await ownLibraryFolder(userId, parentId) : null;
  if (parent) {
    const t = await folderTree(userId);
    if (t.depth(parent) >= LIBRARY_FOLDER_MAX_DEPTH) throw new AppError(`Folders go ${LIBRARY_FOLDER_MAX_DEPTH} levels deep at most; "${t.path(parent)}" is as deep as they go.`, 400, "too-deep");
  }
  await checkSiblingName(userId, n, parent?.id ?? null);
  const f = await prisma.libraryFolder.create({ data: { userId, name: n, parentId: parent?.id ?? null } });
  if (parent) await prisma.libraryFolder.update({ where: { id: parent.id }, data: { updatedAt: new Date() } });
  return f;
}

/** A name no folder next to it has, for a folder added from Drive or the computer (never mixed into one that only has
 *  the same name): the name itself, else "name (hint)" (the Drive folder it sits in, so two clients' "B-roll" folders
 *  are told apart), else "name (2)", "name (3)"... */
export async function freeFolderName(userId: string, name: string, parentId: string | null, hint?: () => Promise<string | null>) {
  const base = name.replace(/\//g, "-").trim().slice(0, 80) || "Untitled folder";
  const taken = new Set((await prisma.libraryFolder.findMany({ where: { userId, parentId }, select: { name: true } })).map((f) => f.name.toLowerCase()));
  if (!taken.has(base.toLowerCase())) return base;
  const h = (await hint?.().catch(() => null))?.replace(/\//g, "-").trim().slice(0, 40);
  if (h && h.toLowerCase() !== base.toLowerCase() && !taken.has(`${base} (${h})`.toLowerCase())) return `${base} (${h})`;
  for (let n = 2; ; n++) if (!taken.has(`${base} (${n})`.toLowerCase())) return `${base} (${n})`;
}

/** A folder from a path, making the levels that are not there yet ("Course/Module 1"). */
export async function ensureLibraryFolderPath(userId: string, path: string): Promise<{ folder: LibraryFolder; made: number }> {
  const parts = path.split("/").map((x) => x.trim()).filter(Boolean);
  if (!parts.length) throw new AppError("Give the folder a name.", 400, "invalid-input");
  if (parts.length > LIBRARY_FOLDER_MAX_DEPTH) throw new AppError(`Folders go ${LIBRARY_FOLDER_MAX_DEPTH} levels deep at most.`, 400, "too-deep");
  let parent: LibraryFolder | null = null, made = 0;
  for (const p of parts) {
    const found: LibraryFolder | null = await prisma.libraryFolder.findFirst({ where: { userId, parentId: parent ? (parent as LibraryFolder).id : null, name: { equals: p, mode: "insensitive" } }, orderBy: { createdAt: "asc" } });
    if (found) { parent = found; continue; }
    parent = await createLibraryFolder(userId, p.slice(0, 80), parent ? (parent as LibraryFolder).id : null);
    made++;
  }
  return { folder: parent!, made };
}

/** Rename a folder, or move it inside another (null: to the top). Never into itself or a folder inside it. */
export async function updateLibraryFolder(userId: string, id: string, b: { name?: string; parentId?: string | null }): Promise<LibraryFolder> {
  const f = await ownLibraryFolder(userId, id);
  const name = b.name !== undefined ? b.name.trim() : f.name;
  let parentId = f.parentId;
  if (b.parentId !== undefined && b.parentId !== f.parentId) {
    const t = await folderTree(userId);
    const to = b.parentId ? await ownLibraryFolder(userId, b.parentId) : null;
    if (to && t.subtree(f).some((x) => x.id === to.id)) throw new AppError(`"${f.name}" cannot go inside ${to.id === f.id ? "itself" : `"${t.path(to)}", which is inside it`}.`, 400, "folder-loop");
    if (to && t.depth(to) + t.height(f) > LIBRARY_FOLDER_MAX_DEPTH) throw new AppError(`Folders go ${LIBRARY_FOLDER_MAX_DEPTH} levels deep at most; "${f.name}" and what is in it do not fit inside "${t.path(to)}".`, 400, "too-deep");
    parentId = to?.id ?? null;
  }
  await checkSiblingName(userId, name, parentId, f.id);
  return prisma.libraryFolder.update({ where: { id: f.id }, data: { name, parentId } });
}

/** The folder goes; its videos and subfolders move up into the folder it was in (or to the top of the library). */
export async function deleteLibraryFolder(userId: string, id: string) {
  const f = await ownLibraryFolder(userId, id);
  const up = f.parentId ?? null;
  const { count } = await prisma.video.updateMany({ where: { userId, libraryFolderId: f.id }, data: { libraryFolderId: up } });
  const subs = await prisma.libraryFolder.findMany({ where: { userId, parentId: f.id } });
  // A subfolder whose name its new neighbours already use gets "(2)" after it.
  for (const s of subs) {
    let name = s.name;
    for (let n = 2; await prisma.libraryFolder.findFirst({ where: { userId, parentId: up, id: { notIn: [f.id, s.id] }, name: { equals: name, mode: "insensitive" } } }); n++) name = `${s.name} (${n})`;
    await prisma.libraryFolder.update({ where: { id: s.id }, data: { parentId: up, name } });
  }
  await prisma.libraryFolder.delete({ where: { id: f.id } });
  // A folder that came from Google Drive: the sync of the folder above it must not make it again.
  if (f.driveFolderId) await prisma.driveRemoved.upsert({ where: { userId_itemId: { userId, itemId: f.driveFolderId } }, create: { userId, itemId: f.driveFolderId }, update: {} });
  return { ok: true, moved: count, folders: subs.length, to: up };
}

/** Put videos in a folder (null: take them out). Only the user's own videos and folders. */
export async function moveVideos(userId: string, videoIds: string[], folderId: string | null) {
  const f = folderId ? await ownLibraryFolder(userId, folderId) : null;
  const ids = Array.from(new Set(videoIds));
  const own = await prisma.video.findMany({ where: { id: { in: ids }, userId, kind: { not: "canvas" } }, select: { id: true } });
  if (own.length !== ids.length) throw new AppError(ids.length > 1 ? "Some of those videos are not in your library any more." : "That video is not in your library any more.", 404, "not-found");
  await prisma.video.updateMany({ where: { id: { in: ids }, userId }, data: { libraryFolderId: f?.id ?? null } });
  if (f) await prisma.libraryFolder.update({ where: { id: f.id }, data: { updatedAt: new Date() } });
  return { moved: ids.length, folder: f };
}

/** The videos a folder sends to an edit, subfolders included: the folder's own videos in name order, then each
 *  subfolder's (in name order, the same way down). Ready footage is used; what is left out says why. */
export async function folderFootage(userId: string, f: LibraryFolder) {
  const t = await folderTree(userId);
  const folders = t.subtree(f);
  const vids = await prisma.video.findMany({ where: { userId, libraryFolderId: { in: folders.map((x) => x.id) }, kind: { not: "canvas" }, deletedAt: null }, include: { analysis: { select: { videoId: true } } } });
  const rel = (x: LibraryFolder) => (x.id === f.id ? "" : t.path(x).slice(t.path(f).length + 3)); // "Module 1" under "Course"
  const all = folders.flatMap((x) => vids.filter((v) => v.libraryFolderId === x.id).sort(byName).map((v) => ({ ...v, folderPath: rel(x) })));
  const use: (Video & { folderPath: string })[] = [], skipped: { id: string; name: string; why: string }[] = [];
  for (const v of all) {
    if (v.kind === "reference") skipped.push({ id: v.id, name: v.name, why: "a reference (a style to copy), not footage" });
    else if (v.status !== "ready" || !v.analysis) skipped.push({ id: v.id, name: v.name, why: "not ready yet" });
    else use.push(v);
  }
  return { all, use, skipped, subfolders: folders.length - 1, path: t.path(f) };
}

/** One new edit from every ready video in the folder and its subfolders, in that order (the first is the footage). */
export async function projectFromLibraryFolder(userId: string, folderId: string, input: { name?: string | null; folderId?: string | null; aspect?: string } = {}, opts: { actorKind?: "user" | "claude" | "chatgpt"; folder?: LibraryFolder } = {}) {
  const f = opts.folder ?? (await ownLibraryFolder(userId, folderId));
  const { all, use, skipped, subfolders } = await folderFootage(userId, f);
  if (!all.length) throw new AppError(`"${f.name}" is empty${subfolders ? ", its folders too" : ""}. Add videos to it first.`, 400, "folder-empty");
  if (!use.length) throw new AppError(`None of the videos in "${f.name}" can be edited yet: ${skipped.slice(0, 3).map((s) => `"${s.name}" is ${s.why}`).join("; ")}${skipped.length > 3 ? "; …" : ""}.`, 409, "not-ready");
  if (use.length > LIBRARY_FOLDER_MAX_VIDEOS) throw new AppError(`"${f.name}" has ${use.length} videos ready${subfolders ? " with its folders" : ""}; an edit starts from up to ${LIBRARY_FOLDER_MAX_VIDEOS}. Edit one of its folders, move some out, or select the ones you want.`, 400, "too-many");
  const p = await createProject(userId, { videoIds: use.map((v) => v.id), name: (input.name || "").trim() || f.name, folderId: input.folderId, aspect: input.aspect }, { actorKind: opts.actorKind });
  return { project: p, folder: f, videos: use, skipped, subfolders };
}
