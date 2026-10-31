// Phase 13 on the server: cut to whoever speaks. Two measured cameras (their sound every 10 ms in storage, as the
// deep measurements keep it): Ana loud on the main camera for 10 s, then Ben loud on his for 10 s. apply_edits fills
// multicam_auto's plan from their sound (an angle the same batch adds counts), the editor's route returns the plan,
// and a camera that is not the edit's is refused. Needs a database, Redis and storage (as in .env).
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { DeepAudio } from "@rendrr/shared";

const ready = !!process.env.DATABASE_URL && !!process.env.REDIS_URL && !!process.env.S3_BUCKET;
const run = Math.random().toString(36).slice(2, 8);

// 20 s at 10 ms: who is loud on this camera when (its own person -18 dB, the other one -32 dB, room -62 dB).
function audioBin(ownLoud: (t: number) => boolean, otherLoud: (t: number) => boolean, offset = 0): Buffer {
  const n = 2400, b = Buffer.alloc(n * 4);
  for (let i = 0; i < n; i++) {
    const t = i / 100 - offset, syll = Math.floor(t * 6) % 3 !== 2; // syllables and small gaps
    const db = ownLoud(t) && syll ? -18 : otherLoud(t) && syll ? -32 : -62;
    b[i * 4] = -40 & 0xff; b[i * 4 + 1] = 40; b[i * 4 + 2] = db & 0xff; b[i * 4 + 3] = db > -40 ? 230 : 5;
  }
  return b;
}

describe("cut to whoever speaks", { skip: !ready && "needs DATABASE_URL, REDIS_URL and storage" }, async () => {
  const { prisma } = await import("@rendrr/db");
  const { putObject, redis } = await import("@rendrr/core");
  const { DEEP_VERSION, PREFIX, MCP_TOOLS, stubTranscript } = await import("@rendrr/shared");
  const { createProject } = await import("../src/services/projects");
  const { autoPlan } = await import("../src/services/multicam");
  const { TOOL_HANDLERS } = await import("../src/tools");
  let userId = "", mainId = "", camId = "", projectId = "";
  const tool = (name: string, input: Record<string, unknown>) => TOOL_HANDLERS[name]({ userId, ai: "claude" as const }, MCP_TOOLS.find((t) => t.name === name)!.input.parse(input));
  const ana = (t: number) => t >= 0.5 && t < 10, ben = (t: number) => t >= 10.3 && t < 20;

  const measured = async (name: string, bin: Buffer) => {
    const v = await prisma.video.create({ data: { userId, name, seconds: 24, width: 1920, height: 1080, fps: 30, source: "drive", status: "ready", proxyKey: `proxies/${run}-${name}.mp4`,
      analysis: { create: { transcriber: "stub", transcript: stubTranscript(24) as never, silences: [], sceneCuts: [], keyFrames: [] } } } });
    const key = `${PREFIX.frames}${userId}/${v.id}/audio.bin`;
    await putObject(key, bin, "application/octet-stream");
    const audio = { v: 1, frameMs: 10, frames: 2400, seconds: 24, layout: "min,max,db,vad", peakDb: -6, noiseFloorDb: -64, roomDb: -62, speechDb: -18, lufs: -18, truePeakDb: -5, speech: [], speechShare: 0.4, onsets: [], breaths: [], clicks: [], clipping: [], rms100: "", key } as unknown as DeepAudio;
    await prisma.footageAnalysis.update({ where: { videoId: v.id }, data: { audio: audio as never, deepVersion: DEEP_VERSION, deepAt: new Date() } });
    return v.id;
  };

  before(async () => {
    userId = (await prisma.user.create({ data: { clerkId: `mca_${run}`, email: `mca-${run}@test.rendrr.dev`, name: "Mca" } })).id;
    await prisma.folder.create({ data: { userId, name: "My edits", workspace: "Mca's Workspace" } });
    mainId = await measured(`Ana cam ${run}`, audioBin(ana, ben));
    camId = await measured(`Ben cam ${run}`, audioBin(ben, ana, 1.5)); // Ben's camera started 1.5 s earlier
    projectId = (await createProject(userId, { videoId: mainId, name: `Pod ${run}` })).id;
    await tool("apply_edits", { projectId, edits: [{ op: "set_clips", track: "v1", clips: [{ start: 0, end: 20, label: "" }] }] });
  });
  after(async () => {
    await prisma.project.deleteMany({ where: { userId } });
    await prisma.folder.deleteMany({ where: { userId } });
    await prisma.video.deleteMany({ where: { userId } });
    await prisma.user.deleteMany({ where: { id: userId } });
    await redis().quit().catch(() => {});
  });

  it("apply_edits works the plan out from the cameras' sound (an angle added in the same batch counts)", async () => {
    const out = await tool("apply_edits", { projectId, edits: [{ op: "multicam", angles: [{ videoId: camId, offset: 1.5, name: "Ben cam" }] }, { op: "multicam_auto", minShot: 2 }] });
    assert.match(out.text, /cut to whoever speaks over footage 0:00 to 0:20: 1 cut: (Ben cam|main camera) 5\d%, (Ben cam|main camera) [45]\d%; shots at least 2 s/);
    const p = await prisma.project.findUniqueOrThrow({ where: { id: projectId } });
    const v1 = (p.timeline as unknown as { tracks: { v1: { sourceIn: number; sourceOut: number; angle?: string }[] } }).tracks.v1;
    assert.equal(v1.length, 2);
    assert.equal(v1[0].angle, undefined, "Ana's part on the main camera");
    assert.equal(v1[1].angle, camId, "Ben's part on his camera");
    assert.ok(v1[1].sourceIn > 9.7 && v1[1].sourceIn < 10.5, `the cut near 10.3 s, a little before Ben (${v1[1].sourceIn})`);
  });

  it("the editor's plan (route logic) names the cameras; one that is not the edit's is refused", async () => {
    const p = await prisma.project.findUniqueOrThrow({ where: { id: projectId } });
    const plan = await autoPlan(userId, mainId, p.timeline as never, { cameras: ["main", "Ben cam"], minShot: 3 });
    assert.deepEqual(plan.map((x) => x.angle), ["main", camId]);
    await assert.rejects(autoPlan(userId, mainId, p.timeline as never, { cameras: ["main", "Nobody"] }), /"Nobody" is not a camera of this edit/);
  });
});
