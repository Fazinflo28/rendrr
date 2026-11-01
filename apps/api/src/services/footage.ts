// Footage the AI brings in from the chat (add_footage): a video or an image the user gave it (attached to the chat, a
// share link, a file in their Google Drive) goes into their library, and into an edit's Media panel when asked. The file
// is kept by Rendrr as the raw (source "upload"; there is no Drive or computer copy to go back to), its preview made by
// the worker. An image becomes a still clip (STILL_SECONDS) so it plays anywhere a video does.
import { AppError, applyTimelineChange, drive, enqueue, env, features, redis, uploadFile, type ChangeActor, type ProxyJob } from "@rendrr/core";
import { prisma, type Video } from "@rendrr/db";
import { FOOTAGE_UPLOAD_MAX_BYTES, IMAGE_MAX_BYTES, PREFIX, STILL_SECONDS, type VideoKind } from "@rendrr/shared";
import { randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdtemp, open, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { linkDriveFile } from "./driveLibrary";
import { fetchPublicTo } from "./fetchPublic";
import { ensureLibraryFolderPath, findLibraryFolder } from "./libraryFolders";
import { driveIdOf } from "./luts";

const err = (m: string) => new AppError(m, 400, "bad-footage");
const UPLOAD_SECONDS = 30 * 60;
const uploadKey = (t: string) => `footage-upload:${t}`;
const ART = ["c", "d", "e", "f", "a", "b"];
const GB = (n: number) => `${Math.round(n / 1024 / 1024 / 1024)} GB`;
const MB = (n: number) => `${Math.round(n / 1024 / 1024)} MB`;

export type FootageOpts = { name?: string | null; kind?: VideoKind | null; libraryFolder?: string | null; projectId?: string | null; ai?: "claude" | "chatgpt"; aiName?: string };

/** What a file is, from its first bytes: an image (its type) or, failing that, taken as a video (the worker checks it). */
export function sniff(head: Buffer): { image: false } | { image: true; ext: string; type: string } {
  const s = (a: number, b: number) => head.subarray(a, b).toString("latin1");
  if (head[0] === 0x89 && s(1, 4) === "PNG") return { image: true, ext: "png", type: "image/png" };
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return { image: true, ext: "jpg", type: "image/jpeg" };
  if (s(0, 4) === "RIFF" && s(8, 12) === "WEBP") return { image: true, ext: "webp", type: "image/webp" };
  if (s(0, 4) === "GIF8") return { image: true, ext: "gif", type: "image/gif" };
  if (s(4, 12) === "ftypavif" || s(4, 12) === "ftypheic" || s(4, 12) === "ftypmif1") throw err("HEIC and AVIF pictures are not taken yet: send it as a JPEG or PNG.");
  return { image: false };
}
const videoExt = (name: string) => (/\.(mp4|mov|m4v|webm|mkv|avi|mts|m2ts|3gp|wmv|mpg|mpeg)$/i.exec(name)?.[1] ?? "mp4").toLowerCase();
const nameOf = (raw: string | null | undefined, fallback: string) => (raw || "").replace(/\.[a-z0-9]{2,5}$/i, "").replace(/[\u0000-\u001f]/g, " ").trim().slice(0, 200) || fallback;

/** The library folder asked for (id, name or path; a path not there yet is made), or none. */
async function folderOf(userId: string, ref?: string | null): Promise<string | null> {
  if (!ref?.trim()) return null;
  const f = await findLibraryFolder(userId, ref);
  if (f) return f.id;
  if (/^c[a-z0-9]{20,}$/.test(ref.trim())) throw new AppError("That library folder is not there any more. list_footage lists them.", 404, "not-found");
  return (await ensureLibraryFolderPath(userId, ref)).folder.id;
}

/** Puts a video (any status) in an edit's Media panel, as the AI's change (one version with the rest of its change). */
export async function intoEdit(userId: string, projectId: string, videoId: string, o: FootageOpts) {
  const actor: ChangeActor = { kind: o.ai === "chatgpt" ? "chatgpt" : "claude", userId, ai: o.aiName, toolName: "add_footage", input: { videoId } };
  await applyTimelineChange(projectId, { op: "add_media", videoIds: [videoId] }, actor);
}

/** A file on disk kept as the user's footage: stored as sent (the raw), its preview made by the worker. */
export async function keepFootage(userId: string, path: string, name: string, o: FootageOpts): Promise<Video> {
  const size = (await stat(path)).size;
  if (!size) throw err("The file is empty.");
  const fh = await open(path, "r");
  const head = Buffer.alloc(16);
  try { await fh.read(head, 0, 16, 0); } finally { await fh.close(); }
  const kind = sniff(head);
  if (kind.image && size > IMAGE_MAX_BYTES) throw err(`Pictures are ${MB(IMAGE_MAX_BYTES)} at most.`);
  if (!kind.image && size > FOOTAGE_UPLOAD_MAX_BYTES) throw err(`Videos are ${GB(FOOTAGE_UPLOAD_MAX_BYTES)} at most this way: put it in Google Drive and send its driveFileId (Drive files are linked, nothing is copied).`);
  if (o.projectId) await ownProject(userId, o.projectId);
  const libraryFolderId = await folderOf(userId, o.libraryFolder);
  const v = await prisma.video.create({ data: {
    userId, name: nameOf(o.name || name, kind.image ? "Picture" : "Video"), kind: o.kind || "footage", libraryFolderId, source: "upload", still: kind.image,
    status: "linking", progress: 0, sizeBytes: BigInt(size), originalSize: BigInt(size), originalName: name.slice(0, 300) || null, art: ART[Math.floor(Math.random() * ART.length)],
    ...(kind.image ? { seconds: STILL_SECONDS } : {}),
  } });
  const key = `${PREFIX.uploads}${userId}/${v.id}/source.${kind.image ? kind.ext : videoExt(name)}`;
  try {
    await uploadFile(key, path, kind.image ? kind.type : "application/octet-stream");
  } catch (e) { await prisma.video.delete({ where: { id: v.id } }).catch(() => {}); throw e; }
  const out = await prisma.video.update({ where: { id: v.id }, data: { sourceKey: key } });
  await enqueue<ProxyJob>("proxy", { videoId: v.id });
  if (o.projectId) await intoEdit(userId, o.projectId, v.id, o);
  return out;
}

async function ownProject(userId: string, projectId: string) {
  const p = await prisma.project.findUnique({ where: { id: projectId }, select: { userId: true, deletedAt: true } });
  if (!p || p.userId !== userId || p.deletedAt) throw new AppError("That edit is not there. list_projects lists them.", 404, "not-found");
}

/**
 * From a share link (Google Drive, Dropbox, any direct link) or a file in the user's connected Google Drive. A Drive
 * video is linked as the Library links one (it stays in Drive); a Drive picture is copied (a picture has no preview to
 * stream from Drive).
 */
export async function footageFromSource(userId: string, i: { url?: string; driveFileId?: string } & FootageOpts): Promise<Video> {
  const fileId = i.driveFileId ?? (i.url ? driveIdOf(i.url) : null);
  const conn = fileId && features().drive ? await prisma.driveConnection.findUnique({ where: { userId } }) : null;
  const dir = await mkdtemp(join(tmpdir(), "footage-"));
  const path = join(dir, "src");
  try {
    if (fileId && conn && !conn.stub) {
      const f = await drive.getFile(userId, fileId, false).catch(() => null);
      if (!f) throw err("Rendrr cannot find that file in your Google Drive (it may be in another account's Drive, or trashed).");
      if (!/^image\//.test(f.mimeType || "")) {
        if (i.projectId) await ownProject(userId, i.projectId);
        const have = await prisma.video.findFirst({ where: { userId, source: "drive", driveFileId: f.id, status: { not: "missing" } } });
        const v = have ?? (await linkDriveFile(userId, f, { stub: false, kind: i.kind ?? "footage", libraryFolderId: await folderOf(userId, i.libraryFolder) }));
        if (i.name && !have) await prisma.video.update({ where: { id: v.id }, data: { name: nameOf(i.name, v.name) } });
        if (i.projectId) await intoEdit(userId, i.projectId, v.id, i);
        return prisma.video.findUniqueOrThrow({ where: { id: v.id } });
      }
      if (f.sizeBytes > IMAGE_MAX_BYTES) throw err(`Pictures are ${MB(IMAGE_MAX_BYTES)} at most.`);
      const m = await drive.mediaRequest(userId, fileId);
      const r = await fetch(m.url, { headers: m.headers, signal: AbortSignal.timeout(5 * 60_000) }).catch(() => null);
      if (!r?.ok || !r.body) throw err(`Google Drive did not give the file${r ? ` (${r.status})` : ""}. Try again in a moment.`);
      const out = createWriteStream(path);
      for await (const c of r.body as unknown as AsyncIterable<Uint8Array>) if (!out.write(c)) await new Promise<void>((ok) => out.once("drain", () => ok()));
      await new Promise<void>((ok) => out.end(() => ok()));
      return await keepFootage(userId, path, f.name, i);
    }
    if (i.driveFileId) throw err("Connect Google Drive in Rendrr first (Settings › Google Drive), or send a share link of the file (Anyone with the link) as url, or upload: true.");
    let url = fileId ? `https://drive.usercontent.google.com/download?id=${encodeURIComponent(fileId)}&export=download&confirm=t` : i.url!;
    try { const u = new URL(url); if (/(^|\.)dropbox\.com$/.test(u.hostname)) { u.searchParams.set("dl", "1"); url = u.href; } } catch { /* fetchPublicTo says why */ }
    const got = await fetchPublicTo(url, path, { max: FOOTAGE_UPLOAD_MAX_BYTES, what: "footage", code: "bad-footage", timeoutMs: 20 * 60_000 });
    if (/^text\/html/i.test(got.type)) throw err(fileId ? "Google Drive did not give the file: it is not shared as Anyone with the link. Share it that way, or connect Google Drive in Rendrr and send its driveFileId." : "That link gives a web page, not a video or a picture. Send a direct link to the file.");
    return await keepFootage(userId, path, got.name || decodeURIComponent(got.url.pathname.split("/").pop() || "") || "Video", i);
  } finally { await rm(dir, { recursive: true, force: true }).catch(() => {}); }
}

/** A one-time link the AI's code workspace sends a file to (curl -T), for 30 minutes. */
export async function footageUploadLink(userId: string, o: FootageOpts) {
  if (o.projectId) await ownProject(userId, o.projectId);
  if (o.libraryFolder) await folderOf(userId, o.libraryFolder); // a bad folder is said now, not after the upload
  const token = randomBytes(24).toString("base64url");
  await redis().set(uploadKey(token), JSON.stringify({ userId, ...o }), "EX", UPLOAD_SECONDS);
  const url = `${env().PUBLIC_API_URL.replace(/\/$/, "")}/footage/upload/${token}`;
  return { url, host: new URL(url).host };
}
export async function footageUploadFor(token: string) {
  const raw = await redis().get(uploadKey(token));
  if (!raw) throw new AppError("This upload link has expired or was used already. Call add_footage with upload: true for a new one.", 404, "footage-upload");
  return JSON.parse(raw) as FootageOpts & { userId: string };
}
export const usedFootageUpload = (token: string) => redis().del(uploadKey(token));

/** Waits (up to ms) for a video to be ready or failed. */
export async function waitForFootage(id: string, ms: number): Promise<Video> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await prisma.video.findUniqueOrThrow({ where: { id } });
    if (["ready", "failed", "missing"].includes(v.status) || Date.now() >= end) return v;
    await new Promise((r) => setTimeout(r, 1000));
  }
}

