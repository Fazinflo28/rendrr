import type { FileSound } from "@rendrr/shared";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "./ffmpeg";

const HERE = dirname(fileURLToPath(import.meta.url));
const PY = join(HERE, "../../python/deep_audio.py");
const VAD = join(HERE, "../../models/silero/silero_vad.onnx");
const PYTHON = process.env.PYTHON_BIN || "python3";

/**
 * A rendered preview's sound, measured as the footage's is (Engine Part 2's deep_audio.py): speech with its edges moved
 * onto the level (from 0.15 s), the room's and the voice's level, breaths, and clicks within 20 ms of the edit's sound
 * joins (`joins`, edit seconds). The limit grows with the length (30 s + 8% of it: the live worker takes about 1.5%)
 * and stays well inside the preview's own, so a slow measurement is said in the check instead of failing the render.
 * Progress 0-1 goes to onProgress.
 */
export async function measureSound(file: string, joins: number[], o: { dir: string; seconds: number; signal?: AbortSignal; onProgress?: (f: number) => void }): Promise<FileSound> {
  const limitMs = 30_000 + Math.round(o.seconds * 80);
  const limit = AbortSignal.timeout(limitMs);
  const signal = o.signal ? AbortSignal.any([o.signal, limit]) : limit;
  const dir = await mkdtemp(join(o.dir, "sound-"));
  const p48 = join(dir, "a48.raw"), p16 = join(dir, "a16.raw"), pj = join(dir, "joins.json");
  try {
    await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-i", file, "-vn", "-ac", "1", "-ar", "48000", "-f", "s16le", p48], { signal });
    await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-i", file, "-vn", "-ac", "1", "-ar", "16000", "-f", "f32le", p16], { signal });
    await writeFile(pj, JSON.stringify(joins));
    const { stdout } = await run(PYTHON, [PY, "--pcm48", p48, "--pcm16", p16, "--vad", VAD, "--out", dir, "--joins", pj, "--min-speech", "0.15", "--edges"], {
      signal, onLine: (line) => { const m = /^PROGRESS (\d+)/.exec(line); if (m) o.onProgress?.(Number(m[1]) / 100); },
    });
    const j = JSON.parse(stdout.trim().split("\n").pop() || "{}") as { speech?: [number, number][]; roomDb?: number; speechDb?: number; breaths?: [number, number, number, number][]; joinClicks?: FileSound["joinClicks"] };
    return { speech: j.speech ?? [], roomDb: j.roomDb ?? -100, speechDb: j.speechDb ?? -100, breaths: (j.breaths ?? []).map(([a, b]) => [a, b]), joinClicks: j.joinClicks ?? [] };
  } catch (e) {
    if (o.signal?.aborted) throw e;
    return { speech: [], roomDb: -100, speechDb: -100, breaths: [], joinClicks: [], error: limit.aborted ? `measuring the sound took longer than ${Math.round(limitMs / 1000)}s` : `measuring the sound failed: ${(e as Error).message.slice(0, 200)}` };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
