// A render's time limit grows with the layers it decodes: 20 s a layer for a final, 5 s for a preview.
import { describe, expect, it } from "vitest";
import { layerAllowanceMs } from "../src/look";

describe("layerAllowanceMs", () => {
  it("counts b-roll, graphics and texts, music and sound effects, and the other V1 videos (not zooms or captions)", () => {
    const tl = { tracks: {
      v1: [{ sourceVideoId: "a" }, { sourceVideoId: "a" }, { sourceVideoId: "b" }],
      v2: [{ kind: "broll" }, { kind: "broll" }, { kind: "zoom" }],
      v3: [{ kind: "graphic" }, { kind: "text" }, { kind: "caption" }],
      a2: [{}], a3: [{}, {}],
    } };
    // 2 b-roll + 2 v3 + 1 music + 2 sfx + 1 other V1 video = 8 layers
    expect(layerAllowanceMs(tl, "final")).toBe(8 * 20_000);
    expect(layerAllowanceMs(tl, "preview")).toBe(8 * 5_000);
  });
  it("a heavy edit (43 inputs) gets about 14 more minutes for its final", () => {
    const tl = { tracks: { v1: [{ sourceVideoId: "a" }], v2: Array.from({ length: 30 }, () => ({ kind: "broll" })), v3: Array.from({ length: 10 }, () => ({ kind: "graphic" })), a2: [{}], a3: [{}, {}] } };
    expect(layerAllowanceMs(tl, "final")).toBe(43 * 20_000);
  });
  it("nothing for a plain cut or a missing timeline", () => {
    expect(layerAllowanceMs({ tracks: { v1: [{ sourceVideoId: "a" }] } }, "final")).toBe(0);
    expect(layerAllowanceMs(null, "final")).toBe(0);
  });
});
