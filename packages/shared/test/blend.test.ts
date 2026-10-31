// Premiere parity, phase 4: blend modes and opacity on b-roll and graphics. The formulas (W3C, what CSS draws in the
// editor), set_blend (what it takes and refuses, plain again at normal and full opacity), the text, the plan and the
// FFmpeg graph (opacity in the alpha; a blend mode over the layer's frames only, in RGB, the right input on top).
import { describe, expect, it } from "vitest";
import { applyOp, blendCss, blendFilter, blendPixel, buildInitialTimeline, buildTranscript, composite, summarizeTimeline, BLEND_MODES, type EditContext, type Op, type Snapshot } from "../src/index";
import { ffmpegArgs, planRender, type PlanFiles } from "../src/renderPlan";

const tr = buildTranscript([Array.from({ length: 20 }, (_, i) => ({ text: `w${i}`, start: 0.5 + i * 0.5, end: 0.9 + i * 0.5 }))], { maxWordsPerLine: 8 }).map((l) => ({ ...l, words: l.words.map((w) => ({ ...w, filler: false })) }));
const ctx: EditContext = {
  videoId: "v", transcript: tr, silences: [], sceneCuts: [], duration: 12, getStyle: () => undefined,
  getVideo: (id) => (id === "leak" ? { id, name: "light leak", seconds: 8, ready: true } : undefined),
  getGraphic: (id) => (id === "gc" ? { id, name: "Grain", durationSec: 20, custom: true, params: {} } : undefined),
} as EditContext;
const edit = (s: Snapshot, op: Op) => applyOp(s, op, ctx);
const base = (): Snapshot => {
  let s = applyOp({ timeline: buildInitialTimeline(tr, 12, "clean", [], "v"), name: "t", aspect: "16:9", styleId: "s2" }, { op: "set_captions", on: false } as Op, ctx).snap;
  s = edit(s, { op: "add_broll", videoId: "leak", start: 2, end: 5, sourceStart: 0 } as Op).snap;
  s = edit(s, { op: "add_graphic", graphicId: "gc", start: 6, end: 9 } as Op).snap;
  return s;
};
const v2 = (s: Snapshot) => (s.timeline.tracks.v2 as { id: string; kind?: string; blend?: string; opacity?: number }[]).find((c) => c.kind === "broll")!;
const v3 = (s: Snapshot) => (s.timeline.tracks.v3 as { id: string; kind?: string; blend?: string; opacity?: number }[]).find((c) => c.kind === "graphic")!;
const source = { width: 1920, height: 1080, fps: 30, seconds: 12, hasAudio: true };

