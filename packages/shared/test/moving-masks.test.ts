// Premiere parity, phase 3: masks and effect areas that move (keys) or follow the face, and darken (a spotlight). The
// box between keys, keys made from a face track (the shape kept against the face, few keys where it is still), the ops
// (faces measured by the server; a clip with no face keeps the shape still), the text, the render plan (a moving look
// file in footage time, held still on a reversed clip) and the FFmpeg graph (the mask video put through the clip's own
// trim and speed).
import { describe, expect, it } from "vitest";
import { applyOp, areaAt, buildInitialTimeline, buildTranscript, followFace, moving, simplifyKeys, summarizeTimeline, type Area, type AreaKey, type EditContext, type FaceTrack, type Op, type SeqClip, type Snapshot } from "../src/index";
import { ffmpegArgs, movingFrames, planRender, type LookFile, type PlanFiles } from "../src/renderPlan";

const tr = buildTranscript([Array.from({ length: 20 }, (_, i) => ({ text: `w${i}`, start: 0.5 + i * 0.5, end: 0.9 + i * 0.5 }))], { maxWordsPerLine: 8 }).map((l) => ({ ...l, words: l.words.map((w) => ({ ...w, filler: false })) }));
const ctx: EditContext = { videoId: "v", transcript: tr, silences: [], sceneCuts: [], duration: 12, getStyle: () => undefined };
const base = (): Snapshot => applyOp({ timeline: buildInitialTimeline(tr, 12, "clean", [], "v"), name: "t", aspect: "16:9", styleId: "s2" }, { op: "set_clips", track: "v1", clips: [{ id: "a", start: 1, end: 5, label: "" }, { id: "b", start: 6, end: 10, label: "" }] } as Op, ctx).snap;
const edit = (s: Snapshot, op: Op) => applyOp(s, op, ctx);
const clipOf = (s: Snapshot, id: string) => (s.timeline.tracks.v1 as (SeqClip & { masks?: Area[]; effects?: { type: string; amount: number; area?: Area }[] })[]).find((c) => c.id === id)!;
const source = { width: 1920, height: 1080, fps: 30, seconds: 12, hasAudio: true };
// A face moving from the left to the right of the frame over clip a (footage 1-5 s), still for the last second.
const track: FaceTrack = Array.from({ length: 41 }, (_, i) => { const t = 1 + i * 0.1, x = 0.2 + Math.min(t - 1, 3) * 0.1; return [Math.round(t * 1000) / 1000, x, 0.2, x + 0.2, 0.6]; });

describe("the box over time", () => {
  const a: Area = { shape: "rect", x: 0, y: 0, w: 0.2, h: 0.2, keys: [{ at: 1, x: 0, y: 0, w: 0.2, h: 0.2 }, { at: 3, x: 0.4, y: 0.2, w: 0.4, h: 0.2 }] };
  it("moves in a straight line between keys and stays before the first and after the last", () => {
    expect(areaAt(a, 0)).toMatchObject({ x: 0, y: 0, w: 0.2 });
    expect(areaAt(a, 2)).toMatchObject({ x: 0.2, y: 0.1, w: 0.30000000000000004 });
    expect(areaAt(a, 9)).toMatchObject({ x: 0.4, y: 0.2, w: 0.4 });
    expect(moving(a)).toBe(true);
    expect(moving({ ...a, keys: [a.keys![0]] })).toBe(false);
  });
  it("few keys where the box moves in a line or stands still", () => {
    const line: AreaKey[] = Array.from({ length: 101 }, (_, i) => ({ at: i / 10, x: i / 200, y: 0.1, w: 0.2, h: 0.2 }));
    expect(simplifyKeys(line, 0.004)).toHaveLength(2);
    const bend = [...line.slice(0, 51), ...line.slice(51).map((k) => ({ ...k, x: 0.25 }))];
    expect(simplifyKeys(bend, 0.004).length).toBeLessThanOrEqual(4);
  });
});

