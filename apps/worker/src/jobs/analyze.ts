import { downloadFile, enqueue, noteCost, recordUsage, signGet, transcriber, type AnalyzeJob, type DeepJob } from "@rendrr/core";
import { prisma, type Prisma } from "@rendrr/db";
import { buildTranscript, DAY_MS, DEEP_VERSION, PREVIEW_RETENTION_DAYS, sentencesFromWords, stubTranscript, type Transcript } from "@rendrr/shared";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { JobError, run, silences } from "../lib/ffmpeg";
import { throttle, type Ctx } from "../lib/job";
import { madeOnMeta, transcriptOnComputer, withMadeOn, type StepWhere } from "../lib/onComputer";
import { breakdownVideo } from "./breakdown";

const SCENES_PY = join(dirname(fileURLToPath(import.meta.url)), "../../python/scenes.py");
const PYTHON = process.env.PYTHON_BIN || "python3";

async function sceneCuts(path: string, signal: AbortSignal): Promise<number[]> {
  try {
    const { stdout } = await run(PYTHON, [SCENES_PY, path], { signal });
    const cuts = JSON.parse(stdout.trim().split("\n").pop() || "[]");
    return Array.isArray(cuts) ? cuts.filter((x) => typeof x === "number") : [];
  } catch (e) {
    if (signal.aborted) throw e;
    console.error("[analyze] scene detection failed, continuing without scene cuts:", (e as Error).message.slice(0, 300));
    return [];
  }
}

// Steps match the UI: Transcribing, Finding silences, Finding scene cuts, Reading the frames.
export async function analyzeJob(ctx: Ctx) {
  const { videoId } = ctx.job.data as AnalyzeJob;
  const v = await prisma.video.findUnique({ where: { id: videoId } });
  if (!v) return;
  if (!v.audioKey || !v.proxyKey) throw new JobError("The preview copy is missing. Press Retry to make it again.", "no-proxy", false);
  // A picture (a still clip): nothing to hear or cut. Ready as it is (its key frames came with the preview).
  if (v.still) {
    await prisma.footageAnalysis.upsert({ where: { videoId: v.id }, create: { videoId: v.id, transcriber: "none", transcript: [], silences: [], sceneCuts: [] }, update: { transcriber: "none", transcript: [], silences: [], sceneCuts: [] } });
    await prisma.video.update({ where: { id: v.id }, data: { status: "ready", step: null, progress: null, error: null, previewExpiresAt: new Date(Date.now() + PREVIEW_RETENTION_DAYS * DAY_MS) } });
    return;
  }
  const step = (n: number) => prisma.video.update({ where: { id: v.id }, data: { status: "processing", step: n } });

  await step(0);
  const t = transcriber();
  let transcript: Transcript | null = null;
  let by = "stub";
  let heard: StepWhere = { on: "cloud", by: t?.name ?? "stub", why: null, at: Date.now() };
  // On the user's computer first, while the Rendrr app is open and has its speech model (lib/onComputer.ts): the
  // preview's 16 kHz sound goes to the app, which writes the words; nothing goes to the transcription service. Samples
  // keep the cloud's (free) transcript. Anything that stops it: the cloud transcribes as before, the reason kept.
  if (!v.sample && v.hasAudio !== false) {
    const progress = throttle((f: number) => prisma.video.update({ where: { id: v.id }, data: { progress: Math.min(99, Math.round(f * 100)) } }).catch(() => {}), 1500);
    const r = await transcriptOnComputer({ userId: v.userId, videoId: v.id, signal: ctx.signal, dir: ctx.dir, extend: ctx.extend, audioKey: v.audioKey, seconds: v.seconds, language: "en", onProgress: progress });
    if (r.words) { transcript = buildTranscript(sentencesFromWords(r.words)); by = "whisper"; heard = r.where; }
    else heard.why = r.why;
    await prisma.video.update({ where: { id: v.id }, data: { progress: null } }).catch(() => {});
  }
  if (!transcript && t) {
    // TODO(key): without ASSEMBLYAI_API_KEY every video gets the sample transcript below.
    const sentences = await t.transcribe(await signGet(v.audioKey, 2 * 3600), { signal: ctx.signal });
    transcript = buildTranscript(sentences);
    by = t.name;
  } else if (!transcript) {
    transcript = stubTranscript(v.seconds);
  }
  const madeOn = withMadeOn(v.madeOn, { transcript: heard });
  await prisma.video.update({ where: { id: v.id }, data: { madeOn } }).catch(() => {});
  // Billing: this video's footage minutes, once (a video processed again is not counted again). Where its preview copy
  // and transcript were made goes with it (the usage page shows it).
  noteCost({ kind: "analyze", refId: v.id });
  if (!v.sample) await recordUsage({ userId: v.userId, metric: "footage", quantity: Math.round((v.seconds / 60) * 1000) / 1000, refId: v.id, meta: { name: v.name, source: v.source, ...madeOnMeta(madeOn) } });

  await step(1);
  const audio = join(ctx.dir, "audio.m4a"), proxy = join(ctx.dir, "proxy.mp4");
  await downloadFile(v.audioKey, audio);
  const sil = await silences(audio, ctx.signal);

  await step(2);
  await downloadFile(v.proxyKey, proxy);
  const cuts = await sceneCuts(proxy, ctx.signal);

  const an = await prisma.footageAnalysis.upsert({
    where: { videoId: v.id },
    create: { videoId: v.id, transcriber: by, transcript: transcript as unknown as Prisma.InputJsonValue, silences: sil, sceneCuts: cuts },
    update: { transcriber: by, transcript: transcript as unknown as Prisma.InputJsonValue, silences: sil, sceneCuts: cuts },
  });

  // The video as text and frames for the AI. If it fails the footage still becomes ready (editing does not need
  // it); the worker tries again on its next start (see index.ts).
  await step(3);
  await breakdownVideo(ctx, v, an, proxy, audio).catch((e) => {
    if (ctx.signal.aborted) throw e;
    console.error(`[analyze] breakdown failed for ${v.id}, continuing:`, (e as Error).message.slice(0, 300));
  });
  await prisma.video.update({ where: { id: v.id }, data: { status: "ready", step: null, progress: null, error: null, previewExpiresAt: new Date(Date.now() + PREVIEW_RETENTION_DAYS * DAY_MS) } });
  // The deeper measurements run after the video is ready: editing never waits for them.
  await enqueue<DeepJob>("deep", { videoId: v.id, force: true }, { jobId: `deep-${v.id}-v${DEEP_VERSION}-${Date.now()}` }).catch((e) => console.error(`[analyze] could not queue the deeper measurements for ${v.id}:`, (e as Error).message));
}
