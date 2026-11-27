// Recreate's plan for a motion template's videos: every b-roll clip it asks for is long enough for add_broll (0.05 s;
// asked for at 0.055 s so rounding never drops under it), so a one-frame silhouette strobe (0.042 s at 24 fps) is held
// just past that. A talking head given as a cut edit plays on V1 through its cuts, its shots' moves on the V1 clips
// under them, and the silhouettes are taken from the footage the edit plays at their moment.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { TALKING_HEAD_AD as spec } from "../../../packages/shared/src/motionTemplate/talkingHeadAd";
import { footageAt, keysWithin, shotPlan, silhouettePlan, v1Plan, voiceClip, type SlotVideo } from "../src/services/motionTemplates";

const videoSlots = spec.slots.filter((s) => (s as { video?: boolean }).video).map((s) => s.id);
const plain = new Map<string, SlotVideo>(videoSlots.map((id) => [id, { slot: id, videoId: "v_" + id, seconds: 300 }]));
// A cut talking head: good takes of one video (and a second video), back to back.
const pieces = [
  { videoId: "raw", srcIn: 9.6, srcOut: 14.1, start: 0, end: 4.5 },
  { videoId: "raw", srcIn: 26.66, srcOut: 29.12, start: 4.5, end: 6.96 },
  { videoId: "raw", srcIn: 33.66, srcOut: 45, start: 6.96, end: 18.3 },
  { videoId: "raw2", srcIn: 2, srcOut: 12, start: 18.3, end: 28.3 },
];
const cut = new Map(plain);
cut.set("speaker", { slot: "speaker", videoId: "raw", seconds: 28.3, pieces });

describe("recreate plan", () => {
  it("silhouettes are each at least 0.05 s, start where the template says and do not overlap", () => {
    const sils = silhouettePlan(spec, plain);
    assert.equal(sils.length, 8);
    for (const f of sils) assert.ok(f.end - f.start > 0.05, `${f.id} is ${f.end - f.start}s`);
    assert.deepEqual(sils.map((f) => f.start), (spec.edit?.silhouettes ?? []).map((x) => Math.round(x.t * 1000) / 1000));
    for (let i = 1; i < sils.length; i++) assert.ok(sils[i].start >= sils[i - 1].end, `${sils[i].id} overlaps ${sils[i - 1].id}`);
  });
  it("shots are each at least 0.05 s and the talking head runs the template's length", () => {
    for (const s of shotPlan(spec, plain)) assert.ok(s.end - s.start >= 0.05, s.id);
    assert.equal(voiceClip(spec, plain)?.slot, "speaker");
  });
  it("a cut edit plays on V1 through its cuts, end to end, then the canvas, silent, to the template's end", () => {
    const v1 = v1Plan(spec, cut, "canvas")!;
    assert.equal(v1[0].start, 0);
    for (let i = 1; i < v1.length; i++) assert.ok(Math.abs(v1[i].start - v1[i - 1].end) < 1e-6, `gap before V1 clip ${i}`);
    for (const c of v1) assert.ok(Math.abs(c.srcOut - c.srcIn - (c.end - c.start)) < 0.002, `${c.label} footage and edit lengths differ`);
    const last = v1[v1.length - 1];
    assert.deepEqual([last.videoId, last.start, last.end], ["canvas", 28.3, spec.duration]);
    // Every moment plays the footage the edit plays there.
    for (const c of v1.filter((x) => x.videoId !== "canvas")) { const f = footageAt(cut.get("speaker")!, c.start + 0.01); assert.equal(c.videoId, f.videoId); assert.ok(Math.abs(c.srcIn + 0.01 - f.src) < 0.002); }
    // Split at the edit's cuts and the talking head's shots.
    for (const t of [4.5, 6.96, 18.3, 3.25, 4.917, 7.958, 11.958, 14.167]) assert.ok(v1.some((c) => Math.abs(c.start - t) < 0.002), `no V1 cut at ${t}`);
  });
  it("the talking head's moves go on V1: the whip into the office, the push in, the blur behind the disc", () => {
    const v1 = v1Plan(spec, cut, "canvas")!;
    const whip = v1.find((c) => Math.abs(c.start - 11.958) < 0.002)!;
    assert.ok(whip.whip && whip.keys.length && whip.end - whip.start < 0.1, "the whip lands on a clip of its own");
    const after = v1.find((c) => Math.abs(c.start - whip.end) < 0.002)!;
    assert.equal(after.keys.length, 0, "the clip after the whip does not move, so the person matte works on it");
    assert.equal(v1.find((c) => Math.abs(c.start - 14.167) < 0.002)!.blur, 40);
    const push = v1.filter((c) => c.label === "talking head s8");
    assert.ok(push.length >= 1 && push.some((c) => c.keys.some((k) => (k.scale ?? 1) > 1.1)));
  });
  it("no b-roll copies of the talking head under V1, and the silhouettes come from the footage the edit plays", () => {
    assert.ok(!shotPlan(spec, cut, "speaker").some((s) => cut.get("speaker")!.pieces!.some((p) => p.videoId === s.videoId)));
    const f3 = silhouettePlan(spec, cut).find((f) => f.id === "f3")!; // from 3.292 of the talking head
    assert.deepEqual([f3.videoId, f3.sourceStart], ["raw", 12.892]);
  });
  it("a move split in two keeps its values at the split", () => {
    const keys = [{ t: 0.2, scale: 1 }, { t: 3.6, scale: 1.22 }];
    const a = keysWithin(keys, 0, 1.9), b = keysWithin(keys, 1.9, 1.9);
    assert.equal(a[a.length - 1].t, 1.9);
    assert.equal(a[a.length - 1].scale, b[0].scale);
    assert.equal(b[0].t, 0);
    assert.equal(b[b.length - 1].scale, 1.22);
  });
});
