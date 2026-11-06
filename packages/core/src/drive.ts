import { prisma } from "@rendrr/db";
import { decrypt, encrypt } from "./crypto";
import { env, features } from "./env";
import { AppError } from "./errors";

// Google Drive. With GOOGLE_CLIENT_ID/SECRET set it is the real Drive API (drive.readonly + drive.file).
// Without them it is a fake Drive with the built-in sample files, so the whole flow can be tested.
export type DriveFolder = { id: string; name: string };
export type DriveFile = { id: string; folderId: string; name: string; sizeBytes: number; seconds: number; date: number; mimeType?: string; webViewLink?: string; width?: number; height?: number };

export const SCOPES = ["https://www.googleapis.com/auth/drive.readonly", "https://www.googleapis.com/auth/drive.file", "openid", "email"];
/** Asked for only when the user allows saving into their own folders: drive.file adds files only to folders Rendrr made. */
export const WRITE_SCOPE = "https://www.googleapis.com/auth/drive";
export const canSaveAnywhere = (scopes: string) => scopes.split(/\s+/).includes(WRITE_SCOPE);
const API = () => (env().GOOGLE_API_URL || "https://www.googleapis.com").replace(/\/$/, "");
export const driveRedirectUri = () => env().PUBLIC_API_URL.replace(/\/$/, "") + "/drive/callback";

// ---------- fake Drive (stub mode) ----------
const SAMPLE = { talking: "samples/sample-talking-head.mp4", portrait: "samples/sample-portrait.mp4", broll: "samples/sample-broll.mp4" };
export const STUB_FOLDERS: (DriveFolder & { parent: string | null })[] = [
  { id: "root", name: "My Drive", parent: null }, { id: "fd1", name: "Podcast raw", parent: "root" }, { id: "fd2", name: "Client footage", parent: "root" },
  { id: "fd3", name: "B-roll", parent: "root" }, { id: "fd4", name: "BFS Health", parent: "fd2" }, { id: "fd5", name: "Shoot day 2", parent: "fd4" },
  { id: "fs1", name: "Shared by Sam", parent: "shared" },
];
export const STUB_FILES: (DriveFile & { sampleKey: string })[] = [
  { id: "df1", folderId: "fd1", name: "Ep 13 full session.mp4", sizeBytes: 989_324, seconds: 41, date: 0, sampleKey: SAMPLE.talking },
  { id: "df3", folderId: "fd4", name: "BFS knee pain talking head.mp4", sizeBytes: 987_459, seconds: 41, date: 0, sampleKey: SAMPLE.portrait },
  { id: "df4", folderId: "fd5", name: "BFS heel pain Q&A.mp4", sizeBytes: 989_324, seconds: 41, date: 0, sampleKey: SAMPLE.talking },
  { id: "df5", folderId: "fd3", name: "Office drone pass.mp4", sizeBytes: 352_889, seconds: 12, date: 0, sampleKey: SAMPLE.broll },
  { id: "df6", folderId: "fs1", name: "Sam interview cut.mp4", sizeBytes: 352_889, seconds: 12, date: 0, sampleKey: SAMPLE.broll },
  { id: "df7", folderId: "root", name: "Vancouver night reel raw.mp4", sizeBytes: 987_459, seconds: 41, date: 0, sampleKey: SAMPLE.portrait },
];
export const SAMPLE_KEYS = SAMPLE;

