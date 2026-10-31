// Premiere parity, phase 17: a text layer's anchor (a point of its text it turns and scales about) and motion blur on
// its keyed movement; a border on b-roll cards. The anchor's arithmetic (textLookAt), the ASS pieces, the plan (blurred
// text drawn on its own, the b-roll border's picture), the graph and the player's frame.
import { describe, expect, it } from "vitest";
import { applyOp, buildInitialTimeline, liveFrame, textLookAt, textPieces, textRect, textPreset, type EditContext, type Op, type Snapshot, type TextLayer } from "../src/index";
import { ffmpegArgs, planRender, type PlanFiles } from "../src/renderPlan";

const SEC = 10;
const ctx: EditContext = { videoId: "v", transcript: [], silences: [], sceneCuts: [], duration: SEC, getStyle: () => undefined,
  getVideo: (id) => (id === "orange" ? { id, name: "orange", seconds: 4, ready: true } : undefined) };
const base = (): Snapshot => applyOp({ timeline: buildInitialTimeline([], SEC, "clean", [], "v"), name: "t", aspect: "16:9", styleId: "s2" }, { op: "batch", ops: [{ op: "set_captions", on: false }] } as never, ctx).snap;
const run = (s: Snapshot, ...ops: Op[]) => applyOp(s, (ops.length === 1 ? ops[0] : { op: "batch", ops }) as never, ctx);
const source = { width: 1280, height: 720, fps: 30, seconds: SEC, hasAudio: true };
const W = 960, H = 540;
const plan = (s: Snapshot) => planRender({ kind: "preview", snapshot: s, transcript: [], source, videoId: "v", brollSeconds: { orange: 4 } });
const graph = (s: Snapshot) => {
  const p = plan(s);
  const looks = Object.fromEntries(Object.keys(p.lookFiles ?? {}).map((n) => [n, `/tmp/${n}`]));
  const textBlurs = Object.fromEntries((p.textBlurs ?? []).map((b) => [b.clipId, `/tmp/blur-${b.clipId}.ass`]));
  const broll = Object.fromEntries(p.broll.map((b) => [b.clipId, "/tmp/orange.mp4"]));
  return { p, g: ffmpegArgs(p, { source: "/in.mp4", output: "/o.mp4", looks, assPath: "/c.ass", textBlurs, broll } as PlanFiles, source, { loudnessGainDb: 0 }).filterGraph };
};
const layer = (over: Partial<TextLayer> = {}): TextLayer => ({ clipId: "t", start: 0, end: 4, lines: ["HELLO"], style: { ...textPreset("title").style, x: 0.5, y: 0.5, align: "center" }, card: null, anim: "none", ...over });

describe("a text layer's anchor", () => {
  it("without one it turns about its alignment point, as before", () => {
    const t = layer({ keys: [{ t: 0, rotation: 0 }, { t: 1, rotation: 90 }] });
    const l = textLookAt(t, 1, W, H);
    expect(l.x).toBeCloseTo(480, 6); expect(l.y).toBeCloseTo(270, 6); expect(l.rotation).toBe(90);
  });
  it("an anchor at its left edge's middle: turned a quarter clockwise, its middle swings below that point", () => {
    const t = layer({ keys: [{ t: 0, rotation: 0 }, { t: 1, rotation: 90 }], anchor: { x: 0, y: 0.5 } });
    const r = textRect(t, W, H), ax = r.x, ay = r.y + r.h / 2;
    const at0 = textLookAt(t, 0, W, H);
    expect(at0.x).toBeCloseTo(480, 6); expect(at0.y).toBeCloseTo(270, 6);
    const l = textLookAt(t, 1, W, H);
    expect(l.x).toBeCloseTo(ax, 6);
    expect(l.y).toBeCloseTo(ay + r.w / 2, 6);
  });
  it("scaling about its top left corner keeps that corner in place; the position keys move the anchor", () => {
    const t = layer({ keys: [{ t: 0, scale: 1, x: 0 }, { t: 1, scale: 2, x: 0.1 }], anchor: { x: 0, y: 0 } });
    const r = textRect(t, W, H), l = textLookAt(t, 1, W, H);
    // The middle (alignment point) at the corner + 2 x (half the box) + the move.
    expect(l.x).toBeCloseTo(r.x + 2 * (r.w / 2) + 0.1 * W, 6);
    expect(l.y).toBeCloseTo(r.y + 2 * (r.h / 2), 6);
    expect(l.scale).toBe(2);
  });
  it("an anchor at the alignment point is the same as none", () => {
    const keys = [{ t: 0, rotation: 0, scale: 1 }, { t: 2, rotation: 45, scale: 1.5 }];
    const left = { ...textPreset("title").style, x: 0.2, y: 0.4, align: "left" as const };
    const a = textLookAt(layer({ keys, style: left }), 1.3, W, H), b = textLookAt(layer({ keys, style: left, anchor: { x: 0, y: 0.5 } }), 1.3, W, H);
    expect(b.x).toBeCloseTo(a.x, 6); expect(b.y).toBeCloseTo(a.y, 6);
  });
  it("turning about an anchor is drawn in pieces every 0.05 s (an arc); without turning or scaling the pieces stay at the keys", () => {
    expect(textPieces(layer({ keys: [{ t: 0, rotation: 0 }, { t: 1, rotation: 90 }], anchor: { x: 0, y: 0 } })).length).toBeGreaterThan(70);
    expect(textPieces(layer({ keys: [{ t: 0, x: 0 }, { t: 1, x: 0.2 }], anchor: { x: 0, y: 0 } }))).toEqual([0, 1, 4]);
  });
  it("set_keyframes on a text layer stores it; the plan and the player's frame use it", () => {
    let s = run(base(), { op: "add_text", text: "HELLO", start: 1, end: 5, edit: true, x: 0.5, y: 0.5, anim: "none" } as Op).snap;
    const id = (s.timeline.tracks.v3 as { id: string; kind?: string }[]).find((c) => c.kind === "text")!.id;
    const r = run(s, { op: "set_keyframes", track: "v3", clipId: id, keys: [{ t: 0, rotation: 0 }, { t: 1, rotation: 90 }], anchor: { x: 0, y: 0.5 }, motionBlur: 0 } as Op);
    expect(r.summary).toMatch(/anchor 0, 0\.5/);
    s = r.snap;
    const p = plan(s), t = p.texts!.find((x) => x.clipId === id)!;
    expect(t.anchor).toEqual({ x: 0, y: 0.5 });
    const f = liveFrame(p, 2.5)!, look = f.texts[0].look!;
    const want = textLookAt(t, 1.5, p.width, p.height);
    expect(look.x).toBeCloseTo(want.x, 6); expect(look.y).toBeCloseTo(want.y, 6);
    // The ASS file draws the same point (the pieces' \move ends).
    expect(p.ass).toMatch(new RegExp(`\\\\move\\([\\d.]+,[\\d.]+,${want.x.toFixed(1).replace(".", "\\.").replace(/\.0$/, "")}`));
  });
});

