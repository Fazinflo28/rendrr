// Decoder threads in the render command. Left alone, FFmpeg gives each input's decoder as many threads as the host
// has CPUs (up to 16 each; two decoders for a graphic with transparency): on the worker's 48-CPU host, a render with
// 15 graphics started about 1,500 threads, over the container's 1,000, and everything running beside it failed. Each
// graphic now decodes with 1 thread (2 when there are 3 or fewer), and the other inputs share a budget.
import { describe, expect, it } from "vitest";
import { applyOp, buildInitialTimeline, buildTranscript, customParamsSchema, graphicDefaults, type EditContext, type Op, type Snapshot } from "../src/index";
import { capInputThreads, ffmpegArgs, planRender, type PlanFiles } from "../src/renderPlan";

const tr = buildTranscript([Array.from({ length: 40 }, (_, i) => ({ text: `w${i}`, start: 0.5 + i * 0.5, end: 0.9 + i * 0.5 }))], { maxWordsPerLine: 8 }).map((l) => ({ ...l, words: l.words.map((w) => ({ ...w, filler: false })) }));
const ctx: EditContext = {
  videoId: "v", transcript: tr, silences: [], sceneCuts: [], duration: 30, getStyle: () => undefined, getVideo: () => undefined,
  getGraphic: (id) => (id === "gc" ? { id, name: "Card", durationSec: 20, custom: true, params: graphicDefaults(customParamsSchema({ n: 1 })) } : undefined),
} as EditContext;
const src = { width: 1920, height: 1080, fps: 30, seconds: 30, hasAudio: true };
/** An edit with `n` placements of one custom graphic, each with its own params (its own file, as variants are). */
function withGraphics(n: number) {
  let s: Snapshot = { timeline: buildInitialTimeline(tr, 30, "clean", [], "v"), name: "t", aspect: "16:9", styleId: "s2" };
  s = applyOp(s, { op: "batch", ops: [{ op: "set_captions", on: false }, { op: "set_audio", loudness: null }, ...Array.from({ length: n }, (_, i) => ({ op: "add_graphic", graphicId: "gc", start: i * 1.5, end: i * 1.5 + 1.4, params: { n: i + 2 } }))] as never }, ctx).snap;
  const plan = planRender({ kind: "preview", snapshot: s, transcript: tr, source: src, videoId: "v" });
  const files: PlanFiles = { source: "/in.mp4", output: "/out.mp4", graphics: Object.fromEntries(plan.graphics.map((g) => [g.clipId, `/g-${g.clipId}.webm`])) };
  return { plan, files };
}
/** The options just before each "-i" (back to the previous input), by input path. */
function inputOpts(args: string[]) {
  const out: Record<string, string[]> = {};
  let from = args.indexOf("-y") + 1;
  for (let i = from; i < args.length; i++) if (args[i] === "-i") { out[args[i + 1]] = args.slice(from, i); from = i + 2; i++; }
  return out;
}
const threadsOf = (opts: string[]) => (opts.includes("-threads") ? Number(opts[opts.indexOf("-threads") + 1]) : null);

describe("decoder threads in the render", () => {
  it("15 graphics: each decodes with 1 thread; the footage gets its share of the budget", () => {
    const { plan, files } = withGraphics(15);
    expect(plan.graphics).toHaveLength(15);
    const opts = inputOpts(ffmpegArgs(plan, files, src, { inputThreads: 12 }).args);
    const graphics = Object.entries(opts).filter(([p]) => p.startsWith("/g-"));
    expect(graphics).toHaveLength(15);
    for (const [, o] of graphics) { expect(threadsOf(o)).toBe(1); expect(o.slice(-2)).toEqual(["-c:v", "libvpx-vp9"]); }
    // The other inputs (the footage) share 12 between them: every one has a cap, none over 12.
    const rest = Object.entries(opts).filter(([p]) => !p.startsWith("/g-"));
    expect(rest.length).toBeGreaterThan(0);
    for (const [, o] of rest) { const t = threadsOf(o)!; expect(t).toBeGreaterThanOrEqual(1); expect(t).toBeLessThanOrEqual(12); }
  });
  it("3 graphics or fewer: 2 threads each; without a budget the footage is left as it was", () => {
    const { plan, files } = withGraphics(3);
    const opts = inputOpts(ffmpegArgs(plan, files, src).args);
    for (const [p, o] of Object.entries(opts)) expect(threadsOf(o)).toBe(p.startsWith("/g-") ? 2 : null);
  });
  it("capInputThreads: a share for each input without its own, an input with its own kept, options kept in order", () => {
    expect(capInputThreads(["-ss", "1", "-i", "a", "-threads", "1", "-c:v", "libvpx-vp9", "-i", "b", "-i", "c"], 8))
      .toEqual(["-ss", "1", "-threads", "4", "-i", "a", "-threads", "1", "-c:v", "libvpx-vp9", "-i", "b", "-threads", "4", "-i", "c"]);
    expect(capInputThreads(["-i", "a"], 64)).toEqual(["-threads", "16", "-i", "a"]);
    expect(capInputThreads(Array.from({ length: 20 }, (_, i) => ["-i", `x${i}`]).flat(), 12).filter((x) => x === "1")).toHaveLength(20);
    expect(capInputThreads(["-i", "a"], undefined)).toEqual(["-i", "a"]);
  });
});