// ---------- real Drive ----------
async function tokenRequest(params: Record<string, string>) {
  const r = await fetch(env().GOOGLE_TOKEN_URL || "https://oauth2.googleapis.com/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(params) });
  const j = (await r.json().catch(() => ({}))) as Record<string, string>;
  if (!r.ok) throw new AppError("Google Drive did not accept the connection. Connect it again.", 400, "drive-auth");
  return j;
}
export function authUrl(state: string, write = false) {
  const p = new URLSearchParams({ client_id: env().GOOGLE_CLIENT_ID!, redirect_uri: driveRedirectUri(), response_type: "code", scope: [...SCOPES, ...(write ? [WRITE_SCOPE] : [])].join(" "), access_type: "offline", prompt: "consent", include_granted_scopes: "true", state });
  return "https://accounts.google.com/o/oauth2/v2/auth?" + p.toString();
}
export async function exchangeCode(code: string) {
  const j = await tokenRequest({ code, client_id: env().GOOGLE_CLIENT_ID!, client_secret: env().GOOGLE_CLIENT_SECRET!, redirect_uri: driveRedirectUri(), grant_type: "authorization_code" });
  let email = "";
  if (j.id_token) { try { email = JSON.parse(Buffer.from(j.id_token.split(".")[1], "base64url").toString()).email || ""; } catch { /* ignore */ } }
  return { refreshToken: j.refresh_token, accessToken: j.access_token, scope: j.scope || SCOPES.join(" "), email };
}
// Access tokens per connection: the key holds the stored refresh token, so reconnecting Drive (another Google account,
// more access) or disconnecting it is seen at once by the API and the worker, not when the old token runs out.
const tokenCache = new Map<string, { token: string; until: number }>();
export async function accessTokenFor(userId: string): Promise<string> {
  const conn = await prisma.driveConnection.findUnique({ where: { userId } });
  if (!conn || conn.stub) throw new AppError("Connect Google Drive first.", 400, "drive");
  const key = `${userId}:${conn.refreshToken}`;
  const c = tokenCache.get(key);
  if (c && c.until > Date.now() + 60_000) return c.token;
  try {
    const j = await tokenRequest({ refresh_token: decrypt(conn.refreshToken), client_id: env().GOOGLE_CLIENT_ID!, client_secret: env().GOOGLE_CLIENT_SECRET!, grant_type: "refresh_token" });
    for (const k of tokenCache.keys()) if (k.startsWith(`${userId}:`)) tokenCache.delete(k);
    tokenCache.set(key, { token: j.access_token, until: Date.now() + Number(j.expires_in || 3000) * 1000 });
    return j.access_token;
  } catch {
    throw new AppError("Google Drive access expired. Connect Google Drive again in Settings.", 400, "drive");
  }
}
export const encryptToken = encrypt;

async function driveGet(userId: string, path: string, params: Record<string, string>) {
  const t = await accessTokenFor(userId);
  const r = await fetch(API() + "/drive/v3" + path + "?" + new URLSearchParams(params), { headers: { authorization: "Bearer " + t } });
  if (r.status === 404) return null;
  if (!r.ok) throw new AppError("We could not reach Google Drive. Try again in a moment.", 502, "drive");
  return r.json() as Promise<Record<string, unknown>>;
}
const FIELDS = "id,name,mimeType,size,modifiedTime,webViewLink,parents,driveId,videoMediaMetadata(durationMillis,width,height)";
const toFile = (f: Record<string, any>, folderId: string): DriveFile => ({
  id: f.id, folderId, name: f.name, sizeBytes: Number(f.size || 0), seconds: Math.round(Number(f.videoMediaMetadata?.durationMillis || 0) / 1000),
  date: Date.parse(f.modifiedTime) || 0, mimeType: f.mimeType, webViewLink: f.webViewLink, width: f.videoMediaMetadata?.width, height: f.videoMediaMetadata?.height,
});

/** What the picker asks for: one folder (any depth, My Drive or a shared drive), Shared with me, recent videos anywhere, or a name search anywhere. */
export type DriveView = "folder" | "shared" | "recent" | "search";
export type DriveBrowse = { view?: DriveView; folderId?: string; driveId?: string; q?: string };
export type DriveListing = { folders: (DriveFolder & { date: number; driveId?: string })[]; files: DriveFile[]; truncated: boolean };
const FOLDER = "application/vnd.google-apps.folder";
const KINDS = `(mimeType = '${FOLDER}' or mimeType contains 'video/')`;
const quote = (s: string) => s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
const cleanId = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 200);

function stubBrowse(b: DriveBrowse): DriveListing {
  const view = b.view || "folder", t = Date.now() - 3600_000 * 20;
  const text = (b.q || "").trim().toLowerCase();
  const inView = <T extends { name: string }>(x: T, parentOf: (x: T) => string | null) =>
    view === "search" ? !!text && x.name.toLowerCase().includes(text) : view === "shared" ? parentOf(x) === "shared" : view === "recent" ? false : parentOf(x) === (b.folderId || "root");
  const folders = STUB_FOLDERS.filter((f) => f.id !== "root" && inView(f, (x) => x.parent)).map((f) => ({ id: f.id, name: f.name, date: t }));
  const files = STUB_FILES.filter((f) => view === "recent" || inView(f, (x) => x.folderId)).map(({ sampleKey: _s, ...f }) => ({ ...f, date: t }));
  return { folders, files, truncated: false };
}

