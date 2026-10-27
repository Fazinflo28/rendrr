// Engine Part 6: the waveform's columns from 10 ms peaks: what plays where (a cut moves the sound along), a column
// covering many frames takes their lowest and highest, nothing where nothing plays, muted parts flagged.
import { describe, expect, it } from "vitest";
import { peaksFromSamples, waveColumns, type Peaks } from "../src/waveform";

describe("waveform", () => {
  // 10 s of sound: silent, except loud (0.8) from 2 to 3 s.
  const x = new Float32Array(10 * 1000).map((_, i) => (i >= 2000 && i < 3000 ? (i % 2 ? 0.8 : -0.8) : 0));
  const pk: Peaks = peaksFromSamples(x, 1000);
  it("10 ms peaks of samples", () => {
    expect(pk.n).toBe(1000);
    expect([pk.min[199], pk.max[199], pk.min[200], pk.max[200], pk.max[299], pk.max[300]]).toEqual([0, 0, -102, 102, 102, 0]);
  });
  it("columns follow the edit: the loud second plays at edit 0.5 s once the footage's first 1.5 s is cut", () => {
    const parts = [{ start: 0, end: 8.5, srcIn: 1.5, srcOut: 10, key: "v" }];
    const c = waveColumns(parts, () => pk, 0, 0.25, 40); // 10 s in 0.25 s columns
    const loud = Array.from(c.hi).map((v, i) => [i, v] as const).filter(([, v]) => v > 0.5).map(([i]) => i);
    expect(loud).toEqual([2, 3, 4, 5]); // edit 0.5-1.5 s
    expect(Number.isNaN(c.hi[35])).toBe(true); // after the edit's end
    expect(c.lo[3]).toBeCloseTo(-102 / 127, 3);
  });
  it("a wide column takes the lowest and highest of every frame it covers; muted parts are flagged", () => {
    const c = waveColumns([{ start: 0, end: 10, srcIn: 0, srcOut: 10, key: "v", muted: true }], () => pk, 0, 5, 2);
    expect(c.hi[0]).toBeCloseTo(102 / 127, 3);
    expect(c.hi[1]).toBe(0);
    expect(Array.from(c.muted)).toEqual([1, 1]);
    // No peaks for that sound (not measured yet): nothing drawn.
    expect(Number.isNaN(waveColumns([{ start: 0, end: 10, srcIn: 0, srcOut: 10, key: "x" }], () => undefined, 0, 1, 3).hi[0])).toBe(true);
  });
});
