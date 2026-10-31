// Premiere parity, phase 8: Morph Cut. A transition type: its sides are each clip's own frames (no footage past the
// cut needed), the graph morphs A's frame at the window's start into B's at its end (minterpolate, each frame twice,
// scene detection off), the player shows a dissolve, and the first clip has none.
import { describe, expect, it } from "vitest";
import { applyOp, buildInitialTimeline, buildTranscript, transitionAt, type EditContext, type Op, type Snapshot } from "../src/index";
import { ffmpegArgs, planRender, type PlanFiles } from "../src/renderPlan";

const tr = buildTranscript([Array.from({ length: 20 }, (_, i) => ({ text: `w${i}`, start: 0.5 + i * 0.5, end: 0.9 + i * 0.5 }))], { maxWordsPerLine: 8 }).map((l) => ({ ...l, words: l.words.map((w) => ({ ...w, filler: false })) }));
const ctx: EditContext = { videoId: "v", transcript: tr, silences: [], sceneCuts: [], duration: 12, getStyle: () => undefined };
const base = (): Snapshot => applyOp({ timeline: buildInitialTimeline(tr, 12, "clean", [], "v"), name: "t", aspect: "16:9", styleId: "s2" }, { op: "set_clips", track: "v1", clips: [{ id: "a", start: 1, end: 5, label: "" }, { id: "b", start: 6, end: 10, label: "" }] } as Op, ctx).snap;
const source = { width: 1280, height: 720, fps: 30, seconds: 12, hasAudio: true };

describe("Morph Cut", () => {
  it("is planned on a jump cut from each clip's own frames, and morphs A's frame into B's", () => {
    const s = applyOp(base(), { op: "set_transition", clipId: "b", type: "morph", duration: 0.4 } as Op, ctx).snap;
    const p = planRender({ kind: "preview", snapshot: s, transcript: tr, source, videoId: "v" });
    const t = p.transitions!.find((x) => x.type === "morph")!;
    expect([t.start, t.end, t.at]).toEqual([3.8, 4.2, 4]);
    expect(t.a.map((x) => [x.srcIn, x.srcOut])).toEqual([[4.8, 5]]);
    expect(t.b.map((x) => [x.srcIn, x.srcOut])).toEqual([[6, 6.2]]);
    const g = ffmpegArgs(p, { source: "/in.mp4", output: "/o.mp4" } as PlanFiles, source, { loudnessGainDb: 0 }).filterGraph;
    expect(g).toMatch(/\[mfa0\]\[mfc0\]\[mfb0\]\[mfd0\]concat=n=4:v=1:a=0,settb=1\/1000,setpts=N\*400,minterpolate=fps=30:mi_mode=mci:mc_mode=aobmc:me_mode=bidir:vsbmc=1:search_param=64:scd=none,trim=start=0\.400000,setpts=PTS-STARTPTS,trim=end_frame=12/);
    expect(p.operations.join("\n")).toMatch(/Transitions: 1 \(morph face-aware 0\.40s\); a face-aware morph slides the head/);
  });
  it("the player shows a dissolve; the first clip has no morph", () => {
    expect(transitionAt({ type: "morph" }, 0.5, 100, 100).b.opacity).toBe(0.5);
    const s = applyOp(base(), { op: "set_transition", clipId: "a", type: "morph", duration: 0.4 } as Op, ctx).snap;
    const t = planRender({ kind: "preview", snapshot: s, transcript: tr, source, videoId: "v" }).transitions!.find((x) => x.clipId === "a")!;
    expect(t.note).toMatch(/left out: no clip before it/);
  });
});

