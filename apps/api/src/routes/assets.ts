import { AppError, editsUsing, notFound, purgeElement, purgeSound, purgeTrash, signGet } from "@rendrr/core";
import { prisma } from "@rendrr/db";
import { isAssetType, trashDaysLeft, type AssetType } from "@rendrr/shared";
import type { FastifyInstance } from "fastify";
import { authenticate } from "../auth";
import { videoOut } from "../serialize";
import { elementOut } from "../services/elements";
import { footageUploadLink } from "../services/footage";
import { soundUploadLink } from "../services/sounds";

// The Assets page (once "Library"): videos and pictures (Video rows; a still is a picture), elements (graphics of kind
// "element": logos and overlays), audio (Sound rows); a heart on each, and the Trash (deletedAt; gone for good
// TRASH_DAYS later unless an edit still uses it).

type SoundRow = Awaited<ReturnType<typeof prisma.sound.findFirstOrThrow>>;
async function soundOutWeb(s: SoundRow) {
  return {
    id: s.id, type: "audio" as const, name: s.name, status: s.status, error: s.error ?? undefined, seconds: Math.round(s.seconds * 100) / 100,
    url: s.status === "ready" && s.key ? await signGet(s.key, 3600) : null, favorite: s.favorite, at: s.createdAt.getTime(), sizeBytes: Number(s.sizeBytes),
    deletedAt: s.deletedAt ? s.deletedAt.getTime() : null, ...(s.deletedAt ? { daysLeft: trashDaysLeft(s.deletedAt) } : {}),
  };
}
const withDays = <T extends { deletedAt: number | null }>(x: T) => (x.deletedAt ? { ...x, daysLeft: trashDaysLeft(x.deletedAt) } : x);

/** The row behind an asset of this user, or 404. */
async function owned(userId: string, type: AssetType, id: string) {
  if (type === "video" || type === "image") {
    const v = await prisma.video.findUnique({ where: { id } });
    if (!v || v.userId !== userId || v.kind === "canvas") throw notFound("That is not in your assets any more.");
    return { type, row: v } as const;
  }
  if (type === "element") {
    const g = await prisma.graphic.findUnique({ where: { id } });
    if (!g || g.ownerId !== userId || g.kind !== "element") throw notFound("That element is not in your assets any more.");
    return { type, row: g } as const;
  }
  const s = await prisma.sound.findUnique({ where: { id } });
  if (!s || s.userId !== userId) throw notFound("That audio file is not in your assets any more.");
  return { type, row: s } as const;
}

const params = (req: { params: unknown }) => {
  const p = req.params as { type: string; id: string };
  if (!isAssetType(p.type)) throw new AppError("There is no such kind of asset.", 404, "not-found");
  return { type: p.type, id: p.id };
};

async function setFields(type: AssetType, id: string, data: { favorite?: boolean; deletedAt?: Date | null; name?: string }) {
  if (type === "video" || type === "image") return prisma.video.update({ where: { id }, data });
  if (type === "element") return prisma.graphic.update({ where: { id }, data });
  return prisma.sound.update({ where: { id }, data });
}