export async function browse(userId: string, b: DriveBrowse, stub: boolean): Promise<DriveListing> {
  if (stub || !features().drive) return stubBrowse(b);
  const view = b.view || "folder";
  const all = { supportsAllDrives: "true", includeItemsFromAllDrives: "true" };
  let q: string, orderBy = "folder,name", limit = 1000, extra: Record<string, string> = {};
  if (view === "shared") q = `sharedWithMe = true and trashed = false and ${KINDS}`;
  else if (view === "recent") { q = "trashed = false and mimeType contains 'video/'"; orderBy = "modifiedTime desc"; limit = 100; extra = { corpora: "allDrives" }; }
  else if (view === "search") {
    const text = (b.q || "").trim().slice(0, 100);
    if (!text) return { folders: [], files: [], truncated: false };
    q = `name contains '${quote(text)}' and trashed = false and ${KINDS}`; orderBy = "folder,modifiedTime desc"; limit = 200; extra = { corpora: "allDrives" };
  } else {
    q = `'${cleanId(b.folderId || "root") || "root"}' in parents and trashed = false and ${KINDS}`;
    if (b.driveId) extra = { corpora: "drive", driveId: cleanId(b.driveId) };
  }
  const items: Record<string, any>[] = [];
  let pageToken: string | undefined;
  do {
    const j = await driveGet(userId, "/files", { q, fields: `nextPageToken,files(${FIELDS})`, pageSize: String(Math.min(limit, 200)), orderBy, ...all, ...extra, ...(pageToken ? { pageToken } : {}) });
    if (!j) break;
    items.push(...((j.files as Record<string, any>[]) || []));
    pageToken = j.nextPageToken as string | undefined;
  } while (pageToken && items.length < limit);
  const parentOf = (f: Record<string, any>) => (view === "folder" ? b.folderId || "root" : (f.parents?.[0] as string) || "");
  return {
    folders: items.filter((f) => f.mimeType === FOLDER).map((f) => ({ id: f.id, name: f.name, date: Date.parse(f.modifiedTime) || 0, ...(b.driveId ? { driveId: b.driveId } : f.driveId ? { driveId: f.driveId } : {}) })),
    files: items.filter((f) => String(f.mimeType).startsWith("video/")).map((f) => toFile(f, parentOf(f))),
    truncated: !!pageToken,
  };
}

/** A Drive folder and everything under it, for importing a whole folder: its videos and its folders, the same way
 *  down (to maxDepth levels, at most maxFiles videos in all; past that it says truncated). */
export type DriveTree = { id: string; name: string; files: DriveFile[]; folders: DriveTree[] };
export async function walkFolder(userId: string, root: { id: string; name: string; driveId?: string }, stub: boolean, limits = { maxDepth: 6, maxFiles: 200 }): Promise<{ tree: DriveTree; files: number; folders: number; truncated: boolean }> {
  let files = 0, folders = 0, truncated = false;
  const walk = async (f: { id: string; name: string; driveId?: string }, depth: number): Promise<DriveTree> => {
    const l = await browse(userId, { view: "folder", folderId: f.id, driveId: f.driveId }, stub);
    if (l.truncated) truncated = true;
    const room = Math.max(0, limits.maxFiles - files);
    const mine = l.files.slice(0, room);
    if (mine.length < l.files.length) truncated = true;
    files += mine.length;
    const node: DriveTree = { id: f.id, name: f.name, files: mine, folders: [] };
    if (depth >= limits.maxDepth) { if (l.folders.length) truncated = true; return node; }
    for (const sub of l.folders) {
      if (files >= limits.maxFiles) { truncated = true; break; }
      folders++;
      node.folders.push(await walk({ id: sub.id, name: sub.name, driveId: sub.driveId ?? f.driveId }, depth + 1));
    }
    return node;
  };
  const tree = await walk(root, 1);
  return { tree, files, folders, truncated };
}

/** Shared drives the user is a member of (empty for most personal accounts). */
export async function sharedDrives(userId: string, stub: boolean): Promise<DriveFolder[]> {
  if (stub || !features().drive) return [];
  const j = await driveGet(userId, "/drives", { pageSize: "100", fields: "drives(id,name)" });
  return (((j?.drives as Record<string, any>[]) || []).map((d) => ({ id: d.id, name: d.name })));
}