describe("following the face", () => {
  it("without a box: an ellipse round the face at each moment, keys only where it turns", () => {
    const f = followFace({ shape: "ellipse", follow: "face" }, track);
    expect(f.follow).toBe("face");
    expect(f.keys!.length).toBeGreaterThanOrEqual(2);
    expect(f.keys!.length).toBeLessThan(8);
    // The ellipse is centred on the face (its x moves 0.3 over 3 s) and wider than it (forehead to neck).
    const at = (t: number) => areaAt(f, t);
    expect(at(1).x! + at(1).w! / 2).toBeCloseTo(0.3, 2);
    expect(at(4.5).x! + at(4.5).w! / 2).toBeCloseTo(0.6, 2);
    expect(at(2.5).h!).toBeGreaterThan(0.4);
  });
  it("with its own box: kept in its place and size against the face (a blur box over the eyes stays on them)", () => {
    const f = followFace({ shape: "rect", x: 0.22, y: 0.3, w: 0.16, h: 0.05, follow: "face" }, track);
    expect(areaAt(f, 1)).toMatchObject({ x: 0.22, y: 0.3, w: 0.16, h: 0.05 });
    expect(areaAt(f, 4).x!).toBeCloseTo(0.52, 3);
  });
});

describe("set_masks and set_effects", () => {
  it("follow \"face\": keys from each clip's face; a clip with no face keeps the shape still and is named", () => {
    const r = edit(base(), { op: "set_effects", clipIds: ["a", "b"], effects: [{ type: "blur", amount: 40, area: { shape: "ellipse", follow: "face" } }], faceTracks: { a: track, b: null } } as Op);
    const fa = clipOf(r.snap, "a").effects![0].area!, fb = clipOf(r.snap, "b").effects![0].area!;
    expect(fa.follow).toBe("face");
    expect(moving(fa)).toBe(true);
    expect(fb.follow).toBeUndefined();
    expect(fb).toMatchObject({ x: 0.3, y: 0.15, w: 0.4, h: 0.6 });
    expect(r.summary).toMatch(/^2 clips: blur 40 in ellipse .* following the face \(\d+ keys\); no face measured on b: the shape stays where it is there$/);
  });
  it("needs the faces measured, unless the shape has its keys; other changes keep them", () => {
    expect(() => edit(base(), { op: "set_masks", clipId: "a", masks: [{ shape: "ellipse", follow: "face" }] } as Op)).toThrow(/needs the faces measured/);
    let s = edit(base(), { op: "set_masks", clipId: "a", masks: [{ shape: "ellipse", follow: "face" }], faceTracks: { a: track } } as Op).snap;
    const m = clipOf(s, "a").masks![0];
    s = edit(s, { op: "set_masks", clipId: "a", masks: [{ ...m, feather: 0.1 }] } as Op).snap;
    expect(clipOf(s, "a").masks![0].keys).toEqual(m.keys);
    expect(summarizeTimeline(s, tr)).toMatch(/masks ellipse .* following the face \(\d+ keys\) on a/);
  });
  it("keys sent by hand move a rect; a path cannot move; darken is an effect", () => {
    const keys = [{ at: 1, x: 0.1, y: 0.1, w: 0.2, h: 0.2 }, { at: 4, x: 0.6, y: 0.1, w: 0.2, h: 0.2 }];
    const s = edit(base(), { op: "set_masks", clipId: "a", masks: [{ shape: "rect", x: 0.1, y: 0.1, w: 0.2, h: 0.2, keys }] } as Op);
    expect(s.summary).toMatch(/moving \(2 keys, 1-4s\)/);
    expect(() => edit(base(), { op: "set_masks", clipId: "a", masks: [{ shape: "path", points: [[0, 0], [1, 0], [1, 1]], keys }] } as Op)).toThrow(/keys and follow move a rect or an ellipse/);
    const d = edit(base(), { op: "set_effects", clipId: "a", effects: [{ type: "darken", amount: 55, area: { shape: "ellipse", x: 0.3, y: 0.1, w: 0.4, h: 0.7, invert: true } }] } as Op);
    expect(d.summary).toMatch(/^a: darken 55 in outside ellipse/);
  });
});

