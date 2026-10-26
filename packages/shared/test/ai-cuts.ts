// What an AI does now in place of the retired cut_silences: it reads the silences Rendrr marks and cuts the ones it
// chooses with explicit cut_words ranges. Tests that need an edit with many cuts use this.
import { applyOp, silenceMarks, type EditContext, type Op, type Snapshot } from "../src/index";

/** Cuts every pause between words longer than `over` seconds, leaving `keep` seconds next to the speech each side. */
export function cutPauses(s: Snapshot, ctx: EditContext, over: number, keep = 0.08): Snapshot {
  const marks = silenceMarks({ videoId: ctx.videoId ?? "main", transcript: ctx.transcript, silences: ctx.silences }).filter((m) => m.label === "between words" && m.end - m.start > over);
  const ops = marks.map((m) => ({ op: "cut_words" as const, from: Math.round((m.start + keep) * 1000) / 1000, to: Math.round((m.end - keep) * 1000) / 1000 })).filter((o) => o.to - o.from >= 0.001);
  let out = s;
  for (let i = 0; i < ops.length; i += 50) out = applyOp(out, { op: "batch", ops: ops.slice(i, i + 50) } as Op, ctx).snap;
  return out;
}
