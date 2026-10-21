import { notFound } from "@rendrr/core";
import { prisma } from "@rendrr/db";
import { PLATFORMS, STYLE_TYPES } from "@rendrr/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { authenticate } from "../auth";
import { galleryOut, styleOut } from "../serialize";

/** Explore, Create and Styles are open to everyone. A valid login adds the user's own styles and likes. */
async function optionalAuth(req: FastifyRequest, reply: FastifyReply) {
  if (!req.headers.authorization && !req.headers["x-internal-secret"]) return;
  try { await authenticate(req, reply); } catch { req.user = undefined; }
}

export default async function explore(app: FastifyInstance) {
  app.addHook("preHandler", optionalAuth);
  const visible = (userId?: string) => (userId ? { OR: [{ ownerId: null }, { ownerId: userId }] } : { ownerId: null });

  app.get("/styles", async (req) => {
    const ss = await prisma.style.findMany({ where: visible(req.user?.id), orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] });
    return ss.map(styleOut);
  });
  app.get("/styles/filters", async () => ({ types: STYLE_TYPES, platforms: PLATFORMS }));
  app.get("/styles/:id", async (req) => {
    const s = await prisma.style.findFirst({ where: { id: (req.params as { id: string }).id, ...visible(req.user?.id) } });
    if (!s) throw notFound("That style does not exist.");
    return styleOut(s);
  });

  app.get("/gallery", async (req) => {
    const me = req.user?.id || "";
    const items = await prisma.galleryItem.findMany({ orderBy: { createdAt: "desc" }, take: 300 });
    const likes = me ? new Set((await prisma.galleryLike.findMany({ where: { userId: me, galleryItemId: { in: items.map((i) => i.id) } } })).map((l) => l.galleryItemId)) : new Set<string>();
    const styles = new Map((await prisma.style.findMany()).map((s) => [s.id, s]));
    return items.filter((g) => styles.has(g.styleId)).map((g) => galleryOut(g, me, likes.has(g.id), styles.get(g.styleId)));
  });
}
