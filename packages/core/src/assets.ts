import { prisma } from "@rendrr/db";
import { PREFIX, trashCutoff } from "@rendrr/shared";
import { deleteObjects, deletePrefix } from "./storage";

// The Assets page's Trash: videos and pictures, elements (logos, overlays) and audio wait there TRASH_DAYS, then go
// for good, unless an edit still uses them (they stay in the Trash, said so, until the user deletes them by hand or
// the edit stops using them). Used by the nightly cleanup (worker) and Empty trash (API).

/** The edits (not deleted) that use this asset: made from it, or with its id anywhere in the timeline. */
export async function editsUsing(userId: string, id: string): Promise<{ id: string; name: string }[]> {
  if (!/^[a-z0-9_-]{6,80}$/i.test(id)) return [];
  return prisma.$queryRaw<{ id: string; name: string }[]>`SELECT id, name FROM "Project" WHERE "userId" = ${userId} AND "deletedAt" IS NULL AND ("videoId" = ${id} OR strpos(timeline::text, ${'"' + id + '"'}) > 0) ORDER BY "updatedAt" DESC LIMIT 20`;
}

/** An element's files and row. */
export async function purgeElement(g: { id: string; renderedKey: string | null; thumbKey: string | null; sourceKey: string | null }) {
  await deleteObjects([g.renderedKey, g.thumbKey, g.sourceKey]);
  await prisma.graphic.delete({ where: { id: g.id } }).catch(() => {});
}

/** An audio file's file and row. */
export async function purgeSound(s: { id: string; key: string }) {
  await deleteObjects([s.key || null]);
  await prisma.sound.delete({ where: { id: s.id } }).catch(() => {});
}

/**
 * A video or picture's files and row, when no edit (deleted ones too, which keep their footage until purged) is made
 * from it. A Drive video is remembered so its synced folder does not bring it back. false: kept, an edit needs it.
 */
export async function purgeVideo(v: { id: string; userId: string; source: string; driveFileId: string | null; proxyKey: string | null; audioKey: string | null; thumbKey: string | null; sourceKey: string | null }): Promise<boolean> {
  if (await prisma.project.count({ where: { videoId: v.id } })) return false;
  const an = await prisma.footageAnalysis.findUnique({ where: { videoId: v.id }, select: { keyFrames: true } });
  await deleteObjects([v.proxyKey, v.audioKey, v.thumbKey, v.source === "upload" ? v.sourceKey : null, ...(((an?.keyFrames as { key: string }[] | null) || []).map((k) => k.key))]);
  await deletePrefix(`${PREFIX.frames}${v.userId}/${v.id}/`);
  await prisma.video.delete({ where: { id: v.id } });
  if (v.source === "drive" && v.driveFileId) await prisma.driveRemoved.upsert({ where: { userId_itemId: { userId: v.userId, itemId: v.driveFileId } }, create: { userId: v.userId, itemId: v.driveFileId }, update: {} });
  return true;
}

/**
 * Trashed assets that are due go for good: trashed before `before` (default: TRASH_DAYS ago), of one user or all.
 * Those an edit still uses stay (`kept`).
 */
export async function purgeTrash(o: { userId?: string; before?: Date } = {}) {
  const before = o.before ?? trashCutoff();
  const who = o.userId ? { userId: o.userId } : {};
  const out = { videos: 0, elements: 0, sounds: 0, kept: [] as { type: string; id: string; name: string; edits: string[] }[] };
  const vids = await prisma.video.findMany({ where: { ...who, deletedAt: { not: null, lte: before } }, take: 500 });
  for (const v of vids) {
    const used = await editsUsing(v.userId, v.id);
    if (used.length || !(await purgeVideo(v))) { out.kept.push({ type: v.still ? "image" : "video", id: v.id, name: v.name, edits: used.map((p) => p.name) }); continue; }
    out.videos++;
  }
  const els = await prisma.graphic.findMany({ where: { ...(o.userId ? { ownerId: o.userId } : { ownerId: { not: null } }), kind: "element", deletedAt: { not: null, lte: before } }, take: 500 });
  for (const g of els) {
    const used = await editsUsing(g.ownerId!, g.id);
    if (used.length) { out.kept.push({ type: "element", id: g.id, name: g.name, edits: used.map((p) => p.name) }); continue; }
    await purgeElement(g); out.elements++;
  }
  const snds = await prisma.sound.findMany({ where: { ...who, deletedAt: { not: null, lte: before } }, take: 500 });
  for (const s of snds) {
    const used = await editsUsing(s.userId, s.id);
    if (used.length) { out.kept.push({ type: "audio", id: s.id, name: s.name, edits: used.map((p) => p.name) }); continue; }
    await purgeSound(s); out.sounds++;
  }
  return out;
}
