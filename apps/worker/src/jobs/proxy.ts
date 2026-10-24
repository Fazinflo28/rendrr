import { drive, enqueue, signGet, uploadFile, type AnalyzeJob, type ProxyJob } from "@rendrr/core";
import { prisma, type Prisma } from "@rendrr/db";
import { DAY_MS, orientationOf, PREFIX, PREVIEW_RETENTION_DAYS } from "@rendrr/shared";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { frameAt, JobError, probe, run } from "../lib/ffmpeg";
import { throttle, type Ctx } from "../lib/job";

// Proxy settings (see DECISIONS.md): 720p H.264 ~2 Mbps, keyframe every 0.5 s, constant 30 fps, SDR BT.709, AAC.
const PROXY_VIDEO = ["-c:v", "libx264", "-preset", "veryfast", "-b:v", "2M", "-maxrate", "2500k", "-bufsize", "4M", "-g", "15", "-keyint_min", "15", "-sc_threshold", "0", "-r", "30",
  "-pix_fmt", "yuv420p", "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709"];

/** Where FFmpeg reads the original from: our storage (samples, fake Drive) or Google Drive, streamed, never saved whole. */
export async function sourceInput(v: { userId: string; source: string; driveFileId: string | null; sourceKey: string | null; sample: boolean }): Promise<{ input: string; headers?: string; drive: boolean }> {
  if (v.sourceKey) return { input: await signGet(v.sourceKey, 6 * 3600), drive: false };
  if (v.source === "drive" && v.driveFileId) {
    const conn = await prisma.driveConnection.findUnique({ where: { userId: v.userId } });
    if (!conn) throw new JobError("Connect Google Drive again to read this file.", "drive", false);
    const f = await drive.getFile(v.userId, v.driveFileId, conn.stub);
    if (!f) throw new JobError("We could not find this file in your Drive. It was moved or deleted.", "missing", false);
    const m = await drive.mediaRequest(v.userId, v.driveFileId);
    return { input: m.url, headers: `Authorization: ${m.headers.authorization}\r\n`, drive: true };
  }
  throw new JobError("We need the file from your computer again. Add it again from the Library.", "local", false);
}

export async function proxyJob(ctx: Ctx) {
  const { videoId } = ctx.job.data as ProxyJob;
  const v = await prisma.video.findUnique({ where: { id: videoId } });
  if (!v) return;
  const local = v.source === "local";
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
  await prisma.video.update({ where: { id: v.id }, data: { status: local ? "previewing" : "preview", seconds: info.seconds, width: info.width, height: info.height, fps: info.fps, orientation: orientationOf(info.width, info.height), hasAudio: info.hasAudio, hdr: info.transfer ?? null } });

  const proxy = join(ctx.dir, "proxy.mp4"), audio = join(ctx.dir, "audio.m4a");
  const landscape = info.width >= info.height;
  const short = Math.min(720, landscape ? info.height : info.width);
  const scale = landscape ? `scale=-2:${short - (short % 2)}` : `scale=${short - (short % 2)}:-2`;
  const tone = info.hdr ? "zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv," : "";
  const progress = throttle((sec: number) => prisma.video.update({ where: { id: v.id }, data: { progress: Math.min(99, Math.round((sec / info.seconds) * 100)) } }).catch(() => {}), 1500);
  const args = [
    "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
    ...(src.headers ? ["-headers", src.headers] : []), "-i", src.input,
    ...(info.hasAudio ? [] : ["-f", "lavfi", "-t", info.seconds.toFixed(3), "-i", "anullsrc=r=48000:cl=stereo"]),
    "-map", "0:v:0", "-map", info.hasAudio ? "0:a:0" : "1:a:0",
    "-vf", `${tone}${scale},fps=30,format=yuv420p`, ...PROXY_VIDEO,
    "-c:a", "aac", "-b:a", "128k", "-ac", "2", "-ar", "48000", "-movflags", "+faststart", proxy,
    "-map", info.hasAudio ? "0:a:0" : "1:a:0", "-vn", "-ac", "1", "-ar", "16000", "-c:a", "aac", "-b:a", "48k", audio,
    "-progress", "pipe:1", "-nostats",
  ];
  await run("ffmpeg", args, { signal: ctx.signal, onProgress: progress }).catch((e) => {
    if (ctx.signal.aborted) throw e;
    throw new JobError("We could not read this video. Check it plays, then try again.", "decode", true);
  });

  // Five key frames, spread across the footage. The first one doubles as the thumbnail.
  const base = `${v.userId}/${v.id}`;
  const frames: { t: number; key: string; path: string }[] = [];
  for (const [i, f] of [0.1, 0.3, 0.5, 0.7, 0.9].entries()) {
    const t = Math.round(info.seconds * f * 100) / 100;
    const path = join(ctx.dir, `kf${i}.jpg`);
    await frameAt(proxy, t, path, 640, ctx.signal).catch(() => {});
    frames.push({ t, key: `${PREFIX.frames}${base}/kf${i}.jpg`, path });
  }
  const [proxySize, audioSize] = await Promise.all([uploadFile(`${PREFIX.proxies}${base}.mp4`, proxy, "video/mp4"), uploadFile(`${PREFIX.audio}${base}.m4a`, audio, "audio/mp4")]);
  let framesSize = 0;
  const saved: { t: number; key: string }[] = [];
  for (const f of frames) {
    const ok = await stat(f.path).then((s) => s.size).catch(() => 0);
    if (!ok) continue;
    framesSize += await uploadFile(f.key, f.path, "image/jpeg");
    saved.push({ t: f.t, key: f.key });
  }
  await prisma.footageAnalysis.upsert({ where: { videoId: v.id }, create: { videoId: v.id, transcriber: "pending", transcript: [], keyFrames: saved as unknown as Prisma.InputJsonValue }, update: { keyFrames: saved as unknown as Prisma.InputJsonValue } });
  await prisma.video.update({ where: { id: v.id }, data: {
    proxyKey: `${PREFIX.proxies}${base}.mp4`, audioKey: `${PREFIX.audio}${base}.m4a`, thumbKey: saved[0]?.key ?? null,
    previewSizeBytes: BigInt(proxySize + audioSize + framesSize), status: "processing", step: 0, progress: null,
    previewExpiresAt: new Date(Date.now() + PREVIEW_RETENTION_DAYS * DAY_MS), // a fresh copy gets the full 30 days
    sizeBytes: v.sizeBytes || BigInt(info.sizeBytes || 0),
  } });
  await enqueue<AnalyzeJob>("analyze", { videoId: v.id });
}
