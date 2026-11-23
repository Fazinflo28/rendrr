// Renders that filled the memory of the user's Mac and of the cloud (23 November): "PT Clinic Owners V2", 51 clips cut
// from one 4K original, framed 1.22 and moved up, graded, keyframes on the first clip, 3 graphics over it all, music,
// and four plain morphs. Its 540p preview took over 14 GB before it made a frame. Four faults, each fixed here:
// 1. A transition was centred on its clip's start, which falls between two frames, while the picture changes on a
//    frame: the morph's B side took a sliver of the clip before it, under a frame long (no frame at all). Framed, that
//    sliver never ended (overlay with a picture that has no frame never ends; the frame under it went on forever), and
//    the morph's reverse held every frame it was given. Now the cut is the picture's own, a side reads at least its
//    frames of footage, the frame under a framed picture ends, and the reverse is given no more than B's frames.
// 2. A layer starting part way in (a transition, a flash, an adjustment layer, a blended layer) was laid with its
//    first frame at its start: the overlay read that frame before laying frame 0, so FFmpeg made, and kept, all of the
//    edit before it first (the whole edit, for a transition near the end of a final read in one window). Now each is
//    laid from frame 0 behind blank frames (fromStart).
// 3. A plain morph's motion interpolation set aside 288 bytes a pixel for each morph when the render started (600 MB
//    a morph at 1080p, 2.4 GB at 4K). It works at a 540p frame's worth at most now, and the result is scaled back up.
// 4. Each clip drawn on its own kept its framing's frame and layer until the end (~24 MB a clip at 1080p): a framed
//    clip that still covers the whole frame is cut out of the scaled picture instead.
import { describe, expect, it } from "vitest";
import { applyOp, buildInitialTimeline, type EditContext, type Op, type Snapshot } from "../src/index";
import { ffmpegArgs, MORPH_PIXELS, planRender, type PlanFiles, type SourceInfo } from "../src/renderPlan";

// Clips of off-grid lengths (as the user's: 1.225 s, 1.585 s, ...), so most cuts fall between two frames.
const LENS = [1.225, 1.585, 2.295, 1.585, 0.955, 0.635, 2.355, 2.97, 1.475, 0.845, 1.855, 1.315];
const SECONDS = 120;
const clips = LENS.map((len, i) => ({ id: `c${i}`, start: 5 + i * 9, end: 5 + i * 9 + len, label: "" }));
const ctx: EditContext = { videoId: "v", transcript: [], silences: [], sceneCuts: [], duration: SECONDS, getStyle: () => undefined };
const source: SourceInfo = { width: 720, height: 1280, fps: 30, seconds: SECONDS, hasAudio: true };
const edit = (ops: Op[]): Snapshot => {
  const s0 = applyOp({ timeline: buildInitialTimeline([], SECONDS, "clean", [], "v"), name: "t", aspect: "9:16", styleId: "s2" } as Snapshot, { op: "batch", ops: [{ op: "set_captions", on: false }, { op: "set_clips", track: "v1", clips }] } as never, ctx).snap;
  return ops.length ? applyOp(s0, { op: "batch", ops } as never, ctx).snap : s0;
};
const plan = (s: Snapshot, kind: "preview" | "final" = "preview") => planRender({ kind, snapshot: s, transcript: [], source, videoId: "v" });
const graph = (p: ReturnType<typeof plan>, budget?: number) => ffmpegArgs(p, { source: "/in.mp4", output: "/o.mp4" } as PlanFiles, source, { loudnessGainDb: 0, ...(budget ? { windowBudget: { v: budget } } : {}) }).filterGraph;
const id = (s: Snapshot, k: number) => ((s.timeline as unknown as { sequence: { id: string }[] }).sequence ?? (s.timeline.tracks as unknown as { v1: { id: string }[] }).v1)[k].id;

