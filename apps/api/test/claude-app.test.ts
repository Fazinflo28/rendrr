// The Rendrr app in the chat and the one-render rule: the app's tools list the edits, show one edit's latest preview,
// its render progress and comments, add and resolve comments (the editor's own tables); check_edit checks an edit
// without rendering; apply_edits ends with the edit's flags; render_preview with nothing changed renders nothing.
// Needs a database, Redis and storage (as in .env). Run: pnpm --filter @rendrr/api test
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

const ready = !!process.env.DATABASE_URL && !!process.env.REDIS_URL && !!process.env.S3_BUCKET;
const run = Math.random().toString(36).slice(2, 8);

describe("the Rendrr app and one render per revision", { skip: !ready && "needs DATABASE_URL, REDIS_URL and storage" }, async () => {
  const { prisma } = await import("@rendrr/db");
  const { stubTranscript, MCP_TOOLS, APP_TOOLS } = await import("@rendrr/shared");
  const { createProject } = await import("../src/services/projects");
  const { TOOL_HANDLERS } = await import("../src/tools");
  const { APP_HANDLERS, appMediaOrigins } = await import("../src/services/claudeApp");
  const { queue, redis } = await import("@rendrr/core");

  let userId = "", otherId = "", videoId = "", projectId = "";
  const c = (id = userId) => ({ userId: id, ai: "claude" as const });
  const app = (name: string, input: Record<string, unknown>) => APP_HANDLERS[name](c(), APP_TOOLS.find((t) => t.name === name)!.input.parse(input));
  const tool = (name: string, input: Record<string, unknown>) => TOOL_HANDLERS[name](c(), MCP_TOOLS.find((t) => t.name === name)!.input.parse(input));
  before(async () => {
    userId = (await prisma.user.create({ data: { clerkId: `app_${run}`, email: `app-${run}@test.rendrr.dev`, name: "Ana" } })).id;
    otherId = (await prisma.user.create({ data: { clerkId: `app2_${run}`, email: `app2-${run}@test.rendrr.dev`, name: "Other" } })).id;
    await prisma.folder.create({ data: { userId, name: "Client A", workspace: "Ana's Workspace" } });
    const analysis = { create: { transcriber: "stub", transcript: stubTranscript(20) as never, silences: [] as never, sceneCuts: [], keyFrames: [] } };
    videoId = (await prisma.video.create({ data: { userId, name: `Talk ${run}`, seconds: 20, width: 1080, height: 1920, source: "drive", status: "ready", proxyKey: `proxies/${run}.mp4`, thumbKey: `thumbs/${run}.jpg`, analysis } })).id;
    projectId = (await createProject(userId, { videoId, name: `Reel ${run}` })).id;
    // Version 1 already has a preview.
    await prisma.render.create({ data: { projectId, userId, kind: "preview", version: 1, status: "done", outputKey: `renders/${run}-v1.mp4`, seconds: 20, quality: "540p", steps: [] } });
  });
  after(async () => {
    for (const j of await queue("render").getJobs(["waiting", "delayed"])) if (await prisma.render.findFirst({ where: { id: (j.data as { renderId: string }).renderId, userId } })) await j.remove().catch(() => {});
    await prisma.project.deleteMany({ where: { userId } });
    await prisma.video.deleteMany({ where: { userId } });
    await prisma.user.deleteMany({ where: { id: { in: [userId, otherId] } } });
    await redis().quit().catch(() => {});
  });

  it("render_preview with nothing changed returns that version's preview and renders nothing", async () => {
    const before = await prisma.render.count({ where: { projectId } });
    const out = await tool("render_preview", { projectId });
    console.log(out.text.split("\n").slice(0, 2).join("\n"));
    assert.match(out.text, /^Nothing changed since preview v1, so nothing was rendered\./);
    assert.match(out.text, /Make every change in one apply_edits \(check_edit checks it without rendering\), then render once\./);
    assert.equal(await prisma.render.count({ where: { projectId } }), before);
  });

  it("apply_edits ends with the edit's check flags; check_edit checks it without rendering", async () => {
    const out = await tool("apply_edits", { projectId, edits: [{ op: "cut_words", from: 2, to: 3.2 }] });
    console.log(out.text);
    assert.match(out.text, /^Done \(v2,/);
    assert.match(out.text, /\nEdit check \(nothing rendered\): Flags: /);
    const before = await prisma.render.count({ where: { projectId } });
    const chk = await tool("check_edit", { projectId });
    console.log(chk.text.split("\n").slice(0, 4).join("\n"));
    assert.match(chk.text, /^Check of v2 from the edit itself \(nothing rendered\)\./);
    assert.match(chk.text, /\nCHECK /);
    assert.match(chk.text, /\nFlags: /);
    assert.equal(await prisma.render.count({ where: { projectId } }), before, "check_edit renders nothing");
  });

  it("render_preview of a changed version renders it (and again true renders a rendered version again)", async () => {
    const out = await tool("render_preview", { projectId });
    assert.match(out.text, /render is queued \(render id \w+/);
    const r = await prisma.render.findFirst({ where: { projectId, version: 2 } });
    assert.ok(r, "a render of v2");
    const again = await tool("render_preview", { projectId: projectId, again: true });
    assert.match(again.text, /render is queued/, "a running render of the same version is joined");
    assert.equal(await prisma.render.count({ where: { projectId, version: 2 } }), 1);
  });

  it("the app adds a comment at a moment; it is the editor's note and get_comments reads it", async () => {
    const out = await app("app_add_comment", { projectId, time: 3.25, text: "  Cut the pause here  " });
    const v = out.data as any;
    assert.equal(v.comments.length, 1);
    assert.deepEqual({ time: v.comments[0].time, text: v.comments[0].text, author: v.comments[0].author, mine: v.comments[0].mine, resolved: v.comments[0].resolved }, { time: 3.25, text: "Cut the pause here", author: "Ana", mine: true, resolved: false });
    assert.equal(await prisma.projectComment.count({ where: { projectId } }), 1);
    assert.match((await tool("get_comments", { projectId })).text, / \| 0:03 \| Cut the pause here \| open/);
  });

  it("the app lists the edits with their preview, render and open comments", async () => {
    const page = (await app("app_list_projects", {})).data as any;
    assert.equal(page.total, 1);
    const p = page.projects[0];
    assert.deepEqual({ id: p.id, folder: p.folder, version: p.version, previewVersion: p.previewVersion, rendering: p.rendering, openComments: p.openComments }, { id: projectId, folder: "Client A", version: 2, previewVersion: 1, rendering: true, openComments: 1 });
    assert.match(p.thumb, /^https?:\/\/.*X-Amz-Signature=/);
    assert.equal(((await app("app_list_projects", { query: "nothing like it" })).data as any).total, 0);
    assert.equal(((await app("app_list_projects", { query: `reel ${run}` })).data as any).total, 1);
  });

  it("the app shows one edit: the latest preview (signed), the render of the newer version, and its comments", async () => {
    const v = (await app("app_get_project", { projectId })).data as any;
    assert.equal(v.project.version, 2);
    assert.equal(v.preview.version, 1);
    assert.match(v.preview.url, /^https?:\/\/.*X-Amz-Signature=/);
    assert.equal(v.rendering.version, 2);
    assert.equal(v.rendering.queued, true);
    assert.equal(v.failed, null);
    // Where the app's video comes from: the storage the links point to.
    assert.deepEqual(await appMediaOrigins(), [new URL(v.preview.url).origin]);
    await assert.rejects(APP_HANDLERS.app_get_project(c(otherId), { projectId }), /could not find|not found|does not exist|gone/i);
  });

  it("the app resolves a comment and opens it again", async () => {
    const id = (await prisma.projectComment.findFirstOrThrow({ where: { projectId } })).id;
    let v = (await app("app_resolve_comment", { projectId, commentId: id })).data as any;
    assert.equal(v.comments[0].resolved, true);
    assert.equal(((await app("app_list_projects", {})).data as any).projects[0].openComments, 0);
    v = (await app("app_resolve_comment", { projectId, commentId: id, resolved: false })).data as any;
    assert.equal(v.comments[0].resolved, false);
    await assert.rejects(APP_HANDLERS.app_resolve_comment(c(otherId), { projectId, commentId: id }), /could not find|not found|does not exist|gone/i);
  });

  it("open_projects tells the AI what the user sees and gives the app the page (and the edit asked for)", async () => {
    const all = await tool("open_projects", {});
    assert.match(all.text, /^Showing the Rendrr app with 1 edit\. Newest: Reel \w+ \(\w+, v2, 1 open comments\)\./);
    assert.equal((all.data as any).open, null);
    const one = await tool("open_projects", { projectId });
    console.log(one.text);
    assert.match(one.text, /Open: "Reel \w+" \(\w+\), v2; preview v1, rendering v2 \(0%\); 1 open comment \(get_comments reads them\)\./);
    assert.equal((one.data as any).open.project.id, projectId);
    assert.equal((one.data as any).projects.length, 1);
  });

  it("the app's tools go through the internal route as the user; its polling is not logged as tool calls", async () => {
    const { buildServer } = await import("../src/server");
    const srv = await buildServer();
    try {
      const headers = { "x-internal-secret": process.env.INTERNAL_API_SECRET!, "x-rendrr-clerk-id": `app_${run}`, "x-rendrr-ai": "claude" };
      const logged = () => prisma.usageEvent.count({ where: { userId, kind: "mcp_tool" } });
      const n0 = await logged();
      const get = await srv.inject({ method: "POST", url: "/internal/tools/app_get_project", headers, payload: { projectId } });
      assert.equal(get.statusCode, 200, get.body);
      assert.equal(get.json().data.project.id, projectId);
      assert.equal(await logged(), n0, "a read by the app is not logged");
      const add = await srv.inject({ method: "POST", url: "/internal/tools/app_add_comment", headers, payload: { projectId, time: 5, text: "From the route" } });
      assert.equal(add.statusCode, 200, add.body);
      assert.equal(await logged(), n0 + 1, "a write is");
      const bad = await srv.inject({ method: "POST", url: "/internal/tools/app_add_comment", headers, payload: { projectId, time: 5, text: "   " } });
      assert.equal(bad.statusCode, 400, bad.body);
      const cfg = await srv.inject({ method: "GET", url: "/internal/app-config", headers });
      assert.deepEqual(cfg.json().mediaOrigins, await appMediaOrigins());
      const none = await srv.inject({ method: "POST", url: "/internal/tools/app_nothing", headers, payload: {} });
      assert.equal(none.statusCode, 404);
    } finally { await srv.close(); }
  });

  it("get_editing_skill returns the skill", async () => {
    const out = await tool("get_editing_skill", {});
    assert.match(out.text, /^# Fazinflo Editing Skill \(Rendrr edition\)/);
  });
});
