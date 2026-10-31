// Premiere parity, phase 14: Hue vs Hue and Luma vs Sat (Lumetri's curves), in the grade's LUT so the render and the
// player draw them alike; the op, merging, the text, the LUT size.
import { describe, expect, it } from "vitest";
import { applyOp, buildInitialTimeline, gradeFn, gradeIsActive, gradeText, lutSizeFor, mergeGrade, valueCurveFn, type EditContext, type Grade, type Op, type Snapshot } from "../src/index";
import { planRender } from "../src/renderPlan";

const hsv = (r: number, g: number, b: number) => { const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn; let h = 0; if (d) h = mx === r ? ((g - b) / d + 6) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4; return [h * 60, mx ? d / mx : 0, mx]; };

describe("Hue vs Hue", () => {
  it("turns greens toward teal by the curve, leaves other hues and greys alone", () => {
    const g: Grade = { hueHue: [[0, 0.5], [1 / 3, 0.5 + 40 / 360], [2 / 3, 0.5]] }; // +40° at green
    const f = gradeFn(g);
    const green = f(0.2, 0.7, 0.2);
    expect(Math.round(hsv(...green)[0])).toBe(160); // 120° + 40°
    expect(hsv(...green)[1]).toBeCloseTo(hsv(0.2, 0.7, 0.2)[1], 2); // saturation kept
    const red = f(0.8, 0.2, 0.2);
    expect(Math.round(hsv(...red)[0])).toBe(0);
    expect(f(0.5, 0.5, 0.5).map((v) => +v.toFixed(3))).toEqual([0.5, 0.5, 0.5]);
    // Between points the turn eases off: at yellow (60°) it is half way between none (red) and 40° (green).
    const y = hsv(...f(0.7, 0.7, 0.2))[0];
    expect(y).toBeGreaterThan(68); expect(y).toBeLessThan(84);
  });
});

describe("Luma vs Sat", () => {
  it("takes colour out of the shadows by the curve and keeps the highlights' colour", () => {
    const g: Grade = { lumaSat: [[0, 0.1], [0.5, 0.5], [1, 0.5]] }; // 20% saturation at black, as is from the middle up
    const f = gradeFn(g);
    const dark = f(0.25, 0.08, 0.08), bright = f(0.95, 0.55, 0.55);
    expect(hsv(...dark)[1]).toBeLessThan(hsv(0.25, 0.08, 0.08)[1] * 0.75);
    expect(hsv(...bright)[1]).toBeCloseTo(hsv(0.95, 0.55, 0.55)[1], 2);
    expect(valueCurveFn([[0.2, 0.3], [0.8, 0.7]])(0)).toBe(0.3);
    expect(valueCurveFn([[0.2, 0.3], [0.8, 0.7]])(0.5)).toBeCloseTo(0.5, 5);
  });
});

describe("the op, the text and the LUT", () => {
  it("set_grade takes both (null removes), the text says them, the LUT is the finer one", () => {
    const ctx: EditContext = { videoId: "v", transcript: [], silences: [], sceneCuts: [], duration: 10, getStyle: () => undefined };
    let s: Snapshot = applyOp({ timeline: buildInitialTimeline([], 10, "clean", [], "v"), name: "c", aspect: "16:9", styleId: null }, { op: "set_clips", track: "v1", clips: [{ id: "a", start: 0, end: 10, label: "" }] } as Op, ctx).snap;
    const r = applyOp(s, { op: "set_grade", all: true, hueHue: [[0, 0.5], [1 / 3, 0.611], [2 / 3, 0.5]], lumaSat: [[0, 0.25], [1, 0.5]] } as Op, ctx);
    expect(r.summary).toMatch(/hue vs hue \(120° \+40°\), luma vs sat \(0% → 50%, 100% → 100%\)/);
    s = r.snap;
    const grade = (s.timeline.tracks.v1 as { grade?: Grade }[])[0].grade!;
    expect(gradeIsActive(grade)).toBe(true);
    expect(lutSizeFor(grade)).toBe(49);
    expect(planRender({ kind: "preview", snapshot: s, transcript: [], source: { width: 1280, height: 720, fps: 30, seconds: 10, hasAudio: false }, videoId: "v" }).lookFiles).toBeTruthy();
    expect(mergeGrade(grade, { hueHue: null }).hueHue).toBeUndefined();
    expect(gradeText({ lumaSat: [[0, 0.5]] })).toBe("luma vs sat (0% → 100%)");
  });
});
