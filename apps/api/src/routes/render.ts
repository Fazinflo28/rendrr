import { AppError, completeMultipart, createMultipart, abortMultipart, deleteObjects, newRedis, notFound, readRender, renderChannel, signPart } from "@rendrr/core";
import { prisma } from "@rendrr/db";
import { OriginalCompleteInput, OriginalUploadInput, PREFIX, TEMP_ORIGINAL_HOURS } from "@rendrr/shared";
import type { FastifyInstance } from "fastify";
import { authenticate } from "../auth";
import { getOwnedProject } from "../services/projects";
import { renderStatus, startRender } from "../services/render";
import { openSse } from "./projects";

export default async function render(app: FastifyInstance) {
  app.addHook("preHandler", authenticate);

  app.post("/projects/:id/renders", async (req) => {
    const kind = (req.body as { kind?: string })?.kind === "final" ? "final" : "preview";
    const r = await startRender(req.user!.id, (req.params as { id: string }).id, kind);
    return { renderId: r.id, kind, steps: r.steps, status: r.status };
  });

  async function ownedRender(userId: string, id: string) {
    const r = await prisma.render.findUnique({ where: { id } });
    if (!r || r.userId !== userId) throw notFound("That render is gone.");
    return r;
  }

  app.get("/renders/:id", async (req) => renderStatus(await ownedRender(req.user!.id, (req.params as { id: string }).id)));

  // Live progress: { step, steps, percent } exactly as the render modal expects, then done or failed.
  app.get("/renders/:id/events", async (req, reply) => {
    const r = await ownedRender(req.user!.id, (req.params as { id: string }).id);
    const s = openSse(req, reply);
    const finish = async () => {
      const fresh = await prisma.render.findUniqueOrThrow({ where: { id: r.id } });
      const st = await renderStatus(fresh);
      s.send(st.status === "done" ? "done" : "failed", st);
      s.close();
    };
    if (r.status === "done" || r.status === "failed") return finish();
    const sub = newRedis();
    let ended = false;
    const end = () => { if (!ended) { ended = true; sub.disconnect(); } };
    s.onClose(end);
    await sub.subscribe(renderChannel(r.id));
    const cur = await readRender(r.id);
    if (cur) s.send("progress", { step: cur.step, steps: cur.steps, percent: cur.percent });
    sub.on("message", async (_c, msg) => {
      const p = JSON.parse(msg) as { status: string; step: number; steps: string[]; percent: number };
      if (p.status === "done" || p.status === "failed") { end(); await finish(); return; }
      s.send("progress", { step: p.step, steps: p.steps, percent: p.percent });
    });
    // A job that already finished between the first read and the subscribe.
    const again = await prisma.render.findUniqueOrThrow({ where: { id: r.id } });
    if (again.status === "done" || again.status === "failed") { end(); await finish(); }
  });

  // ---------------- local footage: the original once, for a full-quality export ----------------
  app.post("/projects/:id/original", async (req) => {
    const p = await getOwnedProject(req.user!.id, (req.params as { id: string }).id);
    const v = await prisma.video.findUniqueOrThrow({ where: { id: p.videoId } });
    const b = OriginalUploadInput.parse(req.body);
    if (v.source !== "local") throw new AppError("This footage lives in Google Drive. We fetch it from there.", 400);
    const sizeOk = !v.originalSize || Number(v.originalSize) === b.size;
    if (b.name !== v.originalName || !sizeOk) {
      throw new AppError(`That is not the same file. We need '${v.originalName}'${v.originalSize ? ` (${(Number(v.originalSize) / 1e6).toFixed(0)} MB)` : ""}.`, 400, "wrong-file");
    }
    const ext = (b.name.split(".").pop() || "mp4").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 5) || "mp4";
    const key = `${PREFIX.tempRaw}${req.user!.id}/${p.id}-${Date.now()}.${ext}`;
    const uploadId = await createMultipart(key, "application/octet-stream");
    // Parts of at least 16 MB, at most 10,000 parts.
    const partSize = Math.max(16 * 1024 * 1024, Math.ceil(b.size / 9000));
    const count = Math.ceil(b.size / partSize);
    const urls = await Promise.all(Array.from({ length: count }, (_, i) => signPart(key, uploadId, i + 1)));
    await prisma.tempOriginal.create({ data: { projectId: p.id, videoId: v.id, key, uploadId, sizeBytes: BigInt(b.size), completed: false, expiresAt: new Date(Date.now() + TEMP_ORIGINAL_HOURS * 3600_000) } });
    return { uploadId, partSize, urls };
  });

  app.post("/projects/:id/original/complete", async (req) => {
    const p = await getOwnedProject(req.user!.id, (req.params as { id: string }).id);
    const b = OriginalCompleteInput.parse(req.body);
    const t = await prisma.tempOriginal.findFirst({ where: { projectId: p.id, uploadId: b.uploadId } });
    if (!t) throw notFound("That upload expired. Pick the file again.");
    await completeMultipart(t.key, b.uploadId, b.parts);
    const deletesAt = new Date(Date.now() + TEMP_ORIGINAL_HOURS * 3600_000);
    await prisma.tempOriginal.update({ where: { id: t.id }, data: { completed: true, expiresAt: deletesAt } });
    return { ok: true, deletesAt: deletesAt.getTime() };
  });

  app.post("/projects/:id/original/abort", async (req) => {
    const p = await getOwnedProject(req.user!.id, (req.params as { id: string }).id);
    const uploadId = String((req.body as { uploadId?: string })?.uploadId || "");
    const t = await prisma.tempOriginal.findFirst({ where: { projectId: p.id, uploadId, completed: false } });
    if (t) { await abortMultipart(t.key, uploadId); await prisma.tempOriginal.delete({ where: { id: t.id } }); }
    return { ok: true };
  });

  app.post("/account/delete-finals", async (req) => {
    const userId = req.user!.id;
    const finals = await prisma.render.findMany({ where: { userId, kind: "final", outputKey: { not: null } } });
    await deleteObjects(finals.flatMap((r) => [r.outputKey, ...((r.framesKeys as string[]) || [])]));
    await prisma.render.updateMany({ where: { id: { in: finals.map((r) => r.id) } }, data: { outputKey: null, framesKeys: [], sizeBytes: 0 } });
    const ps = await prisma.project.findMany({ where: { userId, status: "Final ready" } });
    await prisma.project.updateMany({ where: { id: { in: ps.map((p) => p.id) } }, data: { status: "Preview ready" } });
    return { ok: true, deleted: finals.length };
  });
}
