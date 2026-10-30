// remove_background: the op (every V1 clip by default, values kept, b-roll refused, off, copy_grade carries it), the
// look lines, the matte's blocks (with 2 s each side, within the footage), the render plan (one matte per clip's
// blocks, the alpha, the check line) and the FFmpeg graph (the matte read from its list's start with the footage's
// times, put through the clip's own trim and fit, into the alpha; edge, soft and invert).
import { describe, expect, it } from "vitest";
import { applyOp, buildInitialTimeline, buildTranscript, matteAllowanceMs, matteBlocks, matteJobId, matteKey, matteTimeoutMs, summarizeTimeline, SUBJECT_DEFAULTS, type EditContext, type Op, type SeqClip, type Snapshot } from "../src/index";
import { ffmpegArgs, planRender, type PlanFiles } from "../src/renderPlan";

const tr = buildTranscript([Array.from({ length: 20 }, (_, i) => ({ text: `w${i}`, start: 0.5 + i * 0.5, end: 0.9 + i * 0.5 }))], { maxWordsPerLine: 8 }).map((l) => ({ ...l, words: l.words.map((w) => ({ ...w, filler: false })) }));
const ctx: EditContext = { videoId: "v", transcript: tr, silences: [], sceneCuts: [], duration: 30, getStyle: () => undefined, getVideo: (id) => (id === "br" ? { id, name: "bg.mp4", seconds: 20, ready: true } : undefined) };
const base = (): Snapshot => applyOp({ timeline: buildInitialTimeline(tr, 30, "clean", [], "v"), name: "t", aspect: "16:9", styleId: "s2" }, { op: "set_clips", track: "v1", clips: [{ id: "a", start: 1, end: 5, label: "" }, { id: "b", start: 12, end: 25, label: "" }] } as Op, ctx).snap;
const edit = (s: Snapshot, op: Op) => applyOp(s, op, ctx);
const subj = (s: Snapshot, id: string) => (s.timeline.tracks.v1 as (SeqClip & { subject?: unknown })[]).find((c) => c.id === id)!.subject as Record<string, unknown> | undefined;
const source = { width: 1920, height: 1080, fps: 30, seconds: 30, hasAudio: true };

