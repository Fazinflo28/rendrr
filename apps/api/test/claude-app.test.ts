// The Rendrr app in the chat and the one-render rule: the app's tools list the edits, show one edit's latest preview,
// its render progress and comments, add and resolve comments (the editor's own tables); check_edit checks an edit
// without rendering; apply_edits ends with the edit's flags; render_preview with nothing changed renders nothing (a
// graphic in the edit changed in place is a change).
// Needs a database, Redis and storage (as in .env). Run: pnpm --filter @rendrr/api test
import assert from "node:assert/strict";
import type { AppProjectView } from "@rendrr/shared";
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
    assert.match((await tool("get_comments", { projectId })).text, / \| 0:03\.250 \| Cut the pause here \| open/);
  });

  it("the app lists the edits with their preview, render and open comments", async () => {
    const page = (await app("app_list_projects", {})).data as any;
    assert.equal(page.total, 1);
    const p = page.projects[0];
    assert.deepEqual({ id: p.id, folder: p.folder, version: p.version, previewVersion: p.previewVersion, rendering: p.rendering, openComments: p.openComments }, { id: projectId, folder: "Client A", version: 2, previewVersion: 1, rendering: true, openComments: 1 });
    assert.match(p.thumb, /^https?:\/\/.*X-Amz-Signature=/);
    assert.equal(((await app("app_list_projects", { query: "nothing like it" })).data as any).total, 0);
    assert.equal(((await app("app_list_projects", { query: `reel ${run}` })).data as any).total, 1);
    // The projects come with the first page: each with its count of edits, open comments and whether one renders.
    const f = page.folders.find((x: any) => x.name === "Client A");
    assert.deepEqual({ edits: f.edits, openComments: f.openComments, rendering: f.rendering, aspect: f.aspect }, { edits: 1, openComments: 1, rendering: true, aspect: p.aspect });
    assert.match(f.thumb, /^https?:\/\/.*X-Amz-Signature=/);
    assert.equal(p.folderId, f.id);
    // One project's edits: only its own, named.
    const inF = (await app("app_list_projects", { folderId: f.id })).data as any;
    assert.deepEqual([inF.total, inF.projects[0].id, inF.folder.name, inF.folders], [1, projectId, "Client A", undefined]);
    const empty = await prisma.folder.create({ data: { userId, name: `Empty ${run}`, workspace: "W" } });
    assert.equal(((await app("app_list_projects", { folderId: empty.id })).data as any).total, 0);
    assert.equal(((await app("app_list_projects", {})).data as any).folders.find((x: any) => x.id === empty.id).edits, 0);
    await assert.rejects(APP_HANDLERS.app_list_projects(c(otherId), { folderId: f.id }), /could not find|not found|does not exist|gone/i);
    assert.equal(((await app("app_get_project", { projectId })).data as any).project.folderId, f.id);
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

  it("open_projects tells the AI what the user sees and gives the app the page, or only the edit asked for", async () => {
    const all = await tool("open_projects", {});
    assert.match(all.text, /^Showing the Rendrr app: \d+ projects?, 1 edit \(the user opens a project to see its videos\)\. Newest: Reel \w+ \(\w+, v2, 1 open comments\)\./);
    assert.equal((all.data as any).open, null);
    const one = await tool("open_projects", { projectId });
    console.log(one.text);
    assert.match(one.text, /^Showing "Reel \w+" \(\w+\) in the Rendrr app, v2; preview v1, rendering v2 \(0%\) on Rendrr's cloud server; 1 open comment \(get_comments reads them\)\. The Rendrr app \(Mac or Windows\) is not open: finals go to Google Drive or a download\./);
    assert.equal((one.data as any).open.project.id, projectId);
    // Only that edit: not the list and its picture links (the app loads the list when the user goes back).
    assert.equal((one.data as any).projects, undefined);
    assert.ok(JSON.stringify(one.data).length < JSON.stringify(all.data).length + JSON.stringify((one.data as any).open).length);
  });

  it("open_projects opens what it is given: a project (folder) by id or name, an edit by name; an id that names nothing shows the list", async () => {
    const folder = await prisma.folder.findFirstOrThrow({ where: { userId, name: "Client A" } });
    for (const input of [{ projectId: folder.id }, { folderId: folder.id }, { projectId: "client a" }]) {
      const out = await tool("open_projects", input);
      assert.match(out.text, /^Showing the project "Client A" \(\w+\) in the Rendrr app: \d+ edits?\./, JSON.stringify(input));
      assert.equal((out.data as any).folder.id, folder.id);
      assert.equal((out.data as any).open, null);
    }
    const byName = await tool("open_projects", { projectId: `reel ${run}` });
    assert.equal((byName.data as any).open.project.id, projectId);
    const none = await tool("open_projects", { projectId: "cm-not-a-thing" });
    assert.match(none.text, /^Showing the Rendrr app: .* No edit or project is called "cm-not-a-thing", so the list is shown \(list_projects has the ids\)\.$/);
    assert.equal((none.data as any).open, null);
    // Someone else's project is not opened.
    const theirs = await prisma.folder.create({ data: { userId: otherId, name: `Theirs ${run}`, workspace: "Other's Workspace" } });
    const other = await tool("open_projects", { projectId: theirs.id });
    assert.match(other.text, /No edit or project is called/);
    await prisma.folder.delete({ where: { id: theirs.id } });
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

  it("a comment can carry a drawing on the picture and pictures; Claude reads them in words, then sees them", async () => {
    const { headObject } = await import("@rendrr/core");
    const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
    const JPG = "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=";
    const render1 = (await prisma.render.findFirstOrThrow({ where: { projectId, version: 1 } })).id;
    const drawing = { w: 1080, h: 1920, strokes: [{ c: "#FF3B30", w: 0.006, p: [0.4, 0.2, 0.5, 0.25, 0.6123456, 0.3] }], png: PNG };
    let v = (await app("app_add_comment", { projectId, time: 7.125, text: "Make the logo smaller, like https://example.com/ref", renderId: render1, drawing, images: [{ type: "image/jpeg", data: JPG, name: "ref.jpg", w: 1, h: 1 }, { type: "image/png", data: PNG }] })).data as any;
    const n = v.comments.find((x: any) => x.time === 7.125);
    assert.equal(n.renderId, render1);
    assert.deepEqual(n.drawing, { w: 1080, h: 1920, strokes: [{ c: "#ff3b30", w: 0.006, p: [0.4, 0.2, 0.5, 0.25, 0.6123, 0.3] }] });
    assert.equal(n.images.length, 2);
    assert.match(n.images[0].url, /X-Amz-Signature=/);
    assert.equal(n.images[0].name, "ref.jpg");
    const row = await prisma.projectComment.findUniqueOrThrow({ where: { id: n.id } });
    const keys = [(row.drawing as any).key, ...(row.images as any[]).map((i) => i.key)];
    assert.equal(keys.length, 3);
    for (const k of keys) { assert.ok(k.startsWith(`comments/${userId}/${projectId}/${n.id}/`), k); assert.ok(await headObject(k), `${k} is stored`); }
    // Claude, in words: the time to the ms, the preview it was made on, the drawing, the pictures.
    const words = (await tool("get_comments", { projectId })).text;
    console.log(words);
    assert.match(words, new RegExp(`${n.id} \\| 0:07\\.125 \\| Make the logo smaller, like https://example\\.com/ref \\| on preview v1 \\| a drawing in red: 1 stroke over x 40-61%, y 20-30% of the picture \\| 2 pictures \\| open`));
    assert.match(words, /images true shows the open notes' pictures and drawings\./);
    // A comment needs something: words, a drawing or a picture; pictures are checked by their bytes.
    await assert.rejects(app("app_add_comment", { projectId, time: 1, text: "  " }), /Write a comment, draw on the picture or add a picture first/);
    await assert.rejects(app("app_add_comment", { projectId, time: 1, text: "x", images: [{ type: "image/png", data: Buffer.from("<svg onload=alert(1)>").toString("base64") }] }), /must be a JPEG, PNG or WebP/);
    assert.equal(await prisma.projectComment.count({ where: { projectId, text: "x" } }), 0, "nothing half made");
    // Edit: new words, one picture off, the drawing off; its files go.
    v = (await app("app_edit_comment", { projectId, commentId: n.id, text: "Logo smaller", removeImages: [n.images[1].id], drawing: null })).data as any;
    const e = v.comments.find((x: any) => x.id === n.id);
    assert.deepEqual({ text: e.text, edited: e.edited, drawing: e.drawing, images: e.images.length }, { text: "Logo smaller", edited: true, drawing: null, images: 1 });
    assert.equal(await headObject(keys[0]), null, "the drawing's file is gone");
    assert.equal(await headObject(keys[2]), null, "the picture's file is gone");
    assert.ok(await headObject(keys[1]), "the kept picture stays");
    // Pictures for Claude to look at (a note with only pictures: no frame needed).
    const seen = await tool("get_comments", { projectId, images: true });
    assert.equal(seen.images?.length, 1);
    assert.match(seen.text, new RegExp(`Images, in order:\\n1\\. note ${n.id}: picture "ref\\.jpg"`));
    // Only the user's own notes can be changed; a client's can be deleted.
    const review = await prisma.review.create({ data: { token: `t_${run}`, userId, projectId } });
    const cc = await prisma.reviewComment.create({ data: { reviewToken: review.token, projectId, time: 2, text: "Client says hi", author: "Dana" } });
    await assert.rejects(app("app_edit_comment", { projectId, commentId: cc.id, text: "changed" }), /not yours to change|gone/);
    v = (await app("app_delete_comment", { projectId, commentId: cc.id })).data as any;
    assert.ok(!v.comments.some((x: any) => x.id === cc.id));
    await assert.rejects(APP_HANDLERS.app_delete_comment(c(otherId), { projectId, commentId: n.id }), /could not find|gone/i);
    // Delete: the note and every file it had.
    v = (await app("app_delete_comment", { projectId, commentId: n.id })).data as any;
    assert.ok(!v.comments.some((x: any) => x.id === n.id));
    assert.equal(await headObject(keys[1]), null);
  });

  it("the editor can change a note's words and delete notes; deleting the edit takes its comments' files", async () => {
    const { buildServer } = await import("../src/server");
    const { headObject } = await import("@rendrr/core");
    const { purgeProjectFiles } = await import("../src/services/projects");
    const srv = await buildServer();
    try {
      const headers = { "x-internal-secret": process.env.INTERNAL_API_SECRET!, "x-rendrr-clerk-id": `app_${run}` };
      const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
      const v = (await app("app_add_comment", { projectId, time: 9, text: "Old words", images: [{ type: "image/png", data: PNG }] })).data as any;
      const id = v.comments.find((x: any) => x.time === 9).id;
      const full = await srv.inject({ method: "GET", url: `/projects/${projectId}`, headers });
      const shown = full.json().comments.find((x: any) => x.id === id);
      assert.equal(shown.images.length, 1, "the editor gets the pictures");
      const ed = await srv.inject({ method: "PATCH", url: `/comments/${id}`, headers, payload: { text: "New words" } });
      assert.equal(ed.statusCode, 200, ed.body);
      assert.deepEqual({ text: ed.json().text, edited: ed.json().edited }, { text: "New words", edited: true });
      const key = ((await prisma.projectComment.findUniqueOrThrow({ where: { id } })).images as any[])[0].key;
      await purgeProjectFiles({ id: projectId });
      assert.equal(await headObject(key), null, "deleting the edit takes the comments' files");
      const del = await srv.inject({ method: "DELETE", url: `/comments/${id}`, headers });
      assert.equal(del.statusCode, 200, del.body);
      assert.equal(await prisma.projectComment.count({ where: { id } }), 0);
    } finally { await srv.close(); }
  });

  it("the app lists every rendered version, opens the one picked, gives its download, and renames the edit", async () => {
    const fin = await prisma.render.create({ data: { projectId, userId, kind: "final", version: 1, status: "done", outputKey: `renders/${run}-f1.mp4`, seconds: 20, quality: "1080p", steps: [] } });
    const v = (await app("app_get_project", { projectId })).data as AppProjectView;
    assert.deepEqual(v.versions.map((x) => `${x.kind} v${x.version} ${x.quality}`).slice(0, 2), ["final v1 1080p", "preview v1 540p"]);
    assert.equal(v.preview!.kind, "preview"); // the latest preview is what plays by default
    assert.match(v.preview!.download, /response-content-disposition=attachment/);
    assert.equal(v.preview!.fileName, `Reel ${run} preview v1.mp4`);
    const f = (await app("app_get_project", { projectId, renderId: fin.id })).data as AppProjectView;
    assert.equal(f.preview!.renderId, fin.id);
    assert.equal(f.preview!.kind, "final");
    assert.equal(f.preview!.fileName, `Reel ${run} final v1.mp4`);
    // Another user's render id plays this edit's latest preview, never theirs.
    const o = (await app("app_get_project", { projectId, renderId: "nope-not-mine" })).data as AppProjectView;
    assert.equal(o.preview!.kind, "preview");
    const r = await app("app_rename_project", { projectId, name: `Reel ${run} for the client` });
    assert.equal((r.data as AppProjectView).project.name, `Reel ${run} for the client`);
    assert.equal((await prisma.project.findUniqueOrThrow({ where: { id: projectId } })).name, `Reel ${run} for the client`);
    await assert.rejects(APP_HANDLERS.app_rename_project(c(otherId), { projectId, name: "Mine now" }), /could not find|not found|does not exist|gone/i);
    await prisma.project.update({ where: { id: projectId }, data: { name: `Reel ${run}` } });
  });

  it("render_preview renders again when a graphic in the edit was changed in place (create_graphic replace)", async () => {
    // Its own edit with one custom graphic placed, and a preview of that version made after the graphic.
    const pid = (await createProject(userId, { videoId, name: `Bar ${run}` })).id;
    const code = `<canvas id="c"></canvas><script>window.renderFrame = (t) => { const g = document.getElementById("c").getContext("2d"); g.fillStyle = "#FFC400"; g.fillRect(0, 0, t * 10, 9); };</script>`;
    const old = new Date(Date.now() - 60_000);
    const g = await prisma.graphic.create({ data: { ownerId: userId, name: `Bar ${run}`, kind: "custom", code, durationSec: 5, width: 640, height: 360, status: "ready", changedAt: old, createdAt: old } });
    const p = await prisma.project.findUniqueOrThrow({ where: { id: pid } });
    const tl = p.timeline as { tracks: { v3: unknown[] } };
    tl.tracks.v3 = [{ id: `gb${run}`, start: 0, end: 5, label: "Bar", kind: "graphic", graphicId: g.id }];
    await prisma.project.update({ where: { id: pid }, data: { timeline: tl as never } });
    const ver = await prisma.projectVersion.findFirstOrThrow({ where: { projectId: pid } });
    await prisma.projectVersion.update({ where: { id: ver.id }, data: { timeline: { ...(ver.timeline as object), timeline: tl } as never } });
    await prisma.render.create({ data: { projectId: pid, userId, kind: "preview", version: 1, status: "done", outputKey: `renders/${run}-bar.mp4`, seconds: 20, quality: "540p", steps: [], createdAt: new Date(Date.now() - 30_000) } });
    const count = () => prisma.render.count({ where: { projectId: pid } });
    assert.match((await tool("render_preview", { projectId: pid })).text, /^Nothing changed since preview v1/);
    assert.equal(await count(), 1);
    // One line of its code fixed in place: same id, same edit.
    const fix = await tool("create_graphic", { codeFrom: g.id, edits: [{ find: "#FFC400", replace: "#38E07B" }], replace: true });
    assert.match(fix.text, /^Changed with 1 edit: same id/);
    const again = await tool("render_preview", { projectId: pid });
    console.log(again.text.split("\n")[0]);
    assert.match(again.text, new RegExp(`^"Bar ${run}" \\(${g.id}\\) changed since preview v1: rendering it again\\.`));
    assert.equal(await count(), 2, "rendered again");
    // That new preview done: asking again renders nothing.
    await prisma.render.updateMany({ where: { projectId: pid, status: { not: "done" } }, data: { status: "done", outputKey: `renders/${run}-bar2.mp4`, seconds: 20 } });
    assert.match((await tool("render_preview", { projectId: pid })).text, /^Nothing changed since preview v1/);
    assert.equal(await count(), 2);
    for (const j of await queue("graphic").getJobs(["waiting", "delayed"])) if ((j.data as { graphicId?: string }).graphicId === g.id) await j.remove().catch(() => {});
  });

  it("a whole project folder is shared with one link: create_review_link folderId, and the app's Share on a project", async () => {
    const folderId = (await prisma.project.findUniqueOrThrow({ where: { id: projectId } })).folderId;
    const edits = await prisma.project.count({ where: { folderId, deletedAt: null } });
    const out = await tool("create_review_link", { folderId });
    assert.match(out.text, new RegExp(`Review link for the whole project \\(${edits} edits?\\): .*/review/(\\w+)`));
    assert.match(out.text, /added to the project later show up/);
    const tok = /\/review\/(\w+)/.exec(out.text)![1];
    const row = await prisma.review.findUniqueOrThrow({ where: { token: tok } });
    assert.deepEqual([row.folderId, row.projectId], [folderId, null], "the link is the folder's, not one edit's");
    await assert.rejects(() => tool("create_review_link", {}), /projectId \(one edit\) or folderId/);
    await assert.rejects(() => tool("create_review_link", { projectId, folderId }), /not both/);
    // The app's Share on a project: that link again (no password, still good), with the project and how many edits.
    const a1 = await app("app_share_link", { folderId }) as { data: { url: string; folder: { id: string; name: string }; edits: number; created: boolean } };
    assert.equal(a1.data.folder.id, folderId);
    assert.equal(a1.data.edits, edits);
    assert.match(a1.data.url, /\/review\/\w+$/);
    const a2 = await app("app_share_link", { folderId }) as { data: { url: string; created: boolean } };
    assert.deepEqual([a2.data.url, a2.data.created], [a1.data.url, false], "the same link the next time");
    // Someone else's project is not theirs to share.
    await assert.rejects(() => APP_HANDLERS.app_share_link(c(otherId), { folderId }), /gone, or is not yours/);
    await assert.rejects(() => app("app_share_link", {}), /Pick an edit or a project/);
  });

  it("render_final quality best: a render at the best quality (its label says so), apart from a standard one; asked again, the same", async () => {
    const finals = () => prisma.render.findMany({ where: { projectId, kind: "final" }, orderBy: { createdAt: "asc" } });
    const before = (await finals()).length;
    await tool("render_final", { projectId, quality: "best" });
    let fs = await finals();
    const best = fs[fs.length - 1];
    assert.equal(fs.length, before + 1);
    assert.match(best.quality, /^1080p best$/, `vertical 1080p footage: 1080p, at the best quality (${best.quality})`);
    await tool("render_final", { projectId, quality: "best" });
    assert.equal((await finals()).length, before + 1, "asked again while it renders: the same render");
    await tool("render_final", { projectId });
    fs = await finals();
    const std = fs[fs.length - 1];
    assert.equal(fs.length, before + 2, "a standard final of the same version is a render of its own");
    assert.doesNotMatch(std.quality, /best/);
    const desc = MCP_TOOLS.find((t) => t.name === "render_final")!.description;
    assert.match(desc, /never download the file and upload it again/);
    assert.match(desc, /Drive folder link/);
  });

  it("get_editing_skill returns the skill", async () => {
    const out = await tool("get_editing_skill", {});
    assert.match(out.text, /^# Fazinflo Editing Skill \(Rendrr edition\)/);
  });
});
