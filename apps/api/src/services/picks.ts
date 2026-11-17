// Files the AI asks the user for (add_footage from: computer | dropbox | google_photos): a pick is a one-hour link the
// user opens in Rendrr (signed in as themselves) to add videos or pictures from their computer, their Dropbox or their
// Google Photos. What arrives is recorded on the pick, so the AI learns exactly which videos came (add_footage pickId),
// and goes in the edit's Media panel when the pick was made for one. A pick belongs to one account: opened in another,
// it says so and takes nothing.
import { AppError, drive, notFound, redis } from "@rendrr/core";
import { prisma } from "@rendrr/db";
import { randomBytes } from "node:crypto";
import { footageFromDownload, footageFromSource, intoEdit } from "./footage";
import { createSession, deleteSession, downloadOf, durationSeconds, getSession, listPicked, photosReady, type PickedItem } from "./googlePhotos";

export const PICK_SOURCES = ["computer", "dropbox", "google_photos"] as const;
export type PickSource = (typeof PICK_SOURCES)[number];
export const PICK_SECONDS = 3600;
export type Pick = {
  id: string; userId: string; source: PickSource; projectId: string | null; kind: string | null;
  ai: "claude" | "chatgpt"; aiName?: string; videoIds: string[]; at: number; until: number; done: boolean;
  /** Links being brought in (a Dropbox link, files chosen in Dropbox), and the ones that could not be. */
  pending?: number; errors?: { name: string; message: string }[];
  /** Google Photos: the picker session the user chooses in, once made; when Google was last asked, how often it may be,
   *  and when the choice times out. */
  photos?: { sessionId: string; pickerUri: string; imported?: boolean; error?: string | null; checkedAt?: number; pollSeconds?: number; timeoutAt?: number } | null;
};
const key = (id: string) => `pick:${id}`;
const WEB = () => (process.env.PUBLIC_WEB_URL || "").replace(/\/$/, "");
export const pickLink = (p: Pick) => `${WEB()}/add/${p.id}`;

async function save(p: Pick) {
  const ttl = Math.max(60, Math.ceil((p.until - Date.now()) / 1000) + 600); // kept a little past the link, so a late look says it expired
  await redis().set(key(p.id), JSON.stringify(p), "EX", ttl);
}

export async function createPick(userId: string, source: PickSource, o: { projectId?: string | null; kind?: string | null; ai?: "claude" | "chatgpt"; aiName?: string } = {}): Promise<Pick> {
  if (o.projectId) {
    const p = await prisma.project.findUnique({ where: { id: o.projectId }, select: { userId: true, deletedAt: true } });
    if (!p || p.userId !== userId || p.deletedAt) throw notFound("That edit does not exist. list_projects lists them.");
  }
  const now = Date.now();
  const p: Pick = { id: randomBytes(18).toString("base64url"), userId, source, projectId: o.projectId ?? null, kind: o.kind ?? null,
    ai: o.ai ?? "claude", aiName: o.aiName, videoIds: [], at: now, until: now + PICK_SECONDS * 1000, done: false, photos: null };
  await save(p);
  return p;
}

/** The pick, for its own account only. Another account's pick, or one past its hour, is refused with a plain reason. */
export async function ownPick(userId: string, id: string, o: { open?: boolean } = {}): Promise<Pick> {
  const raw = /^[A-Za-z0-9_-]{10,64}$/.test(id) ? await redis().get(key(id)) : null;
  const p = raw ? (JSON.parse(raw) as Pick) : null;
  if (!p) throw new AppError("This link has expired. Ask your AI for a new one.", 404, "pick-expired");
  if (p.userId !== userId) throw new AppError("This link was made for another Rendrr account. Log in with that account to add the files, or ask your AI for a new link.", 403, "pick-other-account");
  if (o.open && Date.now() > p.until) throw new AppError("This link has expired. Ask your AI for a new one.", 410, "pick-expired");
  return p;
}

