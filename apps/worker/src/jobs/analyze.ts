import { downloadFile, signGet, transcriber, type AnalyzeJob } from "@rendrr/core";
import { prisma, type Prisma } from "@rendrr/db";
import { buildTranscript, DAY_MS, PREVIEW_RETENTION_DAYS, stubTranscript, type Transcript } from "@rendrr/shared";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { JobError, run, silences } from "../lib/ffmpeg";
import type { Ctx } from "../lib/job";

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

// Steps match the UI: Transcribing, Finding silences, Finding scene cuts.
export async function analyzeJob(ctx: Ctx) {
  const { videoId } = ctx.job.data as AnalyzeJob;
  const v = await prisma.video.findUnique({ where: { id: videoId } });
  if (!v) return;
  if (!v.audioKey || !v.proxyKey) throw new JobError("The preview copy is missing. Press Retry to make it again.", "no-proxy", false);
  const step = (n: number) => prisma.video.update({ where: { id: v.id }, data: { status: "processing", step: n } });

  await step(0);
  const t = transcriber();
  let transcript: Transcript;
  let by = "stub";
  if (t) {
    // TODO(key): without ASSEMBLYAI_API_KEY every video gets the sample transcript below.
    const sentences = await t.transcribe(await signGet(v.audioKey, 2 * 3600), { signal: ctx.signal });
    transcript = buildTranscript(sentences);
    by = t.name;
  } else {
    transcript = stubTranscript(v.seconds);
  }

  await step(1);
  const audio = join(ctx.dir, "audio.m4a"), proxy = join(ctx.dir, "proxy.mp4");
  await downloadFile(v.audioKey, audio);
  const sil = await silences(audio, ctx.signal);

  await step(2);
  await downloadFile(v.proxyKey, proxy);
  const cuts = await sceneCuts(proxy, ctx.signal);

  await prisma.footageAnalysis.upsert({
    where: { videoId: v.id },
    create: { videoId: v.id, transcriber: by, transcript: transcript as unknown as Prisma.InputJsonValue, silences: sil, sceneCuts: cuts },
    update: { transcriber: by, transcript: transcript as unknown as Prisma.InputJsonValue, silences: sil, sceneCuts: cuts },
  });
  await prisma.video.update({ where: { id: v.id }, data: { status: "ready", step: null, progress: null, error: null, previewExpiresAt: new Date(Date.now() + PREVIEW_RETENTION_DAYS * DAY_MS) } });
}
