// A new edit, from the app or the connector, is the raw footage: version 1 only, nothing cut, captions off, no style.
// A reference (a style, a gallery recipe or a reference video) is attached for the AI and never applied.
// Needs a database (as in .env). Run: pnpm --filter @rendrr/api test
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

const ready = !!process.env.DATABASE_URL && !!process.env.REDIS_URL;
const run = Math.random().toString(36).slice(2, 8);

describe("new edits start raw; references are attached, not applied", { skip: !ready && "needs DATABASE_URL and REDIS_URL" }, async () => {
  const { prisma } = await import("@rendrr/db");
  const { stubTranscript } = await import("@rendrr/shared");
  const { createProject, resolveReference } = await import("../src/services/projects");
  const { TOOL_HANDLERS } = await import("../src/tools");
  const { redis } = await import("@rendrr/core");

  let userId = "", otherUser = "", videoId = "", refVideoId = "";
  const tr = stubTranscript(20);
  const c = () => ({ userId, ai: "claude" as const, clerkId: `raw_${run}` });

  before(async () => {
    userId = (await prisma.user.create({ data: { clerkId: `raw_${run}`, email: `raw-${run}@test.rendrr.dev`, name: "Raw" } })).id;
    otherUser = (await prisma.user.create({ data: { clerkId: `raw2_${run}`, email: `raw2-${run}@test.rendrr.dev`, name: "Other" } })).id;
    await prisma.folder.create({ data: { userId, name: "My edits", workspace: "Raw's Workspace" } });
    const analysis = { create: { transcriber: "stub", transcript: tr as never, silences: [{ start: 5, end: 7 }] as never, sceneCuts: [], keyFrames: [] } };
    videoId = (await prisma.video.create({ data: { userId, name: `Talk ${run}`, seconds: 20, width: 1920, height: 1080, source: "drive", status: "ready", analysis } })).id;
    refVideoId = (await prisma.video.create({ data: { userId, name: `Ref ${run}`, kind: "reference", seconds: 20, source: "local", status: "ready", analysis: { create: { transcriber: "stub", transcript: tr as never, silences: [], sceneCuts: [], keyFrames: [] } } } })).id;
  });
  after(async () => {
    await prisma.project.deleteMany({ where: { userId: { in: [userId, otherUser] } } });
    await prisma.galleryItem.deleteMany({ where: { userId: { in: [userId, otherUser] } } });
    await prisma.video.deleteMany({ where: { userId } });
    await prisma.user.deleteMany({ where: { id: { in: [userId, otherUser] } } });
    await redis().quit().catch(() => {});
  });

  it("the app's new edit is version 1 only: the footage as recorded, captions off, no style, nothing applied", async () => {
    const p = await createProject(userId, { videoId });
    assert.equal(p.styleId, null);
    assert.equal(p.reference, null);
    assert.equal(p.currentVersion, 1);
    const versions = await prisma.projectVersion.findMany({ where: { projectId: p.id } });
    assert.deepEqual(versions.map((v) => [v.v, v.note]), [[1, "Footage as recorded"]]);
    const tl = p.timeline as { captionsOn: boolean; cut: string[]; tracks: Record<string, unknown[]> };
    assert.equal(tl.captionsOn, false);
    assert.deepEqual(tl.cut, []);
    assert.equal(tl.tracks.v2.length + tl.tracks.a2.length + tl.tracks.a3.length, 0);
    assert.equal(Math.round(p.outputSeconds), 20); // nothing removed
    assert.equal(await prisma.aiAction.count({ where: { projectId: p.id } }), 0); // no automatic step was run
  });

  it("a style reference is stored and named but changes nothing in the edit", async () => {
    const plain = await createProject(userId, { videoId });
    const p = await createProject(userId, { videoId, reference: { kind: "style", id: "s1" } });
    assert.deepEqual(p.reference, { kind: "style", id: "s1", name: "Bold Talking Head" });
    assert.equal(p.styleId, null);
    assert.equal(p.currentVersion, 1);
    assert.deepEqual(p.timeline, plain.timeline);
  });

  it("references: a reference video, a gallery recipe that allows recreating; refused otherwise", async () => {
    assert.deepEqual(await resolveReference(userId, { kind: "video", id: refVideoId }), { kind: "video", id: refVideoId, name: `Ref ${run}` });
    const open = await prisma.galleryItem.create({ data: { userId: otherUser, author: "Other", title: `Open ${run}`, styleId: "s4", ori: "9:16", allowRecreate: true } });
    const closed = await prisma.galleryItem.create({ data: { userId: otherUser, author: "Other", title: `Closed ${run}`, styleId: "s4", ori: "9:16", allowRecreate: false } });
    assert.deepEqual(await resolveReference(userId, { kind: "recipe", id: open.id }), { kind: "recipe", id: open.id, name: `Open ${run}` });
    await assert.rejects(resolveReference(userId, { kind: "recipe", id: closed.id }), /not available/);
    await assert.rejects(resolveReference(userId, { kind: "style", id: "nope" }), /not available/);
    await assert.rejects(resolveReference(otherUser, { kind: "video", id: refVideoId }), /not available/);
    const p = await createProject(userId, { videoId, reference: { kind: "recipe", id: open.id } });
    assert.equal((p.reference as { kind: string }).kind, "recipe");
    assert.equal(p.currentVersion, 1);
  });

  it("the connector: create_project says it is raw, styleId is a reference, get_project names it; apply_style is the AI's choice", async () => {
    const r = await TOOL_HANDLERS.create_project(c(), { videoId, styleId: "s1" });
    assert.match(r.text, /v1 = the footage as recorded \(nothing cut, captions off, no style\)/);
    assert.match(r.text, /Reference the user attached, not applied: style s1 "Bold Talking Head" \(get_style\)/);
    const projectId = (r as { data: { projectId: string } }).data.projectId;
    let g = await TOOL_HANDLERS.get_project(c(), { projectId });
    assert.match(g.text, /no style applied/);
    assert.match(g.text, /Reference the user attached, not applied: style s1/);
    assert.match(g.text, /Captions off/);
    // The AI decides to use it: now the style is the edit's, and the reference stays attached.
    await TOOL_HANDLERS.apply_edits(c(), { projectId, edits: [{ op: "apply_style", styleId: "s1" }] });
    g = await TOOL_HANDLERS.get_project(c(), { projectId });
    assert.match(g.text, /style Bold Talking Head applied/);
    assert.match(g.text, /Reference the user attached/);
    const list = await TOOL_HANDLERS.list_projects(c(), {});
    assert.match(list.text, /style applied/);
    assert.match(list.text, /\| none \|/); // the edits made raw
  });
});
