import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ffmpegArgs, loudnessGain, readMixLoudness, type PlanFiles, type RenderPlan, type SourceInfo } from "@rendrr/shared/renderPlan";
import { JobError, run } from "./ffmpeg";

export type MixLoudness = { lufs: number | null; peakDb: number | null; gainDb: number };

/**
 * The loudness pass: plays the mix (audio only, no picture) through ebur128 and returns the gain that brings it to
 * the plan's target. It has its own time limit and fails with a plain message, never silently.
 */
export async function measureMix(plan: RenderPlan, files: PlanFiles, source: SourceInfo, o: { dir: string; signal?: AbortSignal; timeoutMs?: number; onProgress?: (frac: number) => void }): Promise<MixLoudness> {
  const target = plan.audioMix?.loudness;
  if (target == null) return { lufs: null, peakDb: null, gainDb: 0 };
  const { args, filterGraph } = ffmpegArgs(plan, files, source, { measure: true });
  const graph = join(o.dir, "mix-measure.txt");
  await writeFile(graph, filterGraph);
  const timeoutMs = o.timeoutMs ?? Math.max(60_000, plan.outputSeconds * 500);
  const ac = new AbortController();
  const stop = () => ac.abort();
  o.signal?.addEventListener("abort", stop, { once: true });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; ac.abort(); }, timeoutMs);
  try {
    const { stderr } = await run("ffmpeg", args.map((a) => (a === "__FILTER_SCRIPT__" ? graph : a)), { signal: ac.signal, onProgress: (sec) => o.onProgress?.(Math.min(1, sec / Math.max(0.1, plan.outputSeconds))) });
    const m = readMixLoudness(stderr);
    if (m.lufs == null) throw new JobError("Measuring the loudness gave no result. Try again.", "loudness", true);
    return { ...m, gainDb: loudnessGain(target, m.lufs) };
  } catch (e) {
    if (o.signal?.aborted) throw e;
    if (timedOut) throw new JobError(`Measuring the loudness took longer than ${Math.round(timeoutMs / 1000)}s. Try again.`, "loudness", true);
    if (e instanceof JobError) throw e;
    console.error("[render] loudness pass failed:", (e as Error).message.slice(0, 1200));
    throw new JobError("Measuring the loudness failed. Nothing was lost. Try again.", "loudness", true);
  } finally {
    clearTimeout(timer);
    o.signal?.removeEventListener("abort", stop);
  }
}
