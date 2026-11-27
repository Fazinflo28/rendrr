// After Effects keyframes: handles (influence, speed), hold, auto and motion paths, on the curves the player and the
// render both draw.
import { describe, expect, it } from "vitest";
import { aeValueAt, keyTrack, KeySchema, trackAt, trackExpr, type Key } from "../src/motion";

const evalExpr = (e: string, t: number) => new Function("t", "clip", "gte", `return ${e};`)(t, (x: number, a: number, b: number) => Math.min(b, Math.max(a, x)), (a: number, b: number) => (a >= b ? 1 : 0));
const speedAt = (tr: { t: number; v: number }[], t: number, h = 1 / 240) => (trackAt(tr, t + h) - trackAt(tr, t - h)) / (2 * h);

describe("After Effects keyframes", () => {
  it("Easy Ease starts and settles at zero speed and passes the middle at the middle", () => {
    const keys: Key[] = [{ t: 0, x: 0, interp: "bezier" }, { t: 1, x: 0.5 }];
    const tr = keyTrack(keys, "x")!;
    expect(Math.abs(speedAt(tr, 0.01))).toBeLessThan(0.08);
    expect(Math.abs(speedAt(tr, 0.99))).toBeLessThan(0.08);
    expect(trackAt(tr, 0.5)).toBeCloseTo(0.25, 2);
    expect(tr.length).toBe(61); // a piece per 60th of a second
  });
  it("a long influence keeps the move slow at the ends and fast in the middle", () => {
    const easy = keyTrack([{ t: 0, x: 0, easeOut: { influence: 33 } }, { t: 1, x: 1, easeIn: { influence: 33 } }], "x")!;
    const long = keyTrack([{ t: 0, x: 0, easeOut: { influence: 85 } }, { t: 1, x: 1, easeIn: { influence: 85 } }], "x")!;
    expect(trackAt(long, 0.2)).toBeLessThan(trackAt(easy, 0.2));
    expect(speedAt(long, 0.5)).toBeGreaterThan(speedAt(easy, 0.5));
  });
  it("speed at a key is the handle's speed", () => {
    expect((aeValueAt(0, 0, 2, 0.33, 1, 1, 0, 0.33, 0.001) - 0) / 0.001).toBeCloseTo(2, 1);
  });
  it("hold keeps the value, then jumps; auto keeps the speed continuous through a key", () => {
    const hold = keyTrack([{ t: 0, opacity: 1, interp: "hold" }, { t: 1, opacity: 0 }], "opacity")!;
    expect(trackAt(hold, 0.99)).toBe(1);
    expect(trackAt(hold, 1)).toBe(0);
    const auto = keyTrack([{ t: 0, x: 0, interp: "bezier" }, { t: 1, x: 0.5, interp: "auto" }, { t: 2, x: 1 }], "x")!;
    expect(Math.abs(speedAt(auto, 1 - 0.02) - speedAt(auto, 1 + 0.02))).toBeLessThan(0.05);
    const plain = keyTrack([{ t: 0, x: 0, ease: "in-out" }, { t: 1, x: 0.5, ease: "in-out" }, { t: 2, x: 1 }], "x")!;
    expect(Math.abs(speedAt(plain, 1 - 0.02))).toBeLessThan(0.1); // a plain ease stops at the key
  });
  it("a motion path bends x and y together and ends on the key", () => {
    const keys: Key[] = [{ t: 0, x: 0, y: 0, pathOut: [0, -0.4] }, { t: 1, x: 0.5, y: 0, pathIn: [0, -0.4] }];
    const tx = keyTrack(keys, "x")!, ty = keyTrack(keys, "y")!;
    expect(trackAt(ty, 0.5)).toBeLessThan(-0.2);
    expect(trackAt(tx, 1)).toBeCloseTo(0.5, 6);
    expect(trackAt(ty, 1)).toBeCloseTo(0, 6);
  });
  it("the render's expression equals the player's curve, and the fields validate", () => {
    const keys: Key[] = [{ t: 0, scale: 1, easeOut: { influence: 70, speed: 0 } }, { t: 0.8, scale: 1.4, interp: "auto" }, { t: 1.6, scale: 1, interp: "hold" }, { t: 2, scale: 0.5 }];
    const tr = keyTrack(keys, "scale")!, ex = trackExpr(tr, "t");
    for (let t = -0.2; t <= 2.2; t += 0.031) expect(evalExpr(ex, t)).toBeCloseTo(trackAt(tr, t), 6);
    expect(KeySchema.safeParse({ t: 0, x: 0, interp: "bezier", easeOut: { influence: 80 }, pathOut: [0.1, -0.2] }).success).toBe(true);
    expect(KeySchema.safeParse({ t: 0, interp: "bouncy" }).success).toBe(false);
  });
});
