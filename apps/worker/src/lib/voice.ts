// Studio voice: the dialogue made clean before the render (the cleanup's enhance and dereverb): python/voice.py takes
// the room's echo out (WPE) and the noise and room out (DeepFilterNet3, MIT or Apache-2.0, its official ONNX export,
// fetched into the worker image), from the footage's preview copy, in blocks of VOICE_BLOCK s. Each block is made once
// per strength and kept with the video, so the preview, the final, a render on the Mac and the next edit share it.
import { downloadFile, headObject, signGet, uploadFile } from "@rendrr/core";
import { prisma } from "@rendrr/db";
import { VOICE_BLOCK, voiceKey, voiceTag } from "@rendrr/shared";
import type { RenderPlan } from "@rendrr/shared/renderPlan";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { JobError, run } from "./ffmpeg";

const HERE = dirname(fileURLToPath(import.meta.url));
export const VOICE_PY = join(HERE, "../../python/voice.py");
const PYTHON = process.env.PYTHON_BIN || "python3";
/** DeepFilterNet3's ONNX export (enc.onnx, erb_dec.onnx, df_dec.onnx), fetched into the worker image. */
export const VOICE_MODELS = process.env.VOICE_MODELS || "/opt/models/dfn3";

/**
 * The studio voices a render reads (plan.voices): every block kept in storage is fetched, every missing one made (one
 * Python run per video for all its missing blocks), and each video's blocks joined into one file from its start.
 * Returns the files by video id (PlanFiles.voices).
 */
export async function ensureVoices(plan: RenderPlan, userId: string, dir: string, signal?: AbortSignal, onProgress?: (f: number) => void): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const voices = Object.values(plan.voices ?? {});
  if (!voices.length) return out;
  if (voices.some((v) => v.enhance > 0) && !existsSync(join(VOICE_MODELS, "enc.onnx"))) throw new JobError("The studio voice is not installed on this server.", "no-model", false);
  const total = voices.reduce((n, v) => n + v.blocks.length, 0);
  let done = 0;
  const report = (extra = 0) => onProgress?.(Math.min(1, (done + extra) / total));
  for (const v of voices) {
    const row = await prisma.video.findFirst({ where: { id: v.videoId, userId }, select: { id: true, proxyKey: true, seconds: true } });
    if (!row) throw new JobError("A video whose sound this edit cleans up is not in the library any more.", "not-found", false);
    const tag = voiceTag(v), vdir = join(dir, `voice-${v.videoId}`);
    await mkdir(vdir, { recursive: true });
    const missing: number[] = [];
    for (const k of v.blocks) {
      const key = voiceKey(userId, v.videoId, tag, k);
      if (await headObject(key)) { await downloadFile(key, join(vdir, `voice-${k}.flac`)); done++; report(); }
      else missing.push(k);
    }
    if (missing.length) {
      if (!row.proxyKey) throw new JobError("The preview copy of this footage expired. Rebuild it from your Library, then render again.", "expired", false);
      const t0 = Date.now(), before = done;
      const { stdout } = await run(PYTHON, [VOICE_PY, "--input", await signGet(row.proxyKey, 3600), "--blocks", missing.join(","), "--block", String(VOICE_BLOCK), "--seconds", String(row.seconds),
        "--denoise", String(v.enhance), "--dereverb", String(v.dereverb), "--models", VOICE_MODELS, "--out", vdir],
        { signal, onLine: (l) => { const m = /^PROGRESS (\d+)/.exec(l); if (m) { done = before + (Number(m[1]) / 100) * missing.length; report(); } } });
      console.log(`[voice] ${v.videoId} ${tag}: ${missing.length} blocks made in ${((Date.now() - t0) / 1000).toFixed(1)} s: ${(stdout.trim().split("\n").pop() ?? "").slice(0, 300)}`);
      await Promise.all(missing.map((k) => uploadFile(voiceKey(userId, v.videoId, tag, k), join(vdir, `voice-${k}.flac`), "audio/flac")));
      done = before + missing.length;
      report();
    }
    const joined = join(dir, `voice-${v.videoId}.flac`);
    await run(PYTHON, [VOICE_PY, "--join", "--dir", vdir, "--blocks", v.blocks.join(","), "--block", String(VOICE_BLOCK), "--seconds", String(row.seconds), "--out", joined], { signal });
    out[v.videoId] = joined;
  }
  return out;
}