describe("the formulas", () => {
  it("are the W3C ones", () => {
    expect(blendPixel("multiply", 0.5, 0.5)).toBe(0.25);
    expect(blendPixel("screen", 0.5, 0.5)).toBe(0.75);
    expect(blendPixel("overlay", 0.25, 0.8)).toBeCloseTo(0.4);
    expect(blendPixel("overlay", 0.75, 0.2)).toBeCloseTo(0.6);
    expect(blendPixel("hard-light", 0.8, 0.25)).toBeCloseTo(0.4);
    expect(blendPixel("soft-light", 0.5, 0.5)).toBe(0.5);
    expect(blendPixel("soft-light", 0.16, 1)).toBeCloseTo(0.398336, 6);
    expect(blendPixel("add", 0.7, 0.6)).toBe(1);
    expect(blendPixel("color-dodge", 0.4, 0.5)).toBeCloseTo(0.8);
    expect(blendPixel("color-burn", 0.6, 0.5)).toBeCloseTo(0.2);
    expect(composite("screen", 0.5, 0.5, 0.5)).toBeCloseTo(0.625);
    expect(blendCss("add")).toBe("plus-lighter");
    expect(blendCss("soft-light")).toBe("soft-light");
  });
  it("the render's filter: built-in modes with the picture on top, dodge and burn with the layer on top, soft light by expression", () => {
    expect(blendFilter("screen", 255)).toEqual({ filter: "blend=all_mode=screen", layerOnTop: false });
    expect(blendFilter("add", 255).filter).toBe("blend=all_mode=addition");
    expect(blendFilter("color-dodge", 255)).toEqual({ filter: "blend=all_mode=dodge", layerOnTop: true });
    expect(blendFilter("soft-light", 65535).filter).toMatch(/^blend=all_expr='65535\*if\(lte\(\(B\/65535\),0\.5\)/);
    for (const m of BLEND_MODES) if (m !== "normal") expect(blendFilter(m, 255).filter).toMatch(/^blend=all_(mode|expr)=/);
  });
});

describe("set_blend", () => {
  it("sets a mode and an opacity on b-roll and on a graphic; get_project says so", () => {
    let s = base();
    const r = edit(s, { op: "set_blend", clipIds: [v2(s).id, v3(s).id], blend: "screen", opacity: 0.6 } as Op);
    s = r.snap;
    expect(v2(s)).toMatchObject({ blend: "screen", opacity: 0.6 });
    expect(v3(s)).toMatchObject({ blend: "screen", opacity: 0.6 });
    expect(r.summary).toMatch(/^b-roll .*: screen 60%; graphic .*: screen 60%$/);
    expect(summarizeTimeline(s, tr)).toMatch(/video=leak@0 blend screen 60%/);
    // One field at a time keeps the other; normal at full opacity is plain again.
    s = edit(s, { op: "set_blend", clipId: v2(s).id, opacity: 1 } as Op).snap;
    expect(v2(s)).toMatchObject({ blend: "screen" });
    expect(v2(s).opacity).toBeUndefined();
    s = edit(s, { op: "set_blend", clipId: v2(s).id, blend: "normal" } as Op).snap;
    expect(v2(s).blend).toBeUndefined();
  });
  it("refuses a zoom, b-roll behind V1, a text layer, and nothing to set", () => {
    let s = base();
    s = edit(s, { op: "add_zoom", start: 1, end: 2, scale: 1.2 } as Op).snap;
    const zoom = (s.timeline.tracks.v2 as { id: string; kind?: string }[]).find((c) => c.kind === "zoom")!;
    expect(() => edit(s, { op: "set_blend", clipId: zoom.id, blend: "screen" } as Op)).toThrow(/is a zoom/);
    const under = edit(s, { op: "set_under", clipId: v2(s).id, under: true } as Op).snap;
    expect(() => edit(under, { op: "set_blend", clipId: v2(s).id, blend: "screen" } as Op)).toThrow(/behind V1/);
    s = edit(s, { op: "add_text", text: "Hi", start: 1, end: 2 } as Op).snap;
    const text = (s.timeline.tracks.v3 as { id: string; kind?: string }[]).find((c) => c.kind === "text")!;
    expect(() => edit(s, { op: "set_blend", clipId: text.id, blend: "screen" } as Op)).toThrow(/a text layer/);
    expect(() => edit(s, { op: "set_blend", clipId: v2(s).id } as Op)).toThrow(/needs blend or opacity/);
  });
});

describe("the render", () => {
  const plan = (s: Snapshot) => {
    const p = planRender({ kind: "preview", snapshot: s, transcript: tr, source, videoId: "v", brollSeconds: { leak: 8 }, graphicsReady: { [v3(s).id]: true } });
    const files = { source: "/in.mp4", output: "/out.mp4", broll: { [v2(s).id]: "/leak.mp4" }, graphics: { [v3(s).id]: "/grain.webm" } } as PlanFiles;
    return { p, g: ffmpegArgs(p, files, source, { loudnessGainDb: 0 }).filterGraph };
  };
  it("plain layers draw as before", () => {
    const { g } = plan(base());
    expect(g).not.toMatch(/blend=|maskedmerge|lutyuv=a=/);
  });
  it("opacity alone goes into the layer's alpha", () => {
    const s0 = base();
    const { p, g } = plan(edit(s0, { op: "set_blend", clipIds: [v2(s0).id, v3(s0).id], opacity: 0.5 } as Op).snap);
    expect((g.match(/lutyuv=a='val\*0\.500'/g) ?? []).length).toBe(2);
    expect(p.operations.join("\n")).toMatch(/Blend: b-roll \S+ 50% opacity, graphic \S+ 50% opacity/);
  });
  it("a blend mode: the picture under the layer's frames is blended in RGB and laid back in place", () => {
    const s0 = base();
    let s = edit(s0, { op: "set_blend", clipId: v2(s0).id, blend: "screen", opacity: 0.6 } as Op).snap;
    s = edit(s, { op: "set_blend", clipId: v3(s).id, blend: "color-burn" } as Op).snap;
    const { p, g } = plan(s);
    expect(p.broll[0]).toMatchObject({ blend: "screen", opacity: 0.6 });
    // The b-roll: picture on top, layer below, alpha times 0.6 as the mask, back in place from 2 s.
    expect(g).toMatch(/\[bwb0\]trim=start=2\.000000:end=5\.000000,setpts=PTS-2\.000000\/TB,scale=in_color_matrix=bt709:in_range=tv:flags=accurate_rnd,format=gbrp/);
    expect(g).toMatch(/\[bpb0\]\[lrb0\]blend=all_mode=screen\[lfb0\]/);
    expect(g).toMatch(/alphaextract,format=gray,lut=c0='val\*0\.600'/);
    expect(g).toMatch(/\[bqb0\]\[lfb0\]\[lmb0\]maskedmerge,scale=out_color_matrix=bt709/);
    expect(g).toMatch(/overlay=enable='between\(t,2\.000000,4\.98333\d\)':eof_action=pass\[lvb0\]/);
    // The graphic: burn puts the layer on top; it is centred on a full transparent frame first.
    expect(g).toMatch(/\[lrg0\]\[bpg0\]blend=all_mode=burn\[lfg0\]/);
    expect(g).toMatch(/pad=960:540:\(ow-iw\)\/2:\(oh-ih\)\/2:color=black@0/);
  });
});
