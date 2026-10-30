// Footage read in windows (seeked inputs), and the budget that keeps a high-resolution original from opening dozens
// of decoders at once (each holds frames: a 4K final with 25 gaps ran the worker out of memory).
import { describe, expect, it } from "vitest";
import { applyOp, buildInitialTimeline, type EditContext, type Snapshot } from "../src/index";
import { ffmpegArgs, planRender, type SourceInfo } from "../src/renderPlan";

const SRC: SourceInfo = { width: 3840, height: 2160, fps: 24, seconds: 320, hasAudio: true };
const ctx = { videoId: "v", transcript: [], silences: [], sceneCuts: [], duration: 320, getStyle: () => undefined } as unknown as EditContext;
const planOf = (clips: { start: number; end: number }[]) => {
  let s: Snapshot = { timeline: buildInitialTimeline([], 320, "clean", [], "v"), name: "w", aspect: "16:9", styleId: null };
  s = applyOp(s, { op: "batch", ops: [{ op: "set_clips", track: "v1", clips: clips.map((c, i) => ({ ...c, label: "p" + i })) }, { op: "set_captions", on: false }, { op: "set_audio", loudness: null }] } as never, ctx).snap;
  return planRender({ kind: "final", snapshot: s, transcript: [], source: SRC, videoId: "v" });
};
const seeks = (args: string[]) => args.filter((_, i) => args[i - 1] === "-ss");
const inputs = (args: string[]) => args.filter((a) => a === "-i").length;
const files = { source: "/in.mp4", output: "/out.mp4" };

describe("window budget", () => {
  // 25 parts, each past a 10.5 s gap.
  const gaps = planOf(Array.from({ length: 25 }, (_, i) => ({ start: 2 + i * 12, end: 3.5 + i * 12 })));
  it("without a budget, every gap over 10 s gets its own seeked input", () => {
    expect(inputs(ffmpegArgs(gaps, files, SRC).args)).toBe(25);
  });
  it("over its budget, the video reads through its gaps (the smallest gap that fits): one input here", () => {
    const r = ffmpegArgs(gaps, files, SRC, { windowBudget: { v: 4 } });
    expect(inputs(r.args)).toBe(1);
    expect(seeks(r.args)).toEqual(["1"]);
  });
  it("big gaps keep their windows when the budget allows them", () => {
    // Three stretches far apart, each of five parts close together: three windows fit a budget of 4.
    const far = planOf([0, 100, 200].flatMap((b) => Array.from({ length: 5 }, (_, i) => ({ start: b + 2 + i * 3, end: b + 3.5 + i * 3 }))));
    expect(seeks(ffmpegArgs(far, files, SRC, { windowBudget: { v: 4 } }).args)).toEqual(["1", "101", "201"]);
    // A budget of 2 cannot hold them: read through (gap 180 joins 101 and 201? no: 100 s apart, so 180 joins all).
    expect(inputs(ffmpegArgs(far, files, SRC, { windowBudget: { v: 2 } }).args)).toBe(1);
  });
  it("a part played before the footage it follows still reads from its own place within the budget", () => {
    const hook = planOf([{ start: 200, end: 203 }, { start: 3, end: 6 }, { start: 7, end: 9 }]);
    expect(seeks(ffmpegArgs(hook, files, SRC, { windowBudget: { v: 2 } }).args)).toEqual(["199", "2"]);
    // A budget of 1: one input read from the start, as before windows.
    expect(inputs(ffmpegArgs(hook, files, SRC, { windowBudget: { v: 1 } }).args)).toBe(1);
  });
  it("only the inputs change: the cuts stay where they were, in footage seconds", () => {
    const trims = (g: string) => g.match(/trim=start=[\d.]+:end=[\d.]+/g);
    const a = ffmpegArgs(gaps, files, SRC).filterGraph, b = ffmpegArgs(gaps, files, SRC, { windowBudget: { v: 1 } }).filterGraph;
    expect(trims(b)).toEqual(trims(a));
    expect(trims(a)).toHaveLength(50); // picture and sound
    expect(b).toContain("[0:v]setpts=PTS+1/TB,fps=24,split=25"); // one decoder, put back to footage time
  });
});
