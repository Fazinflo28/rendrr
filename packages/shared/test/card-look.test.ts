// A clip drawn as a card on a background (for layouts like a talking head in a rounded card on a gradient): the edits
// (set_card, set_background), what the render plan makes of them (a mask, shadow and border pictures, the background),
// the pictures themselves (the ones the render reads as files and the player draws), and get_project's text.
import { describe, expect, it } from "vitest";
import {
  applyOp, areaCoverage, buildInitialTimeline, cardBorderPicture, cardMask, cardScreenBox, cardShadowPicture, gradientPicture, masksWithCard, ppm, summarizeTimeline,
  type CardLook, type EditContext, type Op, type Snapshot,
} from "../src/index";
import { planRender } from "../src/renderPlan";

const SEC = 10;
const ctx: EditContext = { videoId: "v", transcript: [], silences: [], sceneCuts: [], duration: SEC, getStyle: () => undefined,
  getVideo: (id) => (id === "loop" ? { id, name: "Loop", seconds: 4, ready: true } : id === "busy" ? { id, name: "Busy", seconds: 4, ready: false } : undefined) };
const start = (): Snapshot => applyOp({ timeline: buildInitialTimeline([], SEC, "clean", [], "v"), name: "e", aspect: "16:9", styleId: "s2" }, { op: "batch", ops: [{ op: "set_captions", on: false }, { op: "set_aspect", aspect: "9:16" }] } as never, ctx).snap;
const run = (s: Snapshot, ...ops: Op[]) => applyOp(s, (ops.length === 1 ? ops[0] : { op: "batch", ops }) as never, ctx);
const v1 = (s: Snapshot) => s.timeline.tracks.v1 as unknown as { id: string; cardLook?: CardLook; masks?: unknown[] }[];
const source = { width: 640, height: 360, fps: 30, seconds: SEC, hasAudio: false };

