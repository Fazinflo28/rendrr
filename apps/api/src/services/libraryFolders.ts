// Library folders: the user keeps videos of one kind together (all the parts of a course, a client's interviews) and
// can send a whole folder to a new edit. A folder only groups videos; deleting it leaves its videos in the library.
import { AppError, notFound } from "@rendrr/core";
import { prisma, type LibraryFolder, type Video } from "@rendrr/db";
import { LIBRARY_FOLDER_MAX_VIDEOS } from "@rendrr/shared";
import { createProject } from "./projects";

export function libraryFolderOut(f: LibraryFolder, count = 0, seconds = 0) {
  return { id: f.id, name: f.name, count, seconds: Math.round(seconds * 100) / 100, updated: f.updatedAt.getTime() };
}

/** Name order that reads like a person would sort ("Part 2" before "Part 10"). */
export const byName = (a: { name: string; createdAt: Date }, b: { name: string; createdAt: Date }) =>
  a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }) || a.createdAt.getTime() - b.createdAt.getTime();

export async function listLibraryFolders(userId: string) {
  const fs = await prisma.libraryFolder.findMany({ where: { userId }, orderBy: { name: "asc" } });
  const stats = await prisma.video.groupBy({ by: ["libraryFolderId"], where: { userId, libraryFolderId: { not: null }, kind: { not: "canvas" } }, _count: { _all: true }, _sum: { seconds: true } });
  const by = new Map(stats.map((s) => [s.libraryFolderId, s]));
  return fs.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }))
    .map((f) => libraryFolderOut(f, by.get(f.id)?._count._all ?? 0, by.get(f.id)?._sum.seconds ?? 0));
}

export async function ownLibraryFolder(userId: string, id: string): Promise<LibraryFolder> {
  const f = await prisma.libraryFolder.findUnique({ where: { id } });
  if (!f || f.userId !== userId) throw notFound("That folder is not in your library any more.");
  return f;
}

/** A folder by its id or its name (the connector lets Claude say either). */
export async function findLibraryFolder(userId: string, ref: string): Promise<LibraryFolder | null> {
  const r = ref.trim();
  const byId = await prisma.libraryFolder.findUnique({ where: { id: r } });
  if (byId && byId.userId === userId) return byId;
  return prisma.libraryFolder.findFirst({ where: { userId, name: { equals: r, mode: "insensitive" } }, orderBy: { createdAt: "asc" } });
}

export async function createLibraryFolder(userId: string, name: string): Promise<LibraryFolder> {
  const n = name.trim();
  const same = await prisma.libraryFolder.findFirst({ where: { userId, name: { equals: n, mode: "insensitive" } } });
  if (same) throw new AppError(`You already have a folder called "${same.name}".`, 409, "folder-exists");
  return prisma.libraryFolder.create({ data: { userId, name: n } });
}

export async function renameLibraryFolder(userId: string, id: string, name: string): Promise<LibraryFolder> {
  const f = await ownLibraryFolder(userId, id);
  const n = name.trim();
  const same = await prisma.libraryFolder.findFirst({ where: { userId, id: { not: f.id }, name: { equals: n, mode: "insensitive" } } });
  if (same) throw new AppError(`You already have a folder called "${same.name}".`, 409, "folder-exists");
  return prisma.libraryFolder.update({ where: { id: f.id }, data: { name: n } });
}

/** The folder goes; its videos stay in the library, loose. */
export async function deleteLibraryFolder(userId: string, id: string) {
  const f = await ownLibraryFolder(userId, id);
  const { count } = await prisma.video.updateMany({ where: { userId, libraryFolderId: f.id }, data: { libraryFolderId: null } });
  await prisma.libraryFolder.delete({ where: { id: f.id } });
  return { ok: true, moved: count };
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

/** The videos a folder sends to an edit: its ready footage, in name order. What is left out, and why. */
export async function folderFootage(userId: string, f: LibraryFolder) {
  const all = (await prisma.video.findMany({ where: { userId, libraryFolderId: f.id, kind: { not: "canvas" } }, include: { analysis: { select: { videoId: true } } } })).sort(byName);
  const use: Video[] = [], skipped: { id: string; name: string; why: string }[] = [];
  for (const v of all) {
    if (v.kind === "reference") skipped.push({ id: v.id, name: v.name, why: "a reference (a style to copy), not footage" });
    else if (v.status !== "ready" || !v.analysis) skipped.push({ id: v.id, name: v.name, why: "not ready yet" });
    else use.push(v);
  }
  return { all, use, skipped };
}

/** One new edit from every ready video in the folder, in name order (the first is the edit's footage). */
export async function projectFromLibraryFolder(userId: string, folderId: string, input: { name?: string | null; folderId?: string | null; aspect?: string } = {}, opts: { actorKind?: "user" | "claude" | "chatgpt"; folder?: LibraryFolder } = {}) {
  const f = opts.folder ?? (await ownLibraryFolder(userId, folderId));
  const { all, use, skipped } = await folderFootage(userId, f);
  if (!all.length) throw new AppError(`"${f.name}" is empty. Add videos to it first.`, 400, "folder-empty");
  if (!use.length) throw new AppError(`None of the videos in "${f.name}" can be edited yet: ${skipped.slice(0, 3).map((s) => `"${s.name}" is ${s.why}`).join("; ")}${skipped.length > 3 ? "; …" : ""}.`, 409, "not-ready");
  if (use.length > LIBRARY_FOLDER_MAX_VIDEOS) throw new AppError(`"${f.name}" has ${use.length} videos ready; an edit starts from up to ${LIBRARY_FOLDER_MAX_VIDEOS}. Move some into another folder, or select the ones you want.`, 400, "too-many");
  const p = await createProject(userId, { videoIds: use.map((v) => v.id), name: (input.name || "").trim() || f.name, folderId: input.folderId, aspect: input.aspect }, { actorKind: opts.actorKind });
  return { project: p, folder: f, videos: use, skipped };
}