describe("motion blur on a text layer", () => {
  const blurred = () => {
    let s = run(base(), { op: "add_text", text: "FAST", start: 1, end: 3, edit: true, x: 0.5, y: 0.5, anim: "none" } as Op).snap;
    const id = (s.timeline.tracks.v3 as { id: string; kind?: string }[]).find((c) => c.kind === "text")!.id;
    s = run(s, { op: "set_keyframes", track: "v3", clipId: id, keys: [{ t: 0, x: -0.4 }, { t: 1, x: 0.4 }], motionBlur: 50 } as Op).snap;
    return { s, id };
  };
  it("is drawn on its own (not in the captions' file), blurred over four sub-frames, at its time", () => {
    const { s, id } = blurred();
    const { p, g } = graph(s);
    expect(p.textBlurs).toHaveLength(1);
    expect(p.textBlurs![0]).toMatchObject({ clipId: id, start: 1, end: 3, blur: 50, behind: false });
    expect(p.textBlurs![0].ass).toMatch(/Dialogue: 1,0:00:00\.00,/);
    expect(p.ass ?? "").not.toContain("FAST");
    expect(p.operations.join("\n")).toMatch(new RegExp(`Motion blur: ${id} 50`));
    expect(g).toMatch(/color=c=black@0:s=960x540:r=120:d=[\d.]+,format=yuva420p,ass=filename='\/tmp\/blur-[\w]+\.ass':alpha=1,format=yuva444p,premultiply=inplace=1,tmix=frames=2,unpremultiply=inplace=1,fps=30,trim=end_frame=60,format=yuva420p,setpts=PTS-STARTPTS\+1\.000\/TB\[tbl0\]/);
    expect(g).toMatch(/overlay=enable='between\(t,1\.000000,2\.983333\)':eof_action=pass\[vtbl0\]/);
  });
  it("without keys, or at 0, it is drawn with the other text as before", () => {
    const { s, id } = blurred();
    const off = run(s, { op: "set_keyframes", track: "v3", clipId: id, motionBlur: 0 } as Op).snap;
    expect(plan(off).textBlurs).toBeUndefined();
    expect(plan(off).ass).toContain("FAST");
  });
});

describe("a border on b-roll cards", () => {
  const card = () => {
    const s = run(base(), { op: "add_broll", videoId: "orange", start: 2, end: 5, sourceStart: 0, edit: true } as Op).snap;
    const id = (s.timeline.tracks.v2 as { id: string }[])[0].id;
    const r = run(s, { op: "set_card", clipIds: [id], crop: { left: 0.25, right: 0.25, top: 0.1, bottom: 0.1 }, radius: 0.1, border: { color: "#FFFFFF", width: 0.02 } } as Op);
    return { r, id };
  };
  it("set_card takes a border for b-roll; the plan has its picture on the clip's own frame", () => {
    const { r, id } = card();
    expect(r.summary).toMatch(/drawn as a card over the picture: .*border #FFFFFF 2%/);
    const p = plan(r.snap), b = p.broll.find((x) => x.clipId === id)!;
    expect(b.border?.color).toBe("#FFFFFF");
    expect(p.lookFiles![b.border!.file]).toMatchObject({ kind: "border", framing: null });
  });
  it("the graph lays the border on the picture before its keys move it; the player's frame has it", () => {
    const { r, id } = card();
    const s = run(r.snap, { op: "set_keyframes", track: "v2", clipId: id, keys: [{ t: 0, scale: 0.5 }, { t: 2, scale: 0.8 }] } as Op).snap;
    const { p, g } = graph(s);
    expect(g).toMatch(/\[bdc0\]\[bda0\]alphamerge\[bdf0\]/);
    expect(g).toMatch(/\[bdb0\]\[bdf0\]overlay=format=auto,format=yuva420p\[bdo0\]/);
    expect(g.indexOf("[bdo0]")).toBeLessThan(g.indexOf("perspective="));
    expect(liveFrame(p, 3)!.broll!.border).toEqual(p.broll[0].border);
  });
});
