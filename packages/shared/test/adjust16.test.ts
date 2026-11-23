// Premiere parity, phase 16: masked and keyframed adjustment layers. A layer works only inside its masks (keys at
// seconds from the layer's start), at its strength (opacity), fading in and out. The op (add, change, keep, remove,
// refuse follow face), the text lines, the plan (the mask as a moving picture over the layer's own time), the graph
// (alpha, strength, fades) and the player's frame (masks at t, strength = adjustStrengthAt).
import { describe, expect, it } from "vitest";
import { adjustStrengthAt, adjustText, applyOp, buildInitialTimeline, buildTranscript, liveFrame, summarizeTimeline, type EditContext, type Op, type Snapshot } from "../src/index";
import { ffmpegArgs, planRender, type PlanFiles } from "../src/renderPlan";

const tr = buildTranscript([Array.from({ length: 20 }, (_, i) => ({ text: `w${i}`, start: 0.5 + i * 0.5, end: 0.9 + i * 0.5 }))], { maxWordsPerLine: 8 }).map((l) => ({ ...l, words: l.words.map((w) => ({ ...w, filler: false })) }));
const ctx: EditContext = { videoId: "v", transcript: tr, silences: [], sceneCuts: [], duration: 12, getStyle: () => undefined };
const base = (): Snapshot => applyOp({ timeline: buildInitialTimeline(tr, 12, "clean", [], "v"), name: "t", aspect: "16:9", styleId: "s2" }, { op: "set_clips", track: "v1", clips: [{ id: "a", start: 1, end: 5, label: "" }, { id: "b", start: 6, end: 10, label: "" }] } as Op, ctx).snap;
const edit = (s: Snapshot, op: Op) => applyOp(s, op, ctx);
const source = { width: 1280, height: 720, fps: 30, seconds: 12, hasAudio: true };
type Layer = { id: string; kind?: string; masks?: unknown[]; opacity?: number; fadeIn?: number; fadeOut?: number; start: number; end: number };
const layer = (s: Snapshot) => (s.timeline.tracks.v3 as Layer[]).find((x) => x.kind === "adjust")!;
const graph = (s: Snapshot) => {
  const p = planRender({ kind: "preview", snapshot: s, transcript: tr, source, videoId: "v" });
  const looks = Object.fromEntries(Object.keys(p.lookFiles ?? {}).map((n) => [n, `/tmp/${n}`]));
  return { p, g: ffmpegArgs(p, { source: "/in.mp4", output: "/o.mp4", looks, assPath: "/c.ass" } as PlanFiles, source, { loudnessGainDb: 0 }).filterGraph };
};
const sky = { shape: "rect" as const, x: 0, y: 0, w: 1, h: 0.4, feather: 0.05 };
const moving = { shape: "ellipse" as const, x: 0.1, y: 0.3, w: 0.3, h: 0.4, keys: [{ at: 0, x: 0.1, y: 0.3, w: 0.3, h: 0.4 }, { at: 2, x: 0.6, y: 0.3, w: 0.3, h: 0.4 }] };

describe("adjustment_layer with masks, strength and fades", () => {
  it("adds a masked layer at a strength with fades; the result and get_project say where and how strongly", () => {
    const r = edit(base(), { op: "adjustment_layer", start: 1, end: 4, edit: true, grade: { saturation: 0 }, masks: [sky], opacity: 0.6, fadeIn: 0.5, fadeOut: 1 } as Op);
    expect(layer(r.snap)).toMatchObject({ masks: [sky], opacity: 0.6, fadeIn: 0.5, fadeOut: 1 });
    expect(r.summary).toMatch(/grade saturation 0%; only in rect 100%x40% at 0%,0% feather 5%, 60% strength, fades in over 0\.5 s, fades out over 1 s; over the picture/);
    expect(summarizeTimeline(r.snap, tr)).toMatch(/adjustment layer: grade saturation 0%, only in rect .*60% strength, fades in over 0\.5 s/);
  });
  it("a change keeps what it leaves out; null removes; full strength and zero fades are stored as nothing", () => {
    let s = edit(base(), { op: "adjustment_layer", start: 1, end: 4, edit: true, effects: [{ type: "blur", amount: 40 }], masks: [sky], opacity: 0.5, fadeIn: 1 } as Op).snap;
    const id = layer(s).id;
    s = edit(s, { op: "adjustment_layer", clipId: id, grade: { exposure: 1 } } as Op).snap;
    expect(layer(s)).toMatchObject({ masks: [sky], opacity: 0.5, fadeIn: 1, grade: { exposure: 1 }, effects: [{ type: "blur", amount: 40 }] });
    s = edit(s, { op: "adjustment_layer", clipId: id, masks: null, opacity: 1, fadeIn: 0 } as Op).snap;
    const c = layer(s);
    expect(c.masks).toBeUndefined(); expect(c.opacity).toBeUndefined(); expect(c.fadeIn).toBeUndefined();
    s = edit(s, { op: "adjustment_layer", clipId: id, masks: [sky], fadeOut: 0.4 } as Op).snap;
    s = edit(s, { op: "adjustment_layer", clipId: id, masks: [], fadeOut: null } as Op).snap;
    expect(layer(s).masks).toBeUndefined(); expect(layer(s).fadeOut).toBeUndefined();
  });
  it("a mask that follows the face is refused (a layer has no footage of its own)", () => {
    expect(() => edit(base(), { op: "adjustment_layer", start: 1, end: 4, edit: true, grade: { exposure: 1 }, masks: [{ shape: "ellipse", follow: "face" }] } as Op)).toThrow(/no footage of its own/);
  });
  it("adjustText and adjustStrengthAt", () => {
    expect(adjustText({})).toBe("");
    expect(adjustText({ opacity: 1 })).toBe("");
    expect(adjustStrengthAt({}, 1, 3)).toBe(1);
    const a = { opacity: 0.8, fadeIn: 1, fadeOut: 2 };
    expect(adjustStrengthAt(a, 0, 5)).toBe(0);
    expect(adjustStrengthAt(a, 0.5, 5)).toBeCloseTo(0.4, 6);
    expect(adjustStrengthAt(a, 2, 5)).toBeCloseTo(0.8, 6);
    expect(adjustStrengthAt(a, 4, 5)).toBeCloseTo(0.4, 6);
    expect(adjustStrengthAt(a, 5, 5)).toBe(0);
  });
});

