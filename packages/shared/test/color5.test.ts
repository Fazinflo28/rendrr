// Premiere parity, phase 5: Lumetri's tone (highlights, shadows, whites, blacks), vibrance, colour wheels, HSL
// secondaries and Hue vs Sat in the grade function (so in the LUT the render and the player use), set_grade (merged,
// replaced, removed), the text, and the vignette (darken outside a soft ellipse) in the plan and the graph.
import { describe, expect, it } from "vitest";
import { applyOp, buildInitialTimeline, buildTranscript, gradeFn, gradeIsActive, gradeText, rgbHsv, VIGNETTE_AREA, type EditContext, type Grade, type Op, type SeqClip, type Snapshot } from "../src/index";
import { ffmpegArgs, planRender, type PlanFiles } from "../src/renderPlan";

const tr = buildTranscript([Array.from({ length: 20 }, (_, i) => ({ text: `w${i}`, start: 0.5 + i * 0.5, end: 0.9 + i * 0.5 }))], { maxWordsPerLine: 8 }).map((l) => ({ ...l, words: l.words.map((w) => ({ ...w, filler: false })) }));
const ctx: EditContext = { videoId: "v", transcript: tr, silences: [], sceneCuts: [], duration: 12, getStyle: () => undefined };
const base = (): Snapshot => applyOp({ timeline: buildInitialTimeline(tr, 12, "clean", [], "v"), name: "t", aspect: "16:9", styleId: "s2" }, { op: "set_clips", track: "v1", clips: [{ id: "a", start: 1, end: 5, label: "" }, { id: "b", start: 6, end: 10, label: "" }] } as Op, ctx).snap;
const edit = (s: Snapshot, op: Op) => applyOp(s, op, ctx);
const gradeOf = (s: Snapshot, id: string) => (s.timeline.tracks.v1 as (SeqClip & { grade?: Grade })[]).find((c) => c.id === id)!.grade;
const grey = (g: Grade, v: number) => gradeFn(g)(v, v, v)[0];
const sat = (p: [number, number, number]) => rgbHsv(...p)[1];

describe("tone and vibrance", () => {
  it("shadows lift the darks and leave the brights; highlights pull the brights down and leave the darks", () => {
    expect(grey({ shadows: 60 }, 0.25)).toBeGreaterThan(0.29);
    expect(Math.abs(grey({ shadows: 60 }, 0.95) - 0.95)).toBeLessThan(0.01);
    expect(grey({ highlights: -60 }, 0.75)).toBeLessThan(0.71);
    expect(Math.abs(grey({ highlights: -60 }, 0.1) - 0.1)).toBeLessThan(0.01);
    expect(grey({ blacks: 60 }, 0.02)).toBeGreaterThan(0.1);
    expect(grey({ whites: -60 }, 0.98)).toBeLessThan(0.9);
  });
  it("keeps a colour's hue while it lightens it", () => {
    const p = gradeFn({ shadows: 60 })(0.3, 0.15, 0.05);
    expect(rgbHsv(...p)[0]).toBeCloseTo(rgbHsv(0.3, 0.15, 0.05)[0], 2);
  });
  it("vibrance raises a dull colour more than a strong one", () => {
    const f = gradeFn({ vibrance: 60 });
    const dull: [number, number, number] = [0.55, 0.5, 0.45], strong: [number, number, number] = [0.9, 0.2, 0.1];
    expect(sat(f(...dull)) / sat(dull)).toBeGreaterThan(sat(f(...strong)) / sat(strong) + 0.2);
  });
});

