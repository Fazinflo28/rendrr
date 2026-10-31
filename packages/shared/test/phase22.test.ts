// Phase 22: multicam sync by timecode. A file's start timecode as seconds (non-drop, drop-frame at 29.97 and 59.94,
// 23.976), the angle's offset from both files' timecodes (over midnight too), and the choice: timecode first, the
// sound checks it and is used when timecode is missing or disagrees. The multicam op keeps how each angle was lined up.
import { describe, expect, it } from "vitest";
import { applyOp, buildInitialTimeline, multicamText, pickSync, timecodeOffset, timecodeSeconds, type EditContext, type Op, type Snapshot, type SyncResult } from "../src/index";

const sound = (offset: number, score = 0.8, margin = 3): SyncResult => ({ offset, score, margin, overlap: 60, sure: score >= 0.3 && margin >= 1.5 });

describe("timecode", () => {
  it("non-drop timecode at 25, 30 and 24 fps; 23.976 and 29.97 footage run at their own rate", () => {
    expect(timecodeSeconds("01:00:00:00", 25)).toBe(3600);
    expect(timecodeSeconds("00:00:01:15", 30)).toBe(1.5);
    expect(timecodeSeconds("10:00:00:12", 24)).toBeCloseTo(36000.5, 9);
    // 23.976: 24 frame numbers a second, played at 23.976 (0.1% slower than the clock).
    expect(timecodeSeconds("00:00:10:00", 23.976)).toBeCloseTo(240 / 23.976, 9);
  });
  it("drop-frame at 29.97 and 59.94: the skipped frame numbers left out, every tenth minute kept", () => {
    expect(timecodeSeconds("00:01:00;02", 29.97)).toBeCloseTo(1800 * 1001 / 30000, 9);
    expect(timecodeSeconds("00:10:00;00", 29.97)).toBeCloseTo(17982 * 1001 / 30000, 9);
    expect(timecodeSeconds("01:00:00;00", 29.97)).toBeCloseTo(3599.9964, 3);
    expect(timecodeSeconds("00:01:00;04", 59.94)).toBeCloseTo(3600 * 1001 / 60000, 9);
  });
  it("not a timecode: null", () => {
    for (const x of ["", "garbage", "25:61:00:00", "00:00:00:30", null, undefined]) expect(timecodeSeconds(x as string, 30)).toBeNull();
  });
  it("the angle's offset: the main video started 5 s after the angle, so the angle is 5 s ahead; over midnight", () => {
    expect(timecodeOffset({ timecode: "10:00:05:00", fps: 25 }, { timecode: "10:00:00:00", fps: 25 })).toBe(5);
    expect(timecodeOffset({ timecode: "10:00:00:00", fps: 25 }, { timecode: "10:00:02:12", fps: 25 })).toBe(-2.48);
    expect(timecodeOffset({ timecode: "23:59:59:00", fps: 25 }, { timecode: "00:00:01:00", fps: 25 })).toBe(-2);
    expect(timecodeOffset({ timecode: "10:00:00:00", fps: 25 }, { timecode: "", fps: 25 })).toBeNull();
  });
});

describe("timecode first, the sound checks it", () => {
  it("both agree: timecode, said to be checked", () => {
    const p = pickSync(5, sound(5.04))!;
    expect(p).toMatchObject({ offset: 5, by: "timecode", score: 0.8 });
    expect(p.note).toMatch(/the sound agrees \(within 40 ms\)/);
  });
  it("they disagree and the sound is sure: the sound (a camera whose clock was not jammed)", () => {
    const p = pickSync(5, sound(7.3))!;
    expect(p).toMatchObject({ offset: 7.3, by: "sound" });
    expect(p.note).toMatch(/the timecode is 2\.30 s off/);
  });
  it("they disagree and the sound is unsure: timecode", () => {
    expect(pickSync(5, sound(7.3, 0.2, 1.1))).toMatchObject({ offset: 5, by: "timecode" });
  });
  it("no timecode: the sound; no sound: timecode; neither: nothing", () => {
    expect(pickSync(null, sound(3))).toMatchObject({ offset: 3, by: "sound" });
    expect(pickSync(5, null)).toMatchObject({ offset: 5, by: "timecode" });
    expect(pickSync(null, null)).toBeNull();
  });
});

describe("the multicam op keeps how an angle was lined up", () => {
  const ctx: EditContext = { videoId: "v", transcript: [], silences: [], sceneCuts: [], duration: 30, getStyle: () => undefined, getVideo: (id) => ({ id, name: id === "cam2" ? "Camera 2" : id, seconds: 30, ready: true }) };
  const base = (): Snapshot => applyOp({ timeline: buildInitialTimeline([], 30, "clean", [], "v"), name: "t", aspect: "16:9", styleId: "s2" }, { op: "set_captions", on: false } as Op, ctx).snap;
  it("by timecode: kept on the angle and said; an offset sent by hand drops it; a low sound score is not 'unsure' then", () => {
    const r = applyOp(base(), { op: "multicam", angles: [{ videoId: "cam2", offset: 5, score: 0.2, sync: "timecode" }] } as Op, ctx);
    expect(r.snap.timeline.multicam!.angles[0]).toMatchObject({ videoId: "cam2", offset: 5, sync: "timecode" });
    expect(r.summary).toMatch(/Camera 2 \(\+5\.000s, by timecode, sound check 0\.20\)/);
    expect(r.summary).not.toMatch(/unsure/);
    const hand = applyOp(r.snap, { op: "multicam", angles: [{ videoId: "cam2", offset: 5.5 }] } as Op, ctx);
    expect(hand.snap.timeline.multicam!.angles[0].sync).toBeUndefined();
    expect(multicamText(hand.snap.timeline.multicam!)).toMatch(/set by hand/);
  });
});
