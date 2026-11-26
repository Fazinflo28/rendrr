// Explore's breakdown beside a published video: the style file in plain words, shot by shot, fonts, b-roll, music,
// sound effects and needs, with nothing private in it (no ids, file names, links or emails).
import { describe, expect, it } from "vitest";
import { buildStyleFile, publicBreakdown, type ReferenceMap, type ReferenceMeasure } from "../src";

const measure: ReferenceMeasure = { v: 1, size: [360, 640], texts: [], transitions: [[0.9, "flash", 100], [4, "cut", 0]], grade: [[0, 0.5, 0.2, 0.3, 0, 0]], sound: null };
const scene = (start: number, end: number, kind: string) => ({ start, end, kind, flat: 0.1, noise: 3, colourful: 0.2, light: 0.5, split: null, colours: [["#112233", 0.6], ["#FFFFFF", 0.3]] as [string, number][] });
const map: ReferenceMap = {
  v: 1, fps: 12, size: [240, 426], cuts: [2, 4, 6],
  moves: [{ start: 6.2, end: 7.4, ms: 1300, kind: "zoom in", zoom: 1.2, pan: [0, 0], easing: "ease-in-out", pace: "move" }],
  animations: [{ start: 1, end: 1.4, ms: 400, kind: "grows in (pop, scale or reveal)", box: [0.1, 0.1, 0.3, 0.1], easing: "ease-out" }],
  scenes: [scene(0, 2, "camera footage"), scene(2, 4, "camera footage"), scene(4, 6, "still picture"), scene(6, 10, "camera footage")],
  palette: [["#112233", 0.5], ["#FFFFFF", 0.3]],
  music: { sections: [{ start: 0, end: 10, bpm: 124, beat: 0.5, key: "F", mode: "major", brightHz: 600, duckDb: 6, levelDb: [-20], underVoice: true }], changes: [[5, "drops quieter", -7]], musicSeconds: 10, levelDb: [-20], stops: [] },
  sfx: [{ t: 3.9, kind: "whoosh", ms: 400, db: -18, jumpDb: 12, near: [4, "cut"] }],
};
const frames = Array.from({ length: 100 }, (_, k): [number, never[]] => { const t = k / 10, on = (t >= 2 && t < 4) || t >= 6; return [t, (on ? [[1, 0.35, 0.2, 0.3, 0.3, 0.9, null, null, null, null]] : []) as never]; });
const words = [{ t: 0.2, end: 0.5, w: "Knee" }, { t: 0.6, end: 0.9, w: "pain?" }, { t: 4.2, end: 4.5, w: "Try" }, { t: 4.6, end: 5, w: "this." }];
const f = buildStyleFile({ video: { id: "cmw64ugri0001qr4i44kik96k", name: "IMG_7692", seconds: 10, width: 1080, height: 1920 }, measure, words, cuts: [2, 4, 6], vision: { frames }, map });

describe("public breakdown", () => {
  const g = { ...f, notes: {
    fonts: [{ family: "Poppins", weight: "Bold", use: "captions", color: "white" }],
    scenes: [{ at: 0.5, what: "Hands on a knee", type: "video clip" }, { at: 2.4, what: "Coach talks to camera, see https://example.com" }],
    music: "Soft bed under the voice.", summary: "A warm clinic ad. Mail me at a@b.co",
  } };
  const b = publicBreakdown(g);
  it("facts, plain words and the summary on top", () => {
    expect(b.summary).toBe("A warm clinic ad. Mail me at");
    expect(b.facts.map((x) => x.label).slice(0, 4)).toEqual(["Length", "Shape", "Type", "Pace"]);
    expect(b.facts[1].value).toBe("Vertical (9:16)");
    expect(b.plain[0]).toMatch(/^A 10 second vertical talking-head video/);
    expect(b.plain).toContain("Fonts: Poppins Bold for captions.");
    expect(b.plain.some((x) => x.startsWith("A warm clinic ad"))).toBe(false);
  });
  it("shot by shot with what the AI saw, and the detail sections", () => {
    expect(b.shots).toHaveLength(4);
    expect(b.shots[0]).toMatchObject({ start: 0, end: 2, kind: "video clip", what: "Hands on a knee", says: "Knee pain?" });
    expect(b.shots[1].what).toBe("Coach talks to camera, see");
    const t = Object.fromEntries(b.sections.map((s) => [s.title, s.lines]));
    expect(t["B-roll, one by one"][0]).toBe('0 to 2 s: video clip over "Knee pain?"');
    expect(t["Camera moves"][0]).toMatch(/^6\.2 s: zoom in, 1\.3 s, /);
    expect(t["Transitions"]).toEqual(["0.9 s: white flash"]);
    expect(t["Music"][0]).toBe("Soft bed under the voice.");
    expect(t["Music"]).toContain("5 s: drops quieter");
    expect(t["Sound effects"]).toEqual(["3.9 s: whoosh on the cut"]);
    expect(b.fonts[0]).toEqual({ family: "Poppins", weight: "Bold", use: "captions", color: "white" });
    expect(b.palette).toEqual(["#112233", "#FFFFFF"]);
    expect(b.needs.length).toBeGreaterThan(2);
  });
  it("never carries the video's id or file name, links or emails", () => {
    const s = JSON.stringify(b);
    expect(s).not.toMatch(/cmw64ugri|IMG_7692|https?:|@b\.co/);
    expect(s).not.toMatch(/—/);
  });
  it("an older file with notes only still gives shots from the notes", () => {
    const old = buildStyleFile({ video: { id: "v", name: "Ref", seconds: 10, width: 1080, height: 1920 }, measure, words, cuts: [2, 4, 6] });
    const o = publicBreakdown({ ...old, notes: { scenes: [{ at: 0, what: "Intro" }, { at: 5, what: "Outro" }] } });
    expect(o.plain).toEqual([]);
    expect(o.shots).toEqual([{ start: 0, end: 5, kind: "scene", what: "Intro", says: "" }, { start: 5, end: 10, kind: "scene", what: "Outro", says: "" }]);
  });
});
