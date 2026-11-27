import { checkUsage, deleteObject, downloadFile, drive, enqueue, signGet, uploadFile, type AnalyzeJob, type ProxyJob } from "@rendrr/core";
import { prisma, type Prisma, type Video } from "@rendrr/db";
import { DAY_MS, orientationOf, PREFIX, PREVIEW_RETENTION_DAYS, STILL_SECONDS } from "@rendrr/shared";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { frameArgs, frameAt, JobError, probe, run } from "../lib/ffmpeg";
import { throttle, type Ctx } from "../lib/job";
import { previewOnComputer, withMadeOn, type ComputerSource, type StepWhere } from "../lib/onComputer";

// Proxy settings (see DECISIONS.md): 720p H.264 ~2 Mbps, keyframe every 0.5 s, constant 30 fps, SDR BT.709, AAC.
const PROXY_VIDEO = ["-c:v", "libx264", "-preset", "veryfast", "-b:v", "2M", "-maxrate", "2500k", "-bufsize", "4M", "-g", "15", "-keyint_min", "15", "-sc_threshold", "0", "-r", "30",
  "-pix_fmt", "yuv420p", "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709"];

/**
 * The one FFmpeg run that makes the preview copy (proxy) and the 16 kHz mono sound for the transcript, the same on
 * the cloud and on the user's computer (there input, proxy and audio are names in the task's folder, no headers).
 * An HDR original is tone-mapped to SDR; footage with no sound gets silence.
 */
export function proxyArgs(input: string, info: { width: number; height: number; seconds: number; hasAudio: boolean; hdr?: unknown }, proxy: string, audio: string, headers?: string): string[] {
  const landscape = info.width >= info.height;
  const short = Math.min(720, landscape ? info.height : info.width);
  const scale = landscape ? `scale=-2:${short - (short % 2)}` : `scale=${short - (short % 2)}:-2`;
  const tone = info.hdr ? "zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv," : "";
  return [
    "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
    ...(headers ? ["-headers", headers] : []), "-i", input,
    ...(info.hasAudio ? [] : ["-f", "lavfi", "-t", info.seconds.toFixed(3), "-i", "anullsrc=r=48000:cl=stereo"]),
    "-map", "0:v:0", "-map", info.hasAudio ? "0:a:0" : "1:a:0",
    "-vf", `${tone}${scale},fps=30,format=yuv420p`, ...PROXY_VIDEO,
    "-c:a", "aac", "-b:a", "128k", "-ac", "2", "-ar", "48000", "-movflags", "+faststart", proxy,
    "-map", info.hasAudio ? "0:a:0" : "1:a:0", "-vn", "-ac", "1", "-ar", "16000", "-c:a", "aac", "-b:a", "48k", audio,
    "-progress", "pipe:1", "-nostats",
  ];
}

/** Where FFmpeg reads the original from: our storage (samples, fake Drive) or Google Drive, streamed, never saved whole. */
export async function sourceInput(v: { userId: string; source: string; driveFileId: string | null; sourceKey: string | null; sample: boolean }): Promise<{ input: string; headers?: string; drive: boolean; file?: drive.DriveFile }> {
  if (v.sourceKey) return { input: await signGet(v.sourceKey, 6 * 3600), drive: false };
  if (v.source === "drive" && v.driveFileId) {
    const conn = await prisma.driveConnection.findUnique({ where: { userId: v.userId } });
    if (!conn) throw new JobError("Connect Google Drive again to read this file.", "drive", false);
    const f = await drive.getFile(v.userId, v.driveFileId, conn.stub);
    if (!f) throw new JobError("We could not find this file in your Drive. It was moved or deleted.", "missing", false);
    const m = await drive.mediaRequest(v.userId, v.driveFileId);
    return { input: m.url, headers: `Authorization: ${m.headers.authorization}\r\n`, drive: true, file: f };
  }
  throw new JobError("We need the file from your computer again. Add it again from the Library.", "local", false);
}

/**
 * A picture brought in from the chat (add_footage) made into its raw video once: a still clip STILL_SECONDS long at
 * 30 fps, its own size (even sides, 3840 at most), silent, nearly lossless. Then it is footage like any other: the
 * preview, the renders and finals all read it. A GIF or a WebP gives its first frame.
 */
