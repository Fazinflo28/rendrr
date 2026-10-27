import { downloadFile, enqueue, uploadFile, writeDeepProgress, type DeepJob } from "@rendrr/core";
import { Prisma, prisma } from "@rendrr/db";
import { allWords, DEEP_VERSION, type Alignment, type DeepAudio, type Transcript, type VisionSummary } from "@rendrr/shared";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { JobError, probe, run } from "../lib/ffmpeg";
import type { Ctx } from "../lib/job";
import { framesPrefix } from "./breakdown";

const HERE = dirname(fileURLToPath(import.meta.url));
const PY = (f: string) => join(HERE, "../../python", f);
const MODELS = join(HERE, "../../models");
const PYTHON = process.env.PYTHON_BIN || "python3";
/** wav2vec2 for word alignment (downloaded into the image; see the Dockerfile). Without it the edges are still moved
 *  onto the sound. */
const ALIGN_MODEL = process.env.ALIGN_MODEL || "/opt/models/wav2vec2/model_quantized.onnx";
const ALIGN_VOCAB = process.env.ALIGN_VOCAB || "/opt/models/wav2vec2/vocab.json";

/** The share of the work each step is (for the percent and the time left). */
const WEIGHT = { sound: 0.15, words: 0.2, picture: 0.65 } as const;
type Step = keyof typeof WEIGHT;
const STEP_NAME: Record<Step, string> = { sound: "Measuring the sound", words: "Aligning the words", picture: "Watching faces and motion" };

const lastJson = (stdout: string) => JSON.parse(stdout.trim().split("\n").pop() || "{}");

/** Loudness (LUFS) and true peak (dBTP) of the preview copy's sound. */
async function loudness(proxy: string, signal: AbortSignal): Promise<{ lufs: number | null; truePeakDb: number | null }> {
  const { stderr } = await run("ffmpeg", ["-hide_banner", "-nostats", "-nostdin", "-i", proxy, "-vn", "-af", "ebur128=peak=true", "-f", "null", "-"], { signal });
  const tail = stderr.slice(stderr.lastIndexOf("Summary:"));
  const lufs = /I:\s+(-?[\d.]+) LUFS/.exec(tail), tp = /Peak:\s+(-?[\d.]+) dBFS/.exec(tail);
  return { lufs: lufs ? Number(lufs[1]) : null, truePeakDb: tp ? Number(tp[1]) : null };
}

/**
 * The deeper measurements of a video (Engine Part 2): its sound every 10 ms with speech, onsets, breaths, clicks and
 * clipping; where each word starts and ends in the sound; faces at 10 fps and the picture every 0.5 s. Each step
 * reports its percent and the time left; the job's limit grows with the footage (deepTimeoutMs). A step that fails
 * fails the job loudly (deepError on the video's analysis).
 */
