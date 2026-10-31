// Premiere parity, phase 9: adjustment layers. A V3 layer over a time range whose grade and effects go on everything
// under it (footage, b-roll, graphics); text and captions stay as they are. The op (add, change, remove, text), the plan
// (its look, its window in edit seconds, the operations line), the graph (after the graphics, before the captions;
// nothing else changes) and the player's frame and CSS preview.
import { describe, expect, it } from "vitest";
import { adjustCss, applyOp, buildInitialTimeline, buildTranscript, liveFrame, mergeGrade, summarizeTimeline, type EditContext, type Op, type Snapshot } from "../src/index";
import { ffmpegArgs, planRender, type PlanFiles } from "../src/renderPlan";

const tr = buildTranscript([Array.from({ length: 20 }, (_, i) => ({ text: `w${i}`, start: 0.5 + i * 0.5, end: 0.9 + i * 0.5 }))], { maxWordsPerLine: 8 }).map((l) => ({ ...l, words: l.words.map((w) => ({ ...w, filler: false })) }));
const ctx: EditContext = { videoId: "v", transcript: tr, silences: [], sceneCuts: [], duration: 12, getStyle: () => undefined };
const base = (): Snapshot => applyOp({ timeline: buildInitialTimeline(tr, 12, "clean", [], "v"), name: "t", aspect: "16:9", styleId: "s2" }, { op: "set_clips", track: "v1", clips: [{ id: "a", start: 1, end: 5, label: "" }, { id: "b", start: 6, end: 10, label: "" }] } as Op, ctx).snap;
const edit = (s: Snapshot, op: Op) => applyOp(s, op, ctx);
const source = { width: 1280, height: 720, fps: 30, seconds: 12, hasAudio: true };
const v3 = (s: Snapshot) => s.timeline.tracks.v3 as ({ id: string; kind?: string; grade?: unknown; effects?: unknown; start: number; end: number })[];
const graph = (s: Snapshot) => {
  const p = planRender({ kind: "preview", snapshot: s, transcript: tr, source, videoId: "v" });
  const looks = Object.fromEntries(Object.keys(p.lookFiles ?? {}).map((n) => [n, `/tmp/${n}`]));
  return { p, g: ffmpegArgs(p, { source: "/in.mp4", output: "/o.mp4", looks, assPath: "/c.ass" } as PlanFiles, source, { loudnessGainDb: 0 }).filterGraph };
};

describe("adjustment_layer", () => {
  it("adds a layer on V3 over edit seconds; the result and get_project say what it does", () => {
    const r = edit(base(), { op: "adjustment_layer", start: 2, end: 5, edit: true, grade: { exposure: -1, saturation: 50 }, effects: [{ type: "blur", amount: 30 }] } as Op);
    const c = v3(r.snap).find((x) => x.kind === "adjust")!;
    expect(c).toMatchObject({ grade: { exposure: -1, saturation: 50 }, effects: [{ type: "blur", amount: 30 }] });
    expect(r.summary).toMatch(/^added an adjustment layer at edit 0:02-0:05 \(clip adj\w+\): grade exposure -1, saturation 50%, blur 30; over the picture, b-roll and graphics$/);
    expect(summarizeTimeline(r.snap, tr)).toMatch(/adj\w+ @2\.00-5\.00.*adjustment layer: grade exposure/);
  });
  it("changes one by clipId (grade or effects replaced, the other kept), and only an adjustment layer; delete_clip removes it", () => {
    let s = edit(base(), { op: "adjustment_layer", start: 2, end: 5, edit: true, grade: { contrast: 20 }, effects: [{ type: "darken", amount: 40 }] } as Op).snap;
    const id = v3(s).find((x) => x.kind === "adjust")!.id;
    s = edit(s, { op: "adjustment_layer", clipId: id, grade: { exposure: 0.5 } } as Op).snap;
    expect(v3(s).find((x) => x.id === id)).toMatchObject({ grade: { exposure: 0.5 }, effects: [{ type: "darken", amount: 40 }] });
    s = edit(s, { op: "adjustment_layer", clipId: id, effects: [] } as Op).snap;
    expect(v3(s).find((x) => x.id === id)!.effects).toBeUndefined();
    const t = edit(s, { op: "add_text", text: "Hi", start: 1, end: 2, edit: true } as Op).snap;
    const textId = v3(t).find((x) => x.kind === "text")!.id;
    expect(() => edit(t, { op: "adjustment_layer", clipId: textId, grade: { exposure: 1 } } as Op)).toThrow(/is not an adjustment layer/);
    s = edit(s, { op: "delete_clip", track: "v3", clipId: id } as Op).snap;
    expect(v3(s).some((x) => x.kind === "adjust")).toBe(false);
    expect(() => edit(base(), { op: "adjustment_layer", grade: { exposure: 1 } } as Op)).toThrow(/needs start and end/);
  });
  it("an empty layer (the editor's + Adjustment layer) is allowed and changes nothing in the render", () => {
    const r = edit(base(), { op: "adjustment_layer", start: 1, end: 3, edit: true } as Op);
    expect(r.summary).toMatch(/nothing yet/);
    expect(graph(r.snap).g).toBe(graph(base()).g);
    expect(graph(r.snap).p.adjust).toBeUndefined();
  });
  it("mergeGrade: set_grade's change rules (null removes, wheels merge, hsl replaces)", () => {
    expect(mergeGrade({ exposure: 1, contrast: 10, wheels: { shadows: { hue: 200, amount: 20 } } }, { contrast: null, wheels: { shadows: { amount: 40 }, highlights: { hue: 40, amount: 10 } } }))
      .toEqual({ exposure: 1, wheels: { shadows: { hue: 200, amount: 40 }, highlights: { hue: 40, amount: 10 } } });
  });
});