export async function stillToVideo(v: Video, dir: string, signal?: AbortSignal): Promise<Video> {
  if (!v.still || !v.sourceKey || /\.mp4$/i.test(v.sourceKey)) return v;
  const img = join(dir, "still-src"), first = join(dir, "still-first.png"), out = join(dir, "still.mp4");
  await downloadFile(v.sourceKey, img);
  const bad = () => new JobError("That picture could not be read. Send it as a JPEG or PNG.", "damaged", false);
  await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-i", img, "-frames:v", "1", "-update", "1", first], { signal }).catch((e) => { if (signal?.aborted) throw e; throw bad(); });
  await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-loop", "1", "-framerate", "30", "-t", String(STILL_SECONDS), "-i", first,
    "-vf", "scale='min(3840,iw)':'min(3840,ih)':force_original_aspect_ratio=decrease,scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p",
    "-c:v", "libx264", "-preset", "veryfast", "-tune", "stillimage", "-crf", "14", "-r", "30", "-g", "30", "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709",
    "-an", "-movflags", "+faststart", out], { signal }).catch((e) => { if (signal?.aborted) throw e; throw bad(); });
  const key = v.sourceKey.replace(/\.[a-z0-9]+$/i, "") + ".mp4";
  await uploadFile(key, out, "video/mp4");
  await deleteObject(v.sourceKey).catch(() => {});
  return prisma.video.update({ where: { id: v.id }, data: { sourceKey: key } });
}

