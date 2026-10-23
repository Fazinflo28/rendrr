import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { breakdownAsText, buildBreakdown, fmtT, sheetsIn, stubTranscript, type Measured } from "../src/index";

// Real output of apps/worker/python/breakdown.py on the built-in sample (41 s, scene cuts at 15.0 and 28.03).
const measured = JSON.parse(readFileSync(join(__dirname, "fixtures/measured-sample.json"), "utf8")) as Measured;
const tr = stubTranscript(41);
const video = { id: "v1", name: "Sample", kind: "footage" as const, seconds: 41, width: 1280, height: 720, orientation: "Landscape", fps: 30, hasAudio: true };
const b = buildBreakdown({ video, transcript: tr, silences: [{ start: 7, end: 8 }], sceneCuts: [15, 28.03], measured, sheetKeys: ["k1", "k2", "k3"] });

describe("video breakdown", () => {
  it("splits shots at the scene cuts and measures each", () => {
    expect(b.shots.map((s) => [s.start, s.end])).toEqual([[0, 15], [15, 28.03], [28.03, 41]]);
    expect(b.shots.every((s) => s.colours.length > 0 && s.loudnessDb != null)).toBe(true);
    expect(b.shots[0].motion).toBe("still"); // a still talking head
    expect(b.pacing.shots).toBe(3);
    expect(b.pacing.cutsPerMin).toBeCloseTo(2.9, 1);
    expect(b.pacing.words).toBe(tr.flatMap((l) => l.words).length);
  });
  it("puts what is said in each shot", () => {
    const said = b.shots.reduce((a, s) => a + s.words, 0);
    expect(said).toBe(b.pacing.words);
    expect(b.hook.says.length).toBeGreaterThan(0);
  });
  it("ignores a weak beat (speech only)", () => {
    expect(b.audio.beat).toBeNull();
    expect(b.audio.loudnessDb.length).toBe(41);
  });
  it("keeps the contact sheets in order with their times", () => {
    expect(b.frames.sheets.map((s) => s.key)).toEqual(["k1", "k2", "k3"]);
    expect(b.frames.sheets[0].from).toBe(0);
    expect(b.frames.sheets[2].to).toBeGreaterThan(38);
    expect(sheetsIn(b, 16, 20).map((s) => s.key)).toEqual(["k2"]);
  });
  it("reads as compact text", () => {
    const text = breakdownAsText(b);
    expect(text).toMatch(/^VIDEO FOOTAGE "Sample" v1 \| 41\.0s/);
    expect(text).toContain("PACING shots=3");
    expect(text).toContain("sh2 0:15.0-0:28.0 13.0s");
    expect(text).toContain("no steady beat");
    expect(text).toContain("on 3 contact sheets");
    expect(breakdownAsText(b, { from: 30 })).not.toContain("sh1 ");
  });
  it("detects a steady beat when the analyzer is confident", () => {
    const withBeat = buildBreakdown({ video: { ...video, kind: "reference" }, transcript: [], silences: [], sceneCuts: [], measured: { ...measured, tempo: { bpm: 120, confidence: 0.9, beats: [0.5, 1, 1.5] } }, sheetKeys: [] });
    expect(withBeat.audio.beat?.bpm).toBe(120);
    expect(withBeat.audio.musicLikely).toBe(true);
    expect(breakdownAsText(withBeat)).toContain("VIDEO REFERENCE");
    expect(breakdownAsText(withBeat)).toContain("beat=120bpm");
  });
  it("formats times", () => {
    expect(fmtT(0)).toBe("0:00.0");
    expect(fmtT(75.25)).toBe("1:15.3");
  });
});