describe("wheels, HSL secondaries and Hue vs Sat", () => {
  it("a blue shadows wheel tints the darks, not the brights, and keeps their brightness", () => {
    const f = gradeFn({ wheels: { shadows: { hue: 240, amount: 60 } } });
    const d = f(0.2, 0.2, 0.2), b = f(0.95, 0.95, 0.95);
    expect(d[2] - d[0]).toBeGreaterThan(0.04);
    expect(Math.abs(b[2] - b[0])).toBeLessThan(0.01);
    expect(0.2126 * d[0] + 0.7152 * d[1] + 0.0722 * d[2]).toBeCloseTo(0.2, 2);
    expect(grey({ wheels: { highlights: { luma: -50 } } }, 0.9)).toBeLessThan(0.82);
  });
  it("an HSL secondary on the sky changes blues only", () => {
    const g: Grade = { hsl: [{ hue: 210, range: 50, saturation: 160, hueShift: -10 }] };
    const f = gradeFn(g), sky: [number, number, number] = [0.45, 0.6, 0.8], skin: [number, number, number] = [0.8, 0.6, 0.5];
    expect(sat(f(...sky))).toBeGreaterThan(sat(sky) * 1.4);
    expect(f(...skin).map((v) => Math.round(v * 1000))).toEqual(skin.map((v) => Math.round(v * 1000)));
    // Greys are left (no hue to qualify).
    expect(grey(g, 0.5)).toBeCloseTo(0.5, 6);
  });
  it("Hue vs Sat: reds to grey, blues as they were", () => {
    const pts: [number, number][] = [[0, 0], [1 / 6, 0.5], [2 / 6, 0.5], [3 / 6, 0.5], [4 / 6, 0.5], [5 / 6, 0.5]];
    const f = gradeFn({ hueSat: pts });
    expect(sat(f(0.8, 0.1, 0.1))).toBeLessThan(0.01);
    expect(sat(f(0.1, 0.1, 0.8))).toBeCloseTo(sat([0.1, 0.1, 0.8]), 3);
  });
});

describe("set_grade", () => {
  it("sets tone and vibrance, merges each wheel, replaces the HSL list, and says it all", () => {
    let s = edit(base(), { op: "set_grade", clipId: "a", highlights: -30, shadows: 20, vibrance: 25, wheels: { shadows: { hue: 200, amount: 15 } }, hsl: [{ hue: 25, range: 40, saturation: 90 }] } as Op).snap;
    s = edit(s, { op: "set_grade", clipId: "a", wheels: { shadows: { luma: 10 }, highlights: { hue: 40, amount: 10 } } } as Op).snap;
    const g = gradeOf(s, "a")!;
    expect(g.wheels).toEqual({ shadows: { hue: 200, amount: 15, luma: 10 }, highlights: { hue: 40, amount: 10 } });
    expect(gradeText(g)).toBe("highlights -30, shadows +20, vibrance +25, shadows wheel 200° 15 luma +10, highlights wheel 40° 10, HSL 25°±20 sat 90%");
    expect(gradeIsActive({ vibrance: 5 })).toBe(true);
    s = edit(s, { op: "set_grade", clipId: "a", wheels: { shadows: null, highlights: null }, hsl: [], vibrance: null } as Op).snap;
    expect(gradeOf(s, "a")).toEqual({ highlights: -30, shadows: 20 });
  });
});

describe("the vignette", () => {
  it("darkens outside a soft ellipse a little larger than the frame, in the render and the player", () => {
    const s = edit(base(), { op: "set_effects", clipId: "a", effects: [{ type: "vignette", amount: 35 }] } as Op).snap;
    const source = { width: 1920, height: 1080, fps: 30, seconds: 12, hasAudio: true };
    const p = planRender({ kind: "preview", snapshot: s, transcript: tr, source, videoId: "v" });
    expect(p.looks!.a.effects![0]).toMatchObject({ type: "vignette", amount: 35, area: VIGNETTE_AREA });
    expect(Object.values(p.lookFiles!).filter((f) => f.kind === "area")).toHaveLength(1);
    const looks = Object.fromEntries(Object.keys(p.lookFiles ?? {}).map((n) => [n, `/tmp/${n}`]));
    const g = ffmpegArgs(p, { source: "/in.mp4", output: "/out.mp4", looks } as PlanFiles, source, { loudnessGainDb: 0 }).filterGraph;
    expect(g).toMatch(/colorchannelmixer=rr=0\.650:gg=0\.650:bb=0\.650/);
    expect(g).toMatch(/maskedmerge/);
  });
});
