// The A -> B migration check: a timeline stored in model A is converted to a sequence (toModelB) only when the new
// planner gives the same render as the old one, within one frame (picture parts, dialogue and its muted stretches,
// captions, zooms, b-roll, graphics, music and sound effects). See docs/timeline-model.md.
import { planRender, type PlanInput, type RenderPlan, type SourceInfo } from "./renderPlan";
import { planRenderA } from "./renderPlanA";
import { isSequence, toModelB } from "./sequence";
import type { Snapshot, Timeline } from "./timeline";
import { allWords, type Transcript } from "./transcript";

const FRAME = 1 / 30;

/** Every way the two plans differ (empty = the same render). */
export function planDifferences(a: RenderPlan, b: RenderPlan, tol = FRAME + 1e-6): string[] {
  const out: string[] = [];
  const near = (x: number, y: number) => Math.abs(x - y) <= tol;
  const same = <T>(what: string, xs: T[], ys: T[], eq: (x: T, y: T) => boolean, show: (x: T) => string) => {
    if (xs.length !== ys.length) { out.push(`${what}: ${xs.length} in A, ${ys.length} in B`); return; }
    xs.forEach((x, i) => { if (!eq(x, ys[i])) out.push(`${what} ${i + 1}: A ${show(x)}, B ${show(ys[i])}`); });
  };
  if (!near(a.outputSeconds, b.outputSeconds)) out.push(`length: A ${a.outputSeconds}s, B ${b.outputSeconds}s`);
  if (a.width !== b.width || a.height !== b.height) out.push(`size: A ${a.width}x${a.height}, B ${b.width}x${b.height}`);
  const t = (r: { start: number; end: number }) => `${r.start.toFixed(3)}-${r.end.toFixed(3)}`;
  same("picture part", a.parts, b.parts, (x, y) => near(x.srcIn, y.srcIn) && near(x.srcOut, y.srcOut) && near(x.start, y.start) && near(x.end, y.end) && x.rotate === y.rotate && JSON.stringify(x.framing) === JSON.stringify(y.framing), (x) => `${x.srcIn.toFixed(3)}-${x.srcOut.toFixed(3)}@${t(x)} ${x.rotate}° ${JSON.stringify(x.framing)}`);
  if (a.sources.length !== b.sources.length) out.push(`videos: A ${a.sources.length}, B ${b.sources.length}`);
  same("muted dialogue", a.dialogueMutes, b.dialogueMutes, (x, y) => near(x.start, y.start) && near(x.end, y.end), t);
  // Sound that plays (model A: the picture minus muted stretches; B: its unmuted dialogue parts).
  same("caption", a.captions, b.captions, (x, y) => near(x.start, y.start) && near(x.end, y.end) && x.text === y.text, (x) => `${t(x)} "${x.text}"`);
  same("zoom", a.zooms, b.zooms, (x, y) => near(x.start, y.start) && near(x.end, y.end) && x.scale === y.scale && x.mode === y.mode, (x) => `${t(x)} ${x.scale} ${x.mode}`);
  same("b-roll", a.broll, b.broll, (x, y) => x.clipId === y.clipId && near(x.start, y.start) && near(x.end, y.end) && near(x.sourceStart, y.sourceStart), (x) => `${x.clipId} ${t(x)}`);
  same("graphic", a.graphics, b.graphics, (x, y) => x.clipId === y.clipId && near(x.start, y.start) && near(x.end, y.end), (x) => `${x.clipId} ${t(x)}`);
  const byKind = (p: RenderPlan) => [...p.audio].sort((x, y) => x.kind.localeCompare(y.kind) || x.start - y.start);
  same("audio clip", byKind(a), byKind(b), (x, y) => x.clipId === y.clipId && x.kind === y.kind && near(x.start, y.start) && near(x.end, y.end) && x.gainDb === y.gainDb && x.assetKey === y.assetKey, (x) => `${x.kind} ${x.clipId} ${t(x)}`);
  return out;
}

export type Conversion = { timeline: Timeline; differences: string[]; skipped?: string };

/**
 * Converts a model A timeline and checks it: both planners must give the same render. `source` is the footage
 * (its real length matters at the end of the edit); planning is done for a preview, which uses the same times.
 */
export function convertChecked(snap: Snapshot, transcript: Transcript, opts: { videoId: string; source: SourceInfo; brollSeconds?: Record<string, number> }): Conversion {
  if (isSequence(snap.timeline)) return { timeline: snap.timeline, differences: [], skipped: "already a sequence" };
  const timeline = toModelB(snap.timeline, allWords(transcript), opts.videoId, { seconds: opts.source.seconds });
  const input = (s: Snapshot): PlanInput => ({ kind: "preview", snapshot: s, transcript, source: opts.source, videoId: opts.videoId, brollSeconds: opts.brollSeconds });
  let a: RenderPlan | null = null, aErr: string | null = null;
  try { a = planRenderA(input(snap)); } catch (e) { aErr = (e as Error).message; }
  let b: RenderPlan | null = null, bErr: string | null = null;
  try { b = planRender(input({ ...snap, timeline })); } catch (e) { bErr = (e as Error).message; }
  if (aErr || bErr) return { timeline, differences: aErr && bErr ? [] : [`A ${aErr ?? "plans"}; B ${bErr ?? "plans"}`] };
  return { timeline, differences: planDifferences(a!, b!) };
}
