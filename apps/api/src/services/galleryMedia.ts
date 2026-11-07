import { copyObject, deleteObjects, redis, signGet } from "@rendrr/core";
import { prisma, type GalleryItem, type Render } from "@rendrr/db";
import { startRender } from "./render";

// A published video plays its real export in the gallery. When it is published, the edit's best finished export (a
// final, else a preview; the current version first) is copied to the gallery item's own keys with a still from it,
// so it stays when the project's previews expire or the project is deleted. An edit with no export yet gets a
// preview rendered (at publish, or when the gallery is loaded for one published before this); the gallery item takes
// it when the gallery is next loaded.

const SIGN_SECONDS = 6 * 3600;
// A preview started for a gallery item is not started again for this long (one that failed is not retried on every load).
const RETRY_SECONDS = 6 * 3600;

/** The edit's best finished export: the current version's final, else its preview, else the newest of any version. */
async function bestRender(projectId: string): Promise<Render | null> {
  const p = await prisma.project.findUnique({ where: { id: projectId }, select: { currentVersion: true } });
  if (!p) return null;
  const done = { projectId, status: "done", outputKey: { not: null }, kind: { in: ["final", "preview"] } };
  const list = await prisma.render.findMany({ where: done, orderBy: { createdAt: "desc" }, take: 20 });
  const playable = list.filter((r) => /\.(mp4|mov|m4v|webm)$/i.test(r.outputKey || "")); // not a GIF or sound-only final
  const rank = (r: Render) => (r.version === p.currentVersion ? 0 : 2) + (r.kind === "final" ? 0 : 1);
  return playable.sort((a, b) => rank(a) - rank(b) || b.createdAt.getTime() - a.createdAt.getTime())[0] ?? null;
}

/** Copies the export into the gallery item's own keys. Returns the item as saved (unchanged when nothing to copy). */
export async function attachGalleryMedia(g: GalleryItem): Promise<GalleryItem> {
  if (g.videoKey || !g.projectId) return g;
  const r = await bestRender(g.projectId);
  if (!r?.outputKey) return g;
  const ext = (r.outputKey.match(/\.(\w+)$/)?.[1] || "mp4").toLowerCase();
  const videoKey = `gallery/${g.id}.${ext}`;
  const frame = ((r.framesKeys as string[]) || [])[0];
  const posterKey = frame ? `gallery/${g.id}.jpg` : null;
  await copyObject(r.outputKey, videoKey);
  if (frame && posterKey) await copyObject(frame, posterKey).catch(() => {});
  // Only if no one else attached one meanwhile (two loads of the gallery at once).
  const won = await prisma.galleryItem.updateMany({ where: { id: g.id, videoKey: null }, data: { videoKey, posterKey, seconds: r.seconds ?? null } });
  if (!won.count) { await deleteObjects([videoKey, posterKey]).catch(() => {}); return (await prisma.galleryItem.findUnique({ where: { id: g.id } })) ?? g; }
  return { ...g, videoKey, posterKey, seconds: r.seconds ?? null };
}

/** A preview for an edit with nothing to play yet, unless one is on its way. Once per item every few hours. */
async function startExport(g: GalleryItem) {
  if (!g.projectId) return;
  const busy = await prisma.render.count({ where: { projectId: g.projectId, status: { in: ["queued", "running"] } } });
  if (busy) return;
  if (!(await redis().set(`gallery-export:${g.id}`, "1", "EX", RETRY_SECONDS, "NX").catch(() => null))) return;
  await startRender(g.userId, g.projectId, "preview", { by: "gallery" }).catch(() => {}); // footage expired, edit deleted
}

/** At publish: the export copied now, or a preview started for an edit that has none yet. */
export async function prepareGalleryMedia(g: GalleryItem): Promise<GalleryItem> {
  const done = await attachGalleryMedia(g);
  if (!done.videoKey) await startExport(done).catch(() => {});
  return done;
}

/** Items still waiting for their export: those whose render has finished since take it now, and those with none
 *  get one started (a few per load). */
export async function attachWaiting(items: GalleryItem[]): Promise<GalleryItem[]> {
  const waiting = items.filter((g) => !g.videoKey && g.projectId).slice(0, 5);
  if (!waiting.length) return items;
  const got = new Map<string, GalleryItem>();
  for (const g of waiting) {
    const done = await attachGalleryMedia(g).catch(() => g);
    if (!done.videoKey) await startExport(done).catch(() => {});
    got.set(g.id, done);
  }
  return items.map((g) => got.get(g.id) ?? g);
}

/** Signed links to what the gallery shows: the video and its still (none while the export is still being made). */
export async function galleryMedia(g: GalleryItem) {
  return {
    video: g.videoKey ? await signGet(g.videoKey, SIGN_SECONDS) : null,
    poster: g.posterKey ? await signGet(g.posterKey, SIGN_SECONDS) : null,
    seconds: g.seconds ?? null,
  };
}

/** A gallery item's own files, when it is removed. */
export const deleteGalleryMedia = (g: GalleryItem) => deleteObjects([g.videoKey, g.posterKey]).catch(() => {});
