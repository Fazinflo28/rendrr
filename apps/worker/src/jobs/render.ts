import { billableMinutes, deleteObject, deleteObjects, downloadFile, drive, driveSaveOf, enqueue, forgetOrigins, getBytes, getText, headObject, listPrefix, macExportsKey, macForRender, noteCost, publishRender, queueDriveSave, recordUsage, redis, signGet, transcriber, uploadFile, usage, type HeardJob, type RenderJob } from "@rendrr/core";
import { fitFfmpegThreads, threadUse, waitForThreads } from "../lib/threads";
import { prisma, type Prisma } from "@rendrr/db";
import { bestResolution, desktopAppName, pieceCachePrefix, fmtClock, formatFile, isBestQuality, isSoundFormat, lengthTolerance, SOUND_QUALITY, withExportFormat, type ExportFormat, machineWord, macOriginalOf, renderLimitMs, sampleWindow, type MacOriginal, type SampleDone, type SamplePlan } from "@rendrr/shared";
import { audioSettings, audioText, boardStyle, lookText, onScreenAt, storyboardAutoPanels, type Board, type BoardPanel } from "@rendrr/shared";
import { gifArgs, joinPieces, makeGif, mergeOverlay, mergeOverlayArgs, writeSideFiles } from "../lib/deliver";
import { macPieceRuns, macPiecesFirst, macRanOutOfRoom } from "../lib/macPieces";
import { ffmpegVersion, pieceKey, previewPieceCache } from "../lib/pieceCache";
import { dropTemps, fetchEtaSec, macTaskFor, NotForMac, runOnMac, type MacDone, type MacOut, type MacRun } from "../lib/macTask";
import { exportMultiplier, isFourKQuality, isHeavyPlan, allWords, asSequence, boxCover, reverbIr, wavStereo, faceOnScreenAt, isSequence, layoutTimeline, libraryVideoIds, mainVideoOf, parseCube, PREFIX, qualityLabel, sequenceView, soundJoins, sourceVideoIds, StyleRulesSchema, type ClipLook, type FileMeasure, type FileSound, type HdrTransfer, type HeardTranscript, type Lut, type SeqClip, type Snapshot, type Transcript, type V3Clip, type VisionDetails, type VisionSummary } from "@rendrr/shared";
import { ffmpegArgs, lookFileData, pickHwEncoder, pieceRanges, planRender, RenderPlanError, windowPlan, zoomAt, type PlanFiles, type RenderPlan, type SourceInfo } from "@rendrr/shared/renderPlan";
import { createWriteStream } from "node:fs";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { COVER_SIZE, cpuBudget, filterThreads, frameArgs, frameAt, graphicCover, JobError, measureFile, outOfThreads, probe, run, stalled, windowBudget } from "../lib/ffmpeg";
import { cachedAsset, cachedCopy, eachLimit } from "../lib/assets";
import { matchFacing } from "../lib/orient";
import { closeIdleBrowsers, renderGraphicClip } from "../lib/graphics";
import { ensureMattes } from "../lib/matte";
import { ensureVoices } from "../lib/voice";
import { writeMoving } from "../lib/moving";
import { morphFaces } from "../lib/morph";
import { detectShake, detectShakeArgs, makeStableCopy, stableCopyArgs } from "../lib/stabilize";
import { throttle, type Ctx } from "../lib/job";
import { measureMix, type MixLoudness } from "../lib/mix";
import { measureSound } from "../lib/sound";
import { previewFix } from "../lib/fixMoments";

// The caption and text fonts (Phase 4): the same files the web app serves, so libass and the editor draw alike.
// The worker image copies them to the same place in the repo layout; system fonts are the fallback (fontconfig).
const FONTS_DIR = process.env.FONTS_DIR || fileURLToPath(new URL("../../../web/public/fonts", import.meta.url));

/** How long FFmpeg may sit frozen (no progress, CPU idle) before it is stopped and that part made another way. */
export const STALL_MS = Number(process.env.RENDER_STALL_MS || 60_000);
/** The message for an export that froze at a moment and could not get past it (the picture, its sound, or the
 *  white pass of a transparent file). */
export const frozenAt = (at: number, what: "picture" | "sound" | "transparent" = "picture") =>
  new JobError(`The export${what === "sound" ? "'s sound" : what === "transparent" ? "'s transparent pass" : ""} froze at ${fmtClock(at)} and could not get past it. Nothing was lost. Try again; if it freezes there again, tell us that time.`, "ffmpeg-frozen", true);

/**
 * Music shorter than `need` seconds, made into a WAV of `need` seconds (plus a little) by looping it in a small pass
 * of its own; null when it is long enough already (the file is used as it is).
 */
export async function loopedMusic(src: string, need: number, out: string, signal?: AbortSignal): Promise<string | null> {
  const len = (await probe(src, { signal })).seconds;
  if (!(len > 0) || len >= need + 0.05) return null;
  await run("ffmpeg", ["-hide_banner", "-nostdin", "-y", "-loglevel", "error", "-stream_loop", "-1", "-i", src, "-t", (need + 0.5).toFixed(3), "-vn", "-ar", "48000", "-ac", "2", "-c:a", "pcm_s16le", out], { signal });
  return out;
}

/** A final this heavy is made in pieces from the start (its one pass would run out of memory after many minutes). */
export const piecesFirst = (kind: string, g: { inputs: number; scalers: number }) => kind === "final" && (g.inputs >= 24 || g.scalers >= 150);