/** The name of the folder a file sits in, for "Google Drive · <folder>". */
export async function folderName(userId: string, folderId: string, stub: boolean): Promise<string> {
  if (!folderId || folderId === "root") return "My Drive";
  if (stub || !features().drive) return STUB_FOLDERS.find((x) => x.id === folderId)?.name || "My Drive";
  const j = await driveGet(userId, `/files/${encodeURIComponent(folderId)}`, { fields: "name,parents,driveId", supportsAllDrives: "true" }).catch(() => null);
  return !j ? "Google Drive" : (j.parents as string[] | undefined)?.length || j.driveId ? String(j.name) : "My Drive";
}

export async function getFile(userId: string, fileId: string, stub: boolean): Promise<(DriveFile & { sampleKey?: string }) | null> {
  if (stub || !features().drive) {
    const f = STUB_FILES.find((x) => x.id === fileId);
    return f ? { ...f, date: Date.now() } : null;
  }
  const j = await driveGet(userId, `/files/${encodeURIComponent(fileId)}`, { fields: FIELDS, supportsAllDrives: "true" });
  if (!j || (j as Record<string, unknown>).trashed) return null;
  return toFile(j, ((j as Record<string, any>).parents?.[0] as string) || "");
}
export async function mediaRequest(userId: string, fileId: string) {
  return { url: `${API()}/drive/v3/files/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true`, headers: { authorization: "Bearer " + (await accessTokenFor(userId)) } };
}

// ---------- saving into Drive ----------
/** A folder to save into: its id ("root" is My Drive), the path the user knows it by, its shared drive if any. */
export type DriveTarget = { id: string; path: string; driveId?: string; made: string[] };
const ALL = { supportsAllDrives: "true", includeItemsFromAllDrives: "true" };
const norm = (s: string) => s.normalize("NFC").replace(/\s+/g, " ").trim().toLowerCase();

/** A folder link, a folder id, or a path ("Clients/BFS Health/Finals", "My Drive › Finals"). */
export function folderRef(s: string | undefined): { id: string } | { path: string[] } {
  const t = (s || "").trim();
  const link = /\/folders\/([A-Za-z0-9_-]{10,})/.exec(t) || /[?&]id=([A-Za-z0-9_-]{10,})/.exec(t);
  if (link) return { id: link[1] };
  if (/^[A-Za-z0-9_-]{19,}$/.test(t)) return { id: t };
  const parts = t.split(/\s*(?:\/|\\|›|»|>)\s*/).map((x) => x.trim()).filter(Boolean);
  if (parts.length && /^my drive$/i.test(parts[0])) parts.shift();
  return parts.length ? { path: parts } : { id: "root" };
}

/** Why Google refused to let Rendrr add a file or folder somewhere (the user's own folder, under drive.file). */
const refused = (where: string) => new AppError(`Google Drive did not let Rendrr save into ${where}.`, 403, "drive-write");

async function driveSend(userId: string, method: string, path: string, params: Record<string, string>, body: unknown, where: string) {
  const t = await accessTokenFor(userId);
  const r = await fetch(API() + path + "?" + new URLSearchParams(params), { method, headers: { authorization: "Bearer " + t, "content-type": "application/json; charset=UTF-8" }, body: JSON.stringify(body) });
  if (r.status === 403 || r.status === 404) throw refused(where);
  if (!r.ok) throw new AppError("We could not reach Google Drive. Try again in a moment.", 502, "drive");
  return r;
}

async function childFolders(userId: string, parent: string, driveId?: string) {
  const j = await driveGet(userId, "/files", { q: `'${cleanId(parent)}' in parents and mimeType = '${FOLDER}' and trashed = false`, fields: "files(id,name,driveId,modifiedTime)", pageSize: "200", orderBy: "modifiedTime desc", ...ALL, ...(driveId ? { corpora: "drive", driveId: cleanId(driveId) } : {}) });
  return ((j?.files as Record<string, any>[]) || []).map((f) => ({ id: String(f.id), name: String(f.name), driveId: f.driveId as string | undefined }));
}

/** "Clients/BFS Health/Finals" for a folder, from its parents (up to 8 levels; My Drive is left out). */
export async function folderPath(userId: string, id: string): Promise<string> {
  const names: string[] = [];
  let cur: string | undefined = id;
  for (let i = 0; cur && cur !== "root" && i < 8; i++) {
    const j = await driveGet(userId, `/files/${encodeURIComponent(cur)}`, { fields: "id,name,parents,driveId", supportsAllDrives: "true" });
    if (!j) break;
    // A shared drive's top folder is the drive itself (its id is the driveId).
    if (j.driveId && j.id === j.driveId) { const d = await driveGet(userId, `/drives/${encodeURIComponent(String(j.driveId))}`, { fields: "name" }).catch(() => null); names.unshift(String(d?.name || j.name)); break; }
    const parents = j.parents as string[] | undefined;
    if (!parents?.length) break; // My Drive's root (or a folder shared with the user)
    names.unshift(String(j.name));
    cur = parents[0];
  }
  return names.join("/") || "My Drive";
}

