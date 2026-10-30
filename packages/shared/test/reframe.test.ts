// Shapes and reframing: 4:5 sizes, where the fit cuts footage of another shape (a framing's focus), the speaker's face
// from the 10 fps face tracks, set_framing focus, and the render's crop.
import { describe, expect, it } from "vitest";
import { applyOp, aspectSize, ASPECTS, boxOnScreen, buildInitialTimeline, buildTranscript, fitCrop, plainFraming, speakerCentre, type EditContext, type Op, type Snapshot, type VisionDetails } from "../src/index";
import { ffmpegArgs, outputSize, planRender } from "../src/renderPlan";

const WORDS = Array.from({ length: 40 }, (_, i) => `w${i}`);
const tr = buildTranscript([WORDS.map((text, i) => ({ text, start: 0.5 + i * 0.5, end: 0.9 + i * 0.5 }))], { maxWordsPerLine: 8 }).map((l) => ({ ...l, words: l.words.map((w) => ({ ...w, filler: false })) }));
const ctx = { videoId: "v", transcript: tr, silences: [], sceneCuts: [], duration: 30, getStyle: () => undefined, getVideo: () => undefined, getGraphic: () => undefined } as unknown as EditContext;
const base = (aspect: Snapshot["aspect"] = "9:16"): Snapshot => ({ timeline: buildInitialTimeline(tr, 30, "clean", [], "v"), name: "t", aspect, styleId: null });
const edit = (s: Snapshot, op: Op) => applyOp(s, op, ctx);
const two = (aspect: Snapshot["aspect"] = "9:16") => edit(base(aspect), { op: "set_clips", track: "v1", clips: [{ id: "a", start: 1, end: 5, label: "" }, { id: "b", start: 6, end: 10, label: "" }] } as Op).snap;
const framingOf = (s: Snapshot, id: string) => (s.timeline.tracks.v1 as unknown as { id: string; framing?: { scale: number; x: number; y: number; focus?: { x: number; y: number } } }[]).find((c) => c.id === id)!.framing;
const SRC = { width: 1920, height: 1080, fps: 30, seconds: 30, hasAudio: true };

describe("shapes", () => {
  it("has 4:5, sized like Instagram's portrait post", () => {
    expect(ASPECTS).toContain("4:5");
    expect(outputSize("4:5", "final")).toEqual({ width: 1080, height: 1350 });
    expect(outputSize("4:5", "preview")).toEqual({ width: 540, height: 676 });
    // The others did not move.
    expect(outputSize("16:9", "final")).toEqual({ width: 1920, height: 1080 });
    expect(outputSize("9:16", "final", "4k")).toEqual({ width: 2160, height: 3840 });
    expect(outputSize("1:1", "preview")).toEqual({ width: 540, height: 540 });
    expect(aspectSize("9:16", 36)).toEqual({ width: 36, height: 64 });
  });
});

describe("fitCrop", () => {
  it("cuts the middle across and 40% down without a focus, and around the focus as near as the edges allow", () => {
    expect(fitCrop(null, 1920, 1080, 1080, 1920)).toEqual({ cx: 0.5, cy: 0.4 });
    // 16:9 into 9:16: the picture is 3413 wide at 1920 high; a face at 30% across is kept in the middle.
    const c = fitCrop({ x: 0.3, y: 0.5 }, 1920, 1080, 1080, 1920);
    const sw = 1920 * (1920 / 1080);
    expect((0.3 * sw - c.cx * (sw - 1080)) / 1080).toBeCloseTo(0.5, 6);
    expect(c.cy).toBe(0.4); // no spare height: as before
    // Near the edge it stops at the edge.
    expect(fitCrop({ x: 0.02, y: 0.5 }, 1920, 1080, 1080, 1920).cx).toBe(0);
    expect(fitCrop({ x: 0.99, y: 0.5 }, 1920, 1080, 1080, 1920).cx).toBe(1);
    // Vertical footage in a 16:9 frame: the focus moves the cut up and down.
    const v = fitCrop({ x: 0.5, y: 0.3 }, 1080, 1920, 1920, 1080);
    expect(v.cx).toBe(0.5);
    const sh = 1920 * (1920 / 1080);
    expect((0.3 * sh - v.cy * (sh - 1080)) / 1080).toBeCloseTo(0.4, 6);
  });
});

describe("speakerCentre", () => {
  // Two faces on screen for 2 s at 10 fps: the left one still, the right one talking (its mouth opens and shuts).
  const frames: VisionDetails["frames"] = Array.from({ length: 20 }, (_, i) => [1 + i / 10, [
    [1, 0.15, 0.3, 0.12, 0.22, 0.9, 0.05, 0, 0, 0],
    [2, 0.68, 0.32, 0.1, 0.18, 0.9, i % 2 ? 0.6 : 0.1, 0, 0, 0],
  ]]) as VisionDetails["frames"];
  it("finds the face that talks, its centre over the stretch", () => {
    const c = speakerCentre({ frames }, 0, 0, 1, 3)!;
    expect(c.x).toBeCloseTo(0.73, 3);
    expect(c.y).toBeCloseTo(0.41, 3);
    expect(c.seen).toBe(1);
  });
  it("takes the biggest face when there are no mouth readings, follows the turn, and is null without faces", () => {
    const still = frames.map(([t, fs]) => [t, fs.map((f) => [...f.slice(0, 6), null, null, null, null])]) as VisionDetails["frames"];
    expect(speakerCentre({ frames: still }, 0, 0, 1, 3)!.x).toBeCloseTo(0.21, 3);
    // Measured as filmed, drawn turned 90° clockwise: (u, v) -> (1 - v, u).
    const t = speakerCentre({ frames }, 0, 90, 1, 3)!;
    expect(t.x).toBeCloseTo(1 - 0.41, 3);
    expect(t.y).toBeCloseTo(0.73, 3);
    expect(speakerCentre({ frames }, 0, 0, 10, 12)).toBeNull();
  });
});