describe("the render", () => {
  it("the layer's grade and effects go on the picture over its window, after the graphics and before the captions", () => {
    const s = edit(base(), { op: "adjustment_layer", start: 2, end: 5, edit: true, grade: { exposure: -1 }, effects: [{ type: "darken", amount: 40 }] } as Op).snap;
    const { p, g } = graph(s);
    const id = v3(s).find((x) => x.kind === "adjust")!.id;
    expect(p.adjust).toEqual([{ clipId: id, start: 2, end: 5, grade: { exposure: -1 }, effects: [{ type: "darken", amount: 40 }] }]);
    expect(p.looks![id].lut).toBeTruthy();
    expect(g).toMatch(/split\[ajo0\]\[ajw0\]/);
    expect(g).toMatch(/\[ajw0\]trim=start=2\.000000:end=5\.000000,setpts=PTS-STARTPTS\[aji0\]/);
    expect(g).toMatch(/lut3d=file=.*colorchannelmixer=rr=0\.600:gg=0\.600:bb=0\.600/s);
    expect(g).toMatch(/setpts=PTS\+2\.000000\/TB\[ajl0\]/);
    expect(g).toMatch(/\[ajo0\]\[ajl0\]overlay=enable='between\(t,2\.000000,4\.983333\)':eof_action=pass\[ajv0\]/);
    // Captions go on after the layer: they are not graded.
    expect(g.indexOf("[ajv0]")).toBeLessThan(g.indexOf("ass=filename"));
    expect(p.operations.join("\n")).toMatch(/Adjustment layers: 0:02-0:05 grade exposure -1.*darken 40.*\(over the picture, b-roll and graphics; text and captions on top as they are\)/);
  });
  it("moves with its clip: a layer attached over clip b follows b's place in the edit", () => {
    let s = edit(base(), { op: "adjustment_layer", start: 5, end: 7, edit: true, grade: { saturation: 0 } } as Op).snap;
    const before = graph(s).p.adjust![0];
    s = edit(s, { op: "delete_clip", track: "v1", clipId: "a" } as Op).snap;
    const after = graph(s).p.adjust?.[0];
    expect(before.start).toBe(5);
    expect(after && after.start).toBeLessThan(before.start);
  });
});

describe("the player", () => {
  it("the frame lists the layers on now; the CSS preview is their exposure, contrast, saturation, blur and darken", () => {
    const s = edit(base(), { op: "adjustment_layer", start: 2, end: 5, edit: true, grade: { exposure: -1, contrast: 20, saturation: 50 }, effects: [{ type: "blur", amount: 30 }, { type: "darken", amount: 40 }] } as Op).snap;
    const p = planRender({ kind: "preview", snapshot: s, transcript: tr, source, videoId: "v" });
    expect(liveFrame(p, 3).adjust).toHaveLength(1);
    expect(liveFrame(p, 6).adjust).toHaveLength(0);
    const css = adjustCss(liveFrame(p, 3).adjust![0], p.width, p.height, 0.5);
    expect(css).toMatch(/^brightness\(0\.730\) contrast\(1\.200\) saturate\(0\.500\) blur\([\d.]+px\) brightness\(0\.600\)$/);
    expect(adjustCss({}, 100, 100, 1)).toBe("none");
  });
});
