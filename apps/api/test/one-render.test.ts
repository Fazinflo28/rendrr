// One version and one render per change from an AI. Claude's apply_edits calls before a render join one version (a
// change goes v1 to v2, not v1 to v5), and undoing goes back to before the whole change. A second preview of the same
// edit for the same request is refused (it would be another version the user must watch, and cost them tokens) until
// the user comments, changes the edit, or Claude says the user asked for something new (newRequest). The editor's
// autosave cannot overwrite a change Claude folded into the version it has. Samples do not close a version.
// Needs a database, Redis and storage (as in .env).
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

const ready = !!process.env.DATABASE_URL && !!process.env.REDIS_URL && !!process.env.S3_BUCKET;
const run = Math.random().toString(36).slice(2, 8);

describe("one version and one render per change", { skip: !ready && "needs DATABASE_URL, REDIS_URL and storage" }, async () => {
  const { prisma } = await import("@rendrr/db");
  const { stubTranscript, MCP_TOOLS } = await import("@rendrr/shared");
  const { createProject } = await import("../src/services/projects");
  const { TOOL_HANDLERS } = await import("../src/tools");
  const { startRender } = await import("../src/services/render");
  const { startSamples } = await import("../src/services/samples");
  const { applyTimelineChange, queue, redis, sealLatestVersion } = await import("@rendrr/core");
  let userId = "", projectId = "";
  const c = () => ({ userId, ai: "claude" as const });
  const tool = (name: string, input: Record<string, unknown>) => TOOL_HANDLERS[name](c(), MCP_TOOLS.find((t) => t.name === name)!.input.parse(input));
  const versionOf = async () => (await prisma.project.findUniqueOrThrow({ where: { id: projectId } })).currentVersion;
  before(async () => {
    userId = (await prisma.user.create({ data: { clerkId: `one_${run}`, email: `one-${run}@test.rendrr.dev`, name: "Ana" } })).id;
    await prisma.folder.create({ data: { userId, name: "Client", workspace: "Ana's Workspace" } });
    const analysis = { create: { transcriber: "stub", transcript: stubTranscript(20) as never, silences: [] as never, sceneCuts: [], keyFrames: [] } };
    const videoId = (await prisma.video.create({ data: { userId, name: `Talk ${run}`, seconds: 20, width: 1920, height: 1080, source: "drive", status: "ready", proxyKey: `proxies/${run}.mp4`, analysis } })).id;
    projectId = (await createProject(userId, { videoId, styleId: null })).id;
  });
  after(async () => {
    await queue("render").obliterate({ force: true }).catch(() => {});
    await prisma.review.deleteMany({ where: { userId } });
    await prisma.project.deleteMany({ where: { userId } });
    await prisma.video.deleteMany({ where: { userId } });
    await prisma.user.deleteMany({ where: { id: userId } });
    await redis().quit().catch(() => {});
  });

  it("Claude's edits before a render are one version; undo goes back to before all of them", async () => {
    assert.equal(await versionOf(), 1);
    const a = await tool("apply_edits", { projectId, edits: [{ op: "set_captions", on: true }] });
    assert.match(a.text, /Done \(v2/);
    await tool("apply_edits", { projectId, edits: [{ op: "add_text", text: "Hello", start: 1, end: 3, edit: true }] });
    const b = await tool("apply_edits", { projectId, edits: [{ op: "add_zoom", start: 4, end: 6, scale: 1.2, edit: true }] });
    assert.match(b.text, /Done \(v2/, "the third call is still v2");
    assert.equal(await versionOf(), 2);
    const v2 = await prisma.projectVersion.findUniqueOrThrow({ where: { projectId_v: { projectId, v: 2 } } });
    assert.match(v2.note, /\(and more changes\)$/);
    const acts = await prisma.aiAction.findMany({ where: { projectId }, orderBy: { createdAt: "asc" } });
    assert.deepEqual(acts.map((x) => [x.beforeVersion, x.afterVersion]), [[1, 2], [1, 2], [1, 2]], "each change undoes to before the whole change");
    // The whole change in v2: captions off, the text and the zoom.
    const tl = v2.timeline as { timeline: { captionsOn: boolean; tracks: { v2: unknown[]; v3: { kind?: string }[] } } };
    assert.equal(tl.timeline.captionsOn, true);
    assert.ok(tl.timeline.tracks.v3.some((x) => x.kind === "text") && tl.timeline.tracks.v2.length >= 1);
  });

  it("samples do not close the version", async () => {
    await startSamples(userId, projectId, { frames: [{ at: 1 }] });
    await tool("apply_edits", { projectId, edits: [{ op: "add_zoom", start: 8, end: 9, scale: 1.1, edit: true }] });
    assert.equal(await versionOf(), 2);
  });

  it("the editor's autosave from before Claude's last change is refused, not written over it", async () => {
    const p = await prisma.project.findUniqueOrThrow({ where: { id: projectId } });
    const v2 = await prisma.projectVersion.findUniqueOrThrow({ where: { projectId_v: { projectId, v: 2 } } });
    // The editor loaded the edit a minute before Claude's last change.
    const stale = v2.updatedAt.getTime() - 60_000;
    await assert.rejects(applyTimelineChange(projectId, { op: "replace", timeline: p.timeline as never }, { kind: "user", userId }, { baseVersion: 2, baseAt: stale }), /just changed this edit/);
    // Loaded after it: the autosave goes in (a version of the user's own; Claude's v2 is closed).
    const r = await applyTimelineChange(projectId, { op: "replace", timeline: { ...(p.timeline as object), captionsOn: false } as never }, { kind: "user", userId }, { baseVersion: 2, baseAt: Date.now() });
    assert.equal(r.version, 3);
    const after3 = await tool("apply_edits", { projectId, edits: [{ op: "set_captions", on: true }] });
    assert.match(after3.text, /Done \(v4/, "Claude's next change after the user's is a version of its own");
    // A render or a share seals Claude's version: that is not a change, so an autosave from after Claude's change is
    // not refused as if Claude had just changed the edit.
    const v4 = await prisma.projectVersion.findUniqueOrThrow({ where: { projectId_v: { projectId, v: 4 } } });
    await new Promise((r) => setTimeout(r, 1300));
    await sealLatestVersion(projectId);
    const sealed = await prisma.projectVersion.findUniqueOrThrow({ where: { projectId_v: { projectId, v: 4 } } });
    assert.equal(sealed.sealed, true);
    assert.equal(sealed.updatedAt.getTime(), v4.updatedAt.getTime(), "sealing keeps the version's time");
    const p4 = await prisma.project.findUniqueOrThrow({ where: { id: projectId } });
    const ok = await applyTimelineChange(projectId, { op: "replace", timeline: { ...(p4.timeline as object), captionsOn: false } as never }, { kind: "user", userId }, { baseVersion: 4, baseAt: v4.updatedAt.getTime() + 200 });
    assert.equal(ok.version, 5);
  });

  it("undo, then a new change, then undo: back to the undone state, not the change that was undone", async () => {
    const at = async () => ((await prisma.project.findUniqueOrThrow({ where: { id: projectId } })).timeline as { tracks: { v3: { kind?: string; text?: string }[] } }).tracks.v3.filter((x) => x.kind === "text").map((x) => x.text).sort();
    const before = await at();
    await tool("apply_edits", { projectId, edits: [{ op: "add_text", text: "A change", start: 14, end: 15, edit: true }] });
    assert.deepEqual(await at(), [...before, "A change"].sort());
    await tool("undo", { projectId });
    assert.deepEqual(await at(), before);
    const b = await tool("apply_edits", { projectId, edits: [{ op: "add_text", text: "B change", start: 16, end: 17, edit: true }] });
    assert.doesNotMatch(b.text, /and more changes/);
    await tool("undo", { projectId });
    assert.deepEqual(await at(), before, "A stays undone");
  });

  it("one preview per request: a second is refused until the user asks again", async () => {
    // Claude's preview of this change (the worker is not running here: it stays queued, which counts).
    await startRender(userId, projectId, "preview", { by: "claude" });
    const v = await versionOf();
    // Claude's own fix after the preview: a new version (the rendered one is closed), and no second render.
    const fix = await tool("apply_edits", { projectId, edits: [{ op: "add_zoom", start: 10, end: 11, scale: 1.15, edit: true }] });
    assert.match(fix.text, new RegExp(`Done \\(v${v + 1}`));
    // Still rendering: it says so, and how to wait for it.
    const busy = await tool("render_preview", { projectId });
    assert.match(busy.text, /^Not rendered: preview v\d+ of this edit is still rendering for this request/);
    assert.match(busy.text, /get_render \{renderId: "/);
    // Done: it says it was made for this request.
    await prisma.render.updateMany({ where: { projectId, kind: "preview" }, data: { status: "done" } });
    const again = await tool("render_preview", { projectId });
    assert.match(again.text, /^Not rendered: preview v\d+ of this edit was made \d+ min ago for this request/);
    assert.match(again.text, /newRequest: true/);
    assert.equal(await prisma.render.count({ where: { projectId, kind: "preview" } }), 1, "nothing new was rendered");
    // The user leaves a comment: the next preview goes ahead.
    await prisma.projectComment.create({ data: { projectId, userId, time: 2, text: "Bigger title" } });
    const ok = await tool("render_preview", { projectId });
    assert.doesNotMatch(ok.text, /^Not rendered/);
    assert.equal(await prisma.render.count({ where: { projectId, kind: "preview" } }), 2);
    // Then again for the same request: refused; with newRequest (the user asked for something new in the chat): rendered.
    await tool("apply_edits", { projectId, edits: [{ op: "add_zoom", start: 12, end: 13, scale: 1.1, edit: true }] });
    assert.match((await tool("render_preview", { projectId })).text, /^Not rendered/);
    // again (render the same version once more) does not get round it either.
    assert.match((await tool("render_preview", { projectId, again: true })).text, /^Not rendered/);
    assert.doesNotMatch((await tool("render_preview", { projectId, newRequest: true })).text, /^Not rendered/);
    assert.equal(await prisma.render.count({ where: { projectId, kind: "preview" } }), 3);
    // A client's note on the folder's review link (no edit named) is feedback on this edit too.
    await prisma.render.updateMany({ where: { projectId, kind: "preview" }, data: { status: "done" } });
    await tool("apply_edits", { projectId, edits: [{ op: "add_zoom", start: 14, end: 15, scale: 1.1, edit: true }] });
    assert.match((await tool("render_preview", { projectId })).text, /^Not rendered/);
    const folderId = (await prisma.project.findUniqueOrThrow({ where: { id: projectId } })).folderId;
    const rv = await prisma.review.create({ data: { token: `one_${run}`, userId, folderId } });
    await prisma.reviewComment.create({ data: { reviewToken: rv.token, projectId: null, time: 0, text: "Shorter please", author: "Client" } });
    assert.doesNotMatch((await tool("render_preview", { projectId })).text, /^Not rendered/);
    assert.equal(await prisma.render.count({ where: { projectId, kind: "preview" } }), 4);
    // Previews the user asks for in the editor are never counted.
    assert.equal(await prisma.render.count({ where: { projectId, kind: "preview", by: "claude" } }), 4);
  });
});