export async function proxyJob(ctx: Ctx) {
  const { videoId } = ctx.job.data as ProxyJob;
  let v = await prisma.video.findUnique({ where: { id: videoId } });
  if (!v) return;
  const local = v.source === "local";
  v = await stillToVideo(v, ctx.dir, ctx.signal);
  // Status names the UI expects: Drive shows Linking -> Making preview; samples show the local steps.
  await prisma.video.update({ where: { id: v.id }, data: { status: local ? "previewing" : "linking", progress: 0, error: null, step: null } });

  let src: Awaited<ReturnType<typeof sourceInput>>;
  try { src = await sourceInput(v); } catch (e) {
    if ((e as JobError).code === "missing") { await prisma.video.update({ where: { id: v.id }, data: { status: "missing", error: (e as Error).message } }); return; }
    throw e;
  }
  const info = await probe(src.input, { headers: src.headers, signal: ctx.signal }).catch((e) => {
    if (ctx.signal.aborted) throw e;
    throw new JobError("The file looks damaged. Try exporting it again, then add it.", "damaged", false);
  });
  if (!info.hasVideo || info.seconds <= 0) throw new JobError("The file looks damaged. Try exporting it again, then add it.", "damaged", false);
  if (info.seconds > 4 * 3600) throw new JobError("That video is longer than 4 hours. Trim it first, then add it.", "too-long", false);
  // Billing: new footage uses footage minutes (and storage). A video already counted (a rebuilt preview copy) is not
  // counted or checked again; samples and pictures are free.
  if (!v.sample && !v.still) {
    const counted = await prisma.usageRecord.findUnique({ where: { metric_refId: { metric: "footage", refId: v.id } } });
    if (!counted) {
      const c = await checkUsage(v.userId, { metric: "footage", minutes: info.seconds / 60, storageGBAfter: undefined });
      if (!c.ok && c.enforced) throw new JobError(c.message, "billing", false);
    }
  }
  await prisma.video.update({ where: { id: v.id }, data: { status: local ? "previewing" : "preview", seconds: info.seconds, width: info.width, height: info.height, fps: info.fps, orientation: orientationOf(info.width, info.height), hasAudio: info.hasAudio, hdr: info.transfer ?? null, timecode: info.timecode } });

  const proxy = join(ctx.dir, "proxy.mp4"), audio = join(ctx.dir, "audio.m4a");
  const progress = throttle((frac: number) => prisma.video.update({ where: { id: v.id }, data: { progress: Math.min(99, Math.round(frac * 100)) } }).catch(() => {}), 1500);
  // Five key frames, spread across the footage. The first one doubles as the thumbnail.
  const base = `${v.userId}/${v.id}`;
  const proxyKey = `${PREFIX.proxies}${base}.mp4`, audioKey = `${PREFIX.audio}${base}.m4a`;
  const frames = [0.1, 0.3, 0.5, 0.7, 0.9].map((f, i) => ({ t: Math.round(info.seconds * f * 100) / 100, name: `kf${i}.jpg`, key: `${PREFIX.frames}${base}/kf${i}.jpg`, path: join(ctx.dir, `kf${i}.jpg`) }));

  // On the user's computer first, while the Rendrr app is open and able (lib/onComputer.ts): it fetches the original
  // from Drive (or Rendrr's storage) itself, makes the same files with its own FFmpeg and uploads them. Samples are
  // made here (they are free and already here). Anything that stops it: made here as before, and the reason is kept.
  let where: StepWhere = { on: "cloud", by: "ffmpeg", why: null, at: Date.now() };
  let sizes: { proxy: number; audio: number; frames: number; saved: { t: number; key: string }[] } | null = null;
  const fromComputer: ComputerSource | null = v.sample ? null
    : src.drive && src.file && v.driveFileId ? { drive: { fileId: v.driveFileId, ...(src.file.date ? { version: String(src.file.date) } : {}) }, size: src.file.sizeBytes }
    : v.source === "upload" && v.sourceKey ? { key: v.sourceKey, size: Number(v.sizeBytes || 0) || undefined }
    : null;
  if (fromComputer) {
    const r = await previewOnComputer({
      userId: v.userId, videoId: v.id, signal: ctx.signal, dir: ctx.dir, extend: ctx.extend, name: v.name, seconds: info.seconds, source: fromComputer,
      proxyRun: proxyArgs("src", info, "proxy.mp4", "audio.m4a"), frames: frames.map((f) => ({ args: frameArgs("proxy.mp4", f.t, f.name, 640), name: f.name, key: f.key })),
      proxyKey, audioKey, onProgress: (f) => progress(f),
    });
    if (r.ok) {
      where = { ...r.where, by: "app" };
      sizes = { proxy: r.outputs["proxy.mp4"] || 0, audio: r.outputs["audio.m4a"] || 0, frames: frames.reduce((a, f) => a + (r.outputs[f.name] || 0), 0), saved: frames.map((f) => ({ t: f.t, key: f.key })) };
    } else where.why = r.why;
  }

  if (!sizes) {
    // A Drive sign-in lasts an hour: the computer's attempt may have used up much of it, so a fresh link for the cloud.
    if (fromComputer && src.drive) src = await sourceInput(v);
    await run("ffmpeg", proxyArgs(src.input, info, proxy, audio, src.headers), { signal: ctx.signal, onProgress: (sec: number) => progress(sec / info.seconds) }).catch((e) => {
      if (ctx.signal.aborted) throw e;
      throw new JobError("We could not read this video. Check it plays, then try again.", "decode", true);
    });
    for (const f of frames) await frameAt(proxy, f.t, f.path, 640, ctx.signal).catch(() => {});
    const [proxySize, audioSize] = await Promise.all([uploadFile(proxyKey, proxy, "video/mp4"), uploadFile(audioKey, audio, "audio/mp4")]);
    let framesSize = 0;
    const saved: { t: number; key: string }[] = [];
    for (const f of frames) {
      const ok = await stat(f.path).then((s) => s.size).catch(() => 0);
      if (!ok) continue;
      framesSize += await uploadFile(f.key, f.path, "image/jpeg");
      saved.push({ t: f.t, key: f.key });
    }
    sizes = { proxy: proxySize, audio: audioSize, frames: framesSize, saved };
  }
  const saved = sizes.saved;
  await prisma.footageAnalysis.upsert({ where: { videoId: v.id }, create: { videoId: v.id, transcriber: "pending", transcript: [], keyFrames: saved as unknown as Prisma.InputJsonValue }, update: { keyFrames: saved as unknown as Prisma.InputJsonValue } });
  await prisma.video.update({ where: { id: v.id }, data: {
    proxyKey, audioKey, thumbKey: saved[0]?.key ?? null,
    previewSizeBytes: BigInt(sizes.proxy + sizes.audio + sizes.frames), status: "processing", step: 0, progress: null,
    madeOn: withMadeOn(v.madeOn, { preview: where }),
    previewExpiresAt: new Date(Date.now() + PREVIEW_RETENTION_DAYS * DAY_MS), // a fresh copy gets the full 30 days
    sizeBytes: v.sizeBytes || BigInt(info.sizeBytes || 0),
  } });
  await enqueue<AnalyzeJob>("analyze", { videoId: v.id });
}
