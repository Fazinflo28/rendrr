// Premiere parity, phase 13: cut to whoever speaks. Two people, each on their own camera (and mic): each camera hears
// its own person loud and the other one 12 dB down, over room noise. The plan follows the speaker, keeps a 1 s
// interjection in the shot before it (shorter than the shortest shot), cuts a little before each voice, takes the wide
// camera when both talk, and the op splits the main camera's V1 clips and gives each piece its camera.
import { describe, expect, it } from "vitest";
import { applyOp, buildInitialTimeline, planText, speakerPlan, type EditContext, type Op, type SeqClip, type Snapshot } from "../src/index";

// Speech-like loudness while someone talks (syllables and short gaps), from a seeded random sequence; silence otherwise.
function voice(seed: number, turns: [number, number][]) {
  let x = seed;
  const rnd = () => ((x = (x * 1103515245 + 12345) % 2147483648) / 2147483648);
  const bursts: [number, number, number][] = [];
  for (const [a, b] of turns) for (let t = a; t < b;) { const len = 0.1 + rnd() * 0.25; bursts.push([t, Math.min(b, t + len), -22 + rnd() * 6]); t += len + 0.04 + rnd() * 0.15; }
  return (t: number) => { for (const [a, b, l] of bursts) if (t >= a && t < b) return l; return -90; };
}
const sum = (...db: number[]) => 10 * Math.log10(db.reduce((s, d) => s + Math.pow(10, d / 10), 0));
// A camera's 10 ms loudness over its own time: its person, the other 12 dB down, room noise at -60.
const camera = (own: (t: number) => number, other: (t: number) => number, offset: number, seconds: number) =>
  Int8Array.from({ length: Math.round(seconds * 100) }, (_, i) => { const t = i * 0.01 - offset; return Math.round(sum(own(t), other(t) - 12, -60)); });

const A = voice(3, [[0.4, 8], [15, 16], [25, 30]]);
const B = voice(9, [[8.3, 15], [16.2, 25], [25.2, 30]]);
const main = camera(A, B, 0, 31), cam2 = camera(B, A, 2.5, 34); // camera 2 started 2.5 s before the main one

describe("who speaks when", () => {
  it("follows the speaker by each camera's own sound; a 1 s interjection stays in the shot; cuts lead the voice", () => {
    const plan = speakerPlan([{ angle: "main", db: main, offset: 0 }, { angle: "cam2", db: cam2, offset: 2.5 }], { from: 0, to: 30 });
    expect(plan.map((p) => p.angle)).toEqual(["main", "cam2"]);
    expect(plan[0].start).toBe(0);
    expect(plan[1].start).toBeGreaterThan(7.9); expect(plan[1].start).toBeLessThan(8.6); // B starts at 8.3 s: the cut a little before
    expect(plan[1].end).toBe(30);
    expect(planText(plan, (a) => (a === "main" ? "Ana" : "Ben"))).toMatch(/^1 cut: Ben 7\d%, Ana 2\d%$/);
  });
  it("a shorter shortest shot keeps the interjection; both talking goes to the wide camera", () => {
    const plan = speakerPlan([{ angle: "main", db: main, offset: 0 }, { angle: "cam2", db: cam2, offset: 2.5 }], { from: 0, to: 30, minShot: 0.8, wide: "wide" });
    const at = (t: number) => plan.find((p) => t >= p.start && t < p.end)?.angle;
    expect([at(4), at(12), at(15.5), at(20), at(28)]).toEqual(["main", "cam2", "main", "cam2", "wide"]);
  });
  it("the op splits the main camera's clips at each change and gives each piece its camera; the text says it", () => {
    const ctx: EditContext = { videoId: "v", transcript: [], silences: [], sceneCuts: [], duration: 31, getStyle: () => undefined, getVideo: (id) => (id === "v2" ? { name: "Ben cam", seconds: 34 } as never : undefined) };
    let s: Snapshot = applyOp({ timeline: buildInitialTimeline([], 31, "clean", [], "v"), name: "pod", aspect: "16:9", styleId: null }, { op: "batch", ops: [{ op: "set_clips", track: "v1", clips: [{ id: "a", start: 0, end: 12, label: "" }, { id: "b", start: 14, end: 30, label: "" }] }, { op: "multicam", angles: [{ videoId: "v2", offset: 2.5, name: "Ben cam" }] }] } as never, ctx).snap;
    expect(() => applyOp(s, { op: "multicam_auto" } as Op, ctx)).toThrow(/worked out from the cameras' sound on the server/);
    const r = applyOp(s, { op: "multicam_auto", minShot: 2, plan: [{ start: 0, end: 8.1, angle: "main" }, { start: 8.1, end: 22, angle: "v2" }, { start: 22, end: 30, angle: "main" }] } as Op, ctx);
    s = r.snap;
    const v1 = s.timeline.tracks.v1 as SeqClip[];
    expect(v1.map((c) => [c.sourceIn, c.sourceOut, c.angle ?? "main"])).toEqual([[0, 8.1, "main"], [8.1, 12, "v2"], [14, 22, "v2"], [22, 30, "main"]]);
    expect(r.summary).toMatch(/^cut to whoever speaks over footage 0:00 to 0:30: 2 cuts: (main camera 5\d%, Ben cam 4\d%|Ben cam 4\d%, main camera 5\d%); shots at least 2 s$/);
    expect(() => applyOp(s, { op: "multicam_auto", plan: [{ start: 0, end: 5, angle: "nope" }] } as Op, ctx)).toThrow(/names "nope", which is not a camera/);
  });
});
