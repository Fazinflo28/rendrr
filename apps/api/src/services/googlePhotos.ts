// Google Photos through the Photos Picker API: the user picks photos and videos in Google Photos' own page (a session's
// pickerUri) and Rendrr sees only what they picked. Google's addresses and link forms live here alone.
import { AppError, drive, features } from "@rendrr/core";
import { prisma } from "@rendrr/db";

const API = "https://photospicker.googleapis.com/v1";
export const PHOTOS_MAX_ITEMS = 50;

export type PickerSession = { id: string; pickerUri: string; mediaItemsSet?: boolean; pollingConfig?: { pollInterval?: string; timeoutIn?: string }; expireTime?: string };
export type PickedItem = {
  id: string; type?: "PHOTO" | "VIDEO" | "TYPE_UNSPECIFIED";
  mediaFile?: { baseUrl?: string; mimeType?: string; filename?: string; mediaFileMetadata?: { width?: number; height?: number; videoMetadata?: { processingStatus?: string } } };
};

const CONNECT = "Connect Google Photos in Rendrr first (the Google Photos tab asks for it once).";
/** Whether this account's Google connection lets Rendrr open Google Photos (false: the page offers Connect). */
export async function photosReady(userId: string) {
  if (!features().drive) return false;
  const c = await prisma.driveConnection.findUnique({ where: { userId } });
  return !!c && !c.stub && drive.canPickPhotos(c.scopes);
}

async function call<T>(userId: string, method: string, path: string, body?: unknown): Promise<T> {
  if (!(await photosReady(userId))) throw new AppError(CONNECT, 409, "photos-connect");
  const token = await drive.accessTokenFor(userId).catch(() => { throw new AppError(CONNECT, 409, "photos-connect"); });
  const r = await fetch(API + path, { method, headers: { authorization: "Bearer " + token, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20_000) })
    .catch(() => { throw new AppError("Google Photos did not answer. Try again in a moment.", 502, "photos"); });
  if (r.status === 401 || r.status === 403) throw new AppError("Google Photos access is off or expired. Connect Google Photos again.", 409, "photos-connect");
  if (r.status === 404) throw new AppError("That Google Photos choice has expired. Choose again.", 410, "photos-expired");
  if (!r.ok) throw new AppError(`Google Photos answered ${r.status}. Try again in a moment.`, 502, "photos");
  return (r.status === 204 ? {} : await r.json()) as T;
}

export const createSession = (userId: string) => call<PickerSession>(userId, "POST", "/sessions", { pickingConfig: { maxItemCount: String(PHOTOS_MAX_ITEMS) } });
export const getSession = (userId: string, id: string) => call<PickerSession>(userId, "GET", `/sessions/${encodeURIComponent(id)}`);
export const deleteSession = (userId: string, id: string) => call<unknown>(userId, "DELETE", `/sessions/${encodeURIComponent(id)}`).catch(() => {});

/** Everything picked in a session (pages of 100). */
export async function listPicked(userId: string, sessionId: string): Promise<PickedItem[]> {
  const out: PickedItem[] = [];
  let pageToken = "";
  for (let n = 0; n < 40; n++) {
    const q = new URLSearchParams({ sessionId, pageSize: "100", ...(pageToken ? { pageToken } : {}) });
    const j = await call<{ mediaItems?: PickedItem[]; nextPageToken?: string }>(userId, "GET", `/mediaItems?${q}`);
    out.push(...(j.mediaItems ?? []));
    if (!j.nextPageToken) break;
    pageToken = j.nextPageToken;
  }
  return out;
}

/** "5s", "1.5s" -> seconds. */
export const durationSeconds = (d: string | undefined, dflt: number) => { const m = /^([\d.]+)s$/.exec(d || ""); return m ? Number(m[1]) : dflt; };

/** What to download for a picked item: a video's own file (=dv); a photo at its own size (=w-h), which Google sends as a
 *  JPEG even when the original is an iPhone HEIC. A video Google is still processing cannot be downloaded yet. */
export function downloadOf(it: PickedItem): { url: string; name: string } | { error: string; name: string } {
  const f = it.mediaFile ?? {};
  const video = it.type === "VIDEO" || /^video\//.test(f.mimeType || "");
  const name = (f.filename || (video ? "Video" : "Photo")).slice(0, 200);
  if (!f.baseUrl) return { error: "Google Photos gave no file for it.", name };
  if (video) {
    const st = f.mediaFileMetadata?.videoMetadata?.processingStatus;
    if (st && st !== "READY") return { error: st === "FAILED" ? "Google Photos could not process this video." : "Google Photos is still processing this video: add it again in a few minutes.", name };
    return { url: `${f.baseUrl}=dv`, name };
  }
  const w = Math.min(f.mediaFileMetadata?.width || 4096, 8192), h = Math.min(f.mediaFileMetadata?.height || 4096, 8192);
  return { url: `${f.baseUrl}=w${w}-h${h}`, name: name.replace(/\.(heic|heif|avif)$/i, ".jpg") };
}
