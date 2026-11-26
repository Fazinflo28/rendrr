// analyze_reference, part 2: the map of a reference (no video): scenes and their kinds, b-roll in a talking head
// video, camera moves and animations with their easing, music and sound effects in words, one timeline, the frames to
// look at, what a new video needs, the plain words for the user and the AI's notes.
import { describe, expect, it } from "vitest";
import { buildStyleFile, plainWords, styleFileText, type ReferenceMap, type ReferenceMeasure } from "../src";

const measure: ReferenceMeasure = { v: 1, size: [360, 640], texts: [], transitions: [[0.9, "flash", 100], [4, "cut", 0]], grade: [[0, 0.5, 0.2, 0.3, 0, 0]], sound: null };
const scene = (start: number, end: number, kind: string) => ({ start, end, kind, flat: 0.1, noise: 3, colourful: 0.2, light: 0.5, split: null, colours: [["#112233", 0.6], ["#FFFFFF", 0.3]] as [string, number][] });
const map: ReferenceMap = {
  v: 1, fps: 12, size: [240, 426], cuts: [2, 4, 6],
  moves: [{ start: 6.2, end: 7.4, ms: 1300, kind: "zoom in", zoom: 1.2, pan: [0, 0], easing: "ease-in-out", pace: "move" }],
  animations: [{ start: 1, end: 1.4, ms: 400, kind: "grows in (pop, scale or reveal)", box: [0.1, 0.1, 0.3, 0.1], easing: "ease-out" }, { start: 3, end: 3.3, ms: 300, kind: "slides left", box: [0.5, 0.7, 0.3, 0.1], easing: "ease-out" }],
  scenes: [scene(0, 2, "camera footage"), scene(2, 4, "camera footage"), scene(4, 6, "still picture"), scene(6, 10, "camera footage")],
  palette: [["#112233", 0.5], ["#FFFFFF", 0.3]],
  music: { sections: [{ start: 0, end: 10, bpm: 124, beat: 0.5, key: "F", mode: "major", brightHz: 600, duckDb: 6, levelDb: [-20], underVoice: true }], changes: [[5, "drops quieter", -7]], musicSeconds: 10, levelDb: [-20], stops: [] },
  sfx: [{ t: 3.9, kind: "whoosh", ms: 400, db: -18, jumpDb: 12, near: [4, "cut"] }],
};
// The face fills the frame from 2 to 4 s and from 6 to 10 s (talking head); not in the other two scenes (b-roll).
const frames = Array.from({ length: 100 }, (_, k): [number, never[]] => { const t = k / 10, on = (t >= 2 && t < 4) || t >= 6; return [t, (on ? [[1, 0.35, 0.2, 0.3, 0.3, 0.9, null, null, null, null]] : []) as never]; });
const words = [{ t: 0.2, end: 0.5, w: "Knee" }, { t: 0.6, end: 0.9, w: "pain?" }, { t: 4.2, end: 4.5, w: "Try" }, { t: 4.6, end: 5, w: "this." }];
const f = buildStyleFile({ video: { id: "v", name: "Ref", seconds: 10, width: 1080, height: 1920 }, measure, words, cuts: [2, 4, 6], vision: { frames }, map });

describe("reference map", () => {
  it("scenes with the face are the talking head; the rest is b-roll, with its type and words", () => {
    expect(f.v).toBe(2);
    expect(f.map!.kind).toBe("talking head");
    expect(f.map!.scenes.map((s) => s.kind)).toEqual(["camera footage", "talking head", "still picture", "talking head"]);
    expect(f.map!.broll).toMatchObject({ count: 2, types: { "video clip": 1, image: 1 }, share: 0.4 });
    expect(f.map!.broll!.list[0]).toMatchObject({ start: 0, end: 2, says: "Knee pain?" });
  });
  it("camera, animations, music and sound effects in words; one timeline; frames to look at; needs", () => {
    expect(f.map!.camera).toMatchObject({ count: 1, zoomIn: 1.2, easings: { "ease-in-out": 1 } });
    expect(f.map!.music!.words[0]).toBe("upbeat, strong steady beat");
    expect(f.map!.sfx.kinds).toEqual({ whoosh: 1 });
    const t = styleFileText("sf1", "Mine", f);
    expect(t).toMatch(/^IN PLAIN WORDS/m);
    expect(t).toMatch(/^- B-roll: 2 times .* 1 video clip, 1 image\.$/m);
    expect(t).toMatch(/^- Music: upbeat, strong steady beat, major key \(bright, positive feel\), about 124 beats a minute, the whole way through; it gets quieter at 5 s\.$/m);
    expect(t).toMatch(/^- Fonts: not named yet/m);
    expect(t).toMatch(/^WHAT A NEW VIDEO IN THIS STYLE NEEDS/m);
    expect(t).toMatch(/^- B-roll: 2 pieces \(1 video clip, 1 image\)/m);
    expect(t).toMatch(/^LOOK AT \(get_frames/m);
    expect(t).toMatch(/^TIMELINE \(\d+, seconds of the reference\):$/m);
    expect(t).toMatch(/^3\.9s sound effect: whoosh \(400 ms\) with the cut$/m);
    expect(t).toMatch(/^6\.2s camera zoom in to 7\.4s \(1\.2x, 1300 ms, ease-in-out\)$/m);
    expect(t).toMatch(/^0\.9s white flash \(set_transition flash\) at the cut \(100 ms\)$/m);
    expect(t).not.toMatch(/—/);
  });
  it("the AI's notes name the fonts in the plain words and show in the file", () => {
    const g = { ...f, notes: { fonts: [{ family: "Poppins", weight: "Bold", use: "captions" }], summary: "A warm kitchen ad." } };
    expect(plainWords(g)).toContain("Fonts: Poppins Bold for captions.");
    expect(styleFileText("sf1", "Mine", g)).toMatch(/^- font: Poppins Bold, for captions$/m);
  });
  it("an older style file (no map) reads as before", () => {
    const old = buildStyleFile({ video: { id: "v", name: "Ref", seconds: 10, width: 1080, height: 1920 }, measure, words, cuts: [2, 4, 6] });
    expect(old.map).toBeNull();
    const t = styleFileText("sf0", "Old", old);
    expect(t).not.toMatch(/IN PLAIN WORDS/);
    expect(t).toMatch(/^MOMENTS/m);
    expect(plainWords(old)).toEqual([]);
  });
});