describe("the render", () => {
  it("the layer's look has its masks; a moving mask is a picture over the layer's own time (keys from its start)", () => {
    const s = edit(base(), { op: "adjustment_layer", start: 2, end: 5, edit: true, grade: { exposure: -1 }, masks: [moving] } as Op).snap;
    const { p } = graph(s);
    const id = layer(s).id;
    expect(p.adjust![0]).toMatchObject({ clipId: id, start: 2, end: 5, masks: [moving] });
    const look = p.looks![id];
    expect(look.alpha).toBe(true);
    expect(p.lookFiles![look.mask!]).toMatchObject({ kind: "moving", from: 0, to: 3 });
    expect(p.operations.join("\n")).toMatch(/Adjustment layers: 0:02-0:05 grade exposure -1, only in ellipse 30%x40% at 10%,30% moving \(2 keys, 0-2s\)/);
  });
  it("the graph keeps the layer's alpha, scales it by its strength and ramps it in and out", () => {
    const s = edit(base(), { op: "adjustment_layer", start: 2, end: 5, edit: true, grade: { saturation: 0 }, masks: [sky], opacity: 0.6, fadeIn: 0.5, fadeOut: 1 } as Op).snap;
    const { g } = graph(s);
    expect(g).toMatch(/\[loaj0\]format=yuva420p,lutyuv=a='val\*0\.600',fade=t=in:st=0:d=0\.500000:alpha=1,fade=t=out:st=2\.000000:d=1\.000000:alpha=1\[ajr0\]/);
    expect(g).toMatch(/color=c=black@0:s=960x540:r=30,format=yuva420p,setsar=1,trim=end_frame=60\[ajl0lead\]/);
    expect(g).toMatch(/\[ajo0\]\[ajl0\]overlay=enable='between\(t,2\.000000,[\d.]+\)':eof_action=pass,format=yuv420p\[ajv0\]/);
    expect(g).toMatch(/alphamerge\[loaj0\]/);
  });
  it("without masks, strength or fades the graph is as before (no alpha)", () => {
    const s = edit(base(), { op: "adjustment_layer", start: 2, end: 5, edit: true, grade: { saturation: 0 } } as Op).snap;
    const { g } = graph(s);
    expect(g).toMatch(/\[loaj0\]format=yuv420p\[ajr0\]/);
    expect(g).toMatch(/format=yuv420p,setsar=1,trim=end_frame=60\[ajl0lead\]/);
    expect(g).not.toMatch(/alphamerge\[loaj0\]/);
  });
  it("strength alone: the alpha is made from the layer's strength (no mask picture)", () => {
    const s = edit(base(), { op: "adjustment_layer", start: 2, end: 5, edit: true, grade: { saturation: 0 }, opacity: 0.25 } as Op).snap;
    const { g, p } = graph(s);
    expect(p.looks![layer(s).id].mask).toBeUndefined();
    expect(g).toMatch(/\[loaj0\]format=yuva420p,lutyuv=a='val\*0\.250'\[ajr0\]/);
  });
});

describe("the player's frame", () => {
  it("each layer on now with its masks, its time into the layer and its strength", () => {
    const s = edit(base(), { op: "adjustment_layer", start: 2, end: 5, edit: true, grade: { exposure: -1 }, masks: [moving], opacity: 0.8, fadeIn: 1 } as Op).snap;
    const { p } = graph(s);
    const f = liveFrame(p, 2.5)!;
    expect(f.adjust).toHaveLength(1);
    expect(f.adjust![0].t).toBeCloseTo(0.5, 6);
    expect(f.adjust![0].masks).toEqual([moving]);
    expect(f.adjust![0].strength).toBeCloseTo(0.4, 6);
    expect(liveFrame(p, 4)!.adjust![0].strength).toBeCloseTo(0.8, 6);
  });
});
