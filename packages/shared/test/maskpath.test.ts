// Mask path keyframes: a path mask's shape keyed over time (pathKeys). Shapes of different point counts are spaced out
// to the same count along their outline; between keys each point moves straight; the op keeps the keys in time order
// (one per moment); a changing path is a moving mask (drawn as a mask video in the render, live in the player).
import { describe, expect, it } from "vitest";
import { AreaSchema, applyOp, areaAt, buildInitialTimeline, moving, resamplePath, type Area, type EditContext, type Op, type Snapshot } from "../src/index";
import { planRender } from "../src/renderPlan";

const tri: [number, number][] = [[0, 0], [1, 0], [0, 1]];
const sq: [number, number][] = [[0.2, 0.2], [0.8, 0.2], [0.8, 0.8], [0.2, 0.8]];

describe("a path's shape over time", () => {
  it("the schema takes pathKeys on a path only; a path may be sent with keys alone", () => {
    expect(AreaSchema.safeParse({ shape: "path", points: tri, pathKeys: [{ at: 1, points: sq }] }).success).toBe(true);
    expect(AreaSchema.safeParse({ shape: "path", pathKeys: [{ at: 1, points: sq }] }).success).toBe(true);
    expect(AreaSchema.safeParse({ shape: "rect", x: 0, y: 0, w: 1, h: 1, pathKeys: [{ at: 1, points: sq }] }).success).toBe(false);
  });
  it("spaced out along its outline: its own count unchanged; more points keep the corners' places in order", () => {
    expect(resamplePath(sq, 4)).toEqual(sq);
    const eight = resamplePath(sq, 8);
    expect(eight).toHaveLength(8);
    expect(eight[0]).toEqual([0.2, 0.2]);
    expect(eight[1]).toEqual([0.5, 0.2]);
    expect(eight[2]).toEqual([0.8, 0.2]);
  });
  it("between keys each point moves straight; before the first and after the last the shape stays", () => {
    const a: Area = { shape: "path", points: sq, pathKeys: [{ at: 1, points: sq }, { at: 3, points: sq.map(([x, y]) => [x + 0.1, y] as [number, number]) }] };
    expect(moving(a)).toBe(true);
    expect(areaAt(a, 0).points).toEqual(sq);
    expect(areaAt(a, 2).points![0][0]).toBeCloseTo(0.25, 9);
    expect(areaAt(a, 9).points![1][0]).toBeCloseTo(0.9, 9);
    // A triangle morphing into a square: both spaced out to 4 points.
    const m: Area = { shape: "path", points: tri, pathKeys: [{ at: 0, points: tri }, { at: 2, points: sq }] };
    expect(areaAt(m, 1).points).toHaveLength(4);
  });
  it("the op keeps the keys in time order, one a moment, and says it changes shape; the plan draws it as a moving mask", () => {
    const ctx: EditContext = { videoId: "v", transcript: [], silences: [], sceneCuts: [], duration: 10, getStyle: () => undefined };
    const s0: Snapshot = applyOp({ timeline: buildInitialTimeline([], 10, "clean", [], "v"), name: "t", aspect: "16:9", styleId: "s2" }, { op: "set_clips", track: "v1", clips: [{ id: "c", start: 0, end: 8, label: "" }] } as Op, ctx).snap;
    const r = applyOp(s0, { op: "set_masks", clipId: "c", masks: [{ shape: "path", pathKeys: [{ at: 4, points: sq }, { at: 1, points: tri }, { at: 4, points: sq }] }] } as Op, ctx);
    const m = (r.snap.timeline.tracks.v1 as { masks?: Area[] }[])[0].masks![0];
    expect(m.pathKeys!.map((k) => k.at)).toEqual([1, 4]);
    expect(m.points).toEqual(tri);
    expect(r.summary).toMatch(/changing shape \(2 keys, 1-4s\)/);
    const p = planRender({ kind: "preview", snapshot: r.snap, transcript: [], source: { width: 1280, height: 720, fps: 30, seconds: 10, hasAudio: true }, videoId: "v" });
    expect(Object.values(p.lookFiles ?? {}).some((f) => f.kind === "moving")).toBe(true);
  });
});
