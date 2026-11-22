// Engine Part 4.4: a style file from measurements (no video): which text is the captions, punch-ins at cuts and slow
// zooms from the face's size, pauses kept, the sound's words.
import { describe, expect, it } from "vitest";
import { buildStyleFile, styleFileText, type MeasuredText, type ReferenceMeasure } from "../src/styleFile";

const text = (o: Partial<MeasuredText>): MeasuredText => ({ start: 0, end: 1, box: [0.2, 0.7, 0.6, 0.05], height: 0.08, color: "#FFFFFF", highlight: null, stroke: null, boxColor: null, weight: 0.2, words: 2, changes: [], in: { kind: "cut", ms: 0 }, out: { kind: "cut", ms: 0 }, ...o });

describe("style file", () => {
  const measure: ReferenceMeasure = {
    v: 1, size: [360, 640],
    texts: [
      text({ start: 0, end: 30, changes: Array.from({ length: 50 }, (_, k) => 0.6 * (k + 1)), highlight: "#FFD400", stroke: { color: "#000000", widthPct: 7 }, chunkIn: ["pop", "pop", "cut"] }),
      text({ start: 5, end: 7, box: [0.1, 0.15, 0.4, 0.04], boxColor: "#FF66AA", in: { kind: "slide", ms: 300, dir: "left", easing: "ease-out-cubic" }, out: { kind: "cut", ms: 0 } }),
    ],
    transitions: [[10, "cut", 0], [20, "flash", 100]],
    grade: [[0, 0.5, 0.3, 0.5, 0.08, 0], [0.5, 0.5, 0.3, 0.5, 0.08, 0]],
    sound: { speechDb: -20, pauseDb: -60, lowSpeechDb: -70, lowPauseDb: -70, pauseFrames: 20, hitsAtCuts: [] },
  };
  // A face 0.2 tall to 10 s, 0.26 after the cut (a punch-in), then growing steadily from 20 to 30 s (a slow zoom).
  const frames = Array.from({ length: 300 }, (_, k): [number, never[]] => {
    const t = k / 10, h = t < 10 ? 0.2 : t < 20 ? 0.26 : 0.26 + (t - 20) * 0.006;
    return [t, [[1, 0.4, 0.2, 0.2, h, 0.9, null, null, null, null]] as never];
  });
  const words = Array.from({ length: 60 }, (_, k) => ({ t: k * 0.5, end: k * 0.5 + 0.3 }));
  const f = buildStyleFile({ video: { id: "v", name: "Ref", seconds: 30, width: 1080, height: 1920 }, measure, words, cuts: [10, 20], audio: { speech: [[0, 30]], lufs: -14, truePeakDb: -1 }, vision: { frames } });

  it("the captions are the row that changes with the speech; the other text is a graphic", () => {
    expect(f.captions).toMatchObject({ color: "#FFFFFF", highlight: "#FFD400", stroke: { color: "#000000" }, wordsAtOnce: 2, animation: "pop", weight: "black" });
    expect(f.captions!.chunkSec).toBeCloseTo(0.6, 1);
    expect(f.textGraphics).toHaveLength(1);
    expect(f.textGraphics[0]).toMatchObject({ place: "top-left", boxColor: "#FF66AA" });
    expect(f.textHabits.entrances).toEqual({ "slide left": 1 });
  });
  it("a punch-in at the cut and a slow zoom inside the next shot, from the face's size", () => {
    expect(f.zooms!.list).toEqual([[10, 1.3]]);
    expect(f.zooms!.punchIns).toBe(1);
    expect(f.zooms!.slow).toHaveLength(1);
    expect(f.zooms!.slow[0].change).toBeGreaterThan(0.15);
  });
  it("pacing, pauses kept, grade and sound in words", () => {
    expect(f.pacing).toMatchObject({ cutsPerMin: 4, avgShotSec: 10, wordsPerMin: 120 });
    expect(f.pacing.pausesKept).toMatchObject({ medianMs: 200 });
    expect(f.grade!.words).toEqual(["mid brightness", "high contrast", "saturated colour", "warm"]);
    expect(f.sound).toMatchObject({ bed: "no bed: the pauses drop to near silence", duckDb: null });
    const t = styleFileText("sf1", "Mine", f);
    expect(t).toMatch(/^ZOOMS: 1 punch-ins and 0 punch-outs at cuts \(2 a minute, typically 1\.3x: add_zoom scale 1\.3\); 1 slow zooms inside shots/m);
    expect(t).toMatch(/^20s white flash \(set_transition flash\) at the cut \(100 ms\)$/m);
  });
});
