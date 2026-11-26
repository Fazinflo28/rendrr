// Show only the fix (audit #23): the moments a new preview changed, found by comparing its plan with the one before.
import { describe, expect, it } from "vitest";
import { applyOp, buildInitialTimeline, changedMoments, mapMoment, STYLES, stubTranscript, type EditContext, type Snapshot } from "../src/index";
import { planRender } from "../src/renderPlan";

const tr = stubTranscript(60);
const words = tr.flatMap((l) => l.words);
const ctx: EditContext = { videoId: "vid1", transcript: tr, silences: [], sceneCuts: [], duration: 60, getStyle: (id) => STYLES.find((s) => s.id === id), getVideo: () => undefined, getGraphic: () => undefined, sources: {} };
const snap = (): Snapshot => ({ timeline: buildInitialTimeline(tr, 60, "clean", [], "vid1"), name: "t", aspect: "16:9", styleId: "s2" });
const source = { width: 1920, height: 1080, fps: 30, seconds: 60, hasAudio: true };
const plan = (s: Snapshot) => planRender({ kind: "preview", snapshot: s, transcript: tr, source, videoId: "vid1" });
const edit = (s: Snapshot, op: Parameters<typeof applyOp>[1]) => applyOp(s, op, ctx).snap;
const wordNear = (t: number) => words.reduce((b, w) => (Math.abs(w.t - t) < Math.abs(b.t - t) ? w : b), words[0]);
const inside = (ws: { from: number; to: number }[], t: number) => ws.some((w) => t >= w.from && t <= w.to);
const seconds = (ws: { from: number; to: number }[]) => ws.reduce((s, w) => s + w.to - w.from, 0);

describe("changed moments between two previews", () => {
  const base = snap(), a = plan(base);
  it("the same edit has nothing changed", () => {
    expect(changedMoments(a, plan(base))).toEqual([]);
  });
  it("words cut in the middle: one short window at the new cut, nothing else", () => {
    const w = wordNear(30), s2 = edit(base, { op: "cut_words", wordIds: [w.id] });
    const b = plan(s2), out = changedMoments(a, b)!;
    expect(out.length).toBe(1);
    const cutAt = mapMoment(a, b, w.t)!; // where the cut is in the new preview
    expect(inside(out, cutAt)).toBe(true);
    expect(seconds(out)).toBeLessThan(5);
    expect(inside(out, 5)).toBe(false);
    expect(inside(out, b.outputSeconds - 5)).toBe(false);
  });
  it("a title added: its moments are shown, the rest is not", () => {
    const s2 = edit(base, { op: "add_text", text: "Ten clients", start: 40, end: 42, preset: "title" });
    const b = plan(s2), out = changedMoments(a, b)!;
    expect(out.length).toBe(1);
    expect(inside(out, 41)).toBe(true);
    expect(inside(out, 20)).toBe(false);
  });
  it("a zoom added near the start and words cut near the end: two windows", () => {
    const s2 = edit(edit(base, { op: "add_zoom", start: 5, end: 6, scale: 1.2 }), { op: "cut_words", wordIds: [wordNear(50).id] });
    const out = changedMoments(a, plan(s2))!;
    expect(out.length).toBe(2);
    expect(inside(out, 5.5)).toBe(true);
  });
  it("the comments fixed are shown too", () => {
    const out = changedMoments(a, plan(base), [12])!;
    expect(inside(out, 12)).toBe(true);
    expect(seconds(out)).toBeLessThanOrEqual(3);
  });
  it("a change to the whole edit (the size), or most of it, plays the whole preview", () => {
    expect(changedMoments(a, plan({ ...base, aspect: "9:16" }))).toBeNull();
    const many = edit(base, { op: "cut_words", wordIds: words.filter((_, i) => i % 3 === 0).map((w) => w.id) });
    expect(changedMoments(a, plan(many))).toBeNull();
  });
  it("nothing to compare: no windows", () => {
    expect(changedMoments(null, a)).toBeNull();
    expect(changedMoments(a, null)).toBeNull();
  });
  it("a comment's moment moves with the cuts before it; a moment cut out lands on its cut", () => {
    const w = wordNear(20), s2 = edit(base, { op: "cut_words", wordIds: [w.id] }), b = plan(s2);
    const cutLen = a.outputSeconds - b.outputSeconds;
    expect(cutLen).toBeGreaterThan(0);
    expect(mapMoment(a, b, 40)).toBeCloseTo(40 - cutLen, 1);
    expect(mapMoment(a, b, 10)).toBeCloseTo(10, 1);
    const inCut = mapMoment(a, b, (w.t + w.end) / 2)!;
    expect(Math.abs(inCut - w.t)).toBeLessThan(0.5);
  });
});
