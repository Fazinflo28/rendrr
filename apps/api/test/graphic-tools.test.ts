// The graphic tools after a long session's notes: create_graphic from another graphic's code with find-and-replace
// edits (a new graphic, or the same one changed in place with its placements' recordings dropped), from a link-free
// upload; retry_graphic; a failed graphic can still be placed; add_graphic rerecord and data; get_graphic and
// get_render wait_seconds; placement statuses in the result. Needs a database and Redis (as in .env).
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

const ready = !!process.env.DATABASE_URL && !!process.env.REDIS_URL;
const run = Math.random().toString(36).slice(2, 8);

describe("graphic tools", { skip: !ready && "needs DATABASE_URL and REDIS_URL" }, async () => {
  const { prisma } = await import("@rendrr/db");
  const { graphicVariant, headObject, putObject, queue, redis, setVariantError, readVariantError } = await import("@rendrr/core");
  const { MCP_TOOLS, buildInitialTimeline } = await import("@rendrr/shared");
  const { TOOL_HANDLERS } = await import("../src/tools");
  const { applyCodeEdits } = await import("../src/services/graphicCode");
  let userId = "", videoId = "", projectId = "";
  const tool = (name: string, input: Record<string, unknown>) => TOOL_HANDLERS[name]({ userId, ai: "claude" as const }, MCP_TOOLS.find((t) => t.name === name)!.input.parse(input));
  const CODE = `<div id="t" style="color:#fff;font:60px Inter">Hello</div><script>document.getElementById("t").textContent = window.params.word;</script>`;
  const fails = async (p: Promise<unknown>, re: RegExp) => { try { await p; } catch (e) { assert.match((e as Error).message, re); return; } assert.fail("it should have failed"); };

  before(async () => {
    userId = (await prisma.user.create({ data: { clerkId: `gt_${run}`, email: `gt-${run}@test.rendrr.dev`, name: "Ana" } })).id;
    const v = await prisma.video.create({ data: { userId, name: `v ${run}`, source: "upload", status: "ready", seconds: 30, width: 1920, height: 1080, fps: 30, hasAudio: true } });
    videoId = v.id;
    const tl = buildInitialTimeline([], 30, "clean", [], v.id);
    const folder = await prisma.folder.create({ data: { userId, name: `f ${run}`, workspace: "Personal" } });
    projectId = (await prisma.project.create({ data: { userId, folderId: folder.id, videoId: v.id, name: `p ${run}`, aspect: "16:9", timeline: tl as never } })).id;
  });
  after(async () => {
    for (const j of await queue("graphic").getJobs(["waiting", "prioritized", "delayed"])) if (j?.data?.graphicId) { const g = await prisma.graphic.findUnique({ where: { id: j.data.graphicId }, select: { ownerId: true } }); if (g?.ownerId === userId) await j.remove().catch(() => {}); }
    await prisma.project.deleteMany({ where: { userId } });
    await prisma.folder.deleteMany({ where: { userId } });
    await prisma.video.deleteMany({ where: { userId } });
    await prisma.graphic.deleteMany({ where: { ownerId: userId } });
    await prisma.user.deleteMany({ where: { clerkId: `gt_${run}` } });
    await redis().quit().catch(() => {});
  });

  it("edits: in order, each find once (or all: true); a missing or repeated find says which edit", () => {
    assert.equal(applyCodeEdits("a b a", [{ find: "b", replace: "c" }, { find: "a", replace: "x", all: true }]), "x c x");
    assert.throws(() => applyCodeEdits("a b", [{ find: "z", replace: "y" }]), /Edit 1: "z" is not in the code/);
    assert.throws(() => applyCodeEdits("a b a", [{ find: "b", replace: "c" }, { find: "a", replace: "x" }]), /Edit 2: "a" is in the code 2 times/);
    assert.equal(applyCodeEdits("$1 cost", [{ find: "cost", replace: "$& price" }]), "$1 $& price", "the replacement is taken as it is");
  });

  it("codeFrom + edits: a new graphic with the old one's size, length and params; replace: the same id changed in place", async () => {
    const a = await tool("create_graphic", { code: CODE, durationSec: 4, width: 640, height: 360, params: { word: "Hi" }, name: `Words ${run}` });
    const aid = (a.data as { graphicId: string }).graphicId;
    const b = await tool("create_graphic", { code_from: aid, edits: [{ find: "60px", replace: "80px" }] });
    assert.match(b.text, new RegExp(`^Made from ${aid} with 1 edit\\. `));
    const bid = (b.data as { graphicId: string }).graphicId;
    assert.notEqual(bid, aid);
    const gb = await prisma.graphic.findUniqueOrThrow({ where: { id: bid } });
    assert.ok(gb.code!.includes("80px") && !gb.code!.includes("60px"));
    assert.deepEqual([gb.durationSec, gb.width, gb.height, gb.name], [4, 640, 360, `Words ${run} (edited)`]);
    assert.deepEqual(gb.paramsSchema, (await prisma.graphic.findUniqueOrThrow({ where: { id: aid } })).paramsSchema);
    await fails(tool("create_graphic", { codeFrom: aid, edits: [{ find: "nothere", replace: "x" }] }), /Edit 1: "nothere" is not in the code. Nothing was made/);
    await fails(tool("create_graphic", { codeFrom: "nope", edits: [] }), /no graphic of yours "nope"/);
    await fails(tool("create_graphic", { code: CODE }), /needs durationSec, width, height/);

    // A placement's recording kept, and a failure noted for another: both dropped when the code changes in place.
    const ga = await prisma.graphic.findUniqueOrThrow({ where: { id: aid } });
    const v1 = graphicVariant(ga, { word: "One" })!, v2 = graphicVariant(ga, { word: "Two" })!;
    await putObject(v1.key, Buffer.from("old"), "video/webm");
    await setVariantError(v2.progressId, "crashed");
    const c = await tool("create_graphic", { codeFrom: aid, edits: [{ find: "Hello", replace: "Hey" }], replace: true });
    assert.match(c.text, /^Changed with 1 edit: same id, its placements are recorded again with the new code\. /);
    assert.equal((c.data as { graphicId: string }).graphicId, aid);
    const after_ = await prisma.graphic.findUniqueOrThrow({ where: { id: aid } });
    assert.ok(after_.code!.includes("Hey"));
    assert.equal(after_.status, "queued");
    assert.equal(await headObject(v1.key), null, "the old placement recording is gone");
    assert.equal(await readVariantError(v2.progressId), null, "the old failure is forgotten");
  });

  it("upload: a one-time link; the code sent there makes the graphic with the settings asked", async () => {
    const out = await tool("create_graphic", { upload: true, durationSec: 3, width: 640, height: 360, name: `Up ${run}` });
    const url = (out.data as { uploadUrl: string }).uploadUrl;
    assert.match(url, /\/graphics\/upload\/[\w-]{20,}$/);
    const { graphicUploadFor, resolveGraphic, saveGraphic } = await import("../src/services/graphicCode");
    const token = url.split("/").pop()!;
    const u = await graphicUploadFor(token);
    const g = await saveGraphic(u.userId, await resolveGraphic(u.userId, { ...u.i, code: CODE }));
    const row = await prisma.graphic.findUniqueOrThrow({ where: { id: g.id } });
    assert.deepEqual([row.name, row.durationSec, row.ownerId], [`Up ${run}`, 3, userId]);
  });

  it("a failed graphic can be placed; retry_graphic records it again and its failed placements too", async () => {
    const g = await prisma.graphic.create({ data: { ownerId: userId, name: `Failed ${run}`, kind: "custom", code: CODE, durationSec: 3, width: 640, height: 360, status: "failed", error: "The graphic crashed while recording: socket hang up", paramsSchema: { type: "object", properties: { word: { type: "string", default: "Hi" } }, additionalProperties: false } } });
    const r = await tool("apply_edits", { projectId, edits: [{ op: "add_graphic", graphicId: g.id, start: 1, end: 3, params: { word: "Yo" } }] });
    assert.match(r.text, /its recording failed \(The graphic crashed while recording: socket hang up\): retry_graphic records it again/);
    assert.match(r.text, /\nPlacements: \w+ failed: The graphic crashed while recording: socket hang up\. retry_graphic records failed ones again/);
    const v = graphicVariant(g, { word: "Yo" })!;
    await setVariantError(v.progressId, "crashed");
    const out = await tool("retry_graphic", { graphicId: g.id, wait_seconds: 0 });
    assert.match(out.text, /^Recording it again from its own code\. 1 placement recording queued again \(1 had failed\)\. Graphic \w+ is recording/);
    assert.equal((await prisma.graphic.findUniqueOrThrow({ where: { id: g.id } })).status, "queued");
    assert.equal(await readVariantError(v.progressId), null);
    const jobs = (await queue("graphic").getJobs(["waiting", "prioritized"])).filter((j) => j?.data?.graphicId === g.id);
    assert.equal(jobs.length, 2, "the graphic and its placement");
  });

  it("add_graphic rerecord drops the kept recording for those params; data is any JSON in window.params.data", async () => {
    const g = await prisma.graphic.create({ data: { ownerId: userId, name: `Kept ${run}`, kind: "custom", code: CODE, durationSec: 3, width: 640, height: 360, status: "ready", renderedKey: "x", paramsSchema: { type: "object", properties: { word: { type: "string", default: "Hi" } }, additionalProperties: false } } });
    const words = [{ t: "Every", s: 7.37, e: 7.54 }], params = { word: "Re", data: { words } };
    const v = graphicVariant(g, params)!;
    assert.ok(v.params.data, "data is part of the placement's values (and of its recording's key)");
    await putObject(v.key, Buffer.from("bad"), "video/webm");
    const r = await tool("apply_edits", { projectId, edits: [{ op: "add_graphic", graphicId: g.id, start: 4, end: 6, params: { word: "Re" }, data: { words }, rerecord: true }] });
    assert.match(r.text, /recorded again for these params/);
    assert.equal(await headObject(v.key), null, "the bad recording is gone (the edit queued a new one)");
    const tl = (await prisma.project.findUniqueOrThrow({ where: { id: projectId } })).timeline as { tracks: { v3: { graphicId?: string; params?: Record<string, unknown> }[] } };
    assert.deepEqual(tl.tracks.v3.find((c) => c.graphicId === g.id)!.params, params);
    await fails(tool("apply_edits", { projectId, edits: [{ op: "add_graphic", graphicId: g.id, start: 4, end: 6, params: { colour: "red" } }] }), /has no param "colour"/);
  });

  it("get_graphic and get_render wait_seconds answer as soon as the job ends", async () => {
    const g = await prisma.graphic.create({ data: { ownerId: userId, name: `Wait ${run}`, kind: "custom", code: CODE, durationSec: 3, width: 640, height: 360, status: "rendering" } });
    // (A Prisma query runs only once it is awaited or then-ed.)
    setTimeout(() => { prisma.graphic.update({ where: { id: g.id }, data: { status: "ready", renderedKey: "k" } }).then(() => {}, () => {}); }, 1500);
    const t0 = Date.now();
    const out = await tool("get_graphic", { graphicId: g.id, wait_seconds: 20 });
    assert.match(out.text, / \| ready \| /, `after ${Date.now() - t0} ms: ${JSON.stringify(await prisma.graphic.findUnique({ where: { id: g.id }, select: { status: true } }))}`);
    assert.ok(Date.now() - t0 < 6000, `answered in ${Date.now() - t0} ms`);
    const r = await prisma.render.create({ data: { projectId, userId, kind: "preview", status: "rendering", version: 1 } as never });
    setTimeout(() => { prisma.render.update({ where: { id: r.id }, data: { status: "failed", error: "test" } }).then(() => {}, () => {}); }, 1500);
    const t1 = Date.now();
    assert.match((await tool("get_render", { renderId: r.id, wait_seconds: 20 })).text, /render failed: test/);
    assert.ok(Date.now() - t1 < 6000);
  });
});
