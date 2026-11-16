// The AI deletes and restores the user's things (delete_items): footage, elements and audio go to the Trash first
// (edits using them keep working) and come back with restore; edits are marked deleted and come back; for good only
// with permanent, and never past something in use (footage in edits, a project folder with edits, an element in use)
// unless force; library folders, fonts, LUTs and styles go at once; another user's things are not touched; the Trash
// is listed and emptied. Needs a database, Redis and storage (as in .env).
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

process.env.INTERNAL_API_SECRET ||= "test-internal-secret";
process.env.LOG_LEVEL = process.env.TEST_LOG || "silent";
const ready = !!process.env.DATABASE_URL && !!process.env.REDIS_URL && !!process.env.S3_BUCKET;
const run = Math.random().toString(36).slice(2, 8);

describe("the AI deletes and restores", { skip: !ready && "needs DATABASE_URL, REDIS_URL and storage" }, async () => {
  const { prisma } = await import("@rendrr/db");
  const { stubTranscript, MCP_TOOLS } = await import("@rendrr/shared");
  const { createProject } = await import("../src/services/projects");
  const { TOOL_HANDLERS } = await import("../src/tools");
  const { redis } = await import("@rendrr/core");
  let userId = "", otherId = "", folderId = "";
  const c = () => ({ userId, ai: "claude" as const, clerkId: `del_${run}` });
  const del = (i: Record<string, unknown>) => TOOL_HANDLERS.delete_items(c(), i as never);
  const video = async (name: string, owner = userId) => (await prisma.video.create({ data: { userId: owner, name, seconds: 20, width: 1280, height: 720, source: "drive", status: "ready", proxyKey: `proxies/${run}-${name}.mp4`, analysis: { create: { transcriber: "stub", transcript: stubTranscript(20) as never, silences: [] as never, sceneCuts: [], keyFrames: [] } } } })).id;

  before(async () => {
    userId = (await prisma.user.create({ data: { clerkId: `del_${run}`, email: `del-${run}@test.rendrr.dev`, name: "Del" } })).id;
    otherId = (await prisma.user.create({ data: { clerkId: `delo_${run}`, email: `delo-${run}@test.rendrr.dev`, name: "Other" } })).id;
    folderId = (await prisma.folder.create({ data: { userId, name: `Client ${run}`, workspace: "Personal" } })).id;
  });
  after(async () => {
    for (const u of [userId, otherId]) {
      await prisma.project.deleteMany({ where: { userId: u } });
      await prisma.folder.deleteMany({ where: { userId: u } });
      await prisma.video.deleteMany({ where: { userId: u } });
      await prisma.libraryFolder.deleteMany({ where: { userId: u } });
      await prisma.sound.deleteMany({ where: { userId: u } });
      await prisma.graphic.deleteMany({ where: { ownerId: u } });
      await prisma.lut.deleteMany({ where: { userId: u } });
      await prisma.font.deleteMany({ where: { userId: u } });
      await prisma.style.deleteMany({ where: { ownerId: u } });
    }
    await prisma.user.deleteMany({ where: { id: { in: [userId, otherId] } } });
    await redis().quit().catch(() => {});
  });

  it("is a tool the AI sees, marked as one that deletes", () => {
    const t = MCP_TOOLS.find((x) => x.name === "delete_items");
    assert.ok(t && t.destructive && t.write);
    assert.match(t!.description, /only when the user asks/);
  });

  it("footage goes to the Trash (its edit keeps working) and comes back", async () => {
    const v = await video("Talk");
    const p = await createProject(userId, { videoId: v, name: `Promo ${run}`, folderId });
    const r = await del({ items: [{ kind: "video", id: v }] });
    assert.match(r.text, /^Deleted 1 of 1:\n- Video "Talk" moved to the Trash \(restorable for 30 days\)\. 1 edit using it keep working: "Promo/);
    assert.ok((await prisma.video.findUniqueOrThrow({ where: { id: v } })).deletedAt);
    assert.equal((await prisma.project.findUniqueOrThrow({ where: { id: p.id } })).deletedAt, null, "the edit is untouched");
    const list = await del({ trash: "list" });
    assert.match(list.text, /video "Talk" \(kind video, id \w+\): 30 days left/);
    const back = await del({ items: [{ kind: "video", id: v }], restore: true });
    assert.match(back.text, /"Talk" is back in Assets\./);
    assert.equal((await prisma.video.findUniqueOrThrow({ where: { id: v } })).deletedAt, null);
  });

  it("for good only with permanent, and footage in an edit only with force (the edit goes too)", async () => {
    const v = (await prisma.video.findFirstOrThrow({ where: { userId, name: "Talk" } })).id;
    const refused = await del({ items: [{ kind: "video", id: v }], permanent: true });
    assert.match(refused.text, /Deleted 0 of 1:\n- "Talk" is used by 1 edit: "Promo \w+"\. .* Nothing was deleted: send force: true/);
    assert.ok(await prisma.video.findUnique({ where: { id: v } }), "still there");
    const gone = await del({ items: [{ kind: "video", id: v }], permanent: true, force: true });
    assert.match(gone.text, /Video "Talk" deleted for good, with the 1 edit made from it\./);
    assert.equal(await prisma.video.findUnique({ where: { id: v } }), null);
  });

  it("an edit is deleted and restored; permanent deletes it for good", async () => {
    const p = await createProject(userId, { videoId: await video("Second"), name: `Reel ${run}`, folderId });
    assert.match((await del({ items: [{ kind: "edit", id: p.id }] })).text, /Edit "Reel \w+" deleted \(restore: true brings it back\)/);
    assert.ok((await prisma.project.findUniqueOrThrow({ where: { id: p.id } })).deletedAt);
    assert.match((await del({ items: [{ kind: "edit", id: p.id }], restore: true })).text, /Edit "Reel \w+" is back\./);
    assert.match((await del({ items: [{ kind: "edit", id: p.id }], permanent: true })).text, /deleted for good, with its renders/);
    assert.equal(await prisma.project.findUnique({ where: { id: p.id } }), null);
  });

  it("a project folder with edits only with force; a library folder at once (its videos move up)", async () => {
    await createProject(userId, { videoId: await video("Third"), name: `Short ${run}`, folderId });
    assert.match((await del({ items: [{ kind: "folder", id: folderId }] })).text, /Project folder "Client \w+" has 1 edit in it: "Short \w+"\. .* Nothing was deleted/);
    assert.ok(await prisma.folder.findUnique({ where: { id: folderId } }));
    assert.match((await del({ items: [{ kind: "folder", id: folderId }], force: true })).text, /Project folder "Client \w+" deleted, with its 1 edit\./);
    assert.equal(await prisma.folder.findUnique({ where: { id: folderId } }), null);
    const lf = await prisma.libraryFolder.create({ data: { userId, name: "Shoot day" } });
    const inside = await video("Inside");
    await prisma.video.update({ where: { id: inside }, data: { libraryFolderId: lf.id } });
    assert.match((await del({ items: [{ kind: "library_folder", id: lf.id }] })).text, /Library folder "Shoot day" deleted; its 1 video moved up a level/);
    assert.equal((await prisma.video.findUniqueOrThrow({ where: { id: inside } })).libraryFolderId, null);
  });

  it("elements, audio, fonts, LUTs and styles; several at once; another user's things are not touched", async () => {
    const el = await prisma.graphic.create({ data: { name: "Logo", kind: "element", durationSec: 5, ownerId: userId } });
    const snd = await prisma.sound.create({ data: { userId, name: "Beat" } });
    const lut = await prisma.lut.create({ data: { userId, name: "Warm", key: `luts/${run}.cube`, kind: "cube", size: 10 } });
    const font = await prisma.font.create({ data: { userId, family: "Brand Sans", format: "ttf", key: `fonts/${run}.ttf`, size: 10 } });
    const style = await prisma.style.create({ data: { id: `st-${run}`, name: "My look", type: "custom", vibe: "", captionLook: "", cutPace: "", captionRule: "", zoomRules: "", musicVibe: "", rules: {}, art: "", ownerId: userId } });
    const theirs = await video("Theirs", otherId);
    const r = await del({ items: [{ kind: "element", id: el.id }, { kind: "audio", id: snd.id }, { kind: "lut", id: lut.id }, { kind: "font", id: font.id }, { kind: "style", id: style.id }, { kind: "video", id: theirs }] });
    assert.match(r.text, /^Deleted 5 of 6:/);
    assert.match(r.text, /Element "Logo" moved to the Trash/);
    assert.match(r.text, /Audio "Beat" moved to the Trash/);
    assert.match(r.text, /LUT "Warm" deleted/);
    assert.match(r.text, /Font "Brand Sans" 400 deleted/);
    assert.match(r.text, /Style "My look" deleted/);
    assert.match(r.text, /video \w+: not found/);
    assert.equal((await prisma.video.findUniqueOrThrow({ where: { id: theirs } })).deletedAt, null, "the other user's video is untouched");
    assert.equal(await prisma.lut.findUnique({ where: { id: lut.id } }), null);
    const lf = await del({ items: [{ kind: "lut", id: lut.id }], restore: true });
    assert.match(lf.text, /A lut cannot be restored/);
  });

  it("the Trash is emptied for good", async () => {
    const r = await del({ trash: "empty" });
    assert.match(r.text, /^Trash emptied: 2 items deleted for good\./);
    assert.equal(await prisma.graphic.count({ where: { ownerId: userId, kind: "element" } }), 0);
    assert.equal((await del({ trash: "list" })).text.includes("element"), false);
  });
});
