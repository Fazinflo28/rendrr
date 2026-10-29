import { randomBytes } from "node:crypto";
import { AppError, drive, env, features, putObject, redis } from "@rendrr/core";
import { prisma } from "@rendrr/db";
import { parseCube, PREFIX } from "@rendrr/shared";
import { fetchPublic } from "./fetchPublic";

// LUTs the user imports once (.cube, 1D or 3D) and grades use by id (set_grade lut). From the editor's Color tab,
// or from the AI with add_lut: a link, a file in the user's Google Drive, or the file's text.
export const LUT_MAX = 19 * 1024 * 1024;
const err = (m: string) => new AppError(m, 400, "bad-lut");

/** Keeps a LUT under its name: checked first (a broken file is refused with the reason); the same name again
 *  replaces that LUT's file, so grades already using it get the new one. */
export async function saveLut(userId: string, name: string, text: string) {
  let lut;
  try { lut = parseCube(text); } catch (e) { throw err(`${(e as Error).message} Nothing was saved.`); }
  const nm = name.replace(/\.cube$/i, "").trim().slice(0, 120) || "LUT";
  const old = await prisma.lut.findFirst({ where: { userId, name: nm }, orderBy: { createdAt: "desc" } });
  if (!old && (await prisma.lut.count({ where: { userId } })) >= 200) throw new AppError("You have 200 LUTs. Delete some first.", 409);
  const row = old ?? (await prisma.lut.create({ data: { userId, name: nm, key: "pending", kind: lut.kind, size: lut.size } }));
  const key = `${PREFIX.luts}${userId}/${row.id}.cube`;
  await putObject(key, text, "text/plain");
  await prisma.lut.update({ where: { id: row.id }, data: { key, kind: lut.kind, size: lut.size } });
  return { id: row.id, name: nm, kind: lut.kind as "3d" | "1d", size: lut.size, replaced: !!old };
}

/** A Google Drive file id from a share link (file/d/ID, open?id=ID, uc?id=ID), or null. */
export function driveIdOf(url: string): string | null {
  let u: URL;
  try { u = new URL(url); } catch { return null; }
  if (!/(^|\.)(drive|docs)\.google\.com$/.test(u.hostname) && u.hostname !== "drive.usercontent.google.com") return null;
  return u.pathname.match(/\/d\/([\w-]{10,})/)?.[1] ?? u.searchParams.get("id") ?? null;
}

const asText = (buf: Buffer, from: string) => {
  const t = buf.toString("utf8");
  if (/^\s*</.test(t)) throw err(`${from} gave a web page, not a .cube file.`);
  return t;
};
const nameFromUrl = (u: URL) => { try { return decodeURIComponent(u.pathname.split("/").pop() || "").replace(/\.cube$/i, ""); } catch { return ""; } };
export const titleOf = (text: string) => text.match(/^\s*TITLE\s+"?([^"\r\n]+)"?/m)?.[1]?.trim() || "";