/** Videos (or pictures) the user added through the pick: their own only; each goes in the edit when the pick has one. */
export async function addToPick(userId: string, id: string, videoIds: string[]): Promise<Pick> {
  const p = await ownPick(userId, id, { open: true });
  const fresh = Array.from(new Set(videoIds)).filter((v) => !p.videoIds.includes(v));
  const mine = fresh.length ? await prisma.video.findMany({ where: { id: { in: fresh }, userId, deletedAt: null }, select: { id: true } }) : [];
  for (const v of mine) {
    if (p.projectId) await intoEdit(userId, p.projectId, v.id, { ai: p.ai, aiName: p.aiName }).catch(() => {}); // the edit gone meanwhile: the library keeps it
    p.videoIds.push(v.id);
  }
  await save(p);
  return p;
}

export async function updatePick(p: Pick) { await save(p); }

export async function finishPick(userId: string, id: string): Promise<Pick> {
  const p = await ownPick(userId, id);
  p.done = true;
  await save(p);
  return p;
}

/** What the page shows: the source, the edit it is for, and what came so far. */
export async function pickView(userId: string, id: string) {
  const p = await ownPick(userId, id);
  const [project, videos] = await Promise.all([
    p.projectId ? prisma.project.findUnique({ where: { id: p.projectId }, select: { id: true, name: true } }) : null,
    p.videoIds.length ? prisma.video.findMany({ where: { id: { in: p.videoIds }, userId }, select: { id: true, name: true, status: true, still: true } }) : [],
  ]);
  const byId = new Map(videos.map((v) => [v.id, v]));
  return { id: p.id, source: p.source, ai: p.ai, aiName: p.aiName ?? null, project, kind: p.kind, until: p.until, expired: Date.now() > p.until, done: p.done,
    videos: p.videoIds.map((v) => byId.get(v)).filter((v): v is NonNullable<typeof v> => !!v), pending: p.pending ?? 0, errors: p.errors ?? [], photos: p.photos ? { pickerUri: p.photos.pickerUri, imported: !!p.photos.imported, error: p.photos.error ?? null } : null,
    ...(p.source === "google_photos" ? { photosReady: await photosReady(userId) } : {}) };
}

/** Reads the pick again, changes it and saves it (work in the background meets the page's own changes). */
async function mutatePick(id: string, fn: (p: Pick) => void) {
  const raw = await redis().get(key(id));
  if (!raw) return;
  const p = JSON.parse(raw) as Pick;
  fn(p);
  await save(p);
}

/** A short name for a link the user gave (its file name when it has one). */
export const linkName = (url: string) => { try { const u = new URL(url); return decodeURIComponent(u.pathname.split("/").filter(Boolean).pop() || u.hostname).slice(0, 120); } catch { return url.slice(0, 120); } };

/**
 * Share links (a Dropbox link, files chosen in Dropbox) brought in for the pick, in the background: a large video takes a
 * while to download, so the page polls the pick for what arrived and what could not be. Each arrival goes in the edit.
 */
export async function importLinks(userId: string, id: string, urls: string[]): Promise<Pick> {
  const p = await ownPick(userId, id, { open: true });
  const list = Array.from(new Set(urls.map((u) => u.trim()).filter(Boolean))).slice(0, 50);
  if (!list.length) throw new AppError("Paste a link to a video or a picture.", 400, "bad-footage");
  for (const u of list) { try { if (new URL(u).protocol !== "https:") throw 0; } catch { throw new AppError(`That is not a link: ${u.slice(0, 80)}`, 400, "bad-footage"); } }
  await mutatePick(id, (x) => { x.pending = (x.pending ?? 0) + list.length; });
  void (async () => {
    for (const url of list) {
      try { await arrived(p, await footageFromSource(userId, { url, ...optsOf(p) })); } catch (e) { await failed(p, linkName(url), e); }
    }
  })();
  return (await ownPick(userId, id));
}

const optsOf = (p: Pick) => ({ kind: (p.kind as "footage" | "reference" | null) ?? null, ai: p.ai, aiName: p.aiName });
/** One file brought in for the pick: recorded, and put in the edit when the pick has one. */
async function arrived(p: Pick, v: { id: string }) {
  if (p.projectId) await intoEdit(p.userId, p.projectId, v.id, { ai: p.ai, aiName: p.aiName }).catch(() => {}); // the edit gone meanwhile: the library keeps it
  await mutatePick(p.id, (x) => { if (!x.videoIds.includes(v.id)) x.videoIds.push(v.id); x.pending = Math.max(0, (x.pending ?? 1) - 1); });
}
async function failed(p: Pick, name: string, e: unknown) {
  await mutatePick(p.id, (x) => { x.errors = [...(x.errors ?? []), { name, message: (e as Error).message }].slice(-20); x.pending = Math.max(0, (x.pending ?? 1) - 1); });
}