describe("set_framing focus", () => {
  it("reframes each clip on its measured face, keeps clips with none as they were, and says so", () => {
    const r = edit(two(), { op: "set_framing", focus: "face", centers: { a: { x: 0.3, y: 0.42 }, b: null } } as Op);
    expect(framingOf(r.snap, "a")).toEqual({ scale: 1, x: 0, y: 0, focus: { x: 0.3, y: 0.42 } });
    expect(framingOf(r.snap, "b")).toBeUndefined();
    expect(r.summary).toBe("reframed the footage on the speaker's face (1 of 2); no face found in b: its fit stays as it was");
  });
  it("says when clips were made in the same call (not measured yet)", () => {
    const r = edit(two(), { op: "set_framing", focus: "face", centers: { a: { x: 0.3, y: 0.42 } } } as Op);
    expect(r.summary).toBe('reframed the footage on the speaker\'s face (1 of 2); b made in this same call: send focus "face" again in the next apply_edits to reframe it');
  });
  it("takes a point by hand, keeps scale and offset, null goes back to the middle", () => {
    let s = edit(two(), { op: "set_framing", scale: 1.2, clipIds: ["a"] } as Op).snap;
    s = edit(s, { op: "set_framing", focus: { x: 0.7, y: 0.4 }, clipIds: ["a"] } as Op).snap;
    expect(framingOf(s, "a")).toEqual({ scale: 1.2, x: 0, y: 0, focus: { x: 0.7, y: 0.4 } });
    s = edit(s, { op: "set_framing", focus: null, clipIds: ["a"] } as Op).snap;
    expect(framingOf(s, "a")).toEqual({ scale: 1.2, x: 0, y: 0 });
    expect(plainFraming({ scale: 1, x: 0, y: 0, focus: { x: 0.5, y: 0.4 } })).not.toBeNull();
  });
  it("needs the faces measured, and is not mixed with fitFaceTo", () => {
    expect(() => edit(two(), { op: "set_framing", focus: "face" } as Op)).toThrow(/needs the faces measured/);
    expect(() => edit(two(), { op: "set_framing", focus: { x: 0.5, y: 0.5 }, fitFaceTo: { x: 0.5, y: 0.4, r: 0.1 }, faces: {} } as Op)).toThrow(/two apply_edits/);
  });
  it("a fitFaceTo after a reframe keeps the focus", () => {
    const s = edit(two(), { op: "set_framing", focus: { x: 0.3, y: 0.4 } } as Op).snap;
    const r = edit(s, { op: "set_framing", fitFaceTo: { x: 0.5, y: 0.4, r: 0.2 }, faces: { a: { u: 0.5, v: 0.4, r: 0.1 }, b: null } } as Op);
    expect(framingOf(r.snap, "a")!.focus).toEqual({ x: 0.3, y: 0.4 });
  });
});

describe("the render of a reframed clip", () => {
  it("cuts the fit around the focus (no extra scale step for a focus alone), and the face lands where the editor shows it", () => {
    const s = edit(two(), { op: "set_framing", focus: { x: 0.3, y: 0.45 }, clipIds: ["a"] } as Op).snap;
    const p = planRender({ kind: "preview", snapshot: s, transcript: tr, source: SRC, videoId: "v" });
    expect(p.width).toBe(540);
    const g = ffmpegArgs(p, { source: "/in.mp4", output: "/o.mp4", assPath: "/c.ass" }, SRC, { loudnessGainDb: 0 }).filterGraph;
    expect(g).toContain("crop=540:960:x='clip(0.300*iw-ow/2,0,iw-ow)':y='clip(0.450*ih-oh*0.4,0,ih-oh)'");
    expect(g).toContain("crop=540:960:(iw-ow)/2:(ih-oh)*0.4"); // clip b: the middle, as before
    expect(g).not.toMatch(/fscaled/); // only the fit moved
    // The face at 30% across lands in the middle of the 9:16 frame.
    const box = boxOnScreen([0.28, 0.4, 0.04, 0.1], 0, [1920, 1080], 540, 960, { rotate: 0, framing: { scale: 1, x: 0, y: 0, focus: { x: 0.3, y: 0.45 } } })!;
    expect((box[0] + box[2]) / 2).toBeCloseTo(0.5, 2);
  });
  it("a 4:5 edit renders 4:5", () => {
    const s = edit(two("4:5"), { op: "set_framing", focus: { x: 0.6, y: 0.4 } } as Op).snap;
    const p = planRender({ kind: "final", snapshot: s, transcript: tr, source: SRC, videoId: "v" });
    expect([p.width, p.height]).toEqual([1080, 1350]);
    const g = ffmpegArgs(p, { source: "/in.mp4", output: "/o.mp4", assPath: "/c.ass" }, SRC, { loudnessGainDb: 0 }).filterGraph;
    expect(g).toContain("crop=1080:1350:x='clip(0.600*iw-ow/2,0,iw-ow)'");
  });
});