/** The .cube text and a name for it, from a link, a Drive file or the text itself. */
export async function lutSource(userId: string, i: { url?: string; driveFileId?: string; text?: string }): Promise<{ text: string; name: string }> {
  if (i.text) return { text: i.text, name: titleOf(i.text) };
  const fileId = i.driveFileId ?? (i.url ? driveIdOf(i.url) : null);
  if (fileId) {
    // The user's own Drive connection reads any file they can open; without one, only a file shared as anyone with the link.
    const conn = features().drive ? await prisma.driveConnection.findUnique({ where: { userId } }) : null;
    if (conn && !conn.stub) {
      const f = await drive.getFile(userId, fileId, false).catch(() => null);
      if (!f) throw err("Rendrr cannot find that file in your Google Drive (it may be in another account's Drive, or trashed).");
      if (f.sizeBytes > LUT_MAX) throw err("LUT files are 19 MB at most.");
      const m = await drive.mediaRequest(userId, fileId);
      const r = await fetch(m.url, { headers: m.headers, signal: AbortSignal.timeout(30_000) }).catch(() => null);
      if (!r?.ok) throw err(`Google Drive did not give the file${r ? ` (${r.status})` : ""}. Try again in a moment.`);
      return { text: asText(Buffer.from(await r.arrayBuffer()), "Google Drive"), name: f.name.replace(/\.cube$/i, "") };
    }
    if (i.driveFileId) throw err("Connect Google Drive in Rendrr first (Library > Add footage > Google Drive), or send a share link of the file (Anyone with the link) as url.");
    const got = await fetchPublic(`https://drive.google.com/uc?export=download&id=${encodeURIComponent(fileId)}`, { max: LUT_MAX, what: "LUT", code: "bad-lut" });
    const t = got.buf.toString("utf8");
    if (/^\s*</.test(t)) throw err("Google Drive did not give the file: it is not shared as Anyone with the link. Share it that way, or connect Google Drive in Rendrr (Library > Add footage > Google Drive) and send its driveFileId.");
    return { text: t, name: titleOf(t) };
  }
  let url = i.url!;
  // Dropbox share links show a page; dl=1 gives the file.
  try { const u = new URL(url); if (/(^|\.)dropbox\.com$/.test(u.hostname)) { u.searchParams.set("dl", "1"); url = u.href; } } catch { /* fetchPublic says why */ }
  const got = await fetchPublic(url, { max: LUT_MAX, what: "LUT", code: "bad-lut" });
  const text = asText(got.buf, "That link");
  return { text, name: titleOf(text) || nameFromUrl(got.url) };
}

export async function lutsText(userId: string) {
  const ls = await prisma.lut.findMany({ where: { userId }, orderBy: { createdAt: "desc" }, take: 30, select: { id: true, name: true, kind: true, size: true } });
  return ls.length ? ls.map((l) => `${l.id} "${l.name}" (${l.kind.toUpperCase()}, ${l.size} points)`).join("; ") : "none";
}

// ---------------- upload links ----------------
// For a LUT the AI made in its own code workspace: a .cube of 33 points is about 1 MB of text, too much to send as a
// tool's input, so add_lut upload gives a one-time link the workspace sends the file to (curl). 30 minutes, one user.
const UPLOAD_SECONDS = 30 * 60;
const uploadKey = (token: string) => `lut-upload:${token}`;

export async function lutUploadLink(userId: string, name?: string) {
  const token = randomBytes(24).toString("base64url");
  await redis().set(uploadKey(token), JSON.stringify({ userId, name: name || null }), "EX", UPLOAD_SECONDS);
  const url = `${env().PUBLIC_API_URL.replace(/\/$/, "")}/luts/upload/${token}`;
  return { url, host: new URL(url).host, expiresAt: Date.now() + UPLOAD_SECONDS * 1000 };
}

/** A file sent to an upload link: checked and kept like any LUT; the link works until a file is saved through it. */
export async function saveUpload(token: string, body: Buffer, name?: string) {
  const raw = await redis().get(uploadKey(token));
  if (!raw) throw new AppError("This upload link has expired or was used already. Call add_lut with upload: true for a new one.", 404, "lut-upload");
  const u = JSON.parse(raw) as { userId: string; name: string | null };
  if (!body.length) throw err("Nothing came with the upload. Send the .cube file as the body: curl -X PUT --data-binary @look.cube '<link>'.");
  if (body.length > LUT_MAX) throw err("LUT files are 19 MB at most.");
  const text = body.toString("utf8");
  if (/^--/.test(text) || /^\s*</.test(text)) throw err("Send the .cube file itself as the body (curl --data-binary @look.cube), not a form or a web page.");
  const l = await saveLut(u.userId, name || u.name || titleOf(text) || "LUT", text);
  await redis().del(uploadKey(token));
  return { ...l, userId: u.userId };
}
