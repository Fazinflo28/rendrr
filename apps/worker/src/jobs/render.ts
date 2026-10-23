import { deleteObject, downloadFile, drive, publishRender, signGet, uploadFile, usage, type RenderJob } from "@rendrr/core";
import { prisma, type Prisma } from "@rendrr/db";
import { isSequence, mainVideoOf, PREFIX, renderTimeoutMs, StyleRulesSchema, type FileMeasure, type Snapshot, type Transcript, type V3Clip } from "@rendrr/shared";
import { ffmpegArgs, planRender, RenderPlanError, type PlanFiles, type SourceInfo } from "@rendrr/shared/renderPlan";
import { createWriteStream } from "node:fs";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { frameAt, graphicCover, JobError, measureFile, probe, run } from "../lib/ffmpeg";
import { cachedAsset } from "../lib/assets";
import { renderGraphicClip } from "../lib/graphics";
import { throttle, type Ctx } from "../lib/job";

const FONTS_DIR = process.env.FONTS_DIR || "/usr/share/fonts";

export async function renderJob(ctx: Ctx) {
  const { renderId } = ctx.job.data as RenderJob;
  const r = await prisma.render.findUnique({ where: { id: renderId } });
  if (!r || r.status === "done") return;
  const project = await prisma.project.findUniqueOrThrow({ where: { id: r.projectId } });
  const video = await prisma.video.findUniqueOrThrow({ where: { id: project.videoId }, include: { analysis: true } });
  const version = await prisma.projectVersion.findUnique({ where: { projectId_v: { projectId: project.id, v: r.version } } });
  const snapshot = (version?.timeline ?? { timeline: project.timeline, name: project.name, aspect: project.aspect, styleId: project.styleId }) as unknown as Snapshot;
  const transcript = (video.analysis?.transcript as unknown as Transcript) || [];
  const steps = (r.steps as string[]) || [];
  const kind = r.kind as "preview" | "final";

  // Preview has a tighter limit than the queue's 15 minutes.
  const ac = new AbortController();
  ctx.signal.addEventListener("abort", () => ac.abort(), { once: true });
  let previewTimedOut = false;
  const pt = kind === "preview" ? setTimeout(() => { previewTimedOut = true; ac.abort(); }, renderTimeoutMs("preview", video.seconds)) : null;
  const signal = ac.signal;

  const send = (step: number, frac: number) => publishRender(r.id, { status: "running", step, steps, percent: Math.min(99, Math.round(((step + Math.max(0, Math.min(1, frac))) / steps.length) * 100)) });
  const sendThrottled = throttle(send, 400);
  await prisma.render.update({ where: { id: r.id }, data: { status: "running", startedAt: new Date(), error: null, errorCode: null } });
  let i = 0;
  await send(0, 0);

  try {
    // ---- Source: the preview copy for previews, the original for finals ----
    const src = join(ctx.dir, "source");
    let tempOriginalIds: string[] = [];
    if (kind === "preview") {
      if (!video.proxyKey) throw new JobError("The preview copy of this footage expired. Rebuild it from your Library, then render again.", "expired", false);
      await downloadFile(video.proxyKey, src);
    } else if (video.sourceKey) {
      // Built-in samples and the fake Drive keep their original in our storage.
      if (steps[0] === "Fetching raw from Drive") { await send(0, 0.1); await downloadFile(video.sourceKey, src); await send(0, 1); i = 1; }
      else await downloadFile(video.sourceKey, src);
    } else if (video.source === "drive") {
      const conn = await prisma.driveConnection.findUnique({ where: { userId: video.userId } });
      const f = conn && video.driveFileId ? await drive.getFile(video.userId, video.driveFileId, conn.stub).catch(() => null) : null;
      if (!f) {
        await prisma.video.update({ where: { id: video.id }, data: { status: "missing", error: "Moved or deleted in Drive" } });
        throw new JobError("We could not reach your Drive file. Reconnect it and try again.", "drive", false);
      }
      const m = await drive.mediaRequest(video.userId, video.driveFileId!);
      const res = await fetch(m.url, { headers: m.headers, signal });
      if (!res.ok || !res.body) throw new JobError("We could not reach your Drive file. Reconnect it and try again.", "drive", false);
      const total = Number(res.headers.get("content-length") || f.sizeBytes || 0);
      let got = 0;
      const body = Readable.fromWeb(res.body as never);
      body.on("data", (c: Buffer) => { got += c.length; if (total) sendThrottled(0, got / total); });
      await pipeline(body, createWriteStream(src));
      i = 1;
    } else {
      const orig = await prisma.tempOriginal.findFirst({ where: { projectId: project.id, videoId: video.id, completed: true, expiresAt: { gt: new Date() } }, orderBy: { createdAt: "desc" } });
      if (!orig) throw new JobError("Full quality needs your original file once.", "need-original", false);
      await downloadFile(orig.key, src);
      tempOriginalIds = [orig.id];
    }
    const info = await probe(src, { signal });
    if (!info.hasVideo) throw new JobError("The footage file looks damaged. Try adding it again.", "damaged", false);

    // ---- Reading timeline ----
    await send(i, 0.2);
    const style = await prisma.style.findUnique({ where: { id: snapshot.styleId } });
    const rules = style ? StyleRulesSchema.safeParse(style.rules) : null;
    const brollIds = Array.from(new Set(snapshot.timeline.tracks.v2.map((c) => (c as { videoId?: string }).videoId).filter(Boolean) as string[]));
    const brollVideos = brollIds.length ? await prisma.video.findMany({ where: { id: { in: brollIds }, userId: video.userId, proxyKey: { not: null } } }) : [];
    const graphicClips = (snapshot.timeline.tracks.v3 as V3Clip[]).filter((c) => c.kind === "graphic" && c.graphicId);
    const files: PlanFiles = { source: src, output: join(ctx.dir, "out.mp4"), assPath: join(ctx.dir, "captions.ass"), fontsDir: FONTS_DIR, broll: {}, graphics: {}, audio: {}, videos: {} };
    const sourceInfo = { width: info.width, height: info.height, fps: info.fps, seconds: info.seconds || video.seconds, hasAudio: info.hasAudio, hdr: !!info.hdr };

    // The other videos on V1 (a sequence can cut between several): previews use their preview copy; finals their
    // original when Rendrr keeps it, else the preview copy (the operations say so). A video that is gone fails the
    // plan with a plain message.
    const sources: Record<string, SourceInfo> = {};
    const transcripts: Record<string, Transcript> = {};
    const copies: string[] = [];
    if (isSequence(snapshot.timeline)) {
      const main = mainVideoOf(snapshot.timeline);
      const otherIds = Array.from(new Set((snapshot.timeline.tracks.v1 as unknown as { sourceVideoId: string }[]).map((c) => c.sourceVideoId))).filter((id) => id !== main);
      const others = otherIds.length ? await prisma.video.findMany({ where: { id: { in: otherIds }, userId: video.userId }, include: { analysis: true } }) : [];
      for (const o of others) {
        const key = kind === "final" && o.sourceKey ? o.sourceKey : o.proxyKey;
        if (!key) continue;
        if (kind === "final" && !o.sourceKey) copies.push(o.name);
        const p = join(ctx.dir, `video-${o.id}`);
        await downloadFile(key, p);
        const oi = await probe(p, { signal });
        if (!oi.hasVideo) throw new JobError(`"${o.name}" on V1 looks damaged. Remove it from the edit or add it again.`, "damaged", false);
        files.videos![o.id] = p;
        sources[o.id] = { width: oi.width, height: oi.height, fps: oi.fps, seconds: oi.seconds || o.seconds, hasAudio: oi.hasAudio, hdr: !!oi.hdr };
        transcripts[o.id] = (o.analysis?.transcript as unknown as Transcript) || [];
      }
    }
    const planBase = { kind, snapshot, transcript, source: sourceInfo, videoId: video.id, sources, transcripts, captionRules: rules?.success ? rules.data.captions : undefined, brollSeconds: Object.fromEntries(brollVideos.map((b) => [b.id, b.seconds])) };

    // A first plan tells us the output size, so graphics can be drawn at the right resolution.
    const first = planRender(planBase);
    const graphicsReady: Record<string, boolean> = {};
    // Only graphics that are still in the edit, each drawn for the time it is on screen.
    for (const sp of first.graphics) {
      const c = graphicClips.find((x) => x.id === sp.clipId);
      if (!c) continue;
      try {
        const path = await renderGraphicClip(c, { width: first.width, height: first.height, dir: ctx.dir, userId: video.userId, signal, durationSec: sp.end - sp.start });
        if (path) { files.graphics![c.id] = path; graphicsReady[c.id] = true; }
      } catch (e) {
        if (signal.aborted) throw e;
        console.error("[render] graphic skipped:", c.graphicId, (e as Error).message.slice(0, 200));
      }
    }
    const plan = planRender({ ...planBase, graphicsReady });
    if (copies.length) plan.operations.push(`Other videos without an original in Rendrr use their 720p copy: ${copies.join(", ")}`);
    for (const b of plan.broll) {
      const bv = brollVideos.find((x) => x.id === b.videoId);
      if (bv?.proxyKey) { const p = join(ctx.dir, `broll-${b.clipId}.mp4`); await downloadFile(bv.proxyKey, p); files.broll![b.clipId] = p; }
    }
    for (const a of plan.audio) {
      // Built-in music and sound effects only (the plan takes keys from the catalog; this is a second lock).
      if (!a.assetKey.startsWith(PREFIX.assets)) throw new JobError("This edit uses a sound that is not in the library. Remove it and try again.", "bad-audio", false);
      files.audio![a.clipId] = await cachedAsset(a.assetKey);
    }
    if (plan.ass) await writeFile(files.assPath!, plan.ass);
    const { args, filterGraph } = ffmpegArgs(plan, files, sourceInfo, { threads: Number(process.env.FFMPEG_THREADS || 0) || undefined });
    const graphPath = join(ctx.dir, "graph.txt");
    await writeFile(graphPath, filterGraph);
    await send(i, 1);
    i++;

    // ---- One FFmpeg pass. Its progress moves through the visible steps. ----
    const endStep = steps.length - 1; // the last step is packing / cleaning up
    const span = endStep - i;
    const onProgress = (sec: number) => {
      const p = Math.min(1, sec / Math.max(0.1, plan.outputSeconds));
      const pos = p * span;
      sendThrottled(i + Math.min(span - 1, Math.floor(pos)), pos - Math.min(span - 1, Math.floor(pos)));
    };
    try {
      await run("ffmpeg", args.map((a) => (a === "__FILTER_SCRIPT__" ? graphPath : a)), { signal, onProgress });
    } catch (e) {
      if (signal.aborted) throw e;
      console.error("[render] ffmpeg failed:", (e as Error).message.slice(0, 1500));
      throw new JobError(`Render failed at '${steps[Math.min(endStep - 1, i)]}'. Nothing was lost. Try again.`, "ffmpeg", true);
    }
    i = endStep;
    await send(i, 0.1);

    // ---- Packing: upload, check frames, clean up ----
    const prefix = kind === "final" ? PREFIX.finals : PREFIX.previews;
    const base = `${prefix}${video.userId}/${project.id}/${r.id}`;
    const outInfo = await probe(files.output, { signal });
    // The rendered file, measured once here so the AI's after-render check compares the file with the edit.
    // A failed measurement is reported in the check (never silently left out).
    let measured: FileMeasure;
    try {
      // Previews get the full check; a final (no check is shown for it) only its stream lengths and loudness, as before.
      const base0 = await measureFile(files.output, { signal, timeoutMs: Math.max(60_000, plan.outputSeconds * 1000), picture: kind === "preview" });
      const graphics: FileMeasure["graphics"] = [];
      for (const gr of plan.graphics) {
        const shown = Math.min(gr.end, base0.videoSeconds ?? gr.end) - gr.start;
        if (shown <= 0) continue;
        const file = files.graphics?.[gr.clipId];
        const fileLen = file ? (await probe(file, { signal }).catch(() => null))?.seconds || shown : shown;
        const on = Math.min(shown, fileLen); // eof_action=pass: a graphic shorter than its clip leaves when it ends
        graphics.push({ clipId: gr.clipId, start: gr.start, end: Math.round((gr.start + on) * 1000) / 1000, coverPct: file ? await graphicCover(file, on / 2, signal) : null });
      }
      measured = { ...base0, graphics };
    } catch (e) {
      if (signal.aborted) throw e;
      measured = { videoSeconds: null, audioSeconds: null, black: [], silences: [], lufs: null, peakDb: null, graphics: [], error: (e as Error).message.slice(0, 200) };
    }
    const loudness = { lufs: measured.lufs, peakDb: measured.peakDb };
    const size = await uploadFile(`${base}.mp4`, files.output, "video/mp4");
    await send(i, 0.6);
    const framesKeys: string[] = [];
    for (const [k, f] of [0.15, 0.4, 0.65, 0.9].entries()) {
      const fp = join(ctx.dir, `f${k}.jpg`);
      await frameAt(files.output, outInfo.seconds * f, fp, kind === "final" ? 960 : 540, signal).catch(() => {});
      if (await stat(fp).then(() => true).catch(() => false)) { await uploadFile(`${base}-f${k}.jpg`, fp, "image/jpeg"); framesKeys.push(`${base}-f${k}.jpg`); }
    }
    // Final: the original is deleted straight away (the daily cleanup is only the safety net).
    if (kind === "final" && tempOriginalIds.length) {
      const origs = await prisma.tempOriginal.findMany({ where: { id: { in: tempOriginalIds } } });
      for (const o of origs) await deleteObject(o.key).catch(() => {});
      await prisma.tempOriginal.deleteMany({ where: { id: { in: tempOriginalIds } } });
    }
    await prisma.render.update({ where: { id: r.id }, data: {
      status: "done", outputKey: `${base}.mp4`, sizeBytes: BigInt(size), seconds: outInfo.seconds, framesKeys, finishedAt: new Date(),
      quality: kind === "final" ? "1080p" : "540p", plan: { operations: plan.operations, kept: plan.parts.length, sources: plan.sources, model: plan.model, outputSeconds: plan.outputSeconds, width: plan.width, height: plan.height, loudness, measured } as unknown as Prisma.InputJsonValue,
    } });
    const fresh = await prisma.project.findUniqueOrThrow({ where: { id: project.id } });
    await prisma.project.update({ where: { id: project.id }, data: {
      status: kind === "final" ? "Final ready" : ["Approved", "In review", "Changes requested", "Final ready"].includes(fresh.status) ? fresh.status : "Preview ready",
      sizeBytes: BigInt(size),
    } });
    await usage(video.userId, kind === "final" ? "render_final" : "render_preview", Math.round((outInfo.seconds / 60) * 100) / 100, { projectId: project.id, renderId: r.id });
    await publishRender(r.id, { status: "done", step: steps.length, steps, percent: 100 });
    return { url: await signGet(`${base}.mp4`, 3600) };
  } catch (e) {
    if (previewTimedOut) throw new JobError("Preview render took too long. Try again.", "timeout", false);
    if (e instanceof RenderPlanError) throw new JobError(e.message, "empty", false);
    throw e;
  } finally {
    if (pt) clearTimeout(pt);
  }
}

/** Called when a render fails for good: the UI shows `error` in plain English. */
export async function renderFailed(renderId: string, message: string, code?: string) {
  const r = await prisma.render.findUnique({ where: { id: renderId } });
  if (!r) return;
  await prisma.render.update({ where: { id: r.id }, data: { status: "failed", error: message, errorCode: code ?? null, finishedAt: new Date() } });
  const p = await prisma.project.findUnique({ where: { id: r.projectId } });
  if (p && p.status === "Rendering") {
    // Back to what the edit had before this render: the best finished render decides.
    const done = await prisma.render.findMany({ where: { projectId: p.id, status: "done" }, select: { kind: true } });
    const status = done.some((x) => x.kind === "final") ? "Final ready" : done.length || r.kind === "final" ? "Preview ready" : "Draft";
    await prisma.project.update({ where: { id: p.id }, data: { status } });
  }
  await publishRender(r.id, { status: "failed", step: 0, steps: (r.steps as string[]) || [], percent: 0, error: message, code });
}

export const ensureDir = (d: string) => mkdir(d, { recursive: true });
