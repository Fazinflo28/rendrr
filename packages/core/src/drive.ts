import { prisma } from "@rendrr/db";
import { decrypt, encrypt } from "./crypto";
import { env, features } from "./env";
import { AppError } from "./errors";

// Google Drive. With GOOGLE_CLIENT_ID/SECRET set it is the real Drive API (drive.readonly + drive.file).
// Without them it is a fake Drive with the built-in sample files, so the whole flow can be tested.
export type DriveFolder = { id: string; name: string };
export type DriveFile = { id: string; folderId: string; name: string; sizeBytes: number; seconds: number; date: number; mimeType?: string; webViewLink?: string; width?: number; height?: number };

export const SCOPES = ["https://www.googleapis.com/auth/drive.readonly", "https://www.googleapis.com/auth/drive.file", "openid", "email"];
export const driveRedirectUri = () => env().PUBLIC_API_URL.replace(/\/$/, "") + "/drive/callback";

// ---------- fake Drive (stub mode) ----------
const SAMPLE = { talking: "samples/sample-talking-head.mp4", portrait: "samples/sample-portrait.mp4", broll: "samples/sample-broll.mp4" };
export const STUB_FOLDERS: DriveFolder[] = [{ id: "root", name: "My Drive" }, { id: "fd1", name: "Podcast raw" }, { id: "fd2", name: "Client footage" }, { id: "fd3", name: "B-roll" }];
export const STUB_FILES: (DriveFile & { sampleKey: string })[] = [
  { id: "df1", folderId: "fd1", name: "Ep 13 full session.mp4", sizeBytes: 989_324, seconds: 41, date: 0, sampleKey: SAMPLE.talking },
  { id: "df3", folderId: "fd2", name: "BFS knee pain talking head.mp4", sizeBytes: 987_459, seconds: 41, date: 0, sampleKey: SAMPLE.portrait },
  { id: "df4", folderId: "fd2", name: "BFS heel pain Q&A.mp4", sizeBytes: 989_324, seconds: 41, date: 0, sampleKey: SAMPLE.talking },
  { id: "df5", folderId: "fd3", name: "Office drone pass.mp4", sizeBytes: 352_889, seconds: 12, date: 0, sampleKey: SAMPLE.broll },
  { id: "df7", folderId: "root", name: "Vancouver night reel raw.mp4", sizeBytes: 987_459, seconds: 41, date: 0, sampleKey: SAMPLE.portrait },
];
export const SAMPLE_KEYS = SAMPLE;

// ---------- real Drive ----------
async function tokenRequest(params: Record<string, string>) {
  const r = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(params) });
  const j = (await r.json().catch(() => ({}))) as Record<string, string>;
  if (!r.ok) throw new AppError("Google Drive did not accept the connection. Connect it again.", 400, "drive-auth");
  return j;
}
export function authUrl(state: string) {
  const p = new URLSearchParams({ client_id: env().GOOGLE_CLIENT_ID!, redirect_uri: driveRedirectUri(), response_type: "code", scope: SCOPES.join(" "), access_type: "offline", prompt: "consent", include_granted_scopes: "true", state });
  return "https://accounts.google.com/o/oauth2/v2/auth?" + p.toString();
}
export async function exchangeCode(code: string) {
  const j = await tokenRequest({ code, client_id: env().GOOGLE_CLIENT_ID!, client_secret: env().GOOGLE_CLIENT_SECRET!, redirect_uri: driveRedirectUri(), grant_type: "authorization_code" });
  let email = "";
  if (j.id_token) { try { email = JSON.parse(Buffer.from(j.id_token.split(".")[1], "base64url").toString()).email || ""; } catch { /* ignore */ } }
  return { refreshToken: j.refresh_token, accessToken: j.access_token, scope: j.scope || SCOPES.join(" "), email };
}
const tokenCache = new Map<string, { token: string; until: number }>();
export async function accessTokenFor(userId: string): Promise<string> {
  const c = tokenCache.get(userId);
  if (c && c.until > Date.now() + 60_000) return c.token;
  const conn = await prisma.driveConnection.findUnique({ where: { userId } });
  if (!conn || conn.stub) throw new AppError("Connect Google Drive first.", 400, "drive");
  try {
    const j = await tokenRequest({ refresh_token: decrypt(conn.refreshToken), client_id: env().GOOGLE_CLIENT_ID!, client_secret: env().GOOGLE_CLIENT_SECRET!, grant_type: "refresh_token" });
    tokenCache.set(userId, { token: j.access_token, until: Date.now() + Number(j.expires_in || 3000) * 1000 });
    return j.access_token;
  } catch {
    throw new AppError("Google Drive access expired. Connect Google Drive again in Settings.", 400, "drive");
  }
}
export const encryptToken = encrypt;