/** What the AI is told about footage it brought in: ready (and how to place it), still being prepared, or why not. */
export function footageText(v: Pick<Video, "id" | "name" | "status" | "error" | "still" | "seconds" | "width" | "height" | "source">, o: { projectId?: string | null } = {}) {
  const what = v.still ? "picture" : "video";
  const size = v.width ? ` ${v.width}x${v.height}` : "";
  if (v.status === "failed" || v.status === "missing") return `Rendrr could not use the ${what} "${v.name}" (${v.id}): ${v.error || "the file could not be read"}.`;
  const place = v.still
    ? `add_broll{videoId: "${v.id}", start, end} over the picture (a still clip up to ${STILL_SECONDS} s; set_card and set_keyframes place and move it), add_clip{videoId} on V1, set_background{videoId}`
    : `add_broll{videoId: "${v.id}", start, end, sourceStart} over the picture, add_clip{videoId, from, to} on V1, multicam angles{videoId}`;
  const where = `${o.projectId ? "In the library and this edit's Media panel" : "In the library"}${v.source === "drive" ? " (linked from Google Drive)" : ""}`;
  if (v.status !== "ready") return `${where}: the ${what} "${v.name}" ${v.id}${size}, being prepared (${v.status}). add_footage {videoId: "${v.id}", wait_seconds: 60} waits for it; then apply_edits ${place}.`;
  return `${where}: the ${what} "${v.name}" ${v.id}${size}${v.still ? "" : `, ${v.seconds.toFixed(2)} s`}, ready. Place it with apply_edits ${place}.`;
}
