// Videos into another project (move_to_project, and the folder page's Move to project): an edit moves with its
// versions, renders and comments; footage goes in as a new edit (the Library keeps it); a project is found by id or name,
// a new name makes one and a shared name is refused; another user's things, deleted edits, the project they are already
// in and a footage id sent as an edit are each said plainly. Needs a database, Redis and storage (as in .env).
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

process.env.INTERNAL_API_SECRET ||= "test-internal-secret";
process.env.LOG_LEVEL = process.env.TEST_LOG || "silent";
const ready = !!process.env.DATABASE_URL && !!process.env.REDIS_URL && !!process.env.S3_BUCKET;
const run = Math.random().toString(36).slice(2, 8);

describe("moving videos into projects", { skip: !ready && "needs DATABASE_URL, REDIS_URL and storage" }, async () => {
  const { prisma } = await import("@rendrr/db");
  const { stubTranscript, MCP_TOOLS } = await import("@rendrr/shared");
  const { createProject } = await import("../src/services/projects");
  const { TOOL_HANDLERS } = await import("../src/tools");
  const { redis } = await import("@rendrr/core");
  const { buildServer } = await import("../src/server");
  let app: Awaited<ReturnType<typeof buildServer>>;
  let userId = "", otherId = "", fromId = "", toId = "", theirFolder = "", talk = "";
  const clerkId = `mv_${run}`;
  const c = () => ({ userId, ai: "claude" as const, clerkId });
  const move = (i: Record<string, unknown>) => TOOL_HANDLERS.move_to_project(c(), i as never);
  const headers = () => ({ "x-internal-secret": process.env.INTERNAL_API_SECRET!, "x-rendrr-clerk-id": clerkId });
  const video = async (name: string, owner = userId, status = "ready") => (await prisma.video.create({ data: { userId: owner, name, seconds: 20, width: 1280, height: 720, source: "drive", status, proxyKey: `proxies/${run}-${name}.mp4`, analysis: status === "ready" ? { create: { transcriber: "stub", transcript: stubTranscript(20) as never, silences: [] as never, sceneCuts: [], keyFrames: [] } } : undefined } })).id;
  const folder = async (name: string, owner = userId) => (await prisma.folder.create({ data: { userId: owner, name, workspace: "Personal" } })).id;

  before(async () => {
    app = await buildServer();
    userId = (await prisma.user.create({ data: { clerkId, email: `mv-${run}@test.rendrr.dev`, name: "Mover" } })).id;
    otherId = (await prisma.user.create({ data: { clerkId: `mvo_${run}`, email: `mvo-${run}@test.rendrr.dev`, name: "Other" } })).id;
    fromId = await folder(`Client A ${run}`);
    toId = await folder(`Client B ${run}`);
    theirFolder = await folder(`Theirs ${run}`, otherId);
    talk = await video("Talk");
  });
  after(async () => {
    for (const u of [userId, otherId]) {
      await prisma.project.deleteMany({ where: { userId: u } });
      await prisma.folder.deleteMany({ where: { userId: u } });
      await prisma.video.deleteMany({ where: { userId: u } });
    }
    await prisma.user.deleteMany({ where: { id: { in: [userId, otherId] } } });
    await app.close(); await redis().quit().catch(() => {});
  });

  it("is a tool the AI sees, one that writes but does not delete", () => {
    const t = MCP_TOOLS.find((x) => x.name === "move_to_project");
    assert.ok(t && t.write && !t.destructive);
  });

  it("an edit moves with its versions, renders and comments", async () => {
    const p = await createProject(userId, { videoId: talk, name: `Promo ${run}`, folderId: fromId });
    await prisma.projectVersion.create({ data: { projectId: p.id, v: 2, note: "cut", timeline: p.timeline as never, createdBy: "user" } });
    await prisma.render.create({ data: { projectId: p.id, userId, kind: "preview", version: 2, status: "done" } as never });
    await prisma.projectComment.create({ data: { projectId: p.id, userId, text: "Tighter here", time: 3 } });
    const r = await move({ items: [{ kind: "edit", id: p.id }], project: toId });
    assert.match(r.text, new RegExp(`^Moved 1 of 1 into the project "Client B ${run}" \\(${toId}\\):\\n- Edit "Promo ${run}" moved from "Client A ${run}" to "Client B ${run}"\\.`));
    const moved = await prisma.project.findUniqueOrThrow({ where: { id: p.id }, include: { versions: true, renders: true, notes: true } });
    assert.equal(moved.folderId, toId);
    assert.equal(moved.versions.length, 2);
    assert.equal(moved.renders.length, 1);
    assert.equal(moved.notes.length, 1);
    assert.match((await move({ items: [{ kind: "edit", id: p.id }], project: toId })).text, /^Moved 0 of 1 .*\n- Edit "Promo \w+" is already in "Client B \w+"\./);
  });

  it("footage goes in as a new edit; the Library keeps it; its other edits are named", async () => {
    const r = await move({ items: [{ kind: "video", id: talk }], project: `client a ${run}` });
    assert.match(r.text, /^Moved 1 of 1 into the project "Client A \w+"/);
    assert.match(r.text, /Video "Talk" is in "Client A \w+" as a new edit "Talk[^"]*" \((\w+)\), version 1 = the raw footage; the Library keeps the video\. Its other edits stay where they are: "Promo \w+" \(\w+\) in "Client B \w+"\./);
    const made = (r.data as { projectIds: string[] }).projectIds[0];
    const e = await prisma.project.findUniqueOrThrow({ where: { id: made } });
    assert.equal(e.folderId, fromId);
    assert.equal(e.videoId, talk);
    assert.equal((await prisma.video.findUniqueOrThrow({ where: { id: talk } })).deletedAt, null);
  });

  it("the wrong kind, deleted edits, footage not ready and other users' things are said plainly; the rest still move", async () => {
    const del = await createProject(userId, { videoId: talk, name: `Old ${run}`, folderId: fromId });
    await prisma.project.update({ where: { id: del.id }, data: { deletedAt: new Date() } });
    const keep = await createProject(userId, { videoId: talk, name: `Reel ${run}`, folderId: fromId });
    const waiting = await video("Still uploading", userId, "processing");
    const theirs = await video("Theirs", otherId);
    const r = await move({ project: toId, items: [
      { kind: "edit", id: talk }, { kind: "video", id: keep.id }, { kind: "edit", id: del.id }, { kind: "video", id: waiting }, { kind: "video", id: theirs }, { kind: "edit", id: keep.id },
    ] });
    assert.match(r.text, /^Moved 1 of 6 /);
    assert.match(r.text, new RegExp(`- ${talk} is footage \\("Talk"\\), not an edit: kind video puts it in the project as a new edit\\. Its edits: .*send one of their ids as kind edit to move it\\.`));
    assert.match(r.text, new RegExp(`- ${keep.id} is an edit \\("Reel \\w+"\\), not footage: kind edit moves it\\.`));
    assert.match(r.text, /- Edit "Old \w+" is deleted: restore it first/);
    assert.match(r.text, /- "Still uploading" is not ready yet\. Wait until it finishes processing\./);
    assert.match(r.text, new RegExp(`- video ${theirs}: not found\\.`));
    assert.match(r.text, /- Edit "Reel \w+" moved from "Client A \w+" to "Client B \w+"\./);
    assert.equal((await prisma.project.findUniqueOrThrow({ where: { id: del.id } })).folderId, fromId, "the deleted edit stays");
    assert.equal(await prisma.project.count({ where: { videoId: theirs } }), 0, "nothing made from another user's video");
  });

  it("a new name makes the project; a shared name and another user's project are refused", async () => {
    const e = await createProject(userId, { videoId: talk, name: `Short ${run}`, folderId: fromId });
    const r = await move({ items: [{ kind: "edit", id: e.id }], project: `Launch ${run}` });
    assert.match(r.text, new RegExp(`^Moved 1 of 1 into the new project "Launch ${run}" \\((\\w+)\\)`));
    const made = (r.data as { folderId: string }).folderId;
    assert.equal((await prisma.folder.findUniqueOrThrow({ where: { id: made } })).userId, userId);
    await folder(`Launch ${run}`);
    await assert.rejects(move({ items: [{ kind: "edit", id: e.id }], project: `launch ${run}` }), /2 projects are called "Launch \w+": \w+, \w+\. Send the id of the one meant\./);
    await assert.rejects(move({ items: [{ kind: "edit", id: e.id }], project: theirFolder }), /There is no project/);
    assert.equal((await prisma.project.findUniqueOrThrow({ where: { id: e.id } })).folderId, made, "still where it was moved");
    assert.equal(await prisma.project.count({ where: { folderId: theirFolder } }), 0);
  });

  it("the folder page's Move to project: own edits into an own project only", async () => {
    const a = await createProject(userId, { videoId: talk, name: `Web A ${run}`, folderId: fromId });
    const b = await createProject(userId, { videoId: talk, name: `Web B ${run}`, folderId: fromId });
    const theirEdit = await createProject(otherId, { videoId: await video("Their talk", otherId), name: "Their edit", folderId: theirFolder });
    const res = await app.inject({ method: "POST", url: "/projects/move", headers: headers(), payload: { ids: [a.id, b.id, theirEdit.id], folderId: toId } });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { folder: { id: string }; moved: { id: string; from: string }[]; skipped: { id: string }[] };
    assert.equal(body.folder.id, toId);
    assert.deepEqual(body.moved.map((m) => m.id).sort(), [a.id, b.id].sort());
    assert.ok(body.moved.every((m) => m.from === fromId), "each says where it came from (for Undo)");
    assert.deepEqual(body.skipped.map((s) => s.id), [theirEdit.id]);
    assert.equal((await prisma.project.findUniqueOrThrow({ where: { id: theirEdit.id } })).folderId, theirFolder, "another user's edit is untouched");
    const bad = await app.inject({ method: "POST", url: "/projects/move", headers: headers(), payload: { ids: [a.id], folderId: theirFolder } });
    assert.equal(bad.statusCode, 404);
    assert.equal((await prisma.project.findUniqueOrThrow({ where: { id: a.id } })).folderId, toId, "never into another user's project");
  });
});