describe("the render", () => {
  const plan = (s: Snapshot) => {
    const p = planRender({ kind: "preview", snapshot: s, transcript: tr, source, videoId: "v" });
    const looks = Object.fromEntries(Object.keys(p.lookFiles ?? {}).map((n) => [n, `/tmp/${n}`]));
    return { p, g: ffmpegArgs(p, { source: "/in.mp4", output: "/out.mp4", looks } as PlanFiles, source, { loudnessGainDb: 0 }) };
  };
  it("a moving area is a mask video in footage time, put through the clip's trim; a still one stays a picture", () => {
    const s = edit(base(), { op: "set_effects", clipId: "a", effects: [{ type: "darken", amount: 55, area: { shape: "ellipse", invert: true, follow: "face" } }], faceTracks: { a: track } } as Op).snap;
    const { p, g } = plan(s);
    const mv = Object.entries(p.lookFiles!).filter(([, f]) => f.kind === "moving");
    expect(mv).toHaveLength(1);
    expect(mv[0][0]).toMatch(/\.mkv$/);
    expect(mv[0][1]).toMatchObject({ from: 1, to: 5 });
    expect(g.filterGraph).toMatch(/setpts=PTS\+1(\.0+)?\/TB,fps=30,format=gray,trim=start=1/);
    expect(g.filterGraph).toMatch(/colorchannelmixer=rr=0\.450:gg=0\.450:bb=0\.450/);
    expect(g.args.join(" ")).toContain(`/tmp/${mv[0][0]}`);
    // Clip b's still blur stays a picture.
    const s2 = edit(s, { op: "set_effects", clipId: "b", effects: [{ type: "blur", amount: 20, area: { shape: "rect", x: 0.1, y: 0.1, w: 0.2, h: 0.2 } }] } as Op).snap;
    expect(Object.values(plan(s2).p.lookFiles!).filter((f) => f.kind === "area")).toHaveLength(1);
  });
  it("a reversed clip holds its moving mask where it is at the clip's start, and says so", () => {
    let s = edit(base(), { op: "set_masks", clipId: "a", masks: [{ shape: "ellipse", follow: "face" }], faceTracks: { a: track } } as Op).snap;
    s = edit(s, { op: "set_speed", clipId: "a", reverse: true } as Op).snap;
    const { p } = plan(s);
    expect(Object.values(p.lookFiles!).some((f) => f.kind === "moving")).toBe(false);
    expect(p.operations.join("\n")).toMatch(/Moving masks: held where they are at the clip's start on a \(reversed\)/);
  });
  it("the mask video's frames follow the keys, small, and a still stretch repeats the same frame", () => {
    const spec: Extract<LookFile, { kind: "moving" }> = { kind: "moving", from: 0, to: 2, area: { shape: "rect", x: 0, y: 0, w: 0.25, h: 1, keys: [{ at: 0, x: 0, y: 0, w: 0.25, h: 1 }, { at: 1, x: 0.75, y: 0, w: 0.25, h: 1 }] } };
    const m = movingFrames(spec, { width: 1920, height: 1080, fps: 30 });
    expect([m.w, m.h, m.count]).toEqual([480, 270, 63]);
    const lit = (f: Uint8Array) => { let s = 0; for (let x = 0; x < m.w; x++) s += f[135 * m.w + x] > 128 ? x : 0; return s / f.filter((v, i) => Math.floor(i / m.w) === 135 && v > 128).length; };
    expect(lit(m.frame(0))).toBeLessThan(m.w * 0.15);
    expect(lit(m.frame(30))).toBeGreaterThan(m.w * 0.85);
    expect(m.frame(45)).toBe(m.frame(60));
  });
});
