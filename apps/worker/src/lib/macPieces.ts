// A heavy final made on the user's computer in pieces (as the cloud makes one when its memory runs out): the whole
// edit's sound once, on its own; each piece's picture from the plan cut down to it (windowPlan: only the sources it
// shows, drawn exactly as the whole); then the pieces joined under the one sound, the picture copied. A laptop has far
// less memory than the cloud's container, and one pass of a heavy edit there swaps and crawls.
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ffmpegArgs, pieceRanges, windowPlan, type PlanFiles, type RenderPlan, type SourceInfo } from "@rendrr/shared/renderPlan";
import { joinPiecesArgs, piecesList } from "./deliver";
import { filterThreads } from "./ffmpeg";
import type { MacRun } from "./macTask";

/** A final made on the user's computer in pieces from the start (lower than the cloud's piecesFirst: less memory). */
export const macPiecesFirst = (kind: string, g: { inputs: number; scalers: number }) => kind === "final" && (g.inputs >= 12 || g.scalers >= 60);

/**
 * The runs for a final in pieces, written for the job's folder `dir` (the pieces' list goes in it). at: which run makes
 * which stretch of the edit (for its progress). Null: the edit is one piece (short), so one pass it is.
 */
export async function macPieceRuns(o: { plan: RenderPlan; files: PlanFiles; source: SourceInfo; dir: string; cpus: number; budgets?: Record<string, number>; gainDb?: number; audioBitrate: string }): Promise<{ runs: MacRun[]; at: Map<number, { a: number; b: number }>; count: number } | null> {
  const pieces = pieceRanges(o.plan);
  if (pieces.length < 2) return null;
  const runs: MacRun[] = [], at = new Map<number, { a: number; b: number }>(), made: string[] = [];
  const soundPath = join(o.dir, "sound.wav");
  const sa = ffmpegArgs(o.plan, { ...o.files, output: soundPath }, o.source, { threads: 2, inputThreads: o.cpus * 2, loudnessGainDb: o.gainDb, sound: "only" });
  runs.push({ args: sa.args, graph: sa.filterGraph, seconds: o.plan.outputSeconds });
  pieces.forEach((pc, n) => {
    const out = join(o.dir, `piece-${n}.mov`), sub = windowPlan(o.plan, pc.a, pc.b), f = { ...o.files, output: out };
    const opts = { threads: o.cpus, inputThreads: o.cpus * 2, windowBudget: o.budgets, sound: "none" as const };
    const a = ffmpegArgs(sub, f, o.source, { ...opts, filterThreads: filterThreads(ffmpegArgs(sub, f, o.source, { ...opts, filterThreads: 4 }).filterGraph) });
    at.set(runs.length, pc);
    runs.push({ args: a.args, graph: a.filterGraph, seconds: pc.b - pc.a });
    made.push(out);
  });
  const list = join(o.dir, "pieces.txt");
  await writeFile(list, piecesList(made));
  runs.push({ args: joinPiecesArgs(list, o.files.output, o.audioBitrate, soundPath, true) });
  return { runs, at, count: pieces.length };
}