export async function renderJob(ctx: Ctx) {
  const { renderId } = ctx.job.data as RenderJob;
  const r = await prisma.render.findUnique({ where: { id: renderId } });
  // Only a render still waiting or running is made: one stopped, failed by the cleanup or already done is left alone
  // (a job BullMQ puts back after a worker died must not bring a stopped export back to life).
  if (!r || (r.status !== "queued" && r.status !== "running")) return;
  const project = await prisma.project.findUniqueOrThrow({ where: { id: r.projectId } });
  const video = await prisma.video.findUniqueOrThrow({ where: { id: project.videoId }, include: { analysis: true } });
  const version = await prisma.projectVersion.findUnique({ where: { projectId_v: { projectId: project.id, v: r.version } } });
  // A final of another file type asked for this export only (render_final format: sound only) is made as that type; the
  // edit's own export settings stay as they are.
  const snapshot = withExportFormat((version?.timeline ?? { timeline: project.timeline, name: project.name, aspect: project.aspect, styleId: project.styleId }) as unknown as Snapshot, r.kind === "final" ? (r.format as ExportFormat | null) : null);
  const transcript = (video.analysis?.transcript as unknown as Transcript) || [];
  const steps = (r.steps as string[]) || [];
  const kind = r.kind as "preview" | "final" | "sample";
  // Samples: a few frames and short clips of the edit (render_samples), from the preview copy, drawn as a preview is.
  const samples = kind === "sample" ? ((r.plan as { samples?: SamplePlan } | null)?.samples ?? null) : null;
  // A storyboard Rendrr fills itself (board.auto) gets its panels from the first plan below.
  if (kind === "sample" && !samples?.items?.length && !samples?.board?.auto) throw new JobError("These samples have nothing to render. Ask for them again.", "empty", false);
  const planKind: "preview" | "final" = kind === "final" ? "final" : "preview";
  // Where it is being made: Rendrr's cloud server until the user's Mac app takes the encode (then that Mac); why: why
  // the Mac did not make it, when the app was open.
  const where: { on: "mac" | "cloud"; device: string | null; why: string | null; platform?: "mac" | "windows"; next?: { device: string | null; platform: "mac" | "windows" } | null } = { on: "cloud", device: null, why: null };

  // Preview has a tighter limit than the queue's 15 minutes.
  const ac = new AbortController();
  ctx.signal.addEventListener("abort", () => ac.abort(), { once: true });
  let previewTimedOut = false;
  // The preview's own limit includes what its layers add (the same renderLimitMs as the job's, less the job's margin).
  const previewLimit = renderLimitMs("preview", video.seconds, r.quality, project.timeline) - 60_000;
  const armPreview = (ms: number) => (kind !== "final" ? setTimeout(() => { previewTimedOut = true; ac.abort(); }, ms) : null);
  let pt = armPreview(previewLimit);
  const signal = ac.signal;

  // Phase 7: the time left. Before the encode it comes from this user's last renders of the same kind and quality
  // (seconds of work per second of output); during the encode from its own speed, plus the packing after it. Never
  // made up: null (the UI says "Estimating") until one of the two exists.
  const t0 = Date.now();
  const prior = await workPerSecond(video.userId, kind, r.quality);
  const est = { outSeconds: video.seconds || 0, encStart: 0, encFrac: 0, encEnd: 0, matte: null as null | { start: number; frac: number }, dl: null as null | { start: number; frac: number } };
  const etaSec = (): number | null => {
    const now = Date.now();
    // While the user's computer fetches the files (a big original the first time): the download's own pace, then the
    // encode. (It said "about 5 s left" for the whole of a long download.)
    if (est.dl) return fetchEtaSec(est.dl, now, prior != null ? prior * est.outSeconds : 30);
    // While the person is cut out (remove_background): that work's own pace, then the render as usual.
    if (est.matte) {
      const spent = (now - est.matte.start) / 1000;
      return est.matte.frac > 0.03 ? Math.max(5, Math.round(spent / est.matte.frac - spent + (prior != null ? prior * est.outSeconds : 30))) : null;
    }
    if (est.encEnd) { const enc = (est.encEnd - est.encStart) / 1000; return Math.max(2, Math.round(enc * 0.12 + 5 - (now - est.encEnd) / 1000)); }
    if (est.encStart && (est.encFrac >= 0.02 || now - est.encStart > 8000) && est.encFrac > 0) {
      const spent = (now - est.encStart) / 1000, total = spent / est.encFrac;
      return Math.max(2, Math.round(total - spent + total * 0.12 + 5));
    }
    return prior != null ? Math.max(5, Math.round(prior * est.outSeconds - (now - t0) / 1000)) : null;
  };
  const send = (step: number, frac: number) => publishRender(r.id, { status: "running", step, steps, percent: Math.min(99, Math.round(((step + Math.max(0, Math.min(1, frac))) / steps.length) * 100)), etaSec: etaSec(), on: where.on, device: where.device, ...(where.platform ? { platform: where.platform } : {}), ...(where.on === "cloud" && where.next ? { next: where.next } : {}) });
  const sendThrottled = throttle(send, 400);
  const claimed = await prisma.render.updateMany({ where: { id: r.id, status: { in: ["queued", "running"] } }, data: { status: "running", startedAt: new Date(), error: null, errorCode: null } });
  if (!claimed.count) return;
  // The user's computer open and able: it makes the video once the cloud has it ready (the footage, graphics, checks),
  // so the export says so meanwhile (it said "not on this computer" while the cloud got it ready).
  const soon = await macForRender(video.userId, [], r.target ?? null).catch(() => null);
  if (soon?.info && !soon.why) where.next = { device: soon.info.device, platform: soon.info.platform };
  let i = 0;
  await send(0, 0);

  try {
    // ---- Source: the preview copy for previews, the original for finals ----
    const src = join(ctx.dir, "source");
    let tempOriginalIds: string[] = [];
    // The original read from the user's Drive: a render on their Mac fetches it there itself.
    let driveSource: { path: string; fileId: string; version?: string } | null = null;
    // Originals that stay on the user's Mac (footage added in the Rendrr Mac app, never uploaded): the plan is made from
    // their preview copies at the originals' size, and only that Mac can make the final (it reads the files itself).
    const macSources = new Map<string, { videoId: string; size: number }>();
    let macMain: MacOriginal | null = null;
    const macPre: MacRun[] = []; // runs the Mac makes before the encode (the shake measured on the original)
    if (kind !== "final") {
      if (!video.proxyKey) throw new JobError("The preview copy of this footage expired. Rebuild it from your Library, then render again.", "expired", false);
      await cachedCopy(video.proxyKey, src);
    } else if (video.sourceKey) {
      // Built-in samples and the fake Drive keep their original in our storage.
      if (steps[0] === "Fetching raw from Drive") { await send(0, 0.1); await cachedCopy(video.sourceKey, src); await send(0, 1); i = 1; }
      else await cachedCopy(video.sourceKey, src);
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
      driveSource = { path: src, fileId: video.driveFileId!, ...(f.date ? { version: String(f.date) } : {}) };
      i = 1;
    } else {
      const orig = await prisma.tempOriginal.findFirst({ where: { projectId: project.id, videoId: video.id, completed: true, expiresAt: { gt: new Date() } }, orderBy: { createdAt: "desc" } });
      if (orig) { await downloadFile(orig.key, src); tempOriginalIds = [orig.id]; }
      else {
        const mo = macOriginalOf(video);
        if (!mo || !video.proxyKey) throw new JobError("Full quality needs your original file once.", "need-original", false);
        await cachedCopy(video.proxyKey, src);
        macSources.set(src, { videoId: video.id, size: mo.size });
        macMain = mo;
      }
    }
    let info = await probe(src, { signal });
    // Kept on the Mac: the picture, rate and sound of the original (what the Mac will read), not of its preview copy.
    if (macMain) info = { ...info, width: macMain.width, height: macMain.height, fps: macMain.fps || info.fps, seconds: macMain.seconds || info.seconds, hasAudio: macMain.hasAudio, hdr: !!macMain.transfer, transfer: macMain.transfer ?? undefined };
    if (!info.hasVideo) throw new JobError("The footage file looks damaged. Try adding it again.", "damaged", false);
    // The original the user gave may be renamed or re-saved; it must still be the same video, or the edit's times would
    // land on other moments. A different one is deleted, so the next export asks for the file again.
    if (tempOriginalIds.length && video.seconds && info.seconds && Math.abs(info.seconds - video.seconds) > lengthTolerance(video.seconds)) {
      const origs = await prisma.tempOriginal.findMany({ where: { id: { in: tempOriginalIds } } });
      for (const o of origs) await deleteObject(o.key).catch(() => {});
      await prisma.tempOriginal.deleteMany({ where: { id: { in: tempOriginalIds } } });
      tempOriginalIds = [];
      const clock = (x: number) => `${Math.floor(x / 60)}:${(x % 60).toFixed(1).padStart(4, "0")}`;
      throw new JobError(`The file you gave is ${clock(info.seconds)} long; the footage is ${clock(video.seconds)}, so it is a different video. Export final again and pick '${video.originalName || video.name}'.`, "wrong-file", false);
    }
    // ...and face the way its preview copy does (the edit was made looking at that), whatever its own tag says.
    if (tempOriginalIds.length && video.proxyKey) {
      const proxyPath = join(ctx.dir, "facing-proxy.mp4");
      try {
        await cachedCopy(video.proxyKey, proxyPath);
        const f = await matchFacing(src, proxyPath, ctx.dir, signal);
        if (f.changed) {
          console.log(`[render] ${r.id}: the original was ${f.changed.say} from its preview copy (likeness ${f.before.toFixed(2)} -> ${f.after.toFixed(2)}); its orientation tag was set to match`);
          info = await probe(src, { signal });
        }
      } catch (e) {
        if ((e as Error).name === "AbortError" || signal?.aborted) throw e;
        console.error(`[render] ${r.id}: could not compare the original's facing:`, (e as Error).message);
      }
    }

    // ---- Reading timeline ----
    await send(i, 0.2);
    const style = snapshot.styleId ? await prisma.style.findUnique({ where: { id: snapshot.styleId } }) : null;
    const rules = style ? StyleRulesSchema.safeParse(style.rules) : null;
    // b-roll videos, the library video behind V1 (set_background videoId) and videos inside text: their preview copies.
    const brollIds = libraryVideoIds(snapshot.timeline);
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
    const budgets: Record<string, number> = { [video.id]: windowBudget(info) };
    const transcripts: Record<string, Transcript> = {};
    const hdrFootage: Record<string, HdrTransfer> = video.hdr ? { [video.id]: video.hdr as HdrTransfer } : {};
    const copies: string[] = [];
    if (isSequence(snapshot.timeline)) {
      const main = mainVideoOf(snapshot.timeline);
      // V1's other videos and the multicam angles its clips show (Phase 10).
      const otherIds = sourceVideoIds(snapshot.timeline).filter((id) => id !== main);
      const others = otherIds.length ? await prisma.video.findMany({ where: { id: { in: otherIds }, userId: video.userId }, include: { analysis: true } }) : [];
      // The other videos at once (each from the cache when an earlier render fetched it).
      await Promise.all(others.map(async (o) => {
        const key = kind === "final" && o.sourceKey ? o.sourceKey : o.proxyKey;
        if (!key) return;
        // A final made from originals on the Mac: the other videos kept there too are read there, at full quality.
        const omo = kind === "final" && macMain && !o.sourceKey ? macOriginalOf(o) : null;
        if (kind === "final" && !o.sourceKey && !omo) copies.push(o.name);
        const p = join(ctx.dir, `video-${o.id}`);
        await cachedCopy(key, p);
        const oi = await probe(p, { signal });
        if (!oi.hasVideo) throw new JobError(`"${o.name}" on V1 looks damaged. Remove it from the edit or add it again.`, "damaged", false);
        files.videos![o.id] = p;
        budgets[o.id] = windowBudget(oi);
        sources[o.id] = omo
          ? { width: omo.width, height: omo.height, fps: omo.fps || oi.fps, seconds: omo.seconds || oi.seconds || o.seconds, hasAudio: omo.hasAudio, hdr: !!omo.transfer, ...(omo.transfer ? { transfer: omo.transfer } : {}) }
          : { width: oi.width, height: oi.height, fps: oi.fps, seconds: oi.seconds || o.seconds, hasAudio: oi.hasAudio, hdr: !!oi.hdr, ...(oi.transfer ? { transfer: oi.transfer } : {}) };
        if (omo) macSources.set(p, { videoId: o.id, size: omo.size });
        if (o.hdr) hdrFootage[o.id] = o.hdr as HdrTransfer;
        transcripts[o.id] = (o.analysis?.transcript as unknown as Transcript) || [];
      }));
    }
    // Phase 6: the imported LUTs the grades use (one that is gone renders without it, and the check says so).
    const lutIds = Array.from(new Set([...snapshot.timeline.tracks.v1, ...snapshot.timeline.tracks.v2].map((c) => (c as ClipLook).grade?.lut?.id).filter((x): x is string => !!x)));
    const luts: Record<string, Lut> = {};
    for (const l of lutIds.length ? await prisma.lut.findMany({ where: { id: { in: lutIds }, userId: video.userId } }) : []) {
      try { luts[l.id] = parseCube(await getText(l.key)); } catch (e) { console.error("[render] LUT skipped:", l.id, (e as Error).message.slice(0, 200)); }
    }
    // The user's own audio files the edit uses (own music, the voice): only theirs, only ready ones.
    const soundIds = Array.from(new Set([...(snapshot.timeline.tracks.a2 as { soundId?: string }[]).map((c) => c.soundId), (snapshot.timeline as { voice?: { soundId?: string } | null }).voice?.soundId].filter((x): x is string => !!x)));
    const soundRows = soundIds.length ? await prisma.sound.findMany({ where: { id: { in: soundIds }, userId: video.userId, status: "ready" } }) : [];
    const sounds = Object.fromEntries(soundRows.map((s) => [s.id, { key: s.key, seconds: s.seconds, name: s.name }]));
    // Best quality (render_final quality "best", in the render's quality label): the highest resolution the main
    // footage fills in the edit's shape (4K vertical phone footage in a 9:16 edit: 4K; never below 1080p) and a finer
    // encode (RenderPlan.best).
    const best = kind === "final" && isBestQuality(r.quality);
    if (best) {
      const ex = snapshot.timeline.export ?? {};
      snapshot.timeline.export = { ...ex, resolution: ex.resolution === "4k" || bestResolution(snapshot.aspect, info.width, info.height) === "4k" ? "4k" : "1080p" };
    }
    const planBase = { kind: planKind, snapshot, transcript, source: sourceInfo, best, videoId: video.id, sources, transcripts, captionRules: rules?.success ? rules.data.captions : undefined, brollSeconds: Object.fromEntries(brollVideos.map((b) => [b.id, b.seconds])), luts, hdrFootage, sounds };

    // A first plan tells us the output size, so graphics can be drawn at the right resolution.
    const first = planRender(planBase);
    // Storyboard mode, panels left to Rendrr: the opening, the scenes, the titles, graphics and b-roll of this plan.
    if (samples?.board?.auto && !samples.items.length) {
      samples.items = storyboardAutoPanels(first);
      if (!samples.items.length) throw new JobError("This edit has nothing to put on a storyboard yet.", "empty", false);
    }
    const graphicsReady: Record<string, boolean> = {};
    const graphicErrors: string[] = [];
    // Only graphics that are still in the edit, each drawn for the time it is on screen.
    const sampleWins = samples ? samples.items.map((it) => sampleWindow(it, first.fps || 30)) : null;
    for (const sp of first.graphics) {
      const c = graphicClips.find((x) => x.id === sp.clipId);
      if (!c) continue;
      // Samples: only the graphics on screen in one of them are recorded.
      if (sampleWins && !sampleWins.some((w) => sp.end > w.from + 1e-9 && sp.start < w.to - 1e-9)) continue;
      try {
        // A long graphic is recorded here (Phase 7): its progress moves this step.
        const got = await renderGraphicClip(c, { width: first.width, height: first.height, dir: ctx.dir, userId: video.userId, signal, durationSec: sp.end - sp.start, onProgress: (f) => sendThrottled(i, 0.2 + 0.7 * f) });
        if (got) { files.graphics![c.id] = got.path; files.graphicSeconds![c.id] = got.seconds; graphicsReady[c.id] = true; }
      } catch (e) {
        if (signal.aborted) throw e;
        // A placement that could not be recorded (tried again first) stops the render, naming it and its params.
        console.error("[render] graphic placement failed:", c.id, c.graphicId, (e as Error).message.slice(0, 300));
        if (e instanceof JobError && e.code === "graphic-placement") throw e;
        throw new JobError(`Graphic placement ${c.id} (${c.graphicId}${c.params && Object.keys(c.params).length ? `, params ${JSON.stringify(c.params).slice(0, 300)}` : ""}) could not be drawn: ${(e as Error).message.slice(0, 300).replace(/\.$/, "")}. Nothing was lost.`, "graphic-placement", false);
      }
    }
    const plan = planRender({ ...planBase, graphicsReady });
    plan.operations.push(...graphicErrors);
    // Show only the fix (#23): the moments this preview changed since the one its comments were made on, worked out
    // while it renders (kept with the render for the Rendrr app's player; never fails the render).
    const fixed = kind === "preview" && !samples ? previewFix(r, plan, { ...planBase, graphicsReady }) : Promise.resolve(null);
    // Storyboard mode: the words on screen in each panel (its frame, or a clip's middle), and the edit's style sheet.
    let boardOut: Board | undefined;
    if (samples?.board) {
      for (const it of samples.items as BoardPanel[]) { const said = onScreenAt(plan, it.kind === "clip" ? it.at + Math.min(1, (it.end! - it.at) / 2) : it.at); if (said) it.onScreen = said; else delete it.onScreen; }
      const tl = snapshot.timeline, music = plan.audio.filter((a) => a.kind === "music");
      const cuts = plan.parts.reduce((n, p, k) => n + (k > 0 && p.clipIds[0] !== plan.parts[k - 1].clipIds[0] ? 1 : 0), 0);
      const bg = (tl as { background?: { color?: string } }).background;
      boardOut = { ...samples.board, style: boardStyle({
        aspect: snapshot.aspect, outputSeconds: plan.outputSeconds, width: plan.width, height: plan.height, captionStyle: plan.captionStyle, captionsOn: !!tl.captionsOn && !!plan.styledCaptions?.length,
        texts: plan.texts, background: plan.background ? { color: bg?.color, text: plan.background.text } : null, transitions: plan.transitions, cuts,
        look: lookText(tl), music: music.length ? `${music.length} ${music.length === 1 ? "track" : "tracks"} (${music.map((m) => m.soundId ? "your own file" : m.assetKey.split("/").pop()!.replace(/\.[a-z0-9]+$/i, "")).join(", ")}), ${plan.audioMix?.duck ? `${plan.audioMix.duck} dB down under speech` : "not ducked"}` : "none",
        sound: audioText(audioSettings(tl)),
      }, samples.board.palette) };
    }
    // Samples: the shake and the person's matte only where a sample reads them.
    if (sampleWins) {
      const subs = sampleWins.map((w) => windowPlan(plan, w.from, w.to));
      if (plan.stabilize) { const keep = Object.entries(plan.stabilize).filter(([k]) => subs.some((x) => x.stabilize?.[k])); plan.stabilize = keep.length ? Object.fromEntries(keep) : undefined; }
      if (plan.stabilized) { const keep = Object.entries(plan.stabilized).filter(([k]) => subs.some((x) => x.stabilized?.[k])); plan.stabilized = keep.length ? Object.fromEntries(keep) : undefined; }
      if (plan.mattes) {
        const m: NonNullable<RenderPlan["mattes"]> = {};
        for (const x of subs) for (const [n, mo] of Object.entries(x.mattes ?? {})) m[n] = m[n] ? { ...mo, blocks: Array.from(new Set([...m[n].blocks, ...mo.blocks])).sort((a, b) => a - b) } : mo;
        plan.mattes = Object.keys(m).length ? m : undefined;
      }
      est.outSeconds = sampleWins.reduce((acc, w) => acc + (w.to - w.from), 0);
    }
    if (!sampleWins) est.outSeconds = plan.outputSeconds;
    if (copies.length) plan.operations.push(`Other videos without an original in Rendrr use their 720p copy: ${copies.join(", ")}`);
    // B-roll fetched 4 at a time, not one after another (audit #12).
    await eachLimit([...plan.broll, ...(plan.under ?? [])], 4, async (b) => {
      const bv = brollVideos.find((x) => x.id === b.videoId);
      if (bv?.proxyKey) { const p = join(ctx.dir, `broll-${b.clipId}.mp4`); await cachedCopy(bv.proxyKey, p); (plan.under?.includes(b) ? files.under! : files.broll!)[b.clipId] = p; }
    });
    if (plan.background?.videoId) {
      const bv = brollVideos.find((x) => x.id === plan.background!.videoId);
      if (bv?.proxyKey) { const p = join(ctx.dir, "background.mp4"); await cachedCopy(bv.proxyKey, p); files.background = p; }
    }
    // Phase 6: the grades as .cube files and the masks as pictures, at the render's size (and a card's shadow and
    // border, and the background's colour or gradient).
    for (const [name, spec] of Object.entries(plan.lookFiles ?? {})) {
      const p = join(ctx.dir, `look-${name}`);
      if (spec.kind === "moving") await writeMoving(spec, plan, p, signal);
      else await writeFile(p, lookFileData(spec, plan, luts));
      files.looks![name] = p;
    }
    // Phase 7: each stabilized part's shake, measured on the frames the render will read.
    for (const [key, st] of Object.entries(plan.stabilize ?? {})) {
      const src = st.videoId === video.id ? files.source : files.videos?.[st.videoId];
      if (!src) continue;
      const p = join(ctx.dir, st.file);
      // From an original on the Mac: measured there, on the original's own pixels.
      if (macSources.has(src)) macPre.push({ args: detectShakeArgs(src, st, plan.rate || String(plan.fps || 30), p) });
      else await detectShake(src, st, plan.rate || String(plan.fps || 30), p, signal);
      (files.stabilize ??= {})[key] = p;
    }
    // Phase 21: b-roll and clips at other speeds: the shake measured over the clip's footage, then its stabilized copy.
    for (const [clipId, st] of Object.entries(plan.stabilized ?? {})) {
      const src = st.broll ? (files.broll?.[clipId] ?? files.under?.[clipId]) : st.videoId === video.id ? files.source : files.videos?.[st.videoId];
      if (!src) continue;
      const trf = join(ctx.dir, st.file), copy = join(ctx.dir, st.copy);
      if (macSources.has(src)) macPre.push({ args: detectShakeArgs(src, st, plan.rate || String(plan.fps || 30), trf) }, { args: stableCopyArgs(src, st, plan.rate || String(plan.fps || 30), trf, copy, !!plan.hdr) });
      else {
        await detectShake(src, st, plan.rate || String(plan.fps || 30), trf, signal);
        await makeStableCopy(src, st, plan.rate || String(plan.fps || 30), trf, copy, { deep: !!plan.hdr, signal });
      }
      (files.stableCopies ??= {})[clipId] = copy;
    }
    // Face-aware Morph Cut: the face either side of each morph (a cut with no face found keeps the plain morph).
    if (plan.transitions?.some((t) => t.type === "morph" && t.face !== false)) files.morphFaces = await morphFaces(plan, files, ctx.dir, signal).catch(() => ({}));
    // Phase 6: each reverb room's impulse response (seeded: the same room as the editor's player hears).
    for (const [name, size] of Object.entries(plan.audioMix?.irs ?? {})) {
      const p = join(ctx.dir, name), [l, r] = reverbIr(size);
      await writeFile(p, wavStereo(l, r));
      (files.irs ??= {})[name] = p;
    }
    // remove_background: the person's matte, made once per block of footage and kept (the first render waits for it).
    // The preview's clock stops meanwhile (the job's own limit allows for it: matteAllowanceMs).
    if (plan.mattes) {
      const m0 = Date.now();
      if (pt) clearTimeout(pt);
      const label = steps[i];
      steps[i] = "Cutting out the person";
      est.matte = { start: m0, frac: 0 };
      files.mattes = await ensureMattes(plan, video.userId, ctx.dir, signal, (f) => { est.matte!.frac = f; sendThrottled(i, 0.2 + 0.7 * f); });
      steps[i] = label;
      est.matte = null;
      if (pt) pt = armPreview(Math.max(60_000, previewLimit - (m0 - t0)));
      if (Date.now() - m0 > 3000) plan.operations.push(`Background: the person's matte made in ${Math.round((Date.now() - m0) / 1000)} s (kept: the next render reuses it)`);
    }
    // Studio voice: the dialogue's noise, room and echo taken out by the AI, made once per block of footage and kept
    // (the first render waits for it; the job's own limit allows for it: voiceAllowanceMs).
    if (plan.voices) {
      const v0 = Date.now();
      if (pt) clearTimeout(pt);
      const label = steps[i];
      steps[i] = "Cleaning up the voice";
      est.matte = { start: v0, frac: 0 };
      try {
        files.voices = await ensureVoices(plan, video.userId, ctx.dir, signal, (f) => { est.matte!.frac = f; sendThrottled(i, 0.2 + 0.7 * f); });
        if (Date.now() - v0 > 3000) plan.operations.push(`Studio voice: made in ${Math.round((Date.now() - v0) / 1000)} s (kept: the next render reuses it)`);
      } catch (e) {
        // A voice that cannot be made does not stop the render: the footage's own sound plays, with the cleanup's tone.
        if (signal.aborted) throw e;
        console.error(`[render] ${r.id}: studio voice not made: ${(e as Error).message}`);
        plan.voices = undefined;
        plan.operations = plan.operations.filter((o) => !o.startsWith("Studio voice: the dialogue read"));
        plan.operations.push(`Studio voice: could not be made (${(e as Error).message.slice(0, 160)}): the footage's own sound plays, with the cleanup's tone`);
      }
      steps[i] = label;
      est.matte = null;
      if (pt) pt = armPreview(Math.max(60_000, previewLimit - (v0 - t0)));
    }
    // Every sound checked first (the same refusals, in the same order), then fetched 4 at a time (audit #12).
    for (const a of plan.audio) {
      if (a.soundId) { if (!soundRows.find((s) => s.id === a.soundId)) throw new JobError("This edit uses an audio file that is not in your Rendrr. Remove it and try again.", "bad-audio", false); continue; }
      // Built-in music and sound effects only (the plan takes keys from the catalog; this is a second lock).
      if (!a.assetKey.startsWith(PREFIX.assets)) throw new JobError("This edit uses a sound that is not in the library. Remove it and try again.", "bad-audio", false);
    }
    await eachLimit(plan.audio, 4, async (a) => {
      // The user's own file: the one found for this user above (its key from the database, not the edit).
      if (a.soundId) {
        const own = soundRows.find((s) => s.id === a.soundId)!;
        const p = join(ctx.dir, `sound-${own.id}.m4a`);
        await cachedCopy(own.key, p);
        files.audio![a.clipId] = p;
        return;
      }
      files.audio![a.clipId] = await cachedAsset(a.assetKey);
    });
    // Music shorter than its part was looped by FFmpeg inside the edit's graph (-stream_loop); a heavy final froze
    // where the loop came round. The loop is made here instead, in a small pass of its own, as plain PCM.
    for (const a of plan.audio) {
      if (a.kind !== "music" || !files.audio?.[a.clipId]) continue;
      const looped = await loopedMusic(files.audio[a.clipId], a.end - a.start, join(ctx.dir, `music-${a.clipId}.wav`), signal);
      if (looped) files.audio[a.clipId] = looped;
    }
    if (plan.ass) await writeFile(files.assPath!, plan.ass);
    if (plan.assBehind) { files.assBehindPath = join(ctx.dir, "behind.ass"); await writeFile(files.assBehindPath, plan.assBehind); }
    // Phase 2b: text drawn from a mask: its mask and what is drawn round it, and the library video in its letters.
    for (const m of plan.textMattes ?? []) {
      const mp = join(ctx.dir, `text-${m.clipId}-mask.ass`);
      await writeFile(mp, m.mask);
      (files.textMasks ??= {})[m.clipId] = mp;
      if (m.decor) { const dp = join(ctx.dir, `text-${m.clipId}-decor.ass`); await writeFile(dp, m.decor); (files.textDecor ??= {})[m.clipId] = dp; }
      const bv = m.inside && brollVideos.find((x) => x.id === m.inside!.videoId);
      if (bv && bv.proxyKey) { const p = join(ctx.dir, `inside-${bv.id}.mp4`); await cachedCopy(bv.proxyKey, p); (files.insides ??= {})[m.clipId] = p; }
    }
    // Phase 17: keyframed text layers with motion blur, each drawn from its own ASS file.
    for (const b of plan.textBlurs ?? []) {
      const bp = join(ctx.dir, `text-${b.clipId}-blur.ass`);
      await writeFile(bp, b.ass);
      (files.textBlurs ??= {})[b.clipId] = bp;
    }
    await send(i, 1);
    i++;

    // ---- On the user's Mac: while its Rendrr app is open and able, the encode's FFmpeg runs are made there (the files
    // they read go by link, what they make is uploaded by the Mac to this render's keys). Null: the cloud makes them
    // (the app is closed, cannot take these, did not pick them up in time, went quiet or failed: where.why says).
    const label = `${kind === "final" ? "Final" : kind === "sample" ? "Samples" : "Preview"} v${r.version} of ${project.name}`;
    // Which computer: the one keeping the original (only it can read it), else the one the user picked (r.target: its
    // id, or "cloud"), else the best one free.
    const macCpus = async (): Promise<{ cpus: number; have: string[]; platform: "mac" | "windows"; id: string } | null> => {
      const m = await macForRender(video.userId, [], macMain?.deviceId ?? r.target ?? null).catch(() => ({ info: null, why: null }));
      if (m.why && (m.info || (r.target && r.target !== "cloud"))) where.why = m.why; // (no computer open: nothing to say)
      if (!m.info || m.why) where.next = null; // the cloud makes the video after all
      return m.info && !m.why ? { cpus: m.info.cpus, have: m.info.have, platform: m.info.platform, id: m.info.id } : null;
    };
    // While the user's computer fetches the files: the job's limit is moved later as the fetch goes, and a preview's own
    // clock stops (started again after, with what was left of it).
    let dlHeld = 0, previewHeld = false;
    const fetched = () => {
      if (!est.dl) return;
      ctx.extend?.(Date.now() - dlHeld);
      if (previewHeld) { previewHeld = false; pt = armPreview(Math.max(60_000, previewLimit - (est.dl.start - t0))); }
      est.dl = null;
    };
    const onMac = async (mac: { have: string[]; platform?: "mac" | "windows"; id?: string }, runs: MacRun[], outputs: MacOut[], onRender: (cmd: number, seconds: number) => void): Promise<MacDone | null> => {
      const W = machineWord(mac.platform); // "Mac" or "PC"
      let task: Awaited<ReturnType<typeof macTaskFor>>;
      where.next = null; // from here, the export says where it is: on the computer once it takes it, else the cloud
      try { task = await macTaskFor({ deviceId: mac.id ?? null, renderId: r.id, userId: video.userId, kind, label, dir: ctx.dir, fontsDir: FONTS_DIR, runs, outputs, driveSource, macSources }); }
      catch (e) {
        // Whatever stops the hand-off (a render the Mac cannot be given, storage refusing a file): the cloud makes it.
        if (signal.aborted) throw e;
        console.error(`[render] ${r.id}: made on the cloud, not the Mac: ${(e as Error).message}`);
        where.why = e instanceof NotForMac ? `this render cannot be made on a ${W} yet` : `its files could not be readied for the ${W}`;
        return null;
      }
      const missing = task.spec.needs.filter((n) => !mac.have.includes(n));
      if (missing.length) { where.why = `the ${W}'s FFmpeg lacks ${missing.join(", ")}`; await dropTemps(task.temps); return null; }
      const at = i, was = steps[at];
      try {
        const res = await runOnMac(task.spec, {
          signal, machine: W,
          onClaim: (device, platform) => { where.on = "mac"; where.device = device; where.platform = platform; where.why = null; where.next = null; steps[at] = `Getting the files to your ${machineWord(platform)}`; void send(at, 0); },
          onDownload: (f) => {
            const now = Date.now();
            if (!est.dl) { est.dl = { start: now, frac: 0 }; dlHeld = now; if (pt) { clearTimeout(pt); pt = null; previewHeld = true; } }
            // The time limits do not count the fetch (the user's line, not this server's work): moved later as it goes.
            ctx.extend?.(now - dlHeld); dlHeld = now;
            est.dl.frac = f; sendThrottled(at, 0.98 * f);
          },
          onRender: (cmd, sec) => { if (est.dl) { fetched(); est.encStart = Date.now(); } if (steps[at] !== was) steps[at] = was; onRender(cmd, sec); },
          onUpload: () => { if (steps[at] !== was) steps[at] = was; },
        }).catch((e) => { if (signal.aborted) throw e; return { ok: false as const, why: `the hand-off to your ${W} broke (${(e as Error).message.slice(0, 120)})` }; });
        steps[at] = was;
        if (res.ok) { console.log(`[render] ${r.id}: made on the user's Mac${res.device ? ` "${res.device}"` : ""}`); return res; }
        console.error(`[render] ${r.id}: the Mac did not make it (${res.why}): making it on the cloud`);
        where.on = "cloud"; where.device = null; where.platform = undefined; where.why = res.why; where.next = null;
        plan.operations.push(`Made on Rendrr's cloud server: ${res.why}`);
        await send(at, 0);
        return null;
      } finally { steps[at] = was; fetched(); await dropTemps(task.temps); }
    };

    // ---- Measuring loudness: the mix, audio only, so the render can set it to the target exactly ----
    let mixLoudness: MixLoudness | null = null;
    const measuring = steps[i] === "Measuring loudness";
    // (Stills have no sound: samples measure only when one of them is a clip.)
    if (plan.audioMix?.loudness != null && (!samples || samples.items.some((x) => x.kind === "clip"))) {
      mixLoudness = await measureMix(plan, files, sourceInfo, { dir: ctx.dir, signal, onProgress: measuring ? (f) => sendThrottled(i, f) : undefined });
    }
    if (measuring) { await send(i, 1); i++; }
    // Threads: the encoder as many as the container's CPUs (x264 left alone takes 1.5 times the host's 48), the decoders
    // twice that between them; once more after running out, one filter thread and one per decoder.
    const cpus = cpuBudget();
    // ---- Samples: each frame or clip rendered on its own from the plan cut down to it (windowPlan): a frame as a
    // JPEG, a clip as an MP4 with its first frame as its still. No check runs (render_preview's check is for the whole).
    if (samples) {
      const items = samples.items, fps = plan.fps || 30;
      const base = `${PREFIX.previews}${video.userId}/${project.id}/${r.id}`;
      const weightOf = (it: (typeof items)[number]) => (it.kind === "clip" ? it.end! - it.at : 0.5);
      const total = items.reduce((acc, it) => acc + weightOf(it), 0);
      const done: SampleDone[] = [], keys: string[] = [];
      let spent = 0, bytes = 0;
      await closeIdleBrowsers().catch(() => {}); // the browsers kept from recording its graphics are not needed now
      est.encStart = Date.now();
      // On the user's Mac: each sample's run (a clip's first frame made there too, as its still), uploaded by the Mac.
      const mac = await macCpus();
      let macMade = false;
      if (mac) {
        const runs: MacRun[] = [], outs: MacOut[] = [], cmdItem: number[] = [], made: SampleDone[] = [];
        for (const [k, it] of items.entries()) {
          const w = sampleWindow(it, fps), sub = windowPlan(plan, w.from, w.to), still = it.kind === "frame";
          const out = join(ctx.dir, still ? `sample-${k}.jpg` : `sample-${k}.mp4`), stillPath = still ? out : join(ctx.dir, `sample-${k}.jpg`);
          const o = { threads: mac.cpus, inputThreads: mac.cpus * 2, loudnessGainDb: mixLoudness?.gainDb, windowBudget: budgets, still };
          const f = { ...files, output: out };
          const a = ffmpegArgs(sub, f, sourceInfo, { ...o, filterThreads: filterThreads(ffmpegArgs(sub, f, sourceInfo, { ...o, filterThreads: 4 }).filterGraph) });
          runs.push({ args: a.args, graph: a.filterGraph, seconds: Math.max(0.04, w.to - w.from) }); cmdItem.push(k);
          const stillKey = `${base}-s${k}.jpg`, clipKey = still ? undefined : `${base}-c${k}.mp4`;
          if (!still) { runs.push({ args: frameArgs(out, 0, stillPath, plan.width) }); cmdItem.push(k); }
          outs.push({ path: stillPath, key: stillKey, type: "image/jpeg" });
          if (clipKey) outs.push({ path: out, key: clipKey, type: "video/mp4" });
          made.push({ ...it, still: stillKey, ...(clipKey ? { clip: clipKey } : {}) });
        }
        const before = items.map((_, k) => items.slice(0, k).reduce((acc, x) => acc + weightOf(x), 0));
        const res = await onMac(mac, runs, outs, (cmd, sec) => {
          const k = cmdItem[cmd] ?? 0, it = items[k], w = sampleWindow(it, fps);
          const f = (before[k] + Math.min(1, sec / Math.max(0.05, w.to - w.from)) * weightOf(it)) / total;
          est.encFrac = f; sendThrottled(i, f);
        });
        if (res) {
          macMade = true;
          done.push(...made);
          keys.push(...outs.map((x) => x.key));
          bytes = outs.reduce((acc, x) => acc + (res.outputs[relative(ctx.dir, x.path)] ?? 0), 0);
        }
      }
      try {
      if (!macMade) for (const [k, it] of items.entries()) {
        const w = sampleWindow(it, fps), sub = windowPlan(plan, w.from, w.to), still = it.kind === "frame";
        const out = join(ctx.dir, still ? `sample-${k}.jpg` : `sample-${k}.mp4`);
        const argsOf = (ft: number, decode = cpus * 2) => ffmpegArgs(sub, { ...files, output: out }, sourceInfo, { threads: Number(process.env.FFMPEG_THREADS || 0) || cpus, filterThreads: ft, inputThreads: decode, loudnessGainDb: mixLoudness?.gainDb, windowBudget: budgets, still });
        const gp = join(ctx.dir, `graph-sample-${k}.txt`);
        const go = async (a: ReturnType<typeof argsOf>) => { await writeFile(gp, a.filterGraph); await run("ffmpeg", a.args.map((x) => (x === "__FILTER_SCRIPT__" ? gp : x)), { signal, onProgress: (sec) => { const f = (spent + Math.min(1, sec / Math.max(0.05, w.to - w.from)) * weightOf(it)) / total; est.encFrac = f; sendThrottled(i, f); } }); };
        try {
          try { await go(argsOf(filterThreads(argsOf(4).filterGraph))); }
          catch (e) { if (signal.aborted || !outOfThreads(e)) throw e; await go(argsOf(1, 1)); }
        } catch (e) {
          if (signal.aborted) throw e;
          console.error("[render] sample failed:", k, (e as Error).message.slice(0, 2600));
          throw new JobError(`Sample ${k + 1} (${it.kind} at ${it.at.toFixed(2)} s) could not be rendered. Nothing was lost. Try again.`, "ffmpeg", true);
        }
        const stillPath = still ? out : join(ctx.dir, `sample-${k}.jpg`);
        if (!still) await frameAt(out, 0, stillPath, plan.width, signal);
        const stillKey = `${base}-s${k}.jpg`;
        await uploadFile(stillKey, stillPath, "image/jpeg");
        keys.push(stillKey);
        bytes += (await stat(stillPath)).size;
        let clipKey: string | undefined;
        if (!still) { clipKey = `${base}-c${k}.mp4`; await uploadFile(clipKey, out, "video/mp4"); keys.push(clipKey); bytes += (await stat(out)).size; }
        done.push({ ...it, still: stillKey, ...(clipKey ? { clip: clipKey } : {}) });
        spent += weightOf(it);
        await send(i, spent / total);
      }
      } catch (e) {
        // A sample failed (or the job was stopped): the ones already stored go, so nothing is left behind.
        await deleteObjects(keys).catch(() => {});
        throw e;
      }
      est.encEnd = Date.now();
      // The user's notes may have changed while this rendered (asking for the same samples with new words): the latest.
      const latest = ((await prisma.render.findUnique({ where: { id: r.id }, select: { plan: true } }))?.plan as { samples?: SamplePlan } | null)?.samples;
      const now = latest?.items;
      // A storyboard's words (title, caption, shot, note) may have been changed the same way: the latest too.
      const WORDS = ["note", "title", "caption", "shot"] as const;
      const noted = <T extends { note?: string }>(xs: T[]) => xs.map((x, k) => {
        if (!now?.[k]) return x;
        const y = { ...x } as Record<string, unknown>;
        for (const w of WORDS) { if (!samples.board && w !== "note") continue; const v = (now[k] as Record<string, unknown>)[w]; if (v != null) y[w] = v; else delete y[w]; }
        return y as T;
      });
      // The board as it is now (its title, rules or palette asked again while this drew), with the style sheet read here.
      const boardNow = boardOut ? { ...boardOut, ...(latest?.board ? { title: latest.board.title, rules: latest.board.rules, palette: latest.board.palette, status: latest.board.status } : {}) } : undefined;
      i = steps.length - 1;
      await send(i, 0.5);
      const seconds = Math.round(items.reduce((acc, it) => acc + (it.kind === "clip" ? it.end! - it.at : 0), 0) * 1000) / 1000;
      if (signal.aborted) { await deleteObjects(keys).catch(() => {}); throw new JobError("Stopped."); }
      await prisma.render.updateMany({ where: { id: r.id, status: "running" }, data: {
        status: "done", outputKey: null, sizeBytes: BigInt(bytes), seconds, framesKeys: keys, finishedAt: new Date(), quality: "540p", made: { on: where.on, device: where.device, why: where.why, ...(where.platform ? { platform: where.platform } : {}) },
        plan: { samples: { items: noted(items), done: noted(done), width: plan.width, height: plan.height, ...(boardNow ? { board: boardNow } : {}) }, operations: plan.operations, outputSeconds: plan.outputSeconds, mix: mixLoudness } as unknown as Prisma.InputJsonValue,
      } });
      await usage(video.userId, "render_preview", Math.round((Math.max(seconds, items.length / fps) / 60) * 100) / 100, { projectId: project.id, renderId: r.id });
      // Samples are previews for billing: free on Starter, counted in the trial.
      const sampleMin = Math.round((Math.max(seconds, items.length / fps) / 60) * 1000) / 1000;
      noteCost({ kind: "render_samples", refId: r.id, outputBytes: bytes });
      if (r.by !== "gallery") await recordUsage({ userId: video.userId, metric: "preview", quantity: sampleMin, billable: billableMinutes({ minutes: sampleMin, on: where.on }), refId: r.id, meta: { projectId: project.id, samples: true, on: where.on } });
      await publishRender(r.id, { status: "done", step: steps.length, steps, percent: 100, on: where.on, device: where.device, ...(where.platform ? { platform: where.platform } : {}) });
      return { samples: done.length };
    }
    // Phase 12: what the final is made as. Sound only goes straight to its file; the overlay export renders over black
    // first (and over white after); a GIF is made from the MP4.
    const fmt = plan.format;
    if (fmt === "overlay") files.output = join(ctx.dir, "out-b.mkv");
    else if (fmt === "audio") files.output = join(ctx.dir, "out.m4a");
    else if (fmt === "wav") files.output = join(ctx.dir, "out.wav");
    // Where the file goes in storage (the Mac uploads it there itself when it makes it) and its name for people.
    const prefix = kind === "final" ? PREFIX.finals : PREFIX.previews;
    const base = `${prefix}${video.userId}/${project.id}/${r.id}`;
    const ff = formatFile(fmt);
    const outKey = `${base}.${ff.ext}`;
    const stem = `${(project.name || "rendrr").replace(/[^\w\- ]+/g, "").trim() || "rendrr"} ${kind === "final" ? "final" : "preview"} v${r.version}`;
    const argsFor = (ft: number, decode = cpus * 2, pictureAs?: "black" | "white") => ffmpegArgs(plan, files, sourceInfo, { threads: Number(process.env.FFMPEG_THREADS || 0) || cpus, filterThreads: ft, inputThreads: decode, loudnessGainDb: mixLoudness?.gainDb, windowBudget: budgets, ...(fmt === "overlay" ? { pictureAs: pictureAs ?? "black" } : {}) });
    // The browsers kept from recording this edit's graphics (about 80 threads each) are not needed for the encode.
    await closeIdleBrowsers().catch(() => {});
    // The graph decides how many filter threads it may have (it is the same text whatever that number); then what is
    // free in the container decides how many it gets.
    const ft0 = filterThreads(argsFor(4).filterGraph), atFull = argsFor(ft0);
    const use = threadUse(), free = use.current != null && use.max != null ? use.max - use.current : null;
    const fit = fitFfmpegThreads({ graph: atFull.filterGraph, args: atFull.args, ft: ft0, dec: cpus * 2, cpus, free });
    console.log(`[render] ${r.id}: ${fit.scalers} scalers, ${fit.inputs} inputs, ${free ?? "?"} threads free: filter threads ${fit.ft} of ${ft0}, decoders ${fit.dec} (about ${fit.need} threads)`);
    const { args, filterGraph } = fit.ft === ft0 && fit.dec === cpus * 2 ? atFull : argsFor(fit.ft, fit.dec);
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
    // ---- In pieces: FFmpeg killed by the container (its memory ran out: many big sources at once, e.g. wide b-roll
    // scaled up to cover a vertical frame) makes the edit again in pieces of about 15 s, each drawn from the plan cut
    // down to it (windowPlan: only the sources it shows, drawn exactly as the whole), its sound uncompressed; then the
    // pieces are joined (picture copied, sound encoded once). A piece killed again is made as two halves (down to 2 s).
    const killed = (e: unknown) => !signal.aborted && /exited with null/.test((e as Error)?.message || "");
    const canPiece = plan.model !== "A" && fmt !== "overlay" && fmt !== "audio" && fmt !== "wav";
    // The sound is made once for the whole edit, on its own (no picture read), and each piece is picture only: a piece
    // that made its own sound ran the whole mix from 0 and dropped what came before it, and far into a heavy edit
    // FFmpeg froze doing that (its picture waiting on its sound, the sound on the picture). The joined picture gets
    // the one sound track. A piece that still freezes (see run's stallMs) is made again with one filter thread and
    // one thread per decoder; frozen again, as two halves (down to 2 s), each the same way.
    // A cloud preview (audit #13) passes `cache`: each piece is looked up in storage by its key (lib/pieceCache) and taken
    // back when this edit's last preview made the same piece; the rest are made and stored for the next preview.
    const renderInPieces = async (why = "FFmpeg was killed (out of memory)", cache?: { prefix: string }) => {
      const FPS = plan.fps || 30, onGrid = (t: number) => Math.round(t * FPS) / FPS;
      const queue: { a: number; b: number; simple?: boolean; froze?: boolean }[] = pieceRanges(plan);
      const made: string[] = [];
      const used = new Set<string>(), uploads: Promise<void>[] = [], seen = new Map<string, string>();
      let reused = 0;
      console.error(`[render] ${r.id}: ${why}: making it in ${queue.length} pieces`);
      const soundPath = join(ctx.dir, "sound.wav"), soundGraph = join(ctx.dir, "graph-sound.txt");
      const sa = ffmpegArgs(plan, { ...files, output: soundPath }, sourceInfo, { threads: 2, inputThreads: cpus * 2, loudnessGainDb: mixLoudness?.gainDb, sound: "only" });
      await writeFile(soundGraph, sa.filterGraph);
      const soundRun = (a: typeof sa) => run("ffmpeg", a.args.map((x) => (x === "__FILTER_SCRIPT__" ? soundGraph : x)), { signal, stallMs: STALL_MS, onProgress: () => {} });
      try { await soundRun(sa); }
      catch (e) {
        if (!stalled(e)) throw e;
        // The sound froze: once more with one thread each, then the time it froze at, as for the picture.
        console.error(`[render] ${r.id}: the sound pass froze at ${e.at.toFixed(2)} s. Threads: ${e.threads}`);
        const one = ffmpegArgs(plan, { ...files, output: soundPath }, sourceInfo, { threads: 1, inputThreads: 1, loudnessGainDb: mixLoudness?.gainDb, sound: "only" });
        await writeFile(soundGraph, one.filterGraph);
        try { await soundRun(one); }
        catch (e2) { if (stalled(e2)) throw frozenAt(e2.at, "sound"); throw e2; }
      }
      for (let n = 0; queue.length; n++) {
        const pc = queue.shift()!;
        const out = join(ctx.dir, `piece-${n}.mov`), gp = join(ctx.dir, `graph-piece-${n}.txt`);
        const sub = windowPlan(plan, pc.a, pc.b);
        const argsOf = (ft: number, decode = cpus * 2) => ffmpegArgs(sub, { ...files, output: out }, sourceInfo, { threads: Number(process.env.FFMPEG_THREADS || 0) || cpus, filterThreads: ft, inputThreads: decode, windowBudget: budgets, sound: "none" });
        const go = async (a: ReturnType<typeof argsOf>) => { await writeFile(gp, a.filterGraph); await run("ffmpeg", a.args.map((x) => (x === "__FILTER_SCRIPT__" ? gp : x)), { signal, stallMs: STALL_MS, onProgress: (sec) => onProgress(pc.a + Math.min(sec, pc.b - pc.a)) }); };
        let key: string | null = null;
        if (cache) {
          try {
            const a4 = argsOf(4);
            key = `${cache.prefix}${await pieceKey({ args: a4.args, graph: a4.filterGraph, files, output: out, dir: ctx.dir, win: { a: pc.a, b: pc.b }, version: await ffmpegVersion(), seen })}.mov`;
            if (await headObject(key)) {
              await downloadFile(key, out);
              used.add(key); reused++; made.push(out); onProgress(pc.b);
              continue;
            }
          } catch (e) {
            if (signal.aborted) throw e;
            console.error(`[render] ${r.id}: piece ${pc.a.toFixed(2)}-${pc.b.toFixed(2)} s: could not look it up (${(e as Error).message.slice(0, 200)}); making it`);
          }
        }
        try {
          if (pc.simple) await go(argsOf(1, 1));
          else {
            try { await go(argsOf(filterThreads(argsOf(4).filterGraph))); }
            catch (e) { if (signal.aborted || !outOfThreads(e)) throw e; await waitForThreads(150, 60_000, signal); await go(argsOf(1, 1)); }
          }
        } catch (e) {
          const span = `${pc.a.toFixed(2)}-${pc.b.toFixed(2)} s`;
          if (stalled(e)) {
            console.error(`[render] ${r.id}: piece ${span} froze at ${(pc.a + e.at).toFixed(2)} s${pc.simple ? " (one thread each)" : ""}. Threads: ${e.threads}${e.stderr ? ` | stderr: ${e.stderr.slice(-600)}` : ""}`);
            if (!pc.simple) { queue.unshift({ ...pc, simple: true, froze: true }); continue; }
          }
          if ((killed(e) || stalled(e)) && pc.b - pc.a > 2 + 1e-6) {
            const mid = onGrid((pc.a + pc.b) / 2);
            console.error(`[render] ${r.id}: piece ${span} ${stalled(e) ? "froze" : "killed"} again: making it as two halves`);
            queue.unshift({ a: pc.a, b: mid, simple: pc.simple }, { a: mid, b: pc.b, simple: pc.simple });
            continue;
          }
          if (stalled(e)) throw frozenAt(pc.a + e.at);
          throw e;
        }
        if (pc.froze) console.log(`[render] ${r.id}: piece ${pc.a.toFixed(2)}-${pc.b.toFixed(2)} s made with one thread each after freezing`);
        made.push(out);
        if (key) { const k = key; uploads.push(uploadFile(k, out, "video/quicktime").then(() => { used.add(k); }, () => {})); }
      }
      await joinPieces(ctx.dir, made, files.output, kind === "preview" ? "96k" : best ? "320k" : "192k", signal, soundPath);
      console.log(`[render] ${r.id}: made in ${made.length} pieces and joined${cache ? ` (${reused} taken back unchanged from the last preview)` : ""}`);
      if (cache) {
        await Promise.all(uploads);
        if (reused) plan.operations.push(`Made in ${made.length} pieces: ${reused} unchanged since the last preview came back as they were, ${made.length - reused} made again`);
        // Only this preview's pieces are kept: the next preview starts from it.
        try { await deleteObjects((await listPrefix(cache.prefix)).map((o) => o.key).filter((k) => !used.has(k))); } catch { /* left for next time */ }
      }
    };
    // ---- On the user's Mac first (its Rendrr app open and able): the same runs, with its own number of threads; the
    // overlay's second pass and merge, or the GIF, made there too. The file comes back here to be checked. ----
    const finalPath = fmt === "overlay" ? join(ctx.dir, "out.mov") : fmt === "gif" ? join(ctx.dir, "out.gif") : files.output;
    let macDone: MacDone | null = null;
    const mac = await macCpus();
    // Made from originals that stay on the user's Mac: only that Mac can make it; otherwise the original is asked for.
    const needMac = () => new JobError(`This final is made from your original, which stays on your ${machineWord(macMain?.platform)}${macMain?.device ? ` ("${macMain.device}")` : ""}. Open the ${desktopAppName(macMain?.platform)} there and export again, or give the original file once${where.why ? ` (${where.why})` : ""}.`, "need-original", false);
    if (macSources.size && !mac) throw needMac();
    if (mac) {
      const mArgs = (output: string, pictureAs?: "black" | "white") => {
        // The computer's graphics chip encodes when its app reported one that works (audit #11); older apps report none.
        const hwEncoder = fmt === "mp4" || !fmt ? pickHwEncoder(mac.have) ?? undefined : undefined;
        const o = { threads: mac.cpus, inputThreads: mac.cpus * 2, loudnessGainDb: mixLoudness?.gainDb, windowBudget: budgets, ...(hwEncoder ? { hwEncoder } : {}), ...(fmt === "overlay" ? { pictureAs: pictureAs ?? "black" } : {}) };
        const f = { ...files, output };
        return ffmpegArgs(plan, f, sourceInfo, { ...o, filterThreads: filterThreads(ffmpegArgs(plan, f, sourceInfo, { ...o, filterThreads: 4 }).filterGraph) });
      };
      const a0 = mArgs(files.output);
      const runs: MacRun[] = [...macPre];
      // A heavy final: in pieces there too (lib/macPieces), its progress each piece's own stretch of the edit.
      const inPieces = canPiece && fmt !== "gif" && macPiecesFirst(kind, fit) ? await macPieceRuns({ plan, files, source: sourceInfo, dir: ctx.dir, cpus: mac.cpus, budgets, gainDb: mixLoudness?.gainDb, audioBitrate: best ? "320k" : "192k" }) : null;
      const pieceAt = inPieces?.at ?? new Map<number, { a: number; b: number }>();
      if (inPieces) runs.push(...inPieces.runs);
      else runs.push({ args: a0.args, graph: a0.filterGraph, seconds: plan.outputSeconds });
      if (fmt === "overlay") {
        const wPass = mArgs(join(ctx.dir, "out-w.mkv"), "white");
        runs.push({ args: wPass.args, graph: wPass.filterGraph, seconds: plan.outputSeconds }, { args: mergeOverlayArgs(files.output, join(ctx.dir, "out-w.mkv"), finalPath) });
      } else if (fmt === "gif") runs.push({ args: gifArgs(files.output, finalPath, plan.width, plan.height, plan.outputSeconds) });
      est.encStart = Date.now();
      const macOuts: MacOut[] = [{ path: finalPath, key: outKey, type: ff.type, ...(kind === "final" ? { save: `${stem}.${ff.ext}` } : {}) }];
      const macT0 = Date.now();
      macDone = await onMac(mac, runs, macOuts, (cmd, sec) => { const pc = pieceAt.get(cmd); if (pc) onProgress(pc.a + Math.min(sec, pc.b - pc.a)); else if (!pieceAt.size && cmd === macPre.length) onProgress(sec); });
      // Out of memory there in one pass (the system stopped FFmpeg, or it froze): a final is made on the Mac once more,
      // in pieces (each draws only its own stretch), before the cloud, which has less memory than most Macs. The time it
      // spent is given back to the job's limit.
      let again: Awaited<ReturnType<typeof macPieceRuns>> = null;
      if (!macDone && !inPieces && canPiece && fmt !== "gif" && kind === "final" && macRanOutOfRoom(where.why)) {
        again = await macPieceRuns({ plan, files, source: sourceInfo, dir: ctx.dir, cpus: mac.cpus, budgets, gainDb: mixLoudness?.gainDb, audioBitrate: best ? "320k" : "192k" });
        if (again) {
          const was = where.why;
          console.error(`[render] ${r.id}: the Mac ran out of memory in one pass (${was}): making it there again in ${again.count} pieces`);
          if (plan.operations[plan.operations.length - 1]?.startsWith("Made on Rendrr's cloud server")) plan.operations.pop();
          ctx.extend?.(Date.now() - macT0);
          const at = again.at;
          macDone = await onMac(mac, [...macPre, ...again.runs], macOuts, (cmd, sec) => { const pc = at.get(cmd); if (pc) onProgress(pc.a + Math.min(sec, pc.b - pc.a)); });
          if (macDone) plan.operations.push(`Made on your ${machineWord(mac.platform)} in ${again.count} pieces: in one pass it ran out of memory there (${was})`);
        }
      }
      if (macDone) {
        await downloadFile(outKey, finalPath); files.output = finalPath;
        if (inPieces) plan.operations.push(`Made on your ${machineWord(mac.platform)} in ${inPieces.count} pieces (a heavy edit: ${fit.inputs} inputs, ${fit.scalers} scalers), joined under one sound`);
      }
      else if (macSources.size) throw needMac();
    }
    if (!macDone) {
      est.encStart = Date.now();
      try {
        // A very heavy final (dozens of sources at once) is made in pieces from the start: in one pass it fills the
        // container's memory slowly and is killed only after many minutes (then made in pieces anyway).
        const heavy = canPiece && piecesFirst(kind, fit);
        // A cloud preview long enough for pieces is made in them, so the next preview makes only the pieces that changed
        // (audit #13). Should that fail for any reason, it is made in one pass as before.
        const cacheable = !heavy && kind === "preview" && canPiece && fmt !== "gif" && previewPieceCache() && pieceRanges(plan).length > 1;
        const inCachedPieces = async () => {
          try { await renderInPieces("a preview: only the pieces that changed since the last one are made", { prefix: pieceCachePrefix(video.userId, project.id) }); return true; }
          catch (e) {
            if (signal.aborted) throw e;
            console.error(`[render] ${r.id}: the preview in pieces failed (${(e as Error).message.slice(0, 300)}); making it in one pass`);
            return false;
          }
        };
        // A nearly full container (other jobs hold its threads): wait up to a minute for room; still full, start small.
        const room = heavy || (await waitForThreads(fit.need, 60_000, signal));
        try {
          if (heavy) await renderInPieces(`a heavy final (${fit.inputs} inputs, ${fit.scalers} scalers)`);
          else if (cacheable && (await inCachedPieces())) { /* made in pieces */ }
          else await run("ffmpeg", withGraph(room ? args : argsFor(1, 1).args), { signal, onProgress, stallMs: STALL_MS });
        } catch (e) {
          if (canPiece && killed(e)) await renderInPieces();
          else if (stalled(e)) {
            // Frozen in one pass: made in pieces (each with its own freeze watch), or once more with one thread each.
            console.error(`[render] ${r.id}: the one pass froze at ${e.at.toFixed(2)} s. Threads: ${e.threads}`);
            if (canPiece) await renderInPieces("the one pass froze");
            else {
              try { await run("ffmpeg", withGraph(argsFor(1, 1).args), { signal, onProgress, stallMs: STALL_MS }); }
              catch (e2) { if (stalled(e2)) throw frozenAt(e2.at); throw e2; }
            }
          } else {
            // Out of threads (a container limit): once more with one filter thread, which needs far fewer, when there is room.
            if (signal.aborted || !outOfThreads(e)) throw e;
            console.error("[render] ffmpeg ran out of threads; waiting for room, then trying again with one filter thread and one per decoder");
            await waitForThreads(150, 60_000, signal);
            try { await run("ffmpeg", withGraph(argsFor(1, 1).args), { signal, onProgress, stallMs: STALL_MS }); }
            catch (e2) {
              if (canPiece && (killed(e2) || stalled(e2))) await renderInPieces(stalled(e2) ? "the one-thread pass froze" : undefined);
              else if (stalled(e2)) throw frozenAt(e2.at);
              else throw e2;
            }
          }
        }
      } catch (e) {
        if (signal.aborted) throw e;
        if (e instanceof JobError && e.code === "ffmpeg-frozen") throw e;
        console.error("[render] ffmpeg failed:", (e as Error).message.slice(0, 2600));
        throw new JobError(`Render failed at '${steps[Math.min(endStep - 1, i)]}'. Nothing was lost. Try again.`, "ffmpeg", true);
      }
      try {
        if (fmt === "overlay") {
          // The same edit over white, then the two merged into ProRes 4444 with the alpha their difference gives.
          const black = files.output;
          files.output = join(ctx.dir, "out-w.mkv");
          const w = argsFor(filterThreads(argsFor(4, cpus * 2, "white").filterGraph), cpus * 2, "white");
          const wPath = join(ctx.dir, "graph-w.txt");
          await writeFile(wPath, w.filterGraph);
          await run("ffmpeg", w.args.map((x) => (x === "__FILTER_SCRIPT__" ? wPath : x)), { signal, stallMs: STALL_MS });
          files.output = join(ctx.dir, "out.mov");
          await mergeOverlay(black, join(ctx.dir, "out-w.mkv"), files.output, signal);
        } else if (fmt === "gif") {
          const gif = join(ctx.dir, "out.gif");
          await makeGif(files.output, gif, plan.width, plan.height, signal, plan.outputSeconds);
          files.output = gif;
        }
      } catch (e) {
        if (signal.aborted) throw e;
        if (stalled(e)) throw frozenAt(e.at, "transparent");
        console.error("[render] making the deliverable failed:", (e as Error).message.slice(0, 1600));
        throw new JobError(`Making the ${fmt === "gif" ? "GIF" : "transparent file"} failed. Nothing was lost. Try again, or export MP4.`, "ffmpeg", true);
      }
    }
    i = endStep;
    est.encEnd = Date.now();
    await send(i, 0.1);

    // ---- Packing: upload, check frames, clean up ----
    const outInfo = await probe(files.output, { signal });
    // The rendered file, measured once here so the AI's after-render check compares the file with the edit.
    // A failed measurement is reported in the check (never silently left out).
    let measured: FileMeasure;
    // The upload and the check frames go while the file is measured (they only read it).
    const uploaded = macDone ? stat(files.output).then((x) => x.size) : uploadFile(outKey, files.output, ff.type);
    // Phase 12: captions (SRT, WebVTT) and YouTube chapters next to a final.
    const sideKeys: Record<string, string> = {};
    if (kind === "final") {
      const side = await writeSideFiles(ctx.dir, plan).catch(() => ({} as Record<string, string | undefined>));
      for (const [k, p] of Object.entries(side)) if (p) { const key = `${base}-${k === "chapters" ? "chapters.txt" : `captions.${k}`}`; await uploadFile(key, p, k === "vtt" ? "text/vtt" : "text/plain").then(() => { sideKeys[k] = key; }).catch(() => {}); }
    }
    uploaded.catch(() => {});
    const frames = Promise.all([0.15, 0.4, 0.65, 0.9].map(async (f, k) => {
      const fp = join(ctx.dir, `f${k}.jpg`);
      await frameAt(files.output, outInfo.seconds * f, fp, kind === "final" ? 960 : 540, signal, !!plan.hdr).catch(() => {});
      if (!(await stat(fp).then(() => true).catch(() => false))) return null;
      await uploadFile(`${base}-f${k}.jpg`, fp, "image/jpeg");
      return `${base}-f${k}.jpg`;
    }));
    frames.catch(() => {});
    try {
      // Previews get the full check; a final (no check is shown for it) only its stream lengths and loudness, as before.
      // Engine Part 3: the preview's own sound measured as the footage's is: speech (gaps in it are placed at the
      // edit's joins by the check), breaths and clicks at the joins. Where the footage's face is on screen, to say how
      // much of it each graphic covers (previews with graphics). The three at once.
      await send(i, 0.1);
      const [base0, sound, faceAt] = await Promise.all([
        measureFile(files.output, { signal, timeoutMs: Math.max(60_000, plan.outputSeconds * 1000), picture: kind === "preview" }),
        kind === "preview" && outInfo.hasAudio
          ? measureSound(files.output, soundJoins(plan.sound).map((j) => j.at), { dir: ctx.dir, seconds: plan.outputSeconds, signal, onProgress: (f) => sendThrottled(i, 0.1 + 0.3 * f) })
            .then((x) => { if (x.error) console.error("[render] preview sound not measured:", x.error); return x as FileSound | undefined; })
          : Promise.resolve(undefined as FileSound | undefined),
        kind === "preview" && plan.graphics.length ? facesOnScreen(snapshot, transcript, video.id, video.userId, plan).catch((e) => { console.error("[render] faces not read:", (e as Error).message.slice(0, 200)); return null; }) : Promise.resolve(null),
      ]);
      const graphics: FileMeasure["graphics"] = [];
      for (const gr of plan.graphics) {
        const shown = Math.min(gr.end, base0.videoSeconds ?? gr.end) - gr.start;
        if (shown <= 0) continue;
        const file = files.graphics?.[gr.clipId];
        const fileLen = file ? (await probe(file, { signal }).catch(() => null))?.seconds || shown : shown;
        // Phase 7: a file shorter than its clip holds its last frame to the clip's end (the plan pads it).
        const on = shown;
        // Moments across the part of the file on screen (a held last frame is that frame): 2 a second, 8 to 24.
        const span = Math.max(1 / 30, Math.min(on, fileLen - gr.sourceStart));
        const c = file ? await graphicCover(file, gr.sourceStart, span, signal, Math.min(24, Math.max(8, Math.round(span * 2)))) : null;
        // Each moment: how much of the face's box (where the render draws it then) the graphic's picture covers. A
        // keyframed graphic moves, so its file is not where it shows: not measured.
        let face: FileMeasure["graphics"][number]["face"];
        if (faceAt && c && !gr.keys?.length) {
          let max = 0, maxAt = gr.start, of = 0, known = false;
          c.at.forEach((ft, k) => {
            const t = gr.start + (ft - gr.sourceStart);
            if (t >= gr.end) return;
            const box = faceAt(t);
            if (box === undefined) return;
            known = true;
            if (!box) return;
            of++;
            const cov = c.maps ? boxCover(c.maps[k], COVER_SIZE, box) : 100;
            if (cov > max || of === 1) { max = cov; maxAt = Math.round(t * 100) / 100; }
          });
          if (known) face = of ? { max, at: maxAt, of } : null;
        }
        graphics.push({ clipId: gr.clipId, start: gr.start, end: Math.round((gr.start + on) * 1000) / 1000, coverPct: c?.avg ?? null, ...(c ? { coverMin: c.min, coverMax: c.max, samples: c.samples, visible: c.visible } : {}), ...(face !== undefined ? { face } : {}) });
      }
      measured = { ...base0, graphics, ...(sound ? { sound } : {}) };
    } catch (e) {
      if (signal.aborted) throw e;
      measured = { videoSeconds: null, audioSeconds: null, black: [], silences: [], lufs: null, peakDb: null, graphics: [], error: (e as Error).message.slice(0, 200) };
    }
    const loudness = { lufs: measured.lufs, peakDb: measured.peakDb };
    const size = await uploaded;
    await send(i, 0.6);
    const framesKeys = (await frames).filter((x): x is string => !!x);
    // An edit from scratch (only its blank canvas on V1) has no words to hear again.
    const wordless = video.kind === "canvas" && plan.sources.every((id) => id === video.id);
    const heard: HeardTranscript | null = kind === "preview" && outInfo.hasAudio && !wordless ? { status: transcriber() ? "queued" : "off", seconds: outInfo.seconds } : null;
    // Stopped (or failed by the cleanup) while it finished: only a render still running becomes done. Otherwise what
    // it made is removed and nothing else changes (no "Final ready", no Drive copy, the original kept).
    if (signal.aborted) throw new JobError("Stopped.");
    const fix = await fixed;
    const won = await prisma.render.updateMany({ where: { id: r.id, status: "running" }, data: {
      status: "done", outputKey: outKey, sizeBytes: BigInt(size), seconds: outInfo.seconds, framesKeys, finishedAt: new Date(), made: { on: where.on, device: where.device, why: where.why, ...(where.platform ? { platform: where.platform } : {}) },
      // A final made on the Mac is already in its Downloads (the app kept it there).
      ...(kind === "final" && macDone?.saved ? { delivery: { to: "mac", device: where.device, state: "sent", at: Date.now(), saved: macDone.saved } } : {}),
      quality: kind === "final" ? (isSoundFormat(fmt) ? SOUND_QUALITY[fmt] : qualityLabel({ resolution: snapshot.timeline.export?.resolution, codec: plan.codec, hdr: !!plan.hdr, best })) : "540p", plan: { operations: plan.operations, kept: plan.parts.length, sources: plan.sources, model: plan.model, outputSeconds: plan.outputSeconds, mix: mixLoudness, width: plan.width, height: plan.height, loudness, measured, ...(heard ? { heard } : {}), ...(fmt ? { format: fmt } : {}), ...(Object.keys(sideKeys).length ? { files: sideKeys } : {}), ...(plan.chapters?.length ? { chapters: plan.chapters } : {}), ...(fix ? { fix } : {}) } as unknown as Prisma.InputJsonValue,
    } });
    if (!won.count) {
      await deleteObjects([outKey, ...framesKeys, ...Object.values(sideKeys)]).catch(() => {});
      console.log(`[render] ${r.id}: it was stopped as it finished; what it made was removed`);
      return { stopped: true };
    }
    // A final the Mac kept in Downloads is not fetched again by its app (the AI's exports queue for the Mac).
    if (kind === "final" && macDone?.saved) await redis().hdel(macExportsKey(video.userId), r.id).catch(() => {});
    // Final: the original is deleted straight away, unless another final of this edit still waits for it (two finals
    // asked for back to back); the daily cleanup is the safety net.
    if (kind === "final" && tempOriginalIds.length) {
      const others = await prisma.render.count({ where: { projectId: project.id, kind: "final", status: { in: ["queued", "running"] }, id: { not: r.id } } });
      if (!others) {
        const origs = await prisma.tempOriginal.findMany({ where: { id: { in: tempOriginalIds } } });
        for (const o of origs) await deleteObject(o.key).catch(() => {});
        await prisma.tempOriginal.deleteMany({ where: { id: { in: tempOriginalIds } } });
      }
    }
    // Engine Part 3: the preview's sound is transcribed again after it is ready (it never holds the render up).
    if (heard?.status === "queued") await enqueue<HeardJob>("heard", { renderId: r.id }, { jobId: `heard-${r.id}` }).catch((e) => console.error("[render] heard not queued:", (e as Error).message));
    const fresh = await prisma.project.findUniqueOrThrow({ where: { id: project.id } });
    await prisma.project.update({ where: { id: project.id }, data: {
      status: kind === "final" ? "Final ready" : ["Approved", "In review", "Changes requested", "Final ready"].includes(fresh.status) ? fresh.status : "Preview ready",
      sizeBytes: BigInt(size),
    } });
    await usage(video.userId, kind === "final" ? "render_final" : "render_preview", Math.round((outInfo.seconds / 60) * 100) / 100, { projectId: project.id, renderId: r.id });
    // Billing: a final's export minutes (4K and heavy effects count double), a preview's preview minutes. Gallery
    // renders (Rendrr's own) are not billed.
    noteCost({ kind: kind === "final" ? "render_final" : "render_preview", refId: r.id, outputBytes: size });
    if (r.by !== "gallery") {
      const minutes = Math.round((outInfo.seconds / 60) * 1000) / 1000;
      const fourK = kind === "final" && isFourKQuality(r.quality), heavy = isHeavyPlan(plan);
      // Made on the user's own computer: recorded, billed 0 when local-first billing is on (LOCAL_RENDERS_FREE).
      await recordUsage({ userId: video.userId, metric: kind === "final" ? "export" : "preview", quantity: minutes, billable: billableMinutes({ minutes, multiplier: kind === "final" ? exportMultiplier({ fourK, heavy }) : 1, on: where.on }), refId: r.id, meta: { projectId: project.id, quality: r.quality, fourK, heavy, on: where.on } });
    }
    await publishRender(r.id, { status: "done", step: steps.length, steps, percent: 100, on: where.on, device: where.device, ...(where.platform ? { platform: where.platform } : {}) });
    // A final the user asked to be saved into their Google Drive (render_final driveFolder): the copy starts now.
    const save = kind === "final" ? driveSaveOf(await prisma.render.findUniqueOrThrow({ where: { id: r.id }, select: { driveSave: true } })) : null;
    if (save?.state === "waiting") await queueDriveSave(r.id, save).catch((e) => console.error("[render] Drive copy not queued:", (e as Error).message));
    return { url: await signGet(outKey, 3600) };
  } catch (e) {
    if (previewTimedOut) throw new JobError("Preview render took too long. Try again.", "timeout", false);
    if (e instanceof RenderPlanError) throw new JobError(e.message, "empty", false);
    throw e;
  } finally {
    if (pt) clearTimeout(pt);
    forgetOrigins(ctx.dir);
  }
}

