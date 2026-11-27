// Recreate's plan for a motion template's videos: every b-roll clip it asks for is long enough for add_broll (0.05 s; asked for at 0.055 so rounding never drops under it),
// so a one-frame silhouette strobe (0.042 s at 24 fps) is held just past that instead of the whole recreate failing.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { TALKING_HEAD_AD as talkingHeadAd } from "../../../packages/shared/src/motionTemplate/talkingHeadAd";
import { shotPlan, silhouettePlan, voiceClip } from "../src/services/motionTemplates";

describe("recreate plan", () => {
  const videos = new Map(talkingHeadAd.slots.filter((s) => (s as { video?: boolean }).video).map((s) => [s.id, { videoId: "v_" + s.id, seconds: 300 }]));
  it("silhouettes are each at least 0.05 s, start where the template says and do not overlap", () => {
    const sils = silhouettePlan(talkingHeadAd, videos);
    assert.equal(sils.length, 8);
    for (const f of sils) assert.ok(f.end - f.start > 0.05, `${f.id} is ${f.end - f.start}s`);
    assert.deepEqual(sils.map((f) => f.start), (talkingHeadAd.edit?.silhouettes ?? []).map((x) => Math.round(x.t * 1000) / 1000));
    for (let i = 1; i < sils.length; i++) assert.ok(sils[i].start >= sils[i - 1].end, `${sils[i].id} overlaps ${sils[i - 1].id}`);
  });
  it("shots are each at least 0.05 s and the talking head runs the template's length", () => {
    for (const s of shotPlan(talkingHeadAd, videos)) assert.ok(s.end - s.start >= 0.05, s.id);
    assert.equal(voiceClip(talkingHeadAd, videos)?.slot, "speaker");
  });
});