export async function deepJob(ctx: Ctx) {
  const { videoId, force } = ctx.job.data as DeepJob;
  const v = await prisma.video.findUnique({ where: { id: videoId }, select: { id: true, userId: true, seconds: true, status: true, proxyKey: true, hasAudio: true, analysis: { select: { transcript: true, deepVersion: true } } } });
  if (!v?.analysis || !v.proxyKey || v.status !== "ready") return;
  // Queued twice (the backfill and a tool's first use): measured once.
  if (!force && v.analysis.deepVersion != null && v.analysis.deepVersion >= DEEP_VERSION) return;
  const started = Date.now();
  let done = 0; // weight of the finished steps
  const report = async (step: Step, pct: number) => {
    const overall = Math.min(99, Math.round((done + WEIGHT[step] * (pct / 100)) * 100));
    const spent = (Date.now() - started) / 1000;
    await writeDeepProgress(v.id, { step: STEP_NAME[step], percent: overall, etaSec: overall >= 3 ? Math.round((spent / overall) * (100 - overall)) : null });
  };
  const onLine = (step: Step) => { let last = -1; return (line: string) => { const m = /^PROGRESS (\d+)/.exec(line); if (m && Number(m[1]) !== last) { last = Number(m[1]); void report(step, last); } }; };

  try {
    await report("sound", 0);
    const proxy = join(ctx.dir, "proxy.mp4");
    await downloadFile(v.proxyKey, proxy);
    const info = await probe(proxy, { signal: ctx.signal });
    const base = framesPrefix(v);

    // 1. The sound.
    let audio: DeepAudio | null = null;
    if (info.hasAudio) {
      const p48 = join(ctx.dir, "a48.raw"), p16 = join(ctx.dir, "a16.raw");
      await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-i", proxy, "-vn", "-ac", "1", "-ar", "48000", "-f", "s16le", p48], { signal: ctx.signal });
      await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-i", proxy, "-vn", "-ac", "1", "-ar", "16000", "-f", "f32le", p16], { signal: ctx.signal });
      const { stdout } = await run(PYTHON, [PY("deep_audio.py"), "--pcm48", p48, "--pcm16", p16, "--vad", join(MODELS, "silero/silero_vad.onnx"), "--out", ctx.dir], { signal: ctx.signal, onLine: onLine("sound") });
      audio = { ...lastJson(stdout), ...(await loudness(proxy, ctx.signal)), key: `${base}audio.bin` } as DeepAudio;
      if (!audio.frames) throw new JobError("The sound could not be read from the preview copy.", "no-sound");
      await uploadFile(audio.key!, join(ctx.dir, "audio.bin"), "application/octet-stream");
    }
    done += WEIGHT.sound;

    // 2. Where each word starts and ends in the sound.
    let alignment: Alignment | null = null;
    const words = allWords((v.analysis.transcript as unknown as Transcript) || []);
    if (audio && words.length) {
      await report("words", 0);
      const wj = join(ctx.dir, "words.json");
      await writeFile(wj, JSON.stringify(words.map((w) => [w.id, w.text, w.t, w.end])));
      const model = existsSync(ALIGN_MODEL) && existsSync(ALIGN_VOCAB) ? ["--model", ALIGN_MODEL, "--vocab", ALIGN_VOCAB] : [];
      const { stdout } = await run(PYTHON, [PY("align.py"), "--pcm16", join(ctx.dir, "a16.raw"), "--words", wj, "--frames", join(ctx.dir, "audio.bin"), "--floor", String(audio.roomDb), ...model], { signal: ctx.signal, onLine: onLine("words") });
      alignment = lastJson(stdout) as Alignment;
      if (!model.length) alignment.error = "the alignment model is not installed: edges moved onto the sound only";
    }
    done += WEIGHT.words;

    // 3. The picture.
    await report("picture", 0);
    const scale = Math.min(1, 640 / Math.max(info.width, info.height));
    const w = Math.max(2, Math.round((info.width * scale) / 2) * 2), h = Math.max(2, Math.round((info.height * scale) / 2) * 2);
    const details = join(ctx.dir, "vision.json");
    const { stdout } = await run(PYTHON, [PY("vision.py"), "--video", proxy, "--w", String(w), "--h", String(h), "--seconds", String(info.seconds || v.seconds),
      "--yunet", join(MODELS, "yunet/face_detection_yunet_2023mar.onnx"), "--landmarker", join(MODELS, "mediapipe/face_landmarker.task"), "--out", details], { signal: ctx.signal, onLine: onLine("picture") });
    const vision = { ...lastJson(stdout), key: `${base}vision.json.gz` } as VisionSummary;
    const gz = join(ctx.dir, "vision.json.gz");
    await writeFile(gz, gzipSync(await readFile(details)));
    await uploadFile(vision.key!, gz, "application/gzip");

    // Explicit select: a worker that starts before the API has added these columns fails here, not on every query.
    await prisma.footageAnalysis.update({
      where: { videoId: v.id },
      data: { audio: (audio ?? Prisma.DbNull) as Prisma.InputJsonValue, alignment: (alignment ?? Prisma.DbNull) as Prisma.InputJsonValue, vision: vision as unknown as Prisma.InputJsonValue, deepVersion: DEEP_VERSION, deepError: null, deepAt: new Date() },
      select: { videoId: true },
    });
  } finally {
    await writeDeepProgress(v.id, null);
  }
}

/** The job failed for good: the tools say why instead of waiting. */
export async function deepFailed(videoId: string, message: string) {
  await prisma.footageAnalysis.update({ where: { videoId }, data: { deepError: message.slice(0, 500), deepAt: new Date() }, select: { videoId: true } }).catch(() => {});
}

/**
 * Queues the deeper measurements for ready videos that have none or older ones (newest first, at most 50 per start,
 * once a day each); videos that failed are tried again the next day.
 */
export async function queueMissingDeep(): Promise<number> {
  const rows = await prisma.footageAnalysis.findMany({
    where: { video: { status: "ready", proxyKey: { not: null } }, OR: [{ deepVersion: null }, { deepVersion: { lt: DEEP_VERSION } }] },
    select: { videoId: true }, take: 50, orderBy: { createdAt: "desc" },
  });
  const day = new Date().toISOString().slice(0, 10);
  for (const r of rows) await enqueue<DeepJob>("deep", { videoId: r.videoId }, { jobId: `deep-${r.videoId}-v${DEEP_VERSION}-${day}`, priority: 10 }).catch(() => {});
  return rows.length;
}
