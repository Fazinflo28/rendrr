import { deleteObject, downloadFile, drive, getText, publishRender, signGet, uploadFile, usage, type RenderJob } from "@rendrr/core";
import { prisma, type Prisma } from "@rendrr/db";
import { isSequence, mainVideoOf, parseCube, PREFIX, qualityLabel, renderTimeoutMs, StyleRulesSchema, type ClipLook, type FileMeasure, type HdrTransfer, type Lut, type Snapshot, type Transcript, type V3Clip } from "@rendrr/shared";
import { ffmpegArgs, lookFileData, planRender, RenderPlanError, type PlanFiles, type SourceInfo } from "@rendrr/shared/renderPlan";
import { createWriteStream } from "node:fs";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { filterThreads, frameAt, graphicCover, JobError, measureFile, outOfThreads, probe, run } from "../lib/ffmpeg";
import { cachedAsset } from "../lib/assets";
import { renderGraphicClip } from "../lib/graphics";
import { throttle, type Ctx } from "../lib/job";
import { measureMix, type MixLoudness } from "../lib/mix";

// The caption and text fonts (Phase 4): the same files the web app serves, so libass and the editor draw alike.
// The worker image copies them to the same place in the repo layout; system fonts are the fallback (fontconfig).
const FONTS_DIR = process.env.FONTS_DIR || fileURLToPath(new URL("../../../web/public/fonts", import.meta.url));

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

  // Phase 7: the time left. Before the encode it comes from this user's last renders of the same kind and quality
  // (seconds of work per second of output); during the encode from its own speed, plus the packing after it. Never
  // made up: null (the UI says "Estimating") until one of the two exists.
  const t0 = Date.now();
  const prior = await workPerSecond(video.userId, kind, r.quality);
  const est = { outSeconds: video.seconds || 0, encStart: 0, encFrac: 0, encEnd: 0 };
  const etaSec = (): number | null => {
    const now = Date.now();
    if (est.encEnd) { const enc = (est.encEnd - est.encStart) / 1000; return Math.max(2, Math.round(enc * 0.12 + 5 - (now - est.encEnd) / 1000)); }
    if (est.encStart && (est.encFrac >= 0.02 || now - est.encStart > 8000) && est.encFrac > 0) {
      const spent = (now - est.encStart) / 1000, total = spent / est.encFrac;
      return Math.max(2, Math.round(total - spent + total * 0.12 + 5));
    }
    return prior != null ? Math.max(5, Math.round(prior * est.outSeconds - (now - t0) / 1000)) : null;
  };
  const send = (step: number, frac: number) => publishRender(r.id, { status: "running", step, steps, percent: Math.min(99, Math.round(((step + Math.max(0, Math.min(1, frac))) / steps.length) * 100)), etaSec: etaSec() });
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
    const style = snapshot.styleId ? await prisma.style.findUnique({ where: { id: snapshot.styleId } }) : null;
    const rules = style ? StyleRulesSchema.safeParse(style.rules) : null;
    // b-roll videos, and the library video behind V1 (set_background videoId): both need their preview copy.
    const bgVideoId = (snapshot.timeline as { background?: { videoId?: string } }).background?.videoId;
    const brollIds = Array.from(new Set([...snapshot.timeline.tracks.v2.map((c) => (c as { videoId?: string }).videoId), bgVideoId].filter(Boolean) as string[]));
    const brollVideos = brollIds.length ? await prisma.video.findMany({ where: { id: { in: brollIds }, userId: video.userId, proxyKey: { not: null } } }) : [];
    const graphicClips = (snapshot.timeline.tracks.v3 as V3Clip[]).filter((c) => c.kind === "graphic" && c.graphicId);
    const files: PlanFiles = { source: src, output: join(ctx.dir, "out.mp4"), assPath: join(ctx.dir, "captions.ass"), fontsDir: FONTS_DIR, broll: {}, graphics: {}, graphicSeconds: {}, audio: {}, videos: {}, under: {}, looks: {} };
    const sourceInfo: SourceInfo = { width: info.width, height: info.height, fps: info.fps, seconds: info.seconds || video.seconds, hasAudio: info.hasAudio, hdr: !!info.hdr, ...(info.transfer ? { transfer: info.transfer } : {}) };
    // Phase 6: a final reads the original, so it learns whether the footage is HDR (previews say so from then on).
    if (kind === "final" && (video.hdr ?? null) !== (info.transfer ?? null)) await prisma.video.update({ where: { id: video.id }, data: { hdr: info.transfer ?? null } }).catch(() => {});

    // The other videos on V1 (a sequence can cut between several): previews use their preview copy; finals their
    // original when Rendrr keeps it, else the preview copy (the operations say so). A video that is gone fails the
    // plan with a plain message.
    const sources: Record<string, SourceInfo> = {};
    const transcripts: Record<string, Transcript> = {};
    const hdrFootage: Record<string, HdrTransfer> = video.hdr ? { [video.id]: video.hdr as HdrTransfer } : {};
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
        sources[o.id] = { width: oi.width, height: oi.height, fps: oi.fps, seconds: oi.seconds || o.seconds, hasAudio: oi.hasAudio, hdr: !!oi.hdr, ...(oi.transfer ? { transfer: oi.transfer } : {}) };
        if (o.hdr) hdrFootage[o.id] = o.hdr as HdrTransfer;
        transcripts[o.id] = (o.analysis?.transcript as unknown as Transcript) || [];
      }
    }
    // Phase 6: the imported LUTs the grades use (one that is gone renders without it, and the check says so).
    const lutIds = Array.from(new Set([...snapshot.timeline.tracks.v1, ...snapshot.timeline.tracks.v2].map((c) => (c as ClipLook).grade?.lut?.id).filter((x): x is string => !!x)));
    const luts: Record<string, Lut> = {};
    for (const l of lutIds.length ? await prisma.lut.findMany({ where: { id: { in: lutIds }, userId: video.userId } }) : []) {
      try { luts[l.id] = parseCube(await getText(l.key)); } catch (e) { console.error("[render] LUT skipped:", l.id, (e as Error).message.slice(0, 200)); }
    }
    const planBase = { kind, snapshot, transcript, source: sourceInfo, videoId: video.id, sources, transcripts, captionRules: rules?.success ? rules.data.captions : undefined, brollSeconds: Object.fromEntries(brollVideos.map((b) => [b.id, b.seconds])), luts, hdrFootage };

    // A first plan tells us the output size, so graphics can be drawn at the right resolution.
    const first = planRender(planBase);
    const graphicsReady: Record<string, boolean> = {};
    const graphicErrors: string[] = [];
    // Only graphics that are still in the edit, each drawn for the time it is on screen.
    for (const sp of first.graphics) {
      const c = graphicClips.find((x) => x.id === sp.clipId);
      if (!c) continue;
      try {
        // A long graphic is recorded here (Phase 7): its progress moves this step.
        const got = await renderGraphicClip(c, { width: first.width, height: first.height, dir: ctx.dir, userId: video.userId, signal, durationSec: sp.end - sp.start, onProgress: (f) => sendThrottled(i, 0.2 + 0.7 * f) });
        if (got) { files.graphics![c.id] = got.path; files.graphicSeconds![c.id] = got.seconds; graphicsReady[c.id] = true; }
      } catch (e) {
        if (signal.aborted) throw e;
        // Left out, and said so in the plan (the check repeats it), never silently.
        console.error("[render] graphic skipped:", c.graphicId, (e as Error).message.slice(0, 200));
        graphicErrors.push(`Graphic ${c.id} left out: ${(e as Error).message.slice(0, 300)}`);
      }
    }
    const plan = planRender({ ...planBase, graphicsReady });
    plan.operations.push(...graphicErrors);
    est.outSeconds = plan.outputSeconds;
    if (copies.length) plan.operations.push(`Other videos without an original in Rendrr use their 720p copy: ${copies.join(", ")}`);
    for (const b of [...plan.broll, ...(plan.under ?? [])]) {
      const bv = brollVideos.find((x) => x.id === b.videoId);
      if (bv?.proxyKey) { const p = join(ctx.dir, `broll-${b.clipId}.mp4`); await downloadFile(bv.proxyKey, p); (plan.under?.includes(b) ? files.under! : files.broll!)[b.clipId] = p; }
    }
    if (plan.background?.videoId) {
      const bv = brollVideos.find((x) => x.id === plan.background!.videoId);
      if (bv?.proxyKey) { const p = join(ctx.dir, "background.mp4"); await downloadFile(bv.proxyKey, p); files.background = p; }
    }
    // Phase 6: the grades as .cube files and the masks as pictures, at the render's size (and a card's shadow and
    // border, and the background's colour or gradient).
    for (const [name, spec] of Object.entries(plan.lookFiles ?? {})) {
      const p = join(ctx.dir, `look-${name}`);
      await writeFile(p, lookFileData(spec, plan, luts));
      files.looks![name] = p;
    }
    for (const a of plan.audio) {
      // Built-in music and sound effects only (the plan takes keys from the catalog; this is a second lock).
      if (!a.assetKey.startsWith(PREFIX.assets)) throw new JobError("This edit uses a sound that is not in the library. Remove it and try again.", "bad-audio", false);
      files.audio![a.clipId] = await cachedAsset(a.assetKey);
    }
    if (plan.ass) await writeFile(files.assPath!, plan.ass);
    await send(i, 1);
    i++;

    // ---- Measuring loudness: the mix, audio only, so the render can set it to the target exactly ----
    let mixLoudness: MixLoudness | null = null;
    const measuring = steps[i] === "Measuring loudness";
    if (plan.audioMix?.loudness != null) {
      mixLoudness = await measureMix(plan, files, sourceInfo, { dir: ctx.dir, signal, onProgress: measuring ? (f) => sendThrottled(i, f) : undefined });
    }
    if (measuring) { await send(i, 1); i++; }
    const argsFor = (ft: number) => ffmpegArgs(plan, files, sourceInfo, { threads: Number(process.env.FFMPEG_THREADS || 0) || undefined, filterThreads: ft, loudnessGainDb: mixLoudness?.gainDb });
    const { args, filterGraph } = argsFor(filterThreads());
    const graphPath = join(ctx.dir, "graph.txt");
    await writeFile(graphPath, filterGraph);

    // ---- One FFmpeg pass. Its progress moves through the visible steps. ----
    const endStep = steps.length - 1; // the last step is packing / cleaning up
    const span = endStep - i;
    const onProgress = (sec: number) => {
      const p = Math.min(1, sec / Math.max(0.1, plan.outputSeconds));
      est.encFrac = p;
      const pos = p * span;
      sendThrottled(i + Math.min(span - 1, Math.floor(pos)), pos - Math.min(span - 1, Math.floor(pos)));
    };
    const withGraph = (a: string[]) => a.map((x) => (x === "__FILTER_SCRIPT__" ? graphPath : x));
    est.encStart = Date.now();
    try {
      try {
        await run("ffmpeg", withGraph(args), { signal, onProgress });
      } catch (e) {
        // Out of threads (a container limit): once more with one filter thread, which needs far fewer.
        if (signal.aborted || !outOfThreads(e)) throw e;
        console.error("[render] ffmpeg ran out of threads; trying again with one filter thread");
        await run("ffmpeg", withGraph(argsFor(1).args), { signal, onProgress });
      }
    } catch (e) {
      if (signal.aborted) throw e;
      console.error("[render] ffmpeg failed:", (e as Error).message.slice(0, 2600));
      throw new JobError(`Render failed at '${steps[Math.min(endStep - 1, i)]}'. Nothing was lost. Try again.`, "ffmpeg", true);
    }
    i = endStep;
    est.encEnd = Date.now();
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
        // Phase 7: a file shorter than its clip holds its last frame to the clip's end (the plan pads it).
        const on = shown;
        // 8 moments across the part of the file on screen (a held last frame is that frame).
        const c = file ? await graphicCover(file, gr.sourceStart, Math.max(1 / 30, Math.min(on, fileLen - gr.sourceStart)), signal) : null;
        graphics.push({ clipId: gr.clipId, start: gr.start, end: Math.round((gr.start + on) * 1000) / 1000, coverPct: c?.avg ?? null, ...(c ? { coverMin: c.min, coverMax: c.max } : {}) });
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
      await frameAt(files.output, outInfo.seconds * f, fp, kind === "final" ? 960 : 540, signal, !!plan.hdr).catch(() => {});
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
      quality: kind === "final" ? qualityLabel({ resolution: snapshot.timeline.export?.resolution, codec: plan.codec, hdr: !!plan.hdr }) : "540p", plan: { operations: plan.operations, kept: plan.parts.length, sources: plan.sources, model: plan.model, outputSeconds: plan.outputSeconds, mix: mixLoudness, width: plan.width, height: plan.height, loudness, measured } as unknown as Prisma.InputJsonValue,
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

/** Seconds of work per second of output in this user's last finished renders of this kind and quality (median), or null. */
async function workPerSecond(userId: string, kind: string, quality: string | null): Promise<number | null> {
  const done = await prisma.render.findMany({ where: { userId, kind, status: "done", quality: quality ?? undefined, startedAt: { not: null }, finishedAt: { not: null }, seconds: { gt: 1 } }, orderBy: { createdAt: "desc" }, take: 8, select: { startedAt: true, finishedAt: true, seconds: true } });
  const rates = done.map((x) => (x.finishedAt!.getTime() - x.startedAt!.getTime()) / 1000 / x.seconds).filter((x) => x > 0 && Number.isFinite(x)).sort((a, b) => a - b);
  return rates.length ? rates[Math.floor(rates.length / 2)] : null;
}