export default async function assets(app: FastifyInstance) {
  app.register(async (a) => {
    a.addHook("preHandler", authenticate);

    // The side bar's numbers.
    a.get("/assets/summary", async (req) => {
      const userId = req.user!.id;
      const live = { userId, deletedAt: null, kind: { not: "canvas" } };
      const [videos, images, elements, audio, favV, favE, favA, trV, trE, trA] = await Promise.all([
        prisma.video.count({ where: { ...live, still: false } }),
        prisma.video.count({ where: { ...live, still: true } }),
        prisma.graphic.count({ where: { ownerId: userId, kind: "element", deletedAt: null } }),
        prisma.sound.count({ where: { userId, deletedAt: null } }),
        prisma.video.count({ where: { ...live, favorite: true } }),
        prisma.graphic.count({ where: { ownerId: userId, kind: "element", deletedAt: null, favorite: true } }),
        prisma.sound.count({ where: { userId, deletedAt: null, favorite: true } }),
        prisma.video.count({ where: { userId, deletedAt: { not: null } } }),
        prisma.graphic.count({ where: { ownerId: userId, kind: "element", deletedAt: { not: null } } }),
        prisma.sound.count({ where: { userId, deletedAt: { not: null } } }),
      ]);
      return { all: videos + images + elements + audio, videos, images, elements, audio, favorites: favV + favE + favA, trash: trV + trE + trA };
    });

    a.get("/elements", async (req) => {
      const gs = await prisma.graphic.findMany({ where: { ownerId: req.user!.id, kind: "element", deletedAt: null }, orderBy: { createdAt: "desc" }, take: 1000 });
      return Promise.all(gs.map(elementOut));
    });

    a.get("/sounds", async (req) => {
      const ss = await prisma.sound.findMany({ where: { userId: req.user!.id, deletedAt: null }, orderBy: { createdAt: "desc" }, take: 500 });
      return Promise.all(ss.map(soundOutWeb));
    });

    // Everything in the Trash, newest first, with the days left.
    a.get("/trash", async (req) => {
      const userId = req.user!.id;
      const [vs, gs, ss] = await Promise.all([
        prisma.video.findMany({ where: { userId, deletedAt: { not: null } }, orderBy: { deletedAt: "desc" }, take: 500 }),
        prisma.graphic.findMany({ where: { ownerId: userId, kind: "element", deletedAt: { not: null } }, orderBy: { deletedAt: "desc" }, take: 500 }),
        prisma.sound.findMany({ where: { userId, deletedAt: { not: null } }, orderBy: { deletedAt: "desc" }, take: 500 }),
      ]);
      const items = [
        ...(await Promise.all(vs.map(async (v) => withDays({ ...(await videoOut(v)), type: v.still ? "image" : "video" })))),
        ...(await Promise.all(gs.map(elementOut))),
        ...(await Promise.all(ss.map(soundOutWeb))),
      ];
      return items.sort((x, y) => (y.deletedAt || 0) - (x.deletedAt || 0));
    });

    // A one-time link the browser sends a file to (PUT): pictures and videos become library items, audio the user's
    // audio, `as: "element"` a logo or overlay (transparent).
    a.post("/assets/upload-link", { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } }, async (req) => {
      const b = (req.body ?? {}) as { as?: unknown; name?: unknown; libraryFolder?: unknown };
      const as = b.as === "element" || b.as === "audio" || b.as === "image" || b.as === "video" ? b.as : "video";
      const name = typeof b.name === "string" ? b.name.slice(0, 200) : null;
      if (as === "audio") return { ...(await soundUploadLink(req.user!.id, name ?? undefined)), as };
      const libraryFolder = typeof b.libraryFolder === "string" && b.libraryFolder ? b.libraryFolder : null;
      return { ...(await footageUploadLink(req.user!.id, { name, as, libraryFolder })), as };
    });

    // Rename, or the heart.
    a.patch("/assets/:type/:id", async (req) => {
      const { type, id } = params(req);
      const b = (req.body ?? {}) as { favorite?: unknown; name?: unknown };
      await owned(req.user!.id, type, id);
      const data: { favorite?: boolean; name?: string } = {};
      if (typeof b.favorite === "boolean") data.favorite = b.favorite;
      if (typeof b.name === "string") { const n = b.name.replace(/[\u0000-\u001f]/g, " ").trim().slice(0, 200); if (!n) throw new AppError("Give it a name.", 400, "bad-name"); data.name = n; }
      const r = await setFields(type, id, data);
      return { id, type, favorite: r.favorite, name: r.name };
    });

    // Delete: into the Trash (an edit using it keeps working; restore brings it back).
    a.post("/assets/:type/:id/trash", async (req) => {
      const { type, id } = params(req);
      await owned(req.user!.id, type, id);
      const r = await setFields(type, id, { deletedAt: new Date() });
      return { id, type, deletedAt: r.deletedAt!.getTime(), daysLeft: trashDaysLeft(r.deletedAt!) };
    });

    a.post("/assets/:type/:id/restore", async (req) => {
      const { type, id } = params(req);
      await owned(req.user!.id, type, id);
      await setFields(type, id, { deletedAt: null });
      return { id, type, restored: true };
    });

    // Delete for good: elements and audio here (videos and pictures: DELETE /videos/:id, which asks about edits).
    a.delete("/assets/:type/:id", async (req) => {
      const { type, id } = params(req);
      const o = await owned(req.user!.id, type, id);
      if (o.type === "video" || o.type === "image") throw new AppError("Delete videos and pictures with DELETE /videos/:id.", 400, "use-videos");
      const used = await editsUsing(req.user!.id, id);
      if (used.length && (req.query as { edits?: string }).edits !== "keep") {
        const names = used.slice(0, 5).map((p) => `"${p.name}"`).join(", ") + (used.length > 5 ? ` and ${used.length - 5} more` : "");
        throw new AppError(`"${o.row.name}" is used by ${used.length} ${used.length === 1 ? "edit" : "edits"}: ${names}. Deleting it for good takes it out of ${used.length === 1 ? "that edit" : "those edits"}' renders.`, 409, "in-use");
      }
      if (o.type === "element") await purgeElement(o.row);
      else if (o.type === "audio") await purgeSound(o.row);
      return { ok: true };
    });

    // Empty the Trash: everything in it goes for good, except what an edit still uses (named).
    a.post("/trash/empty", async (req) => {
      const r = await purgeTrash({ userId: req.user!.id, before: new Date(Date.now() + 60_000) });
      return { deleted: r.videos + r.elements + r.sounds, kept: r.kept };
    });
  });
}