describe("a transition's cut is where the picture changes", () => {
  it("each side is whole frames of its own clip: no sliver of the other clip under a frame long", () => {
    const s0 = edit([]);
    const s = applyOp(s0, { op: "batch", ops: [2, 6, 9, 11].map((k) => ({ op: "set_transition", clipId: id(s0, k), type: "morph", duration: 0.25, face: false })) } as never, ctx).snap;
    const p = plan(s);
    const ts = p.transitions!.filter((t) => t.type === "morph");
    expect(ts).toHaveLength(4);
    for (const t of ts) {
      // On the output's frames (30 fps), as the picture's parts are.
      for (const x of [t.at, t.start, t.end]) expect(Math.abs(x * 30 - Math.round(x * 30))).toBeLessThan(0.02);
      expect(t.a.length).toBe(1);
      expect(t.b.length).toBe(1);
      const k = Number(t.clipId.replace(/\D/g, "")) || ts.indexOf(t);
      for (const sd of [...t.a, ...t.b]) expect(sd.end - sd.start).toBeGreaterThan(1 / 30 - 1e-3);
      expect(t.b[0].clipId).toBe(t.clipId);
      expect(t.a[0].clipId).not.toBe(t.clipId);
      expect(k).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("nothing in the graph can run on forever or make FFmpeg read ahead", () => {
  const s0 = edit([]);
  const withAll = applyOp(s0, { op: "batch", ops: [
    { op: "set_framing", all: true, scale: 1.22, y: -0.03 },
    { op: "set_transition", clipId: id(s0, 3), type: "dissolve", duration: 0.4 },
    { op: "set_transition", clipId: id(s0, 7), type: "flash", duration: 0.4 },
    { op: "set_transition", clipId: id(s0, 11), type: "morph", duration: 0.25, face: false },
  ] } as never, ctx).snap;

  it("every transition and flash is laid from frame 0 behind blank frames (one picture, shared)", () => {
    const g = graph(plan(withAll), 1);
    // No layer laid with its first frame part way in.
    expect(g).not.toMatch(/setpts=PTS-STARTPTS\+\d+\[(txo|fl)\d+\]/);
    for (const name of ["txo0", "fl1", "txo2"]) {
      expect(g).toMatch(new RegExp(`color=c=black@0:s=540x960:r=30,format=yuv420p,setsar=1,trim=end_frame=\\d+\\[${name}lead\\]`));
      expect(g).toMatch(new RegExp(`\\[${name}lead\\]\\[${name}own\\]concat=n=2:v=1:a=0,settb=1/30,setpts=N\\[${name}\\]`));
    }
  });

  it("a framed clip that still covers the frame is cut out of the scaled picture: no frame under it, no layer", () => {
    const g = graph(plan(withAll), 1);
    expect(g).toMatch(/scale=658:1172,setsar=1,crop=540:960:59:135:exact=1,format=yuv420p/);
    expect(g).not.toMatch(/\[fcanvas/);
  });

  it("a framed clip that does not cover it is laid on a frame that ends a second after it", () => {
    const s = applyOp(s0, { op: "batch", ops: [{ op: "set_framing", all: true, scale: 0.8 }, { op: "set_keyframes", clipId: id(s0, 0), keys: [{ t: 0, scale: 1 }, { t: 0.5, scale: 1.1 }] }] } as never, ctx).snap;
    const g = graph(plan(s));
    const canvases = g.match(/color=c=black(@0)?:s=540x960:r=30[^[;]*\[fcanvas\d+\]/g) ?? [];
    expect(canvases.length).toBeGreaterThan(0);
    for (const c of canvases) expect(c).toMatch(/:d=\d+\.\d{6}/);
  });

  it("a morph's reverse is given no more than B's frames", () => {
    const g = graph(plan(withAll));
    // (One segment a side: B is [tb2_0], its 7 frames: half the 0.25 s morph, 0.1 s, on whole frames... as planned.)
    const nB = plan(withAll).transitions!.find((t) => t.type === "morph")!.b.reduce((n, x) => n + Math.max(1, Math.round((x.end - x.start) * 30)), 0);
    expect(g).toMatch(new RegExp(`\\[tb2_0\\]trim=end_frame=${nB},reverse,trim=end_frame=1`));
    expect(nB).toBeLessThan(8);
  });
});

describe("a plain morph's motion interpolation works at a 540p frame's worth at most", () => {
  const s0 = edit([]);
  const s = applyOp(s0, { op: "set_transition", clipId: id(s0, 5), type: "morph", duration: 0.25, face: false } as never, ctx).snap;
  it("a 1080x1920 final: made at 540x960 and scaled back up", () => {
    const g = graph(plan(s, "final"));
    expect(MORPH_PIXELS).toBe(960 * 540);
    expect(g).toMatch(/trim=end_frame=1,setpts=PTS-STARTPTS,scale=540:960,split\[mfa0\]/);
    expect(g).toMatch(/minterpolate=fps=30:[^,]*,trim=start=[\d.]+,setpts=PTS-STARTPTS,trim=end_frame=\d+,scale=1080:1920:flags=bicubic,setsar=1,format=yuv420p\[tx0\]/);
  });
  it("a 540x960 preview: at its own size, as before", () => {
    const g = graph(plan(s));
    expect(g).not.toMatch(/scale=540:960,split\[mfa0\]/);
    expect(g).toMatch(/trim=end_frame=1,setpts=PTS-STARTPTS,split\[mfa0\]/);
  });
});