// ---------------- Google Photos ----------------

/** A Google Photos choice for the pick: the page sends the user to its pickerUri. One still open (not chosen in yet) is
 *  given again; after a choice came in (or failed), choosing again makes a new one. */
export async function startPhotos(userId: string, id: string): Promise<Pick> {
  const p = await ownPick(userId, id, { open: true });
  if (p.source !== "google_photos") throw new AppError("This link is not for Google Photos.", 400, "pick-source");
  if (p.photos && !p.photos.imported && !p.photos.error && Date.now() < (p.photos.timeoutAt ?? 0)) return p;
  const s = await createSession(userId);
  const now = Date.now();
  await mutatePick(id, (x) => { x.photos = { sessionId: s.id, pickerUri: s.pickerUri, imported: false, error: null, checkedAt: now, pollSeconds: Math.max(2, durationSeconds(s.pollingConfig?.pollInterval, 5)), timeoutAt: now + durationSeconds(s.pollingConfig?.timeoutIn, 1800) * 1000 }; });
  return ownPick(userId, id);
}

/**
 * Asks Google whether the user has chosen (no more often than Google says), and once they have, brings what they chose in
 * the background, two at a time. The page and the AI both call it (the user may close Rendrr the moment they finish in
 * Google Photos); a claim makes sure a choice is brought in once.
 */
export async function checkPhotos(userId: string, id: string): Promise<void> {
  const p = await ownPick(userId, id);
  const ph = p.photos;
  if (p.source !== "google_photos" || !ph || ph.imported || ph.error) return;
  if (Date.now() - (ph.checkedAt ?? 0) < (ph.pollSeconds ?? 5) * 1000) return;
  await mutatePick(id, (x) => { if (x.photos) x.photos.checkedAt = Date.now(); });
  const stop = (error: string) => mutatePick(id, (x) => { if (x.photos?.sessionId === ph.sessionId) x.photos.error = error; });
  let set = false;
  try { set = !!(await getSession(userId, ph.sessionId)).mediaItemsSet; } catch (e) { if (["photos-expired", "photos-connect"].includes((e as AppError).code ?? "")) await stop((e as Error).message); return; }
  if (!set) { if (Date.now() > (ph.timeoutAt ?? Infinity)) await stop("Nothing was chosen in Google Photos in time. Choose again."); return; }
  if (!(await redis().set(`${key(id)}:photos:${ph.sessionId}`, "1", "EX", 7200, "NX"))) return;
  let items: PickedItem[];
  try { items = await listPicked(userId, ph.sessionId); } catch (e) { await stop((e as Error).message); return; }
  await mutatePick(id, (x) => { if (x.photos?.sessionId === ph.sessionId) x.photos.imported = true; x.pending = (x.pending ?? 0) + items.length; });
  void importPhotos(p, ph.sessionId, items);
}

async function importPhotos(p: Pick, sessionId: string, items: PickedItem[]) {
  // A picked file's link lasts about an hour: when one is refused (many big videos), the choice is listed again once for
  // fresh links.
  let fresh: Promise<Map<string, PickedItem>> | null = null;
  const relist = () => (fresh ||= listPicked(p.userId, sessionId).then((xs) => new Map(xs.map((x) => [x.id, x]))).catch(() => new Map()));
  const one = async (it: PickedItem, retried = false): Promise<void> => {
    const d = downloadOf(it);
    if ("error" in d) return failed(p, d.name, new Error(d.error));
    try {
      const token = await drive.accessTokenFor(p.userId);
      await arrived(p, await footageFromDownload(p.userId, { url: d.url, headers: { authorization: `Bearer ${token}` }, name: d.name }, optsOf(p)));
    } catch (e) {
      const again = !retried && /answered 40[13]\b/.test((e as Error).message) ? (await relist()).get(it.id) : null;
      return again ? one(again, true) : failed(p, d.name, e);
    }
  };
  const queue = [...items];
  await Promise.all([0, 1].map(async () => { for (let it = queue.shift(); it; it = queue.shift()) await one(it); }));
  await deleteSession(p.userId, sessionId);
}