async function makeFolder(userId: string, name: string, parent: string, where: string): Promise<string> {
  const r = await driveSend(userId, "POST", "/drive/v3/files", { supportsAllDrives: "true", fields: "id" }, { name, mimeType: FOLDER, ...(parent !== "root" ? { parents: [parent] } : {}) }, where);
  return String(((await r.json()) as { id: string }).id);
}

/**
 * Finds the folder the user named (a link, an id, or a path from My Drive or a shared drive; a single name is looked
 * for anywhere when it is not in My Drive). create: the missing folders at the end of the path are made. Throws with
 * what is there when it is not found, or when a name matches several folders.
 */
export async function resolveFolder(userId: string, ref: string | undefined, o: { create?: boolean } = {}): Promise<DriveTarget> {
  const r = folderRef(ref);
  if ("id" in r) {
    if (r.id === "root") return { id: "root", path: "My Drive", made: [] };
    const j = await driveGet(userId, `/files/${encodeURIComponent(r.id)}`, { fields: "id,name,mimeType,driveId,trashed,capabilities(canAddChildren)", supportsAllDrives: "true" });
    if (!j || j.trashed) throw new AppError("That Drive folder was not found (or this Google account cannot see it).", 404, "drive-folder");
    if (j.mimeType !== FOLDER) throw new AppError(`"${j.name}" is a file, not a folder. Send the folder it should go in.`, 400, "drive-folder");
    if ((j.capabilities as { canAddChildren?: boolean } | undefined)?.canAddChildren === false) throw new AppError(`This Google account can only view "${j.name}": it cannot add files there.`, 403, "drive-folder");
    return { id: String(j.id), path: await folderPath(userId, String(j.id)), ...(j.driveId ? { driveId: String(j.driveId) } : {}), made: [] };
  }
  const parts = r.path;
  let parent = "root", driveId: string | undefined, at = 0;
  const shown: string[] = [];
  // The first name may be a shared drive.
  const top = await childFolders(userId, "root");
  if (!top.some((f) => norm(f.name) === norm(parts[0]))) {
    const d = (await sharedDrives(userId, false).catch(() => [])).find((x) => norm(x.name) === norm(parts[0]));
    if (d) { parent = d.id; driveId = d.id; shown.push(d.name); at = 1; }
  }
  for (; at < parts.length; at++) {
    const kids = at === 0 && !driveId ? top : await childFolders(userId, parent, driveId);
    const hit = kids.filter((f) => norm(f.name) === norm(parts[at]));
    if (hit.length) { parent = hit[0].id; shown.push(hit[0].name); continue; }
    // One name, not in My Drive: look for it anywhere.
    if (parts.length === 1) {
      const j = await driveGet(userId, "/files", { q: `name = '${quote(parts[0])}' and mimeType = '${FOLDER}' and trashed = false`, fields: "files(id,name,driveId,parents)", pageSize: "20", corpora: "allDrives", ...ALL });
      const found = ((j?.files as Record<string, any>[]) || []).filter((f) => norm(String(f.name)) === norm(parts[0]));
      if (found.length === 1) return { id: String(found[0].id), path: await folderPath(userId, String(found[0].id)), ...(found[0].driveId ? { driveId: String(found[0].driveId) } : {}), made: [] };
      if (found.length > 1) {
        const where = await Promise.all(found.slice(0, 6).map(async (f) => `${await folderPath(userId, String(f.id))} (id ${f.id})`));
        throw new AppError(`Several folders are called "${parts[0]}": ${where.join("; ")}. Send the full path or the id of the one to use.`, 409, "drive-folder");
      }
    }
    const here = shown.length ? shown.join("/") : "My Drive";
    if (!o.create) {
      const names = kids.slice(0, 15).map((f) => f.name);
      throw new AppError(`No folder "${parts[at]}" in ${here}.${names.length ? ` Folders there: ${names.join(", ")}${kids.length > 15 ? ", …" : ""}.` : " It has no folders."} Send createFolders: true to make "${parts.slice(at).join("/")}" there.`, 404, "drive-folder");
    }
    const made: string[] = [];
    for (; at < parts.length; at++) {
      parent = await makeFolder(userId, parts[at], parent, `"${shown.length ? shown.join("/") : "My Drive"}"`);
      shown.push(parts[at]); made.push(shown.join("/"));
    }
    return { id: parent, path: shown.join("/"), ...(driveId ? { driveId } : {}), made };
  }
  return { id: parent, path: shown.join("/"), ...(driveId ? { driveId } : {}), made: [] };
}

