// A render checks every graphic placement before it uses it: a graphic whose recording failed is recorded again here
// (and kept for the graphic itself), a placement's own params waiting in the queue are taken off it and recorded in
// the render's turn (not twice), and one that still cannot be recorded stops the render with its placement id and
// params. Needs Chromium, a database, Redis and storage (as in .env).
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { customParamsSchema, type V3Clip } from "@rendrr/shared";

const ready = !!process.env.DATABASE_URL && !!process.env.REDIS_URL && !!process.env.S3_BUCKET;
const run = Math.random().toString(36).slice(2, 8);
const code = `<canvas id="c" width="160" height="90"></canvas><style>body{margin:0}</style><script>
window.renderFramePure = true;
const g = document.getElementById("c").getContext("2d");
window.renderFrame = (t) => { g.clearRect(0, 0, 160, 90); g.fillStyle = window.params.color; g.fillRect(0, 0, 10 + t * 30, 90); };
</script>`;

describe("graphic placements checked before a render", { skip: !ready && "needs DATABASE_URL, REDIS_URL and storage" }, async () => {
  const { prisma } = await import("@rendrr/db");
  const { deletePrefix, enqueue, graphicVariant, headObject, queue } = await import("@rendrr/core");
  const { renderGraphicClip } = await import("../src/lib/graphics");
  let dir = "", userId = "";
  const clip = (graphicId: string, params?: Record<string, unknown>): V3Clip => ({ id: `g${run}`, start: 0, end: 2, label: "x", kind: "graphic", graphicId, ...(params ? { params } : {}) } as V3Clip);
  const graphic = (status: string, c = code, error: string | null = null) => prisma.graphic.create({ data: { ownerId: userId, name: `Bar ${run}`, kind: "custom", code: c, paramsSchema: customParamsSchema({ color: "#ff0000" }), durationSec: 2, width: 160, height: 90, transparent: true, status, error } });
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "precheck-"));
    userId = (await prisma.user.create({ data: { clerkId: `pre_${run}`, email: `pre-${run}@test.rendrr.dev`, name: "Pre" } })).id;
  });
  after(async () => {
    await deletePrefix(`graphics/${userId}/`).catch(() => {});
    await prisma.graphic.deleteMany({ where: { ownerId: userId } });
    await prisma.user.deleteMany({ where: { clerkId: `pre_${run}` } });
    await rm(dir, { recursive: true, force: true });
  });

  it("a graphic whose recording failed is recorded again by the render, and kept for the graphic", async () => {
    const g = await graphic("failed", code, "The graphic crashed while recording: socket hang up");
    const r = await renderGraphicClip(clip(g.id), { width: 640, height: 360, dir, userId });
    assert.ok(r && r.seconds >= 1.9, "it plays");
    const after_ = await prisma.graphic.findUniqueOrThrow({ where: { id: g.id } });
    assert.equal(after_.status, "ready");
    assert.ok(after_.renderedKey && (await headObject(after_.renderedKey)), "its recording is kept");
  });

  it("a placement's own params waiting in the queue are taken off it and recorded in the render's turn", async () => {
    const g = await graphic("failed", code, "crashed");
    const v = graphicVariant(g, { color: "#00ff00" })!;
    await enqueue("graphic", { graphicId: g.id, params: v.params }, { jobId: v.jobId, removeOnComplete: true, removeOnFail: true });
    const r = await renderGraphicClip(clip(g.id, { color: "#00ff00" }), { width: 640, height: 360, dir, userId });
    assert.ok(r);
    assert.ok(await headObject(v.key), "the placement's recording is kept");
    assert.equal(await queue("graphic").getJob(v.jobId), undefined, "the queued job was taken off (not recorded twice)");
  });

  it("one that cannot be recorded stops the render, naming the placement and its params", async () => {
    const g = await graphic("failed", `<script>throw new Error("boom")</script>`, "The graphic code threw an error: boom");
    await assert.rejects(renderGraphicClip(clip(g.id, { color: "#0000ff" }), { width: 640, height: 360, dir, userId }),
      (e: Error) => { assert.match(e.message, new RegExp(`^Graphic placement g${run} \\(${g.id}, params \\{"color":"#0000ff"\\}\\) could not be recorded: The graphic code threw an error: .*boom.*Nothing was lost: retry_graphic records it again`)); return true; });
  });
});
