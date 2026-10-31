// Object tracking: a box followed through a clip by the server (track_object, rows from the tracker), masks and effect
// areas that follow it (follow "object"), text and graphics pinned to it (pin_layer: keyframes made from the track and
// kept up to date after every change), lost stretches, taking an object off, copying a look to a clip without it, and
// the render plan (a moving look file in the clip's footage time).
import { describe, expect, it } from "vitest";
import { applyOp, areaAt, buildInitialTimeline, keyTracks, motionAt, objectBoxAt, objectTrack, type Area, type EditContext, type Op, type SeqClip, type Snapshot, type TrackedObject, type V3Clip } from "../src/index";
import { planRender } from "../src/renderPlan";

const ctx: EditContext = { videoId: "v", transcript: [], silences: [], sceneCuts: [], duration: 12, getStyle: () => undefined,
  getVideo: (id) => (id === "dog" ? { id, name: "dog", seconds: 10, ready: true } : undefined) };
const base = (): Snapshot => applyOp({ timeline: buildInitialTimeline([], 12, "clean", [], "v"), name: "t", aspect: "16:9", styleId: "s2" },
  { op: "batch", ops: [{ op: "set_captions", on: false }, { op: "set_clips", track: "v1", clips: [{ id: "a", start: 1, end: 5, label: "" }, { id: "b", start: 6, end: 10, label: "" }] }] } as never, ctx).snap;
const run = (s: Snapshot, ...ops: Op[]) => applyOp(s, (ops.length === 1 ? ops[0] : { op: "batch", ops }) as never, ctx);
type Look = SeqClip & { masks?: Area[]; effects?: { type: string; amount: number; area?: Area }[]; objects?: TrackedObject[] };
const clipOf = (s: Snapshot, id: string) => (s.timeline.tracks.v1 as Look[]).find((c) => c.id === id)!;
const layerOf = (s: Snapshot, id: string) => (s.timeline.tracks.v3 as (V3Clip & { pin?: { clipId: string; object: string; scale?: boolean } })[]).find((c) => c.id === id)!;
const r4 = (v: number) => Math.round(v * 10000) / 10000;
// The tracker's rows over clip a (footage 1-5 s, every 0.1 s): a ball swinging left and right, growing a little; lost
// (confidence 0) from 2.5 to 2.8 s.
const cxAt = (t: number) => 0.4 + 0.2 * Math.sin((t - 1) * 1.5), szAt = (t: number) => 0.1 + 0.02 * (t - 1);
const rows: [number, number, number, number, number, number][] = Array.from({ length: 41 }, (_, i) => {
  const t = r4(1 + i * 0.1), c = cxAt(t), s = szAt(t);
  return [t, r4(c - s / 2), r4(0.5 - s / 2), r4(c + s / 2), r4(0.5 + s / 2), t >= 2.5 && t < 2.8 ? 0 : 0.9];
});
const tracked = () => run(base(), { op: "track_object", clipId: "a", at: 1, box: { x: 0.35, y: 0.45, w: 0.1, h: 0.1 }, label: "ball", rows } as Op);

describe("the tracker's rows as an object", () => {
  it("keeps the confident boxes, lightly smoothed, and says where it was lost", () => {
    const { track, lost } = objectTrack(rows);
    expect(track.length).toBe(38);
    expect(lost).toEqual([[2.5, 2.8]]);
    // Through the gap the box goes straight from the last box before it to the first after it.
    const obj: TrackedObject = { id: "o1", at: 1, box: { x: 0, y: 0, w: 0.1, h: 0.1 }, track };
    const mid = objectBoxAt(obj, 2.65)!, before = objectBoxAt(obj, 2.4)!, after = objectBoxAt(obj, 2.8)!;
    expect(mid[0]).toBeGreaterThan(Math.min(before[0], after[0]) - 1e-9);
    expect(mid[0]).toBeLessThan(Math.max(before[0], after[0]) + 1e-9);
  });
});

