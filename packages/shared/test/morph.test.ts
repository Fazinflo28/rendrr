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
    expect(p.operations.join("\n")).toMatch(/Transitions: 1 \(morph 0\.40s\)/);
  });
  it("the player shows a dissolve; the first clip has no morph", () => {
    expect(transitionAt({ type: "morph" }, 0.5, 100, 100).b.opacity).toBe(0.5);
    const s = applyOp(base(), { op: "set_transition", clipId: "a", type: "morph", duration: 0.4 } as Op, ctx).snap;
    const t = planRender({ kind: "preview", snapshot: s, transcript: tr, source, videoId: "v" }).transitions!.find((x) => x.clipId === "a")!;
    expect(t.note).toMatch(/left out: no clip before it/);
  });
});