/** Starts an upload session for a file in the folder; Google checks right away that Rendrr may add it there. */
async function uploadSession(userId: string, name: string, type: string, size: number, folder: DriveTarget): Promise<string> {
  const t = await accessTokenFor(userId);
  const init = await fetch(`${API()}/upload/drive/v3/files?uploadType=resumable&supportsAllDrives=true&fields=id,name,webViewLink`, {
    method: "POST",
    headers: { authorization: "Bearer " + t, "content-type": "application/json; charset=UTF-8", "x-upload-content-type": type, "x-upload-content-length": String(size) },
    body: JSON.stringify({ name, mimeType: type, ...(folder.id !== "root" ? { parents: [folder.id] } : {}) }),
  });
  const session = init.headers.get("location");
  if (init.status === 403 || init.status === 404) throw refused(`"${folder.path}"`);
  if (!init.ok || !session) throw new AppError("We could not reach Google Drive. Try again in a moment.", 502, "drive");
  return session;
}

/**
 * Whether Rendrr may save into the folder, checked without saving anything: an upload session is opened (Google
 * checks the folder then) and cancelled.
 */
export async function checkCanSave(userId: string, folder: DriveTarget): Promise<void> {
  const s = await uploadSession(userId, "Rendrr check", "video/mp4", 1, folder);
  await fetch(s, { method: "DELETE" }).catch(() => {});
}

/**
 * Copies a finished file into the user's Drive, in a folder (My Drive by default): a resumable upload in chunks read
 * from the stored file by range, picked up where it stopped when a chunk fails (up to 5 times in a row).
 */
export async function uploadToDrive(userId: string, name: string, src: { url: string; size: number; type: string }, folder: DriveTarget = { id: "root", path: "My Drive", made: [] }, onProgress?: (f: number) => void) {
  const session = await uploadSession(userId, name, src.type, src.size, folder);
  const chunk = Math.max(256 * 1024, Math.floor((Number(env().DRIVE_CHUNK_BYTES) || 32 * 1024 * 1024) / (256 * 1024)) * 256 * 1024);
  let from = 0, fails = 0;
  const done = (r: Response) => r.json() as Promise<{ id: string; name?: string; webViewLink?: string }>;
  while (true) {
    const to = Math.min(src.size, from + chunk) - 1;
    try {
      const part = await fetch(src.url, { headers: { range: `bytes=${from}-${to}` } });
      if (!part.ok) throw new AppError("The final file could not be read. Render the final again.", 502);
      const body = Buffer.from(await part.arrayBuffer());
      if (body.length !== to - from + 1) throw new Error("short read");
      const put = await fetch(session, { method: "PUT", headers: { "content-length": String(body.length), "content-range": `bytes ${from}-${to}/${src.size}` }, body });
      if (put.status === 200 || put.status === 201) { onProgress?.(1); return done(put); }
      if (put.status !== 308) throw new Error(`Drive said ${put.status}`);
      const got = /bytes=0-(\d+)/.exec(put.headers.get("range") || "");
      from = got ? Number(got[1]) + 1 : 0;
      fails = 0;
      onProgress?.(from / src.size);
    } catch (e) {
      if (e instanceof AppError && e.status === 502 && !/Drive/.test(e.message)) throw e;
      if (++fails > 5) throw new AppError("The upload to Google Drive kept stopping. Try again.", 502, "drive");
      await new Promise((r) => setTimeout(r, 500 * 2 ** fails));
      // Where Google has the file up to (an empty PUT with "*" asks), then go on from there.
      const st = await fetch(session, { method: "PUT", headers: { "content-length": "0", "content-range": `bytes */${src.size}` } }).catch(() => null);
      if (st && (st.status === 200 || st.status === 201)) { onProgress?.(1); return done(st); }
      if (st?.status === 404 || st?.status === 410) throw new AppError("Google Drive dropped the upload. Try again.", 502, "drive");
      const got = /bytes=0-(\d+)/.exec(st?.headers.get("range") || "");
      from = got ? Number(got[1]) + 1 : st?.status === 308 ? 0 : from;
    }
  }
}
