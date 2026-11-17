// Files the AI asks the user for (add_footage from: computer): a one-hour link bound to the user's account; the page
// reports what arrived (their own videos only), each goes in the edit's Media panel, and add_footage pickId tells the AI
// exactly which arrived. Another account's link, an unknown one and an expired one say so and take nothing. Needs a
// database, Redis and storage (as in .env).
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

process.env.INTERNAL_API_SECRET ||= "test-internal-secret";
process.env.LOG_LEVEL = process.env.TEST_LOG || "silent";
process.env.PUBLIC_WEB_URL ||= "https://app.rendrr.test";
const ready = !!process.env.DATABASE_URL && !!process.env.REDIS_URL && !!process.env.S3_BUCKET;
const run = Math.random().toString(36).slice(2, 8);

describe("asking the user for files", { skip: !ready && "needs DATABASE_URL, REDIS_URL and storage" }, async () => {
  const { prisma } = await import("@rendrr/db");
  const { stubTranscript, MCP_TOOLS } = await import("@rendrr/shared");
  const { createProject } = await import("../src/services/projects");
  const { TOOL_HANDLERS } = await import("../src/tools");
  const { redis } = await import("@rendrr/core");
  const { buildServer } = await import("../src/server");
  let app: Awaited<ReturnType<typeof buildServer>>;
  let userId = "", otherId = "", projectId = "", pickId = "", mine = "", theirs = "";
  const clerkId = `pk_${run}`;
  const c = () => ({ userId, ai: "claude" as const, clerkId });
  const as = (id: string) => ({ "x-internal-secret": process.env.INTERNAL_API_SECRET!, "x-rendrr-clerk-id": id });
  const video = async (name: string, owner: string) => (await prisma.video.create({ data: { userId: owner, name, seconds: 20, width: 1280, height: 720, source: "local", status: "previewing", analysis: { create: { transcriber: "stub", transcript: stubTranscript(20) as never, silences: [] as never, sceneCuts: [], keyFrames: [] } } } })).id;

  before(async () => {
    app = await buildServer();
    userId = (await prisma.user.create({ data: { clerkId, email: `pk-${run}@test.rendrr.dev`, name: "Picker" } })).id;
    otherId = (await prisma.user.create({ data: { clerkId: `pko_${run}`, email: `pko-${run}@test.rendrr.dev`, name: "Other" } })).id;
    await prisma.folder.create({ data: { userId, name: "Edits", workspace: "Personal" } });
    const ready = await prisma.video.create({ data: { userId, name: "Base", seconds: 20, width: 1280, height: 720, source: "drive", status: "ready", proxyKey: `proxies/${run}.mp4`, analysis: { create: { transcriber: "stub", transcript: stubTranscript(20) as never, silences: [] as never, sceneCuts: [], keyFrames: [] } } } });
    projectId = (await createProject(userId, { videoId: ready.id, name: `Reel ${run}` })).id;
    mine = await video("Long interview", userId);
    theirs = await video("Not yours", otherId);
  });
  after(async () => {
    await prisma.project.deleteMany({ where: { userId: { in: [userId, otherId] } } });
    await prisma.folder.deleteMany({ where: { userId: { in: [userId, otherId] } } });
    await prisma.video.deleteMany({ where: { userId: { in: [userId, otherId] } } });
    await prisma.user.deleteMany({ where: { id: { in: [userId, otherId] } } });
    await app.close(); await redis().quit().catch(() => {});
  });

  it("add_footage offers it in a sentence and takes from and pickId", () => {
    const t = MCP_TOOLS.find((x) => x.name === "add_footage")!;
    assert.match(t.description, /on their computer, too big to attach; in their Dropbox or Google Photos\): from gives a link to send them/);
    assert.ok(t.input.safeParse({ from: "computer" }).success && t.input.safeParse({ pickId: "abc" }).success);
  });

  it("from: computer gives a one-hour link for the user, and what arrived is nothing yet", async () => {
    const r = await TOOL_HANDLERS.add_footage(c(), { from: "computer", projectId });
    pickId = (r.data as { pickId: string }).pickId;
    assert.match(r.text, new RegExp(`^Give the user this link to add files from their computer \\(open it where they are signed in to Rendrr; it works for 60 minutes\\): https?://\\S+/add/${pickId}\\n`));
    assert.match(r.text, /keep that page open until it says done, and its original stays on their computer: a final asks for it once/);
    assert.match(r.text, /They go in the edit's Media panel too\./);
    assert.match(r.text, new RegExp(`add_footage \\{pickId: "${pickId}", wait_seconds: 60\\}`));
    const none = await TOOL_HANDLERS.add_footage(c(), { pickId });
    assert.match(none.text, /^Nothing has arrived from their computer yet\. The link stays open \d+ more minutes\./);
  });

  it("the page: only its own account opens it; what arrives is the user's own, recorded and put in the edit", async () => {
    const page = await app.inject({ method: "GET", url: `/picks/${pickId}`, headers: as(clerkId) });
    assert.equal(page.statusCode, 200);
    const v = page.json() as { source: string; project: { name: string }; videos: unknown[]; ai: string };
    assert.equal(v.source, "computer"); assert.equal(v.project.name, `Reel ${run}`); assert.equal(v.videos.length, 0); assert.equal(v.ai, "claude");
    const other = await app.inject({ method: "GET", url: `/picks/${pickId}`, headers: as(`pko_${run}`) });
    assert.equal(other.statusCode, 403); assert.equal(other.json().error.code, "pick-other-account");
    assert.equal((await app.inject({ method: "POST", url: `/picks/${pickId}/items`, headers: as(`pko_${run}`), payload: { videoIds: [theirs] } })).statusCode, 403, "another account cannot add to it");
    assert.equal((await app.inject({ method: "GET", url: `/picks/nope_nope_nope`, headers: as(clerkId) })).statusCode, 404);
    const add = await app.inject({ method: "POST", url: `/picks/${pickId}/items`, headers: as(clerkId), payload: { videoIds: [mine, theirs, mine] } });
    assert.equal(add.statusCode, 200, add.body);
    const after = add.json() as { videos: { id: string; name: string }[] };
    assert.deepEqual(after.videos.map((x) => x.id), [mine], "only the user's own video, once");
    const tl = (await prisma.project.findUniqueOrThrow({ where: { id: projectId } })).timeline as { media?: string[] };
    assert.ok(tl.media?.includes(mine), "it went in the edit's Media panel");
  });

  it("add_footage pickId says exactly which arrived, and when the user is done", async () => {
    const r = await TOOL_HANDLERS.add_footage(c(), { pickId, wait_seconds: 1 });
    assert.match(r.text, new RegExp(`^From their computer, 1 file so far:\\n- In the library and this edit's Media panel: the video "Long interview" ${mine}`));
    assert.deepEqual((r.data as { videoIds: string[] }).videoIds, [mine]);
    await app.inject({ method: "POST", url: `/picks/${pickId}/done`, headers: as(clerkId) });
    assert.match((await TOOL_HANDLERS.add_footage(c(), { pickId })).text, /^From their computer, 1 file \(the user is done\)/);
    await assert.rejects(TOOL_HANDLERS.add_footage({ userId: otherId, ai: "claude", clerkId: `pko_${run}` }, { pickId }), /another Rendrr account/);
  });

  it("an expired link takes nothing and the AI is told to make a new one", async () => {
    const raw = JSON.parse((await redis().get(`pick:${pickId}`))!);
    await redis().set(`pick:${pickId}`, JSON.stringify({ ...raw, until: Date.now() - 1000, done: false }), "EX", 600);
    const late = await app.inject({ method: "POST", url: `/picks/${pickId}/items`, headers: as(clerkId), payload: { videoIds: [mine] } });
    assert.equal(late.statusCode, 410); assert.equal(late.json().error.code, "pick-expired");
    assert.match((await TOOL_HANDLERS.add_footage(c(), { pickId })).text, /The link has expired: from: makes a new one\./);
    await assert.rejects(TOOL_HANDLERS.add_footage(c(), { from: "computer", projectId: "nope" }), /That edit does not exist/);
  });
});