describe("the op", () => {
  it("defaults: every V1 clip, edge 0, soft 20; says what is behind", () => {
    const out = edit(base(), { op: "remove_background" } as Op);
    expect(subj(out.snap, "a")).toEqual({ ...SUBJECT_DEFAULTS });
    expect(subj(out.snap, "b")).toEqual({ ...SUBJECT_DEFAULTS });
    expect(out.summary).toMatch(/2 clips: background removed; behind it: black until set_background/);
  });
  it("values given change, the rest keep theirs; invert; off puts the background back", () => {
    let s = edit(base(), { op: "remove_background", clipId: "a", edge: 4 } as Op).snap;
    s = edit(s, { op: "remove_background", clipId: "a", soft: 50, invert: true } as Op).snap;
    expect(subj(s, "a")).toEqual({ edge: 4, soft: 50, invert: true });
    expect(subj(s, "b")).toBeUndefined();
    const off = edit(s, { op: "remove_background", clipId: "a", off: true } as Op);
    expect(subj(off.snap, "a")).toBeUndefined();
    expect(off.summary).toMatch(/background back/);
  });
  it("set in the same call after it, the background is not asked for", () => {
    const out = edit(base(), { op: "batch", ops: [{ op: "remove_background" }, { op: "set_background", color: "#112233" }] } as Op);
    expect(out.summary).not.toMatch(/black until/);
    expect(out.summary).toMatch(/background removed; .*background: #112233 \(it shows where V1 .*has its background removed\)/);
  });
  it("with a background set, the summary does not ask for one", () => {
    const s = edit(base(), { op: "set_background", color: "#112233" } as Op).snap;
    expect(edit(s, { op: "remove_background", clipId: "b" } as Op).summary).not.toMatch(/black until/);
  });
  it("copy_grade with subject carries it", () => {
    const s = edit(base(), { op: "remove_background", clipId: "a", edge: -3 } as Op).snap;
    expect(subj(edit(s, { op: "copy_grade", from: "a", to: ["b"], with: ["subject"] } as Op).snap, "b")).toEqual({ edge: -3, soft: 20 });
  });
  it("get_project shows it", () => {
    const s = edit(base(), { op: "remove_background", clipId: "a", edge: 2 } as Op).snap;
    const text = summarizeTimeline(s, tr);
    expect(text).toMatch(/look: no background/);
    expect(text).toMatch(/Looks: .*background removed, edge \+2 on a/);
  });
});

describe("the matte's blocks", () => {
  it("cover the footage with 2 s each side, within the video", () => {
    expect(matteBlocks(1, 5)).toEqual([0]);
    expect(matteBlocks(12, 25, 30)).toEqual([1, 2]);
    expect(matteBlocks(9, 9.5, 30)).toEqual([0, 1]);
    expect(matteBlocks(25, 29.9, 30)).toEqual([2]);
    expect(matteKey("u", "v", 90, 3)).toBe("frames/u/v/matte-v1-t90-3.mp4");
    expect(matteJobId("v", 0, 2)).toBe("matte-v-t0-2");
  });
  it("give a render extra time to make them: every block once, two at a time; none without it", () => {
    expect(matteAllowanceMs(base().timeline)).toBe(0);
    // Clip a (1-5 s): block 0; clip b (12-25 s): blocks 1 and 2 (to 27 s). Three blocks, two at once.
    expect(matteAllowanceMs(edit(base(), { op: "remove_background" } as Op).snap.timeline)).toBe(matteTimeoutMs(2));
    expect(matteAllowanceMs(null)).toBe(0);
  });
});

describe("the render", () => {
  const snap = () => edit(edit(base(), { op: "remove_background", edge: 5, soft: 40 } as Op).snap, { op: "set_background", color: "#00FF00" } as Op).snap;
  it("plans a matte per clip's blocks, the alpha, and a check line", () => {
    const plan = planRender({ kind: "preview", snapshot: snap(), transcript: tr, source, videoId: "v" });
    expect(plan.mattes).toEqual({ matte_v_0_0: { videoId: "v", blocks: [0] }, matte_v_1_2: { videoId: "v", blocks: [1, 2] } });
    expect(plan.looks?.a).toMatchObject({ subject: { edge: 5, soft: 40, matte: "matte_v_0_0" }, alpha: true });
    expect(plan.operations.join("\n")).toMatch(/Background: a removed, edge \+5, soft 40; b removed, edge \+5, soft 40 \(the person cut out by an AI matte\); behind: /);
  });
  it("the graph reads each matte from its list's start, puts it through the clip's own steps and into the alpha", () => {
    const plan = planRender({ kind: "preview", snapshot: snap(), transcript: tr, source, videoId: "v" });
    const files: PlanFiles = { source: "/x/src.mp4", output: "/x/out.mp4", looks: Object.fromEntries(Object.keys(plan.lookFiles ?? {}).map((n) => [n, `/x/${n}`])), mattes: { matte_v_0_0: "/x/m0.txt", matte_v_1_2: "/x/m12.txt" } };
    const { args, filterGraph } = ffmpegArgs(plan, files, source, { loudnessGainDb: 0 });
    const i0 = args.indexOf("/x/m0.txt"), i1 = args.indexOf("/x/m12.txt");
    // No seek on the concat reader (it would move the frames' times): straight "-f concat -safe 0 -i list".
    expect(args.slice(i0 - 5, i0 + 1)).toEqual(["-f", "concat", "-safe", "0", "-i", "/x/m0.txt"]);
    expect(args.slice(i1 - 5, i1 + 1)).toEqual(["-f", "concat", "-safe", "0", "-i", "/x/m12.txt"]);
    // Block 1 starts 10 s into the footage: its times are moved there before the clip's trim.
    expect(filterGraph).toMatch(/setpts=PTS\+10\/TB,fps=30,format=gray,trim=end=/);
    expect(filterGraph).toMatch(/\[mt\d\]trim=start=[\d.]+:end=[\d.]+,setpts=PTS-STARTPTS.*scale=\d+:\d+:force_original_aspect_ratio=increase.*format=gray\[mf/);
    // Edge out: blurred and its 16% made the middle; soft: a feather; then into the alpha.
    expect(filterGraph).toMatch(/gblur=sigma=[\d.]+,lut=c0='if\(lt\(val,40\),val\*128\/40,128\+\(val-40\)\*127\/215\)',gblur=sigma=[\d.]+\[ms/);
    expect(filterGraph).toMatch(/\[ms\w+\]alphamerge/);
    // Not the one-look shortcut (it would join the clips before the matte could follow each).
    expect(filterGraph).not.toMatch(/\[vfit\]/);
  });
  it("a clip without it, and a reversed clip, need no matte", () => {
    const s = edit(edit(base(), { op: "remove_background", clipId: "a" } as Op).snap, { op: "set_speed", clipId: "a", reverse: true } as Op).snap;
    const plan = planRender({ kind: "preview", snapshot: s, transcript: tr, source, videoId: "v" });
    const files: PlanFiles = { source: "/x/src.mp4", output: "/x/out.mp4", looks: {}, mattes: { [Object.keys(plan.mattes!)[0]]: "/x/m.txt" } };
    expect(ffmpegArgs(plan, files, source, { loudnessGainDb: 0 }).args).not.toContain("/x/m.txt");
  });
  it("refuses b-roll", () => {
    const s = edit(base(), { op: "add_broll", videoId: "br", start: 2, end: 4, sourceStart: 0 } as Op).snap;
    const id = (s.timeline.tracks.v2 as { id: string }[])[0].id;
    expect(() => edit(s, { op: "remove_background", clipId: id } as Op)).toThrow(/works on V1 clips/);
  });
});