describe("face-aware Morph Cut", () => {
  // A's face: five points round (0.4, 0.4); B's the same face 4% of the width to the right and 10% bigger.
  const pts = (cx: number, cy: number, s: number): [number, number][] => [[-0.03, -0.03], [0.03, -0.03], [0, 0], [-0.025, 0.04], [0.025, 0.04]].map(([x, y]) => [cx + x * s, cy + y * s * (16 / 9)] as [number, number]);
  const face = { a: pts(0.4, 0.4, 1), b: pts(0.44, 0.4, 1.1), aBox: [0.36, 0.33, 0.08, 0.14] as [number, number, number, number], bBox: [0.396, 0.32, 0.088, 0.154] as [number, number, number, number] };
  it("fits the move from A's face to B's: centres, scale and turn", async () => {
    const { faceWarp, morphArea } = await import("../src/renderPlan");
    const w = faceWarp(face, 1280, 720)!;
    expect(w.ca[0]).toBeCloseTo(0.4 * 1280, 0);
    expect(w.cb[0]).toBeCloseTo(0.44 * 1280, 0);
    expect(w.s).toBeCloseTo(1.1, 3);
    expect(w.th).toBeCloseTo(0, 4);
    // A head turned or reframed is too much to slide: a plain morph instead.
    expect(faceWarp({ ...face, b: pts(0.44, 0.4, 1.6) }, 1280, 720)).toBeNull();
    expect(faceWarp({ ...face, b: pts(0.9, 0.4, 1) }, 1280, 720)).toBeNull();
    const ar = morphArea(face, 1280, 720);
    expect(ar.cx).toBeGreaterThan(0.4 * 1280); expect(ar.rx).toBeGreaterThan(0.08 * 1280 * 1.9);
  });
  it("with the face measured, the window slides the head into place inside a soft area; without it, the plain morph", () => {
    const s = applyOp(base(), { op: "set_transition", clipId: "b", type: "morph", duration: 0.4 } as Op, ctx);
    expect(s.summary).toMatch(/face-aware/);
    const p = planRender({ kind: "preview", snapshot: s.snap, transcript: tr, source, videoId: "v" });
    const g = ffmpegArgs(p, { source: "/in.mp4", output: "/o.mp4", morphFaces: { b: face } } as PlanFiles, source, { loudnessGainDb: 0 }).filterGraph;
    expect(g).toMatch(/loop=loop=11:size=1:start=0/);
    expect(g.match(/perspective=x0='/g)).toHaveLength(2);
    expect(g).toMatch(/sense=destination:eval=frame/);
    expect(g).toMatch(/blend=all_expr='A\+\(B-A\)\*N\/12'/);
    expect(g).toMatch(/alphamerge\[mam0\]/);
    expect(g).not.toMatch(/minterpolate/);
    // No face measured (or one too far to slide): the morph as before.
    const g2 = ffmpegArgs(p, { source: "/in.mp4", output: "/o.mp4" } as PlanFiles, source, { loudnessGainDb: 0 }).filterGraph;
    expect(g2).toMatch(/minterpolate/); expect(g2).not.toMatch(/perspective/);
  });
  it("face: false keeps a plain morph, and is kept when the duration changes", () => {
    let s = applyOp(base(), { op: "set_transition", clipId: "b", type: "morph", duration: 0.4, face: false } as Op, ctx);
    expect(s.summary).toMatch(/plain: the face is not looked for/);
    s = applyOp(s.snap, { op: "set_transition", clipId: "b", type: "morph", duration: 0.3 } as Op, ctx);
    const p = planRender({ kind: "preview", snapshot: s.snap, transcript: tr, source, videoId: "v" });
    expect(p.transitions![0].face).toBe(false);
    // (0.3 s asked: on the 30 fps grid the window is 0.27 s.)
    expect(p.operations.join("\n")).toMatch(/morph plain 0\.2\ds/);
    const g = ffmpegArgs(p, { source: "/in.mp4", output: "/o.mp4", morphFaces: { b: face } } as PlanFiles, source, { loudnessGainDb: 0 }).filterGraph;
    expect(g).toMatch(/minterpolate/);
    // Sent again to every cut without face: the plain one stays plain (face true changes it).
    const three = applyOp(s.snap, { op: "set_clips", track: "v1", clips: [{ id: "a", start: 1, end: 5, label: "" }, { id: "b", start: 6, end: 8, label: "" }, { id: "c", start: 8.5, end: 10, label: "" }] } as Op, ctx).snap;
    const all = applyOp(three, { op: "set_transition", all: true, type: "morph", duration: 0.4 } as Op, ctx);
    expect(all.summary).toMatch(/1 kept plain as before: b/);
    const ts = planRender({ kind: "preview", snapshot: all.snap, transcript: tr, source, videoId: "v" }).transitions!;
    expect(ts.find((x) => x.clipId === "b")!.face).toBe(false);
    expect(ts.find((x) => x.clipId === "c")!.face).toBeUndefined();
    s = applyOp(s.snap, { op: "set_transition", clipId: "b", type: "morph", face: true } as Op, ctx);
    expect(planRender({ kind: "preview", snapshot: s.snap, transcript: tr, source, videoId: "v" }).transitions![0].face).toBeUndefined();
  });
});
