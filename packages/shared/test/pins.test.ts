import { describe, expect, it } from "vitest";
import { layersAt, pinLayersText, pinWhere, type Timeline } from "../src";

const tl = {
  tracks: {
    v1: [{ id: "c1", start: 0, end: 10, label: "Talking head" }],
    v2: [{ id: "b1", kind: "broll", videoId: "vid9", start: 2, end: 5, label: "knee b-roll" }, { id: "z1", kind: "zoom", zoom: 1.2, start: 6, end: 8, label: "" }],
    v3: [
      { id: "g1", kind: "graphic", graphicId: "logo", start: 1, end: 9, label: "Logo", keys: [{ t: 0, x: -0.38, y: -0.38, scale: 0.2 }] },
      { id: "cap1", kind: "caption", lineId: "l1", start: 0, end: 4, label: "the words" },
    ],
    a1: [], a2: [], a3: [],
  },
  cut: [],
} as unknown as Timeline;

describe("pins", () => {
  it("finds the corner logo under a pin in its corner", () => {
    const ls = layersAt(tl, 3, { x: 0.12, y: 0.12 });
    expect(ls.find((l) => l.id === "g1")!.hit).toBe("covers");
    expect(pinLayersText(ls)).toContain("most likely about: v3 graphic g1");
  });
  it("puts the b-roll under a pin in the middle while it plays, the footage after it", () => {
    const ls = layersAt(tl, 3, { x: 0.5, y: 0.45 });
    expect(ls.find((l) => l.id === "g1")!.hit).toBe("off");
    expect(pinLayersText(ls)).toContain("most likely about: v2 broll b1");
    const later = layersAt(tl, 7, { x: 0.5, y: 0.45 });
    expect(later.some((l) => l.id === "b1")).toBe(false);
    expect(pinLayersText(later)).toContain("most likely about: v1 footage c1");
  });
  it("marks the captions near a pin low on the frame", () => {
    const ls = layersAt(tl, 1, { x: 0.5, y: 0.82 });
    expect(ls[0]).toMatchObject({ id: "cap1", hit: "near" });
  });
  it("says where a pin is in words", () => {
    expect(pinWhere({ x: 0.1, y: 0.9 })).toBe("10% across, 90% down (bottom left)");
    expect(pinWhere({ x: 0.5, y: 0.5 })).toBe("50% across, 50% down (centre)");
  });
});
