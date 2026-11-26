import { z } from "zod";
import type { Board, BoardPanel } from "./storyboard";

/**
 * Samples: a few frames and short clips of an edit, rendered on their own before the whole preview (the way an editor
 * makes style frames first). Each is drawn exactly as the whole render draws that moment (renderPlan windowPlan); the
 * user sees them in the chat's Rendrr app as a storyboard and asks for changes on each one.
 */
export const SAMPLE_MAX_FRAMES = 8;
export const SAMPLE_MAX_CLIPS = 3;
/** The longest clip one sample renders, and the length of one asked for without an end. */
export const SAMPLE_MAX_CLIP = 6;
export const SAMPLE_CLIP_DEFAULT = 4;
export const SAMPLE_STEPS = ["Reading timeline", "Measuring loudness", "Rendering samples", "Packing samples"] as const;

const note = z.string().max(300).optional().describe("What this sample shows or asks the user to look at (shown under it)");
/** What render_samples takes (edit seconds: the edit as it plays). */
export const SampleRequestShape = {
  frames: z.array(z.object({ at: z.number().min(0).describe("Edit seconds"), note })).max(SAMPLE_MAX_FRAMES).optional(),
  clips: z.array(z.object({ start: z.number().min(0).describe("Edit seconds"), end: z.number().min(0).optional().describe(`Default start + ${SAMPLE_CLIP_DEFAULT}, at most start + ${SAMPLE_MAX_CLIP}`), note })).max(SAMPLE_MAX_CLIPS).optional(),
};
export const SampleRequestSchema = z.object(SampleRequestShape);
export type SampleRequest = z.infer<typeof SampleRequestSchema>;

/** One sample: a frame at `at`, or a clip over [at, end). Edit seconds, on the frame grid. */
export type SampleItem = { kind: "frame" | "clip"; at: number; end?: number; note?: string;
  /** A clip's picture: the edit second it is taken at (where its motion has landed). Left out: its first frame. */
  stillAt?: number };
/** A finished sample: its still (a frame's picture, or a clip's first frame) and a clip's file (storage keys). */
export type SampleDone = SampleItem & { still: string; clip?: string };
/** What a sample render keeps in its plan: the items asked for, and once done their files. A storyboard (Storyboard
 *  mode) is a set of samples with a board: its panels' words are on the items. */
export type SamplePlan = { items: (SampleItem & Partial<BoardPanel>)[]; done?: (SampleDone & Partial<BoardPanel>)[]; width?: number; height?: number; operations?: string[]; board?: Board };

export class SampleError extends Error {}

/**
 * The samples asked for, checked against the edit's length and put on its frames, in edit order. A clip without an
 * end is SAMPLE_CLIP_DEFAULT long; one longer than SAMPLE_MAX_CLIP is refused (render_preview renders the whole edit).
 */
export function sampleItems(req: SampleRequest, outputSeconds: number, fps = 30): SampleItem[] {
  const grid = (t: number) => Math.round(t * fps) / fps;
  const last = Math.max(0, grid(outputSeconds) - 1 / fps);
  const items: SampleItem[] = [];
  for (const f of req.frames ?? []) {
    if (f.at > outputSeconds + 1e-6) throw new SampleError(`Frame at ${sampleClock(f.at)} is past the end of the edit (${sampleClock(outputSeconds)}).`);
    items.push({ kind: "frame", at: Math.min(last, grid(f.at)), ...(f.note ? { note: f.note } : {}) });
  }
  for (const c of req.clips ?? []) {
    const at = grid(c.start);
    if (at >= outputSeconds - 1e-6) throw new SampleError(`Clip at ${sampleClock(c.start)} starts past the end of the edit (${sampleClock(outputSeconds)}).`);
    const want = c.end ?? c.start + SAMPLE_CLIP_DEFAULT;
    if (want <= c.start) throw new SampleError(`Clip at ${sampleClock(c.start)}: its end must be after its start.`);
    if (want - c.start > SAMPLE_MAX_CLIP + 1e-6) throw new SampleError(`Clip at ${sampleClock(c.start)} is ${Math.round((want - c.start) * 10) / 10} s: samples are at most ${SAMPLE_MAX_CLIP} s (render_preview renders the whole edit).`);
    const end = Math.min(grid(outputSeconds), Math.max(at + 1 / fps, grid(want)));
    items.push({ kind: "clip", at, end, ...(c.note ? { note: c.note } : {}) });
  }
  if (!items.length) throw new SampleError("Ask for at least one frame or clip.");
  return items.sort((a, b) => a.at - b.at || (a.kind === "frame" ? -1 : 1));
}

/** The edit seconds a sample draws: a frame is one frame long. */
export const sampleWindow = (s: SampleItem, fps = 30) => ({ from: s.at, to: s.kind === "clip" ? s.end! : s.at + 1 / fps });

/** Edit time to a tenth of a second: 0:04.2, 1:05.0. */
export const sampleClock = (x: number) => { const d = Math.round(Math.max(0, x) * 10); return `${Math.floor(d / 600)}:${String(Math.floor((d % 600) / 10)).padStart(2, "0")}.${d % 10}`; };

/** One line per sample, as Claude reads them ("1. frame 0:04.2 - the hook's title"). */
export function samplesText(items: SampleItem[]): string {
  return items.map((s, i) => `${i + 1}. ${s.kind === "frame" ? `frame ${sampleClock(s.at)}` : `clip ${sampleClock(s.at)}-${sampleClock(s.end!)}`}${s.note ? ` - ${s.note}` : ""}`).join("\n");
}
