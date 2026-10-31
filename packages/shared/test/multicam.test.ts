// Premiere parity, phase 10: multicam. The sync (two cameras' loudness every 10 ms slid past each other), the ops
// (multicam, switch_angle and their text), the sequence (an angle's picture at the same moment by its offset, the main
// video's sound or the angle's own, the clip's own picture where the angle has no footage) and the render plan.
import { describe, expect, it } from "vitest";
import { applyOp, buildInitialTimeline, buildTranscript, sequenceView, summarizeTimeline, syncEnvelope, syncOffset, type EditContext, type Op, type SeqClip, type Snapshot } from "../src/index";
import { planRender } from "../src/renderPlan";

// A speech-like loudness: bursts (syllables) of random length and level, silence between, every 10 ms, from a seeded
// random sequence; `at(t)` is continuous so another camera can be sampled at any offset.
function speech(seed: number, seconds: number) {
  let x = seed;
  const rnd = () => ((x = (x * 1103515245 + 12345) % 2147483648) / 2147483648);
  const bursts: [number, number, number][] = [];
  for (let t = 0; t < seconds; ) { const len = 0.08 + rnd() * 0.3; bursts.push([t, t + len, -30 + rnd() * 22]); t += len + 0.03 + rnd() * (rnd() < 0.1 ? 1.2 : 0.25); }
  return (t: number) => { let v = -70; for (const [a, b, l] of bursts) if (t >= a - 0.02 && t < b + 0.02) { const edge = Math.min(1, (t - a + 0.02) / 0.04, (b + 0.02 - t) / 0.04); v = Math.max(v, l + 20 * Math.log10(Math.max(0.01, edge))); } return v; };
}
const frames = (f: (t: number) => number, from: number, seconds: number, gain = 0, floor = -70) => Int8Array.from({ length: Math.round(seconds * 100) }, (_, i) => Math.round(Math.max(floor, f(from + i * 0.01 + 0.005) + gain)));

describe("sync by sound", () => {
  it("finds the angle's offset to a few ms, on a quieter camera with more room noise", () => {
    const f = speech(7, 200);
    // The main camera from 0 s; the angle started 13.374 s earlier: its second 13.374 is the main video's 0.
    const main = frames(f, 0, 150), angle = frames(f, -13.374, 180, -14, -52);
    const r = syncOffset(syncEnvelope(main), syncEnvelope(angle));
    expect(Math.abs(r.offset - 13.374)).toBeLessThan(0.006);
    expect(r.sure).toBe(true);
    expect(r.score).toBeGreaterThan(0.5);
    expect(r.margin).toBeGreaterThan(1.5);
    // And the other way: an angle that started later (negative offset).
    const late = syncOffset(syncEnvelope(main), syncEnvelope(frames(f, 21.5, 100)));
    expect(Math.abs(late.offset + 21.5)).toBeLessThan(0.006);
  });
  it("two unrelated recordings are not sure", () => {
    for (const [a, b] of [[1, 99], [3, 5], [11, 42], [8, 13]]) {
      const r = syncOffset(syncEnvelope(frames(speech(a, 120), 0, 120)), syncEnvelope(frames(speech(b, 120), 0, 120)));
      expect(r.sure, JSON.stringify(r)).toBe(false);
    }
  });
});

const tr = buildTranscript([Array.from({ length: 20 }, (_, i) => ({ text: `w${i}`, start: 0.5 + i * 0.5, end: 0.9 + i * 0.5 }))], { maxWordsPerLine: 8 }).map((l) => ({ ...l, words: l.words.map((w) => ({ ...w, filler: false })) }));
const videos: Record<string, { id: string; name: string; seconds: number; ready: boolean }> = { camB: { id: "camB", name: "Cam B wide", seconds: 30, ready: true }, camC: { id: "camC", name: "Cam C", seconds: 6, ready: true } };
const ctx: EditContext = { videoId: "v", transcript: tr, silences: [], sceneCuts: [], duration: 12, getStyle: () => undefined, getVideo: (id) => videos[id] };
const base = (): Snapshot => applyOp({ timeline: buildInitialTimeline(tr, 12, "clean", [], "v"), name: "t", aspect: "16:9", styleId: "s2" }, { op: "set_clips", track: "v1", clips: [{ id: "a", start: 1, end: 5, label: "" }, { id: "b", start: 6, end: 10, label: "" }] } as Op, ctx).snap;
const edit = (s: Snapshot, op: Op) => applyOp(s, op, ctx);
const v1 = (s: Snapshot) => s.timeline.tracks.v1 as SeqClip[];
const withCams = () => edit(base(), { op: "multicam", angles: [{ videoId: "camB", offset: 2.5, score: 0.8 }, { videoId: "camC", offset: -3, name: "Close" }] } as Op).snap;
const source = { width: 1920, height: 1080, fps: 30, seconds: 12, hasAudio: true };
const sources = { camB: { width: 1280, height: 720, fps: 30, seconds: 30, hasAudio: true }, camC: { width: 1280, height: 720, fps: 30, seconds: 6, hasAudio: true } };
const plan = (s: Snapshot) => planRender({ kind: "preview", snapshot: s, transcript: tr, source, sources, videoId: "v" });

