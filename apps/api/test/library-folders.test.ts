// Library folders: make, rename and delete folders (their videos stay), move videos in and out (only your own),
// add new videos straight into one, and send a whole folder to one new edit (its ready footage in name order; videos
// not ready yet and references left out and named; too many refused). Through the routes the app uses and through
// the connector (list_footage, move_footage, create_project libraryFolder). Needs a database (as in .env).
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

process.env.INTERNAL_API_SECRET ||= "test-internal-secret";
process.env.LOG_LEVEL = "silent";
const ready = !!process.env.DATABASE_URL && !!process.env.REDIS_URL;
const run = Math.random().toString(36).slice(2, 8);

describe("library folders", { skip: !ready && "needs DATABASE_URL and REDIS_URL" }, async () => {
  const { prisma } = await import("@rendrr/db");
  const { stubTranscript, MCP_TOOLS } = await import("@rendrr/shared");
  const { buildServer } = await import("../src/server");
  const { TOOL_HANDLERS } = await import("../src/tools");
  const { redis } = await import("@rendrr/core");
  let app: Awaited<ReturnType<typeof buildServer>>;
  let userId = "", otherId = "";
  const clerkId = `lf_${run}`;
  const headers = () => ({ "x-internal-secret": process.env.INTERNAL_API_SECRET!, "x-rendrr-clerk-id": clerkId });
  const call = async (method: "GET" | "POST" | "PATCH" | "DELETE", url: string, payload?: object) => {
    const r = await app.inject({ method, url, headers: headers(), ...(payload ? { payload } : {}) });
    return { status: r.statusCode, body: r.body ? JSON.parse(r.body) : null };
  };
  const tool = (name: string, input: Record<string, unknown>) => TOOL_HANDLERS[name]({ userId, ai: "claude" as const }, MCP_TOOLS.find((t) => t.name === name)!.input.parse(input));
  const video = async (name: string, o: { status?: string; kind?: string; seconds?: number; user?: string } = {}) => (await prisma.video.create({ data: {
    userId: o.user ?? userId, name, seconds: o.seconds ?? 20, source: "drive", status: o.status ?? "ready", kind: o.kind ?? "footage",
    ...(o.status && o.status !== "ready" ? {} : { analysis: { create: { transcriber: "stub", transcript: stubTranscript(o.seconds ?? 20) as never, silences: [], sceneCuts: [], keyFrames: [] } } }),
  } })).id;

  before(async () => {
    app = await buildServer();
    userId = (await prisma.user.create({ data: { clerkId, email: `lf-${run}@test.rendrr.dev`, name: "Lia" } })).id;
    otherId = (await prisma.user.create({ data: { clerkId: `lf2_${run}`, email: `lf2-${run}@test.rendrr.dev`, name: "Other" } })).id;
    await prisma.folder.create({ data: { userId, name: "My edits", workspace: "Lia's Workspace" } });
  });
  after(async () => {
    for (const u of [userId, otherId]) {
      await prisma.project.deleteMany({ where: { userId: u } });
      await prisma.folder.deleteMany({ where: { userId: u } });
      await prisma.video.deleteMany({ where: { userId: u } });
      await prisma.libraryFolder.deleteMany({ where: { userId: u } });
      await prisma.user.deleteMany({ where: { id: u } });
    }
    await app.close();
    await redis().quit().catch(() => {});
  });

  it("make, list, rename; the same name twice is refused", async () => {
    const made = await call("POST", "/library/folders", { name: "  Course parts " });
    assert.equal(made.status, 200, JSON.stringify(made.body));
    assert.deepEqual([made.body.name, made.body.count], ["Course parts", 0]);
    const twice = await call("POST", "/library/folders", { name: "course PARTS" });
    assert.equal(twice.status, 409);
    assert.match(twice.body.error.message, /already have a folder called "Course parts"/);
    const empty = await call("POST", "/library/folders", { name: "   " });
    assert.equal(empty.status, 400);
    const renamed = await call("PATCH", `/library/folders/${made.body.id}`, { name: "Course: module 1" });
    assert.equal(renamed.body.name, "Course: module 1");
    const list = await call("GET", "/library/folders");
    assert.deepEqual(list.body.map((f: { name: string }) => f.name), ["Course: module 1"]);
  });

  it("videos move in and out; another user's folder or video is refused; new videos can go straight in", async () => {
    const f = (await call("POST", "/library/folders", { name: `Interviews ${run}` })).body;
    const a = await video(`Interview A ${run}`), b = await video(`Interview B ${run}`, { seconds: 30 });
    const moved = await call("POST", "/videos/move", { videoIds: [a, b], libraryFolderId: f.id });
    assert.equal(moved.status, 200, JSON.stringify(moved.body));
    assert.equal(moved.body.moved, 2);
    const listed = (await call("GET", "/library/folders")).body.find((x: { id: string }) => x.id === f.id);
    assert.deepEqual([listed.count, listed.seconds], [2, 50]);
    const vs = (await call("GET", "/videos")).body as { id: string; libraryFolderId: string | null }[];
    assert.equal(vs.find((v) => v.id === a)!.libraryFolderId, f.id);
    // One video out again through PATCH /videos/:id.
    const out = await call("PATCH", `/videos/${b}`, { libraryFolderId: null });
    assert.equal(out.body.libraryFolderId, null);
    // Someone else's video, and someone else's folder.
    const theirs = await video(`Theirs ${run}`, { user: otherId });
    assert.equal((await call("POST", "/videos/move", { videoIds: [a, theirs], libraryFolderId: f.id })).status, 404);
    const theirFolder = await prisma.libraryFolder.create({ data: { userId: otherId, name: "Not yours" } });
    assert.equal((await call("POST", "/videos/move", { videoIds: [a], libraryFolderId: theirFolder.id })).status, 404);
    assert.equal((await call("PATCH", `/videos/${a}`, { libraryFolderId: theirFolder.id })).status, 404);
    // A new video added straight into the folder (the built-in sample, as the app adds it).
    const added = await call("POST", "/videos/sample", { libraryFolderId: f.id });
    assert.equal(added.status, 200, JSON.stringify(added.body));
    assert.equal(added.body[0].libraryFolderId, f.id);
    await prisma.video.delete({ where: { id: added.body[0].id } });
  });

  it("deleting a folder leaves its videos in the library, outside any folder", async () => {
    const f = (await call("POST", "/library/folders", { name: `Temp ${run}` })).body;
    const v = await video(`Kept ${run}`);
    await call("POST", "/videos/move", { videoIds: [v], libraryFolderId: f.id });
    const del = await call("DELETE", `/library/folders/${f.id}`);
    assert.deepEqual(del.body, { ok: true, moved: 1 });
    const kept = await prisma.video.findUniqueOrThrow({ where: { id: v } });
    assert.equal(kept.libraryFolderId, null);
  });

  it("a whole folder becomes one edit: ready footage in name order, the rest named and left out", async () => {
    const f = (await call("POST", "/library/folders", { name: `Shoot ${run}` })).body;
    // Names that sort wrong as plain text: Part 10 must come after Part 2.
    const p10 = await video("Part 10", { seconds: 12 }), p2 = await video("Part 2", { seconds: 15 }), p1 = await video("Part 1", { seconds: 10 });
    const busy = await video("Part 3", { status: "processing" }), ref = await video("Look to copy", { kind: "reference" });
    await call("POST", "/videos/move", { videoIds: [p10, p2, p1, busy, ref], libraryFolderId: f.id });
    const r = await call("POST", `/library/folders/${f.id}/project`, {});
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.project.name, `Shoot ${run}`);
    assert.equal(r.body.videos, 3);
    assert.deepEqual(r.body.skipped.map((s: { name: string; why: string }) => `${s.name}: ${s.why}`).sort(), ["Look to copy: a reference (a style to copy), not footage", "Part 3: not ready yet"]);
    const p = await prisma.project.findUniqueOrThrow({ where: { id: r.body.project.id } });
    const v1 = (p.timeline as unknown as { tracks: { v1: { sourceVideoId?: string }[] } }).tracks.v1;
    const order = Array.from(new Set(v1.map((c) => c.sourceVideoId ?? p.videoId)));
    assert.deepEqual(order, [p1, p2, p10], "Part 1, Part 2, Part 10 back to back");
    assert.equal(p.videoId, p1);
    // Empty, nothing ready, too many.
    const empty = (await call("POST", "/library/folders", { name: `Empty ${run}` })).body;
    const e = await call("POST", `/library/folders/${empty.id}/project`, {});
    assert.equal(e.status, 400);
    assert.match(e.body.error.message, /is empty/);
    const wait = (await call("POST", "/library/folders", { name: `Waiting ${run}` })).body;
    await call("POST", "/videos/move", { videoIds: [await video(`Still processing ${run}`, { status: "processing" })], libraryFolderId: wait.id });
    const w = await call("POST", `/library/folders/${wait.id}/project`, {});
    assert.equal(w.status, 409);
    assert.match(w.body.error.message, /None of the videos .* can be edited yet: "Still processing \w+" is not ready yet/);
    const big = (await call("POST", "/library/folders", { name: `Big ${run}` })).body;
    const many = await Promise.all(Array.from({ length: 21 }, (_, i) => video(`Clip ${i + 1} ${run}`, { seconds: 2 })));
    await call("POST", "/videos/move", { videoIds: many, libraryFolderId: big.id });
    const tooMany = await call("POST", `/library/folders/${big.id}/project`, {});
    assert.equal(tooMany.status, 400);
    assert.match(tooMany.body.error.message, /has 21 videos ready; an edit starts from up to 20/);
  });

  it("the connector: list_footage shows folders and filters by one; move_footage makes a folder by name; create_project libraryFolder", async () => {
    const a = await video(`Hook take ${run}`), b = await video(`Body take ${run}`);
    const mv = await tool("move_footage", { videoIds: [a, b], libraryFolder: `Ads ${run}` });
    assert.match(mv.text, new RegExp(`Moved 2 videos into the new library folder "Ads ${run}" \\(\\w+\\)\\. create_project libraryFolder`));
    const again = await tool("move_footage", { videoIds: [a], libraryFolder: `ads ${run}` }); // by name, any case: the same folder
    assert.match(again.text, /Moved 1 video into library folder/);
    assert.equal(await prisma.libraryFolder.count({ where: { userId, name: { startsWith: "Ads" } } }), 1);
    const all = await tool("list_footage", {});
    assert.match(all.text, new RegExp(`Library folders \\(id \\| name \\| videos\\): .*\\| Ads ${run} \\| 2`));
    assert.match(all.text, new RegExp(`${a} \\| Hook take ${run} \\| footage .* \\| Ads ${run}`));
    const one = await tool("list_footage", { libraryFolder: `Ads ${run}` });
    assert.match(one.text, new RegExp(`Library folder "Ads ${run}" .* in name order .* 1-2 of 2`));
    assert.ok(one.text.indexOf(`Body take ${run}`) < one.text.indexOf(`Hook take ${run}`), "name order: Body before Hook");
    await assert.rejects(tool("list_footage", { libraryFolder: "No such folder" }), /There is no library folder "No such folder"\. Library folders: /);
    const made = await tool("create_project", { libraryFolder: `Ads ${run}`, aspect: "9:16" });
    assert.match(made.text, new RegExp(`Created edit "Ads ${run}" \\(\\w+\\) from the library folder "Ads ${run}": 2 videos back to back in name order \\(Body take ${run}, Hook take ${run}\\), 9:16\\.`));
    await assert.rejects(tool("create_project", { libraryFolder: `Ads ${run}`, videoId: a }), /libraryFolder makes an edit of every ready video in that folder/);
    const outOf = await tool("move_footage", { videoIds: [a], libraryFolder: null });
    assert.equal(outOf.text, "Took 1 video out of their library folder.");
  });
});