/**
 * Engine Part 3: where the footage's main face is on screen at an edit moment, from the faces measured at 10 fps
 * (Engine Part 2) and how the render draws the clip then (turn, fit, framing, keyframes, zoom). null: no face there or
 * b-roll covers it; undefined: that video has no face measurements yet. Null as a whole when no video on V1 has any.
 */
async function facesOnScreen(snapshot: Snapshot, transcript: Transcript, mainId: string, userId: string, plan: RenderPlan): Promise<((t: number) => [number, number, number, number] | null | undefined) | null> {
  const words = allWords(transcript);
  const tl = layoutTimeline(asSequence(snapshot.timeline, words, mainId), words);
  const view = sequenceView(tl, words);
  const clips = new Map((tl.tracks.v1 as SeqClip[]).map((c) => [c.id, c]));
  const ids = Array.from(new Set(view.pieces.map((p) => p.videoId)));
  const rows = await prisma.footageAnalysis.findMany({ where: { videoId: { in: ids }, video: { userId } }, select: { videoId: true, vision: true } });
  const vis = new Map<string, { details: VisionDetails; turned: number }>();
  for (const row of rows) {
    const v = row.vision as unknown as VisionSummary | null;
    const buf = v?.key ? await getBytes(v.key).catch(() => null) : null;
    if (buf) vis.set(row.videoId, { details: JSON.parse(gunzipSync(buf).toString()) as VisionDetails, turned: v!.turned ?? 0 });
  }
  if (!vis.size) return null;
  const covered = (t: number) => plan.broll.some((b) => !b.keys?.length && t >= b.start && t < b.end);
  return (t) => {
    const p = view.pieceAt(t);
    if (!p || !vis.has(p.videoId)) return undefined;
    return faceOnScreenAt(t, { view, clips, W: plan.width, H: plan.height, vision: (id) => vis.get(id) ?? null, zooms: plan.zooms, zoomAt, clipMotion: plan.clipMotion, covered });
  };
}

/** Called when a render fails for good: the UI shows `error` in plain English. */
export async function renderFailed(renderId: string, message: string, code?: string) {
  const r = await prisma.render.findUnique({ where: { id: renderId } });
  if (!r) return;
  const save = driveSaveOf(r);
  await prisma.render.update({ where: { id: r.id }, data: { status: "failed", error: message, errorCode: code ?? null, finishedAt: new Date(), ...(save?.state === "waiting" ? { driveSave: { ...save, state: "failed", error: "The final did not finish, so nothing was saved to Google Drive.", at: Date.now() } } : {}) } });
  const p = await prisma.project.findUnique({ where: { id: r.projectId } });
  if (p && p.status === "Rendering") {
    // Back to what the edit had before this render: the best finished render decides.
    const done = await prisma.render.findMany({ where: { projectId: p.id, status: "done", kind: { not: "sample" } }, select: { kind: true } });
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
