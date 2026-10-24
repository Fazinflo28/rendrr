import { AppError, deleteObject, getText, notFound, putObject } from "@rendrr/core";
import { prisma } from "@rendrr/db";
import { parseCube, PREFIX, type Timeline } from "@rendrr/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authenticate } from "../auth";
import { getOwnedProject } from "../services/projects";
import { colorSamples } from "../services/color";

// Phase 6: imported LUTs (.cube files) and the measured frames the editor's Match button needs.
export default async function color(app: FastifyInstance) {
  app.addHook("preHandler", authenticate);

  app.get("/luts", async (req) => {
    const ls = await prisma.lut.findMany({ where: { userId: req.user!.id }, orderBy: { createdAt: "desc" } });
    return { luts: ls.map((l) => ({ id: l.id, name: l.name, kind: l.kind, size: l.size, createdAt: l.createdAt })) };
  });

  // The file is read and checked here first (a broken or wrong file is refused with the reason), then kept in storage.
  app.post("/luts", { bodyLimit: 20 * 1024 * 1024, config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, async (req) => {
    const body = z.object({ name: z.string().min(1).max(120), text: z.string().min(10).max(19 * 1024 * 1024) }).safeParse(req.body);
    if (!body.success) throw new AppError("Send the LUT's name and the text of its .cube file.", 400);
    let lut;
    try { lut = parseCube(body.data.text); } catch (e) { throw new AppError(`${(e as Error).message} Nothing was saved.`, 400, "bad-lut"); }
    const userId = req.user!.id;
    const count = await prisma.lut.count({ where: { userId } });
    if (count >= 200) throw new AppError("You have 200 LUTs. Delete some first.", 409);
    const row = await prisma.lut.create({ data: { userId, name: body.data.name.replace(/\.cube$/i, "").slice(0, 120), key: "pending", kind: lut.kind, size: lut.size } });
    const key = `${PREFIX.luts}${userId}/${row.id}.cube`;
    await putObject(key, body.data.text, "text/plain");
    await prisma.lut.update({ where: { id: row.id }, data: { key } });
    return { id: row.id, name: row.name, kind: lut.kind, size: lut.size };
  });

  async function ownedLut(userId: string, id: string) {
    const l = await prisma.lut.findUnique({ where: { id } });
    if (!l || l.userId !== userId) throw notFound("That LUT is gone.");
    return l;
  }

  // The file itself, for the editor to build the same table the render uses.
  app.get("/luts/:id/cube", async (req, reply) => {
    const l = await ownedLut(req.user!.id, (req.params as { id: string }).id);
    reply.header("content-type", "text/plain; charset=utf-8").header("cache-control", "private, max-age=86400");
    return getText(l.key);
  });

  app.delete("/luts/:id", async (req) => {
    const l = await ownedLut(req.user!.id, (req.params as { id: string }).id);
    await prisma.lut.delete({ where: { id: l.id } });
    await deleteObject(l.key).catch(() => {});
    return { ok: true };
  });

  // Measured frames of clips for match_color (the editor sends them back inside the op).
  app.post("/projects/:id/color-samples", { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, async (req) => {
    const p = await getOwnedProject(req.user!.id, (req.params as { id: string }).id);
    const body = z.object({ clipIds: z.array(z.string().max(80)).min(1).max(40) }).safeParse(req.body);
    if (!body.success) throw new AppError("Send the clip ids to measure (1 to 40).", 400);
    return { measured: await colorSamples(p.timeline as unknown as Timeline, p.aspect, body.data.clipIds) };
  });
}
