// Premiere parity, phase 15: a parametric EQ (up to 4 bells: frequency, gain, Q) in the render's chain and as the Web
// Audio biquads the live player uses (the same RBJ filters as FFmpeg's bass, equalizer and treble), the op and its text.
import { describe, expect, it } from "vitest";
import { applyOp, buildInitialTimeline, clipFxChain, clipFxText, eqBiquads, eqChain, type EditContext, type Op, type SeqClip, type Snapshot } from "../src/index";

describe("parametric EQ", () => {
  it("the render's chain: each band an equalizer at its Q; bands at 0 dB left out", () => {
    expect(eqChain({ low: 3, bands: [{ f: 60, gain: -18, q: 10 }, { f: 3000, gain: 0 }, { f: 2500, gain: 4 }] })).toBe("lowshelf=g=3:f=120:t=q:w=0.7071,equalizer=f=60:t=q:w=10.000:g=-18,equalizer=f=2500:t=q:w=1.000:g=4");
    expect(clipFxChain({ pan: -0.5, eq: { bands: [{ f: 400, gain: -3, q: 2 }] } })).toBe("equalizer=f=400:t=q:w=2.000:g=-3,pan=stereo|c0=1.0000*c0|c1=0.5000*c1");
  });
  it("the live player's biquads: the shelves at Q 0.707, the 1 kHz bell 1.5 octaves wide, each band at its Q", () => {
    expect(eqBiquads({ low: 6, mid: -4, high: 3, bands: [{ f: 3000, gain: -8, q: 2 }, { f: 90, gain: 0 }] })).toEqual([
      { type: "lowshelf", f: 120, gain: 6, q: 0.7071 }, { type: "peaking", f: 1000, gain: -4, q: 0.9198 }, { type: "highshelf", f: 6000, gain: 3, q: 0.7071 }, { type: "peaking", f: 3000, gain: -8, q: 2 },
    ]);
    expect(eqBiquads(undefined)).toEqual([]);
  });
  it("set_clip_audio: bands replace the old ones, [] removes them, the shelves stay; the text says each band", () => {
    const ctx: EditContext = { videoId: "v", transcript: [], silences: [], sceneCuts: [], duration: 10, getStyle: () => undefined };
    let s: Snapshot = applyOp({ timeline: buildInitialTimeline([], 10, "clean", [], "v"), name: "a", aspect: "16:9", styleId: null }, { op: "set_clips", track: "v1", clips: [{ id: "a", start: 0, end: 10, label: "" }] } as Op, ctx).snap;
    s = applyOp(s, { op: "set_clip_audio", clipId: "a", eq: { low: 2, bands: [{ f: 60, gain: -18, q: 10 }] } } as Op, ctx).snap;
    const r = applyOp(s, { op: "set_clip_audio", clipId: "a", eq: { bands: [{ f: 3200, gain: -4, q: 1.5 }] } } as Op, ctx);
    expect((r.snap.timeline.tracks.v1 as SeqClip[])[0].audioEq).toEqual({ low: 2, bands: [{ f: 3200, gain: -4, q: 1.5 }] });
    expect(r.summary).toMatch(/EQ low \+2 3\.2 kHz -4 Q1\.5 dB/);
    const off = applyOp(r.snap, { op: "set_clip_audio", clipId: "a", eq: { bands: [] } } as Op, ctx).snap;
    expect((off.timeline.tracks.v1 as SeqClip[])[0].audioEq).toEqual({ low: 2 });
    expect(clipFxText({ eq: { bands: [{ f: 60, gain: -18, q: 10 }] } })).toBe("EQ 60 Hz -18 Q10 dB");
  });
});
