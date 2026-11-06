// A render's side files (captions .srt/.vtt and chapters, which hold the transcript) are deleted with its video:
// by "Delete all finals" in Settings and when an edit is deleted. Needs a database, Redis and storage (as in .env).
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

process.env.INTERNAL_API_SECRET ||= "test-internal-secret";
process.env.LOG_LEVEL = process.env.TEST_LOG || "silent";
const ready = !!process.env.DATABASE_URL && !!process.env.REDIS_URL && !!process.env.S3_BUCKET;
const run = Math.random().toString(36).slice(2, 8);

describe("render side files are deleted", { skip: !ready && "needs a database, Redis and storage" }, async () => {
  const { prisma } = await import("@rendrr/db");
  const { headObject, putObject, redis, renderFileKeys } = await import("@rendrr/core");
  const { purgeProjectFiles } = await import("../src/services/projects");
  const { buildServer } = await import("../src/server");
  let app: Awaited<ReturnType<typeof buildServer>>;
  let userId = "", projectId = "";
  const clerkId = `rfd_${run}`;
  const headers = () => ({ "x-internal-secret": process.env.INTERNAL_API_SECRET!, "x-rendrr-clerk-id": clerkId });
  const final = async (tag: string) => {
    const keys = { out: `renders/rf-${run}-${tag}.mp4`, srt: `renders/rf-${run}-${tag}.srt`, vtt: `renders/rf-${run}-${tag}.vtt`, frame: `renders/rf-${run}-${tag}-0.jpg` };
    for (const k of Object.values(keys)) await putObject(k, "x", "application/octet-stream");
    const r = await prisma.render.create({ data: { projectId, userId, kind: "final", version: 1, status: "done", steps: [], quality: "1080p", outputKey: keys.out, framesKeys: [keys.frame], sizeBytes: 1, plan: { outputSeconds: 10, files: { srt: keys.srt, vtt: keys.vtt } }, finishedAt: new Date() } });
    return { r, keys };
  };
  const gone = async (keys: Record<string, string>) => { for (const [n, k] of Object.entries(keys)) assert.equal(await headObject(k), null, `${n} is deleted`); };

  before(async () => {
    app = await buildServer();
    userId = (await prisma.user.create({ data: { clerkId, email: `rfd-${run}@test.rendrr.dev`, name: "Rfd" } })).id;
    const folder = await prisma.folder.create({ data: { userId, name: "Edits", workspace: "Personal" } });
    const v = await prisma.video.create({ data: { userId, name: "Talk", source: "local", status: "ready", seconds: 30 } });
    projectId = (await prisma.project.create({ data: { userId, folderId: folder.id, videoId: v.id, name: "Promo", timeline: {}, currentVersion: 1, status: "Final ready" } })).id;
  });
  after(async () => {
    await prisma.render.deleteMany({ where: { userId } });
    await prisma.project.deleteMany({ where: { userId } });
    await prisma.folder.deleteMany({ where: { userId } });
    await prisma.video.deleteMany({ where: { userId } });
    await prisma.user.deleteMany({ where: { id: userId } });
    await app.close();
    await redis().quit().catch(() => {});
  });

  it("renderFileKeys lists the video, its frames and its side files", () => {
    assert.deepEqual(renderFileKeys({ outputKey: "a.mp4", framesKeys: ["f.jpg"], plan: { files: { srt: "a.srt", vtt: "a.vtt" } } }), ["a.mp4", "f.jpg", "a.srt", "a.vtt"]);
    assert.deepEqual(renderFileKeys({ outputKey: null, framesKeys: null, plan: null }), []);
  });

  it("Delete all finals takes the captions files too, and the render no longer points at them", async () => {
    const { r, keys } = await final("a");
    const res = await app.inject({ method: "POST", url: "/account/delete-finals", headers: headers(), payload: {} });
    assert.equal(res.statusCode, 200);
    await gone(keys);
    const after = await prisma.render.findUniqueOrThrow({ where: { id: r.id } });
    assert.equal(after.outputKey, null);
    assert.equal((after.plan as { files?: unknown }).files, undefined);
    assert.equal((after.plan as { outputSeconds?: number }).outputSeconds, 10, "the rest of the plan is kept");
  });

  it("deleting an edit's files takes its renders' captions files", async () => {
    const { keys } = await final("b");
    await purgeProjectFiles({ id: projectId });
    await gone(keys);
  });
});
