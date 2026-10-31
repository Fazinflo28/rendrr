import { AppError, deleteObject, getText, notFound } from "@rendrr/core";
import { prisma } from "@rendrr/db";
import type { Timeline } from "@rendrr/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authenticate } from "../auth";
import { getOwnedProject } from "../services/projects";
import { colorSamples, trackRows } from "../services/color";
import { saveLut } from "../services/luts";

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
    const l = await saveLut(req.user!.id, body.data.name, body.data.text);
    return { id: l.id, name: l.name, kind: l.kind, size: l.size };
  });

  async function ownedLut(userId: string, id: string) {
    const l = await prisma.lut.findUnique({ where: { id } });
    if (!l || l.userId !== userId) throw notFound("That LUT is gone.");
    return l;
  }

  // The file itself, for the editor to build the same table the render uses.
  app.get("/luts/:id/cube", async (req) => {
    const l = await ownedLut(req.user!.id, (req.params as { id: string }).id);
    return { id: l.id, name: l.name, text: await getText(l.key) };
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

  // Object tracking: the editor's Track button, on the editor's own clip (saved or not): the box drawn on it at its
  // footage second `at` followed through its footage [from, to] (a multicam angle: that file, `shift` later). The
  // answer is the tracker's rows, for the editor's track_object op.
  app.post("/projects/:id/track", { config: { rateLimit: { max: 12, timeWindow: "1 minute" } } }, async (req) => {
    const p = await getOwnedProject(req.user!.id, (req.params as { id: string }).id);
    const n = z.number().finite();
    const body = z.object({ videoId: z.string().min(1).max(80), from: n.min(0), to: n.min(0), at: n.min(0), shift: n.optional(), rotate: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]).optional(), fitY: n.min(0).max(1).optional(),
      focus: z.object({ x: n, y: n }).nullable().optional(), box: z.object({ x: n, y: n, w: n.min(0.005).max(3), h: n.min(0.005).max(3) }), aspect: z.string().max(8).optional() }).safeParse(req.body);
    if (!body.success || body.data.to <= body.data.from) throw new AppError("Send the clip's videoId, from, to (its footage), at and box {x, y, w, h} (shares of its picture) to track an object.", 400);
    const d = body.data;
    if (!(await prisma.video.findFirst({ where: { id: d.videoId, userId: req.user!.id }, select: { id: true } }))) throw new AppError("That video is not in your library.", 404);
    return { rows: await trackRows({ videoId: d.videoId, from: d.from, to: d.to, at: d.at, box: d.box, rotate: d.rotate ?? 0, fitY: d.fitY ?? 0.4, shift: d.shift, ...(d.focus ? { focus: d.focus } : {}) }, d.aspect ?? p.aspect) };
  });
}