async function driveGet(userId: string, path: string, params: Record<string, string>) {
  const t = await accessTokenFor(userId);
  const r = await fetch("https://www.googleapis.com/drive/v3" + path + "?" + new URLSearchParams(params), { headers: { authorization: "Bearer " + t } });
  if (r.status === 404) return null;
  if (!r.ok) throw new AppError("We could not reach Google Drive. Try again in a moment.", 502, "drive");
  return r.json() as Promise<Record<string, unknown>>;
}
const FIELDS = "id,name,mimeType,size,modifiedTime,webViewLink,parents,videoMediaMetadata(durationMillis,width,height)";
const toFile = (f: Record<string, any>, folderId: string): DriveFile => ({
  id: f.id, folderId, name: f.name, sizeBytes: Number(f.size || 0), seconds: Math.round(Number(f.videoMediaMetadata?.durationMillis || 0) / 1000),
  date: Date.parse(f.modifiedTime) || 0, mimeType: f.mimeType, webViewLink: f.webViewLink, width: f.videoMediaMetadata?.width, height: f.videoMediaMetadata?.height,
});

export async function listFolder(userId: string, folderId: string, stub: boolean): Promise<{ folders: DriveFolder[]; files: DriveFile[] }> {
  if (stub || !features().drive) {
    return { folders: STUB_FOLDERS, files: STUB_FILES.filter((f) => f.folderId === folderId).map(({ sampleKey: _s, ...f }) => ({ ...f, date: Date.now() - 3600_000 * 20 })) };
  }
  const id = folderId || "root";
  const q = `'${id.replace(/'/g, "")}' in parents and trashed = false and (mimeType = 'application/vnd.google-apps.folder' or mimeType contains 'video/')`;
  const files: Record<string, any>[] = [];
  let pageToken: string | undefined;
  do {
    const j = await driveGet(userId, "/files", { q, fields: `nextPageToken,files(${FIELDS})`, pageSize: "200", orderBy: "folder,modifiedTime desc", supportsAllDrives: "true", includeItemsFromAllDrives: "true", ...(pageToken ? { pageToken } : {}) });
    if (!j) break;
    files.push(...((j.files as Record<string, any>[]) || []));
    pageToken = j.nextPageToken as string | undefined;
  } while (pageToken && files.length < 1000);
  // Left column: My Drive, its top-level folders, and the folders inside the current one.
  const top = id === "root" ? files : (((await driveGet(userId, "/files", { q: "'root' in parents and trashed = false and mimeType = 'application/vnd.google-apps.folder'", fields: "files(id,name)", pageSize: "100", orderBy: "name" }))?.files as Record<string, any>[]) || []);
  const folders: DriveFolder[] = [{ id: "root", name: "My Drive" }, ...top.filter((f) => f.mimeType === "application/vnd.google-apps.folder" || !f.mimeType).map((f) => ({ id: f.id, name: f.name }))];
  if (id !== "root") for (const f of files.filter((x) => x.mimeType === "application/vnd.google-apps.folder")) if (!folders.some((x) => x.id === f.id)) folders.push({ id: f.id, name: "↳ " + f.name });
  return { folders, files: files.filter((f) => String(f.mimeType).startsWith("video/")).map((f) => toFile(f, id)) };
}

export async function getFile(userId: string, fileId: string, stub: boolean): Promise<(DriveFile & { sampleKey?: string }) | null> {
  if (stub || !features().drive) {
    const f = STUB_FILES.find((x) => x.id === fileId);
    return f ? { ...f, date: Date.now() } : null;
  }
  const j = await driveGet(userId, `/files/${encodeURIComponent(fileId)}`, { fields: FIELDS, supportsAllDrives: "true" });
  if (!j || (j as Record<string, unknown>).trashed) return null;
  return toFile(j, "");
}
export async function mediaRequest(userId: string, fileId: string) {
  return { url: `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true`, headers: { authorization: "Bearer " + (await accessTokenFor(userId)) } };
}

/** Copies a finished file into the user's Drive (drive.file scope: Rendrr only sees files it made). Streams, no temp file. */
export async function uploadToDrive(userId: string, name: string, src: { url: string; size: number; type: string }) {
  const t = await accessTokenFor(userId);
  const init = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,webViewLink", {
    method: "POST",
    headers: { authorization: "Bearer " + t, "content-type": "application/json; charset=UTF-8", "x-upload-content-type": src.type, "x-upload-content-length": String(src.size) },
    body: JSON.stringify({ name, mimeType: src.type }),
  });
  const session = init.headers.get("location");
  if (!init.ok || !session) throw new AppError(init.status === 403 ? "Google Drive did not allow the upload. Connect Google Drive again so Rendrr can save files there." : "We could not reach Google Drive. Try again in a moment.", 502, "drive");
  const file = await fetch(src.url);
  if (!file.ok || !file.body) throw new AppError("The final file could not be read. Render the final again.", 502);
  const put = await fetch(session, { method: "PUT", headers: { "content-type": src.type, "content-length": String(src.size) }, body: file.body, duplex: "half" } as RequestInit & { duplex: "half" });
  if (!put.ok) throw new AppError("The upload to Google Drive stopped part way. Try again.", 502, "drive");
  return (await put.json()) as { id: string; webViewLink?: string };
}
