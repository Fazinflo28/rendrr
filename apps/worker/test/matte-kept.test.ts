// A kept matte block with no picture (made by an older worker when the footage could not be read: FFmpeg wrote an
// MP4 with no stream) broke every render that joined it ("Stream specifier ':v' ... matches no streams"), and "Render
// again" read the same block again. Now such a block is found, taken out of storage and made again; a good block is
// used as kept. Needs ffmpeg, a database and storage (as in .env); not the model (making the block again stops at
// "not installed" here, after the broken one was taken out).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { MATTE_BLOCK, matteKey } from "@rendrr/shared";
import type { RenderPlan } from "@rendrr/shared/renderPlan";

const ready = !!process.env.DATABASE_URL && !!process.env.S3_BUCKET;
const run6 = Math.random().toString(36).slice(2, 8);

describe("kept matte blocks", { skip: !ready && "needs a database and storage" }, () => {
  let dir = "", userId = "", videoId = "", good = "", empty = "";
  before(async () => {
    dir = await mkdtemp(join(process.env.TMPDIR || tmpdir(), "matte-kept-"));
    const { prisma } = await import("@rendrr/db");
    good = join(dir, "good.mp4");
    execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", `color=c=white:s=64x36:r=30:d=${MATTE_BLOCK}`, "-pix_fmt", "yuv420p", "-c:v", "libx264", good]);
    // What matte.py's writer made when its reader got nothing: an MP4 with no stream at all.
    empty = join(dir, "empty.mp4");
    execFileSync("ffmpeg", ["-v", "error", "-nostdin", "-y", "-f", "rawvideo", "-pix_fmt", "gray", "-s", "64x36", "-r", "30", "-i", "/dev/null", "-c:v", "libx264", "-pix_fmt", "yuv420p", empty]);
    userId = (await prisma.user.create({ data: { clerkId: `mk_${run6}`, email: `mk-${run6}@test.rendrr.dev`, name: "Kept" } })).id;
    videoId = (await prisma.video.create({ data: { userId, name: "Talk", seconds: 3 * MATTE_BLOCK, width: 64, height: 36, source: "drive", status: "ready", proxyKey: `proxies/${userId}/talk.mp4` } })).id;
  });
  after(async () => {
    const { prisma } = await import("@rendrr/db");
    const { deletePrefix, redis } = await import("@rendrr/core");
    await deletePrefix(`frames/${userId}/`).catch(() => {});
    await prisma.video.deleteMany({ where: { userId } });
    await prisma.user.deleteMany({ where: { id: userId } });
    await redis().quit().catch(() => {});
    await rm(dir, { recursive: true, force: true });
  });

  it("tells a block with a picture from one without", async () => {
    const { matteReadable } = await import("../src/lib/matte");
    assert.equal(await matteReadable(good), true);
    assert.equal(await matteReadable(empty), false);
    assert.equal(await matteReadable(join(dir, "missing.mp4")), false);
  });

  it("uses a good kept block; takes an empty one out and makes it again", { timeout: 60_000 }, async () => {
    const { headObject, uploadFile } = await import("@rendrr/core");
    const { ensureMattes } = await import("../src/lib/matte");
    const key = (k: number) => matteKey(userId, videoId, 0, k);
    await uploadFile(key(1), good, "video/mp4");
    await uploadFile(key(2), empty, "video/mp4");
    const plan = (blocks: number[]) => ({ mattes: { m0: { videoId, blocks } }, parts: [] }) as unknown as RenderPlan;
    // The good block alone: read as kept, nothing made.
    const lists = await ensureMattes(plan([1]), userId, await mkdtemp(join(dir, "a-")));
    assert.ok(lists.m0, "the list of blocks is written");
    // With the empty one: it is not joined. It leaves storage and is made again (here the model is missing, so making
    // it stops; on the worker it is made).
    await assert.rejects(ensureMattes(plan([1, 2]), userId, await mkdtemp(join(dir, "b-"))), (e: Error) => /not installed|could not|python|ENOENT/i.test(e.message));
    assert.equal(!!(await headObject(key(2))), false, "the empty block is taken out of storage");
    assert.ok(await headObject(key(1)), "the good block stays");
  });
});
