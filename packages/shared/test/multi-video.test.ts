// One edit from several videos (a video filmed in parts): the first is the edit's footage, the others follow it whole
// on V1, back to back, in the order given; the render plays them in that order.
import { describe, expect, it } from "vitest";
import { buildRawSequence, sequenceView, stubTranscript, type Snapshot } from "../src/index";
import { planRender } from "../src/renderPlan";

const tr = stubTranscript(20);
const words = tr.flatMap((l) => l.words);
type Seq = { id: string; label: string; sourceVideoId: string; sourceIn: number; sourceOut: number };

describe("an edit of several videos", () => {
  it("puts the parts on V1 in order, each whole, after the first video", () => {
    const tl = buildRawSequence(tr, 20, [], "partA", [{ id: "partB", name: "Part 2", seconds: 12.345, ready: true }, { id: "partC", name: "Part 3", seconds: 8, ready: true }]);
    const v1 = tl.tracks.v1 as unknown as Seq[];
    const mainClips = v1.filter((c) => c.sourceVideoId === "partA");
    expect(mainClips.length).toBeGreaterThan(0);
    expect(v1.slice(0, mainClips.length).every((c) => c.sourceVideoId === "partA")).toBe(true); // the first video first
    expect(v1.slice(mainClips.length).map((c) => [c.sourceVideoId, c.sourceIn, c.sourceOut, c.label])).toEqual([["partB", 0, 12.345, "Part 2"], ["partC", 0, 8, "Part 3"]]);
    expect(new Set(v1.map((c) => c.id)).size).toBe(v1.length);
    // Nothing else: captions off, no other tracks, nothing cut.
    expect(tl.captionsOn).toBe(false);
    expect(tl.cut).toEqual([]);
    expect(tl.tracks.v2.length + tl.tracks.a2.length + tl.tracks.a3.length).toBe(0);
    // The edit is as long as the three videos, and the render plays them in that order.
    const view = sequenceView(tl, words);
    expect(view.total).toBeCloseTo(20 + 12.345 + 8, 3);
    const snap: Snapshot = { timeline: tl, name: "parts", aspect: "16:9", styleId: null };
    const src = { width: 1920, height: 1080, fps: 30, seconds: 20, hasAudio: true };
    const plan = planRender({ kind: "preview", snapshot: snap, transcript: tr, source: src, videoId: "partA", sources: { partB: { ...src, seconds: 12.345 }, partC: { ...src, seconds: 8 } } });
    const order = plan.parts.map((p) => p.videoId).filter((v, i, a) => v !== a[i - 1]);
    expect(order).toEqual(["partA", "partB", "partC"]);
    expect(plan.outputSeconds).toBeCloseTo(40.345, 1);
  });
  it("one video is the plain raw edit", () => {
    const one = buildRawSequence(tr, 20, [], "partA", []);
    expect((one.tracks.v1 as unknown as Seq[]).every((c) => c.sourceVideoId === "partA")).toBe(true);
  });
});