describe("the ops", () => {
  it("multicam adds the angles; the result and get_project say them; an angle without an offset needs the server", () => {
    const r = edit(base(), { op: "multicam", angles: [{ videoId: "camB", offset: 2.5, score: 0.8 }, { videoId: "camC", offset: -3, name: "Close" }] } as Op);
    expect(r.snap.timeline.multicam).toEqual({ angles: [{ videoId: "camB", offset: 2.5, score: 0.8 }, { videoId: "camC", offset: -3, name: "Close" }] });
    expect(r.summary).toBe("multicam: 2 angles: Cam B wide (+2.500s, sync 0.80), Close (-3.000s, set by hand); sound: the main video's. switch_angle picks which camera V1 shows");
    expect(summarizeTimeline(r.snap, tr)).toMatch(/Multicam: 2 angles: camB \(\+2\.500s, sync 0\.80\), Close/);
    expect(() => edit(base(), { op: "multicam", angles: [{ videoId: "camB" }] } as Op)).toThrow(/has no sync offset yet: send this edit through Rendrr's server/);
    expect(() => edit(base(), { op: "multicam", angles: [{ videoId: "nope", offset: 1 }] } as Op)).toThrow(/no video "nope"/);
    expect(() => edit(base(), { op: "multicam", angles: [{ videoId: "v", offset: 0 }] } as Op)).toThrow(/main camera already/);
    const unsure = edit(base(), { op: "multicam", angles: [{ videoId: "camB", offset: 2.5, score: 0.05 }] } as Op);
    expect(unsure.summary).toMatch(/The sync of Cam B wide is unsure/);
  });
  it("switch_angle over a range splits the clips at its ends; at goes to the next change; main goes back; remove clears the clips", () => {
    let s = edit(withCams(), { op: "switch_angle", angle: "camB", start: 2, end: 6, edit: true } as Op).snap;
    const view = sequenceView(s.timeline, tr.flatMap((l) => l.words));
    const on = view.clips.map((c) => [Math.round(c.start * 100) / 100, Math.round(c.end * 100) / 100, v1(s).find((x) => x.id === c.id)!.angle ?? "main"]);
    expect(on).toEqual([[0, 2, "main"], [2, 4, "camB"], [4, 6, "camB"], [6, 8, "main"]]);
    // From 3 s to the next change: the rest of the camB stretch goes to Close.
    const r = edit(s, { op: "switch_angle", angle: "close", at: 3, edit: true } as Op);
    expect(r.summary).toBe("2 clips from edit 0:03 to 0:06 on Close (the main video's sound)");
    s = r.snap;
    expect(sequenceView(s.timeline, tr.flatMap((l) => l.words)).clips.map((c) => v1(s).find((x) => x.id === c.id)!.angle ?? "main")).toEqual(["main", "camB", "camC", "camC", "main"]);
    s = edit(s, { op: "switch_angle", angle: "main", clipIds: [v1(s)[1].id] } as Op).snap;
    expect(v1(s)[1].angle).toBeUndefined();
    expect(summarizeTimeline(s, tr)).toMatch(/angle Close \(camC\)/);
    s = edit(s, { op: "multicam", remove: ["Close"] } as Op).snap;
    expect(v1(s).some((c) => c.angle)).toBe(false);
    expect(() => edit(s, { op: "switch_angle", angle: "Close", at: 1 } as Op)).toThrow(/not an angle of this edit/);
    expect(() => edit(base(), { op: "switch_angle", angle: "camB", at: 1 } as Op)).toThrow(/no multicam/);
  });
});

describe("the sequence and the render", () => {
  it("an angle's picture is its own video at the same moment; the sound stays the main video's", () => {
    const s = edit(withCams(), { op: "switch_angle", angle: "camB", clipIds: ["b"] } as Op).snap;
    const p = plan(s);
    const b = p.parts.find((x) => x.clipIds.includes("b"))!;
    expect(b.videoId).toBe("camB");
    expect([b.srcIn, b.srcOut]).toEqual([8.5, 12.5]); // main 6..10 + 2.5
    expect(p.sound.filter((x) => x.clipId === "b").every((x) => x.videoId === "v" && x.srcIn >= 6 - 1e-6)).toBe(true);
    expect(Object.keys(p.videos!)).toEqual(expect.arrayContaining(["v", "camB"]));
    expect(p.operations.join("\n")).toMatch(/Multicam: main camera 50%, camB 50% \(offset \+2\.500s\), Close 0% \(offset -3\.000s\); sound: the main video's/);
  });
  it("sound follow: the angle's own sound plays with its picture", () => {
    let s = edit(withCams(), { op: "multicam", audio: "follow" } as Op).snap;
    s = edit(s, { op: "switch_angle", angle: "camB", clipIds: ["b"] } as Op).snap;
    const snd = plan(s).sound.filter((x) => x.clipId === "b");
    expect(snd.map((x) => [x.videoId, x.srcIn, x.srcOut])).toEqual([["camB", 8.5, 12.5]]);
  });
  it("where the angle has no footage the clip shows (and plays) its own", () => {
    // Close (camC) covers main time 3..9 (its 6 s from offset -3); clip a is main 1..5: 1..3 stays main.
    const s = edit(withCams(), { op: "switch_angle", angle: "Close", clipIds: ["a"] } as Op).snap;
    const parts = plan(s).parts.filter((x) => x.clipIds.includes("a")).map((x) => [x.videoId, x.start, x.end, x.srcIn]);
    expect(parts).toEqual([["v", 0, 2, 1], ["camC", 2, 4, 0]]);
  });
  it("an angle missing from the library stops the render with what to do", () => {
    const s = edit(withCams(), { op: "switch_angle", angle: "camB", clipIds: ["b"] } as Op).snap;
    expect(() => planRender({ kind: "preview", snapshot: s, transcript: tr, source, sources: {}, videoId: "v" })).toThrow(/multicam angle is no longer in your library/);
  });
});
