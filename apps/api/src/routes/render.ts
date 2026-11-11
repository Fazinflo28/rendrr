import { AppError, completeMultipart, createMultipart, abortMultipart, deleteObjects, drive, features, finalType, notFound, planWithoutFiles, readRender, redis, renderChannel, renderFileKeys, signGet, signPart } from "@rendrr/core";
import { prisma } from "@rendrr/db";
import { notOriginalMessage, OriginalCompleteInput, OriginalUploadInput, PREFIX, renderLimitMs, sameOriginal, TEMP_ORIGINAL_HOURS } from "@rendrr/shared";
import type { FastifyInstance } from "fastify";
import { authenticate } from "../auth";
import { getOwnedProject } from "../services/projects";
import { renderResult, renderStatus, startRender, stopRender } from "../services/render";
import { listen, openSse } from "../live";
import { samplesView, startSamples } from "../services/samples";
import { claimMacExport, macExports, macPing, macStatus } from "../services/macExport";
import { SampleRequestSchema } from "@rendrr/shared";

export default async function render(app: FastifyInstance) {
  app.addHook("preHandler", authenticate);

  app.post("/projects/:id/renders", async (req) => {
    const kind = (req.body as { kind?: string })?.kind === "final" ? "final" : "preview";
    const r = await startRender(req.user!.id, (req.params as { id: string }).id, kind, { best: (req.body as { best?: unknown })?.best === true });
    // Phase 7: the server's time limit for this render, so the app waits as long as the server does (no less).
    const v = await prisma.project.findUnique({ where: { id: r.projectId }, select: { timeline: true, video: { select: { seconds: true } } } });
    return { renderId: r.id, kind, steps: r.steps, status: r.status, quality: r.quality, limitMs: renderLimitMs(kind, v?.video.seconds ?? 0, r.quality, v?.timeline) };
  });

  // Samples: a few frames and short clips of the edit, drawn as the export draws them (the editor's Samples window).
  app.post("/projects/:id/samples", async (req) => {
    const body = SampleRequestSchema.parse(req.body ?? {});
    const r = await startSamples(req.user!.id, (req.params as { id: string }).id, body);
    const v = await prisma.project.findUnique({ where: { id: r.projectId }, select: { timeline: true, video: { select: { seconds: true } } } });
    return { renderId: r.id, kind: "sample", steps: r.steps, status: r.status, quality: r.quality, limitMs: renderLimitMs("preview", v?.video.seconds ?? 0, r.quality, v?.timeline) };
  });
  // The edit's latest sets of samples (the user's and Claude's), newest first.
  app.get("/projects/:id/samples", async (req) => {
    const p = await getOwnedProject(req.user!.id, (req.params as { id: string }).id);
    const rs = await prisma.render.findMany({ where: { projectId: p.id, kind: "sample", status: { in: ["queued", "running", "done"] } }, orderBy: { createdAt: "desc" }, take: 4, select: { id: true } });
    return { sets: await Promise.all(rs.map((r) => samplesView(req.user!.id, r.id))) };
  });

  async function ownedRender(userId: string, id: string) {
    const r = await prisma.render.findUnique({ where: { id } });
    if (!r || r.userId !== userId) throw notFound("That render is gone.");
    return r;
  }

  app.get("/renders/:id", async (req) => renderStatus(await ownedRender(req.user!.id, (req.params as { id: string }).id)));

  // The Rendrr Mac app: it is open (every 20 s), the finals queued for it, and taking one to save to Downloads.
  app.post("/desktop/ping", async (req) => { const b = (req.body as { version?: unknown; device?: unknown; render?: unknown } | null) ?? {}; await macPing(req.user!.id, String(b.version ?? ""), String(b.device ?? ""), b.render); return { ok: true }; });
  // Whether the Rendrr Mac app is open (and on which Mac): where the AI's next final goes.
  app.get("/desktop/status", async (req) => macStatus(req.user!.id));
  app.get("/desktop/exports", async (req) => macExports(req.user!.id));
  app.post("/desktop/exports/:id/claim", async (req) => ({ claimed: await claimMacExport(req.user!.id, (req.params as { id: string }).id) }));

  // "Stop export" in the export window.
  app.post("/renders/:id/stop", { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, async (req) => stopRender(await ownedRender(req.user!.id, (req.params as { id: string }).id)));

  // "Save to Google Drive" on a finished final: copies the file into the user's Drive.
  app.post("/renders/:id/save-to-drive", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req) => {
    const userId = req.user!.id;
    const r = await ownedRender(userId, (req.params as { id: string }).id);
    if (r.kind !== "final" || r.status !== "done" || !r.outputKey) throw new AppError("Render the final first, then save it.", 409);
    if (!features().drive) throw new AppError("Saving to Google Drive is not switched on yet (the server needs Google keys). Use Save to this computer for now.", 409, "drive-off");
    const conn = await prisma.driveConnection.findUnique({ where: { userId } });
    if (!conn || conn.stub) throw new AppError("Connect Google Drive first (Library > Add footage > Google Drive), then save again.", 409, "drive");
    // One copy at a time per final: a retry while the first is still uploading (the page timed out) is refused,
    // instead of a second copy landing in Drive.
    const lock = `drive-web-save:${r.id}`;
    if (!(await redis().set(lock, "1", "EX", 30 * 60, "NX"))) throw new AppError("This final is already being saved to your Google Drive. It shows up there in a moment.", 409, "drive-busy");
    try {
      const res = await renderResult(r);
      const { type } = finalType(r.outputKey);
      const f = await drive.uploadToDrive(userId, res.fileName, { url: await signGet(r.outputKey, 6 * 3600), size: Number(r.sizeBytes), type });
      return { ok: true, fileId: f.id, link: f.webViewLink ?? null, message: `Saved to your Google Drive as "${res.fileName}".` };
    } finally { await redis().del(lock).catch(() => {}); }
  });

  // Live progress: { step, steps, percent, etaSec } exactly as the render modal expects, then done or failed.
  app.get("/renders/:id/events", async (req, reply) => {
    const r = await ownedRender(req.user!.id, (req.params as { id: string }).id);
    const s = openSse(req, reply);
    // A failed read here closes the stream (the page asks again) instead of leaving a rejected promise behind.
    const finish = async () => {
      try {
        const fresh = await prisma.render.findUniqueOrThrow({ where: { id: r.id } });
        const st = await renderStatus(fresh);
        s.send(st.status === "done" ? "done" : "failed", st);
      } catch (e) { req.log.warn({ msg: (e as Error).message, renderId: r.id }, "render stream finish failed"); }
      s.close();
    };
    if (r.status === "done" || r.status === "failed") return finish();
    if (s.isClosed()) return;
    let ended = false;
    let stop = () => {};
    const end = async () => { if (ended) return; ended = true; stop(); await finish(); };
    stop = await listen(renderChannel(r.id), (msg) => {
      const p = JSON.parse(msg) as { status: string; step: number; steps: string[]; percent: number; etaSec?: number | null; on?: string; device?: string | null };
      if (p.status === "done" || p.status === "failed") { void end(); return; }
      s.send("progress", { step: p.step, steps: p.steps, percent: p.percent, etaSec: p.etaSec ?? null, on: p.on ?? "cloud", device: p.device ?? null });
    });
    s.onClose(() => stop());
    if (ended) stop();
    const cur = await readRender(r.id);
    if (cur) s.send("progress", { step: cur.step, steps: cur.steps, percent: cur.percent, etaSec: cur.etaSec ?? null, on: cur.on ?? "cloud", device: cur.device ?? null });
    // A job that already finished between the first read and the subscribe.
    const again = await prisma.render.findUniqueOrThrow({ where: { id: r.id } });
    if (again.status === "done" || again.status === "failed") await end();
  });

  // ---------------- local footage: the original once, for a full-quality export ----------------
  app.post("/projects/:id/original", async (req) => {
    const p = await getOwnedProject(req.user!.id, (req.params as { id: string }).id);
    const v = await prisma.video.findUniqueOrThrow({ where: { id: p.videoId } });
    const b = OriginalUploadInput.parse(req.body);
    if (v.source !== "local") throw new AppError("This footage lives in Google Drive. We fetch it from there.", 400);
    // The same name and size, or (a renamed or re-saved copy) the same length. The worker checks the length again.
    const want = { originalName: v.originalName, originalSize: v.originalSize != null ? Number(v.originalSize) : null, seconds: v.seconds };
    if (!sameOriginal(b, want).ok) throw new AppError(notOriginalMessage(b, want), 400, "wrong-file");
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
    // Parts S3 does not recognise (a wrong ETag, a part that never arrived): say so, so the app sends the file again.
    await completeMultipart(t.key, b.uploadId, b.parts).catch((e: Error & { name?: string; Code?: string }) => {
      const code = e.name || e.Code || "";
      if (/InvalidPart|InvalidPartOrder|NoSuchUpload|EntityTooSmall/.test(code)) throw new AppError("The upload did not arrive whole. Pick the file again.", 400, "upload-incomplete");
      throw e;
    });
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
    // The captions and chapters files go too (they hold the transcript).
    await deleteObjects(finals.flatMap(renderFileKeys));
    for (const r of finals) await prisma.render.update({ where: { id: r.id }, data: { outputKey: null, framesKeys: [], sizeBytes: 0, plan: (planWithoutFiles(r.plan) ?? undefined) as never } });
    const ps = await prisma.project.findMany({ where: { userId, status: "Final ready" } });
    await prisma.project.updateMany({ where: { id: { in: ps.map((p) => p.id) } }, data: { status: "Preview ready" } });
    return { ok: true, deleted: finals.length };
  });
}