describe("set_card and set_background", () => {
  it("set_card sets fields, keeps the others, null removes one, reset starts over", () => {
    let s = run(start(), { op: "set_card", radius: 0.1, shadow: {} } as Op).snap;
    expect(v1(s)[0].cardLook).toEqual({ radius: 0.1, shadow: {} });
    const r = run(s, { op: "set_card", border: { color: "#FFFFFF", width: 0.01 }, crop: { left: 0.2 } } as Op);
    expect(r.summary).toMatch(/^the footage drawn as a card: cropped to 80%x100% at 20%,0%, corners 10%, shadow #000000 35% blur 3% offset 0%,1\.2%, border #FFFFFF 1% \(set_framing scale under 1 shows it as a card on the background\)$/);
    s = run(r.snap, { op: "set_card", shadow: null } as Op).snap;
    expect(v1(s)[0].cardLook).toEqual({ radius: 0.1, border: { color: "#FFFFFF", width: 0.01 }, crop: { left: 0.2 } });
    s = run(s, { op: "set_card", reset: true, radius: 0.05 } as Op).snap;
    expect(v1(s)[0].cardLook).toEqual({ radius: 0.05 });
    s = run(s, { op: "set_card", radius: 0 } as Op).snap;
    expect(v1(s)[0].cardLook).toBeUndefined();
    expect(() => run(s, { op: "set_card" } as Op)).toThrow(/needs crop, radius, shadow, border or reset/);
    expect(() => run(s, { op: "set_card", radius: 0.7 } as Op)).toThrow();
  });
  it("set_background: one of colour, gradient, a ready library video or blur; none goes back to black", () => {
    const s = start();
    expect(run(s, { op: "set_background", color: "#ff66aa" } as Op).snap.timeline.background).toEqual({ color: "#FF66AA" });
    const g = run(s, { op: "set_background", gradient: { from: "#FF66AA", to: "#FFFFFF", angle: 160 } } as Op);
    expect(g.summary).toBe("background: gradient #FF66AA to #FFFFFF at 160° (it shows where V1 is framed smaller, cropped, rounded, keyed, masked or has its background removed)");
    expect(run(s, { op: "set_background", videoId: "loop" } as Op).summary).toMatch(/^background: video loop "Loop" \(looped\)/);
    expect(() => run(s, { op: "set_background", videoId: "nope" } as Op)).toThrow(/not in your library/);
    expect(() => run(s, { op: "set_background", videoId: "busy" } as Op)).toThrow(/not ready yet/);
    expect(() => run(s, { op: "set_background", color: "#000000", blur: 20 } as Op)).toThrow(/one of color, gradient, videoId/);
    expect(() => run(s, { op: "set_background" } as Op)).toThrow(/one of color, gradient, videoId/);
    const b = run(s, { op: "set_background", blur: 40 } as Op).snap;
    expect(run(b, { op: "set_background", none: true } as Op).snap.timeline.background).toBeUndefined();
  });
  it("get_project names the card and the background", () => {
    const s = run(start(), { op: "set_framing", scale: 0.6, y: 0.15 } as Op, { op: "set_card", radius: 0.1, shadow: {} } as Op, { op: "set_background", gradient: { from: "#FF66AA", to: "#FFFFFF" } } as Op).snap;
    const text = summarizeTimeline(s, [], 60, "v");
    expect(text).toMatch(/look: card/);
    expect(text).toMatch(/card corners 10%, shadow #000000 35% blur 3% offset 0%,1\.2% on /);
    expect(text).toMatch(/behind V1: gradient #FF66AA to #FFFFFF at 180°/);
  });
});

describe("the render plan", () => {
  it("crop and corners join the clip's masks; shadow and border are pictures in the framed place; the background is planned", () => {
    let s = run(start(), { op: "set_masks", all: true, masks: [{ shape: "ellipse", x: 0, y: 0, w: 1, h: 1 }] } as Op,
      { op: "set_framing", scale: 0.6, y: 0.15 } as Op, { op: "set_card", radius: 0.1, crop: { bottom: 0.2 }, shadow: { color: "#330022" }, border: { color: "#FFFFFF", width: 0.01 } } as Op,
      { op: "set_background", color: "#FF66AA" } as Op).snap;
    let plan = planRender({ kind: "preview", snapshot: s, transcript: [], source, videoId: "v" });
    const id = v1(s)[0].id, look = plan.looks![id];
    expect(look.masks).toEqual([{ shape: "ellipse", x: 0, y: 0, w: 1, h: 1 }, { shape: "rect", x: 0, y: 0, w: 1, h: 0.8, radius: 0.1, mode: "intersect" }]);
    expect(look.alpha).toBe(true);
    const card = plan.cards![id];
    expect(card.shadow!.color).toBe("#330022");
    expect(plan.lookFiles![card.shadow!.file]).toMatchObject({ kind: "shadow", framing: { scale: 0.6, x: 0, y: 0.15 } });
    expect(card.border!.file).toMatch(/^border_\w+\.pgm$/);
    // A colour is a gradient from it to itself (the same picture path as a gradient).
    expect(plan.lookFiles![plan.background!.file!]).toEqual({ kind: "gradient", gradient: { from: "#FF66AA", to: "#FF66AA" } });
    expect(plan.operations).toEqual(expect.arrayContaining([expect.stringMatching(/^Cards: \S+ cropped to 100%x80% at 0%,0%, corners 10%, shadow #330022/), "Behind V1: #FF66AA"]));
    // A library video needs its length (else black, said); blur is a sigma at the output size and the scale that
    // keeps its soft edges outside the frame.
    s = run(s, { op: "set_background", videoId: "loop" } as Op).snap;
    expect(planRender({ kind: "preview", snapshot: s, transcript: [], source, videoId: "v", brollSeconds: { loop: 4 } }).background).toMatchObject({ videoId: "loop", seconds: 4 });
    plan = planRender({ kind: "preview", snapshot: s, transcript: [], source, videoId: "v" });
    expect(plan.background).toBeUndefined();
    expect(plan.operations).toContain("Behind V1: the background video is not in the library or not ready: black instead");
    s = run(s, { op: "set_background", blur: 50 } as Op).snap;
    plan = planRender({ kind: "preview", snapshot: s, transcript: [], source, videoId: "v" });
    expect(plan.background).toMatchObject({ blur: 10.8, scale: 1.12 });
  });
  it("clips with different cards stay separate parts (each drawn with its own)", () => {
    const s0 = run(start(), { op: "set_clips", track: "v1", clips: [{ id: "a", start: 0, end: 5, label: "" }, { id: "b", start: 5, end: 10, label: "" }] } as Op).snap;
    expect(planRender({ kind: "preview", snapshot: s0, transcript: [], source, videoId: "v" }).parts.length).toBe(1);
    const s = run(s0, { op: "set_card", clipIds: ["b"], radius: 0.2 } as Op).snap;
    expect(planRender({ kind: "preview", snapshot: s, transcript: [], source, videoId: "v" }).parts.map((p) => p.clipIds)).toEqual([["a"], ["b"]]);
  });
});

describe("the pictures", () => {
  const W = 200, H = 400;
  const card: CardLook = { radius: 0.2, shadow: { opacity: 1, blur: 0, y: 0.05 }, border: { color: "#FFFFFF", width: 0.02 } };
  const f = { scale: 0.5, x: 0, y: 0 };
  it("the card's place on screen follows the render's framing maths", () => {
    expect(cardScreenBox(card, f, W, H)).toEqual({ x: 50, y: 100, w: 100, h: 200 });
    expect(cardScreenBox({ crop: { left: 0.1, top: 0.25 } }, f, W, H)).toEqual({ x: 60, y: 150, w: 90, h: 150 });
  });
  it("rounded corners: the corner of the box is outside, its middle inside", () => {
    const m = cardMask(card)!;
    expect(m).toEqual({ shape: "rect", x: 0, y: 0, w: 1, h: 1, radius: 0.2 });
    const cov = areaCoverage(m, W, H);
    expect(cov[0]).toBe(0);
    expect(cov[2 * W + 100]).toBe(1); // the top edge's middle
    expect(masksWithCard(undefined, { shadow: {} })).toBeUndefined();
  });
  it("the shadow is the card's shape moved by its offset; the border a ring just inside the edge", () => {
    const sh = cardShadowPicture(card, f, W, H), bd = cardBorderPicture(card, f, W, H);
    const S = Math.min(W, H), dy = 0.05 * S; // 10 px down
    expect(sh[(100 + dy - 2) * W + 100]).toBe(0); // above the moved shape
    expect(sh[(100 + dy + 2) * W + 100]).toBe(255);
    expect(sh[(300 + dy - 2) * W + 100]).toBe(255); // the shadow reaches 10 px below the card
    expect(bd[101 * W + 100]).toBe(255); // on the top edge, inside
    expect(bd[200 * W + 100]).toBe(0); // the middle
    expect(bd[99 * W + 100]).toBe(0); // outside
  });
  it("the gradient runs as CSS does (180: top to bottom, 90: left to right), and goes out as a PPM", () => {
    const g = gradientPicture({ from: "#000000", to: "#FFFFFF" }, 4, 4);
    expect([g[0], g[(3 * 4) * 3]]).toEqual([32, 223]); // top row, bottom row
    const h = gradientPicture({ from: "#000000", to: "#FFFFFF", angle: 90 }, 4, 4);
    expect([h[0], h[3 * 3]]).toEqual([32, 223]); // left column, right column
    expect(new TextDecoder().decode(ppm(g, 4, 4).subarray(0, 11))).toBe("P6\n4 4\n255\n");
  });
});