describe("track_object", () => {
  it("needs the server to track it", () => {
    expect(() => run(base(), { op: "track_object", clipId: "a", at: 1, box: { x: 0.35, y: 0.45, w: 0.1, h: 0.1 } } as Op)).toThrow(/apply_edits/);
  });
  it("stores the object on the clip and says where it was followed and lost", () => {
    const r = tracked();
    expect(r.summary).toMatch(/a: object o1 "ball" tracked over 1-5s \(38 boxes/);
    expect(r.summary).toMatch(/lost 2\.5-2\.8s/);
    const o = clipOf(r.snap, "a").objects![0];
    expect(o).toMatchObject({ id: "o1", label: "ball", at: 1, box: { x: 0.35, y: 0.45, w: 0.1, h: 0.1 }, lost: [[2.5, 2.8]] });
    expect(clipOf(r.snap, "b").objects).toBeUndefined();
  });
  it("an edit second (edit: true) is turned into the clip's footage second; a moment outside the clip is refused", () => {
    const r = run(base(), { op: "track_object", clipId: "b", at: 5, edit: true, box: { x: 0.35, y: 0.45, w: 0.1, h: 0.1 }, rows: rows.map((x) => [x[0] + 5, ...x.slice(1)] as typeof x) } as Op);
    expect(clipOf(r.snap, "b").objects![0].at).toBe(7);
    expect(() => run(base(), { op: "track_object", clipId: "a", at: 8, box: { x: 0.35, y: 0.45, w: 0.1, h: 0.1 }, rows } as Op)).toThrow(/outside a/);
  });
  it("nothing followed: says to draw the box round clear detail", () => {
    expect(() => run(base(), { op: "track_object", clipId: "a", at: 1, box: { x: 0.35, y: 0.45, w: 0.1, h: 0.1 }, rows: rows.map((x) => [...x.slice(0, 5), 0.1] as typeof x) } as Op)).toThrow(/could not follow/);
  });
});

describe("shapes that follow the object", () => {
  it("a blur with no box of its own: a box round the object at each moment", () => {
    const r = run(tracked().snap, { op: "set_effects", clipId: "a", effects: [{ type: "blur", amount: 60, area: { shape: "rect", follow: "object", object: "o1" } }] } as Op);
    const a = clipOf(r.snap, "a").effects![0].area!;
    expect(a).toMatchObject({ follow: "object", object: "o1", shape: "rect" });
    expect(a.keys!.length).toBeGreaterThan(4);
    expect(a.keys!.length).toBeLessThan(38);
    for (const t of [1.2, 1.9, 3.3, 4.6]) {
      const b = areaAt(a, t), want = cxAt(t), s = szAt(t) * 1.1;
      expect(Math.abs(b.x! + b.w! / 2 - want)).toBeLessThan(0.01);
      expect(Math.abs(b.w! - s)).toBeLessThan(0.006);
    }
  });
  it("a mask with its own box keeps its place and size against the object", () => {
    // Drawn above the ball at the moment it was drawn (footage 1 s: the ball is 0.35-0.45 across).
    const r = run(tracked().snap, { op: "set_masks", clipId: "a", masks: [{ shape: "ellipse", x: 0.35, y: 0.25, w: 0.1, h: 0.1, follow: "object", object: "o1" }] } as Op);
    const m = clipOf(r.snap, "a").masks![0];
    const b = areaAt(m, 3);
    expect(Math.abs(b.x! + b.w! / 2 - cxAt(3))).toBeLessThan(0.01);
    expect(b.y!).toBeLessThan(0.3);
  });
  it("an object the clip does not have is refused", () => {
    expect(() => run(tracked().snap, { op: "set_masks", clipId: "b", masks: [{ shape: "rect", follow: "object", object: "o1" }] } as Op)).toThrow(/no tracked object "o1"/);
    expect(() => run(base(), { op: "set_masks", clipId: "a", masks: [{ shape: "rect", x: 0, y: 0, w: 0.1, h: 0.1, follow: "object" }] } as Op)).toThrow(/object/);
  });
  it("tracking it again moves the shapes that follow it", () => {
    let s = run(tracked().snap, { op: "set_effects", clipId: "a", effects: [{ type: "pixelate", amount: 40, area: { shape: "rect", follow: "object", object: "o1" } }] } as Op).snap;
    const shifted = rows.map((x) => [x[0], r4(x[1] + 0.1), x[2], r4(x[3] + 0.1), x[4], 0.9] as typeof x);
    const r = run(s, { op: "track_object", clipId: "a", id: "o1", rows: shifted } as Op);
    expect(r.summary).toMatch(/tracked again.*1 shape follows it/);
    s = r.snap;
    const b = areaAt(clipOf(s, "a").effects![0].area!, 2);
    expect(Math.abs(b.x! + b.w! / 2 - (cxAt(2) + 0.1))).toBeLessThan(0.01);
  });
  it("taking the object off: the shapes keep its path as plain keyframes", () => {
    let s = run(tracked().snap, { op: "set_effects", clipId: "a", effects: [{ type: "blur", amount: 50, area: { shape: "rect", follow: "object", object: "o1" } }] } as Op).snap;
    const keys = clipOf(s, "a").effects![0].area!.keys;
    const r = run(s, { op: "track_object", clipId: "a", id: "o1", remove: true } as Op);
    expect(r.summary).toMatch(/object o1 taken off; 1 shape keeps its path/);
    s = r.snap;
    const a = clipOf(s, "a").effects![0].area!;
    expect(a.follow).toBeUndefined();
    expect(a.keys).toEqual(keys);
    expect(clipOf(s, "a").objects).toBeUndefined();
  });
  it("a look copied to a clip without the object: its shapes keep the path, not the link", () => {
    let s = run(tracked().snap, { op: "set_masks", clipId: "a", masks: [{ shape: "rect", follow: "object", object: "o1" }] } as Op).snap;
    s = run(s, { op: "copy_grade", from: "a", to: ["b"], with: ["masks"] } as Op).snap;
    expect(clipOf(s, "b").masks![0].follow).toBeUndefined();
    expect(clipOf(s, "b").masks![0].keys!.length).toBeGreaterThan(2);
    expect(clipOf(s, "a").masks![0].follow).toBe("object");
  });
  it("the render draws the shape from a moving look file over the clip's footage", () => {
    const s = run(tracked().snap, { op: "set_effects", clipId: "a", effects: [{ type: "blur", amount: 60, area: { shape: "rect", follow: "object", object: "o1" } }] } as Op).snap;
    const p = planRender({ kind: "preview", snapshot: s, transcript: [], source: { width: 1280, height: 720, fps: 30, seconds: 12, hasAudio: true }, videoId: "v" });
    const files = Object.values(p.lookFiles ?? {});
    expect(files.some((f) => f.kind === "moving" && f.from === 1 && f.to === 5)).toBe(true);
  });
});

describe("pin_layer", () => {
  const withText = () => run(tracked().snap, { op: "add_text", text: "BALL", start: 0.5, end: 3.5, edit: true, x: 0.5, y: 0.3, anim: "none" } as Op).snap;
  const textId = (s: Snapshot) => (s.timeline.tracks.v3 as V3Clip[]).find((c) => c.kind === "text")!.id;
  /** Where the pinned layer's keys put it at edit second e (its offset from where it is at its start). */
  const offsetAt = (s: Snapshot, id: string, e: number) => { const l = layerOf(s, id); return motionAt(keyTracks(l.keys as never), e - l.start); };
  it("the text moves with the object: its keys follow the object's centre, few of them", () => {
    let s = withText();
    const id = textId(s);
    const r = run(s, { op: "pin_layer", clipId: id, to: { clipId: "a", object: "o1" } } as Op);
    expect(r.summary).toMatch(/BALL|pinned to "ball" \(o1\) on a/);
    s = r.snap;
    const l = layerOf(s, id);
    expect(l.pin).toEqual({ clipId: "a", object: "o1" });
    expect(l.keys!.length).toBeGreaterThan(4);
    expect(l.keys!.length).toBeLessThanOrEqual(60);
    // Clip a plays footage 1-5 s at edit 0-4 s: edit e shows footage 1 + e.
    for (const e of [0.9, 1.7, 2.6, 3.4]) expect(Math.abs(offsetAt(s, id, e).x - (cxAt(1 + e) - cxAt(1.5)))).toBeLessThan(0.006);
    expect(offsetAt(s, id, 0.5).x).toBeCloseTo(0, 3);
  });
  it("scale: it grows with the object", () => {
    const s0 = withText(), id = textId(s0);
    const s = run(s0, { op: "pin_layer", clipId: id, to: { clipId: "a", object: "o1" }, scale: true } as Op).snap;
    expect(offsetAt(s, id, 3.4).scale).toBeCloseTo(szAt(4.4) / szAt(1.5), 1);
  });
  it("a framed clip: the object moves on screen by the framing's scale", () => {
    let s = withText();
    const id = textId(s);
    s = run(s, { op: "set_framing", clipIds: ["a"], scale: 2, x: 0, y: 0 } as Op, { op: "pin_layer", clipId: id, to: { clipId: "a", object: "o1" } } as Op).snap;
    expect(Math.abs(offsetAt(s, id, 2.6).x - 2 * (cxAt(3.6) - cxAt(1.5)))).toBeLessThan(0.012);
  });
  it("kept up to date: moving the layer later in the edit changes its keys", () => {
    let s = withText();
    const id = textId(s);
    s = run(s, { op: "pin_layer", clipId: id, to: { clipId: "a", object: "o1" } } as Op).snap;
    s = run(s, { op: "set_text", clipId: id, start: 1, end: 3.9, edit: true } as Op).snap;
    expect(layerOf(s, id).start).toBeCloseTo(1, 3);
    expect(offsetAt(s, id, 1).x).toBeCloseTo(0, 3);
    expect(Math.abs(offsetAt(s, id, 3).x - (cxAt(4) - cxAt(2)))).toBeLessThan(0.006);
  });
  it("past the end of its clip the layer holds where the object was last", () => {
    let s = run(tracked().snap, { op: "add_text", text: "LONG", start: 2, end: 6, edit: true, x: 0.5, y: 0.3, anim: "none" } as Op).snap;
    const id = textId(s);
    s = run(s, { op: "pin_layer", clipId: id, to: { clipId: "a", object: "o1" } } as Op).snap;
    expect(offsetAt(s, id, 5).x).toBeCloseTo(offsetAt(s, id, 4).x, 3);
  });
  it("on b-roll: the object's track is in the b-roll's footage seconds", () => {
    let s = run(base(), { op: "add_broll", videoId: "dog", start: 1, end: 4, sourceStart: 2, edit: true } as Op).snap;
    const bid = (s.timeline.tracks.v2 as { id: string }[])[0].id;
    // Over the b-roll's footage 2-5 s.
    const brows = rows.map((x) => [r4(x[0] + 1), ...x.slice(1)] as typeof x);
    s = run(s, { op: "track_object", clipId: bid, at: 2, box: { x: 0.35, y: 0.45, w: 0.1, h: 0.1 }, rows: brows } as Op).snap;
    s = run(s, { op: "add_text", text: "DOG", start: 1, end: 4, edit: true, x: 0.5, y: 0.3, anim: "none" } as Op).snap;
    const id = textId(s);
    s = run(s, { op: "pin_layer", clipId: id, to: { clipId: bid, object: "o1" } } as Op).snap;
    // Edit 3 s shows b-roll footage 4 s, which is the rows' 3 s.
    expect(Math.abs(offsetAt(s, id, 3).x - (cxAt(3) - cxAt(1)))).toBeLessThan(0.006);
  });
  it("taking the object off unpins the layer (its keys stay); off removes the pin and its keys", () => {
    let s = withText();
    const id = textId(s);
    s = run(s, { op: "pin_layer", clipId: id, to: { clipId: "a", object: "o1" } } as Op).snap;
    const r = run(s, { op: "track_object", clipId: "a", id: "o1", remove: true } as Op);
    expect(r.summary).toMatch(/BALL no longer pinned/);
    expect(layerOf(r.snap, id).pin).toBeUndefined();
    expect(layerOf(r.snap, id).keys!.length).toBeGreaterThan(2);
    s = run(s, { op: "pin_layer", clipId: id, off: true } as Op).snap;
    expect(layerOf(s, id).pin).toBeUndefined();
    expect(layerOf(s, id).keys).toBeUndefined();
  });
  it("refuses captions and adjustment layers, and an object that is not there", () => {
    let s = withText();
    s = run(s, { op: "adjustment_layer", start: 0, end: 2, edit: true, effects: [{ type: "blur", amount: 10 }] } as Op).snap;
    const adj = (s.timeline.tracks.v3 as V3Clip[]).find((c) => c.kind === "adjust")!.id;
    expect(() => run(s, { op: "pin_layer", clipId: adj, to: { clipId: "a", object: "o1" } } as Op)).toThrow(/adjustment layer/);
    expect(() => run(s, { op: "pin_layer", clipId: textId(s), to: { clipId: "a", object: "o9" } } as Op)).toThrow(/no tracked object "o9"/);
    expect(() => run(s, { op: "pin_layer", clipId: textId(s) } as Op)).toThrow(/to \{clipId, object\}/);
  });
});

describe("naming an object", () => {
  it("id and label alone rename it; the track is kept", () => {
    const s = tracked().snap;
    const r = run(s, { op: "track_object", clipId: "a", id: "o1", label: "red ball" } as Op);
    expect(r.summary).toMatch(/object o1 named "red ball"/);
    expect(clipOf(r.snap, "a").objects![0]).toMatchObject({ label: "red ball", lost: [[2.5, 2.8]] });
    expect(clipOf(r.snap, "a").objects![0].track).toEqual(clipOf(s, "a").objects![0].track);
  });
});

describe("what get_project says", () => {
  it("lists the clip's tracked objects, shapes that follow one, and pinned layers", async () => {
    const { summarizeTimeline } = await import("../src/index");
    let s = run(tracked().snap, { op: "set_effects", clipId: "a", effects: [{ type: "blur", amount: 50, area: { shape: "rect", follow: "object", object: "o1" } }] } as Op).snap;
    s = run(s, { op: "add_text", text: "BALL", start: 0.5, end: 3, edit: true, anim: "none" } as Op).snap;
    const id = (s.timeline.tracks.v3 as V3Clip[]).find((c) => c.kind === "text")!.id;
    s = run(s, { op: "pin_layer", clipId: id, to: { clipId: "a", object: "o1" }, scale: true } as Op).snap;
    const text = summarizeTimeline(s, []);
    expect(text).toMatch(/tracked o1 "ball" 1-5s \(lost 2\.5-2\.8s\) on a/);
    expect(text).toMatch(/following object o1 \(\d+ keys\)/);
    expect(text).toMatch(/pinned to o1 on a \(scaling\)/);
  });
});
