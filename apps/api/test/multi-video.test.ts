// One edit from several videos (a video filmed in parts), from the app and the connector: the parts play whole, back
// to back, in the order picked; a part that is not ready, or a reference, is refused by name; deleting a part names
// the edit that plays it. Needs a database and Redis (as in .env). Run: pnpm --filter @rendrr/api test
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

process.env.INTERNAL_API_SECRET ||= "test-internal-secret";
process.env.LOG_LEVEL = "silent";
const ready = !!process.env.DATABASE_URL && !!process.env.REDIS_URL;
const run = Math.random().toString(36).slice(2, 8);

describe("an edit of several videos", { skip: !ready && "needs DATABASE_URL and REDIS_URL" }, async () => {
  const { prisma } = await import("@rendrr/db");
  const { stubTranscript, CreateProjectInput } = await import("@rendrr/shared");
  const { createProject } = await import("../src/services/projects");
  const { TOOL_HANDLERS } = await import("../src/tools");
  const { redis } = await import("@rendrr/core");
  const { buildServer } = await import("../src/server");

  let userId = "";
  const ids: Record<string, string> = {};
  const c = () => ({ userId, ai: "claude" as const, clerkId: `multi_${run}` });
  const v1Of = async (projectId: string) => ((await prisma.project.findUniqueOrThrow({ where: { id: projectId } })).timeline as { tracks: { v1: { id: string; sourceVideoId: string; sourceIn: number; sourceOut: number; label: string }[] } }).tracks.v1;

  before(async () => {
    userId = (await prisma.user.create({ data: { clerkId: `multi_${run}`, email: `multi-${run}@test.rendrr.dev`, name: "Multi" } })).id;
    await prisma.folder.create({ data: { userId, name: "My edits", workspace: "Multi's Workspace" } });
    const add = async (key: string, seconds: number, extra: Record<string, unknown> = {}) => {
      ids[key] = (await prisma.video.create({ data: { userId, name: `${key} ${run}`, seconds, width: 1920, height: 1080, source: "local", status: "ready", analysis: { create: { transcriber: "stub", transcript: stubTranscript(seconds) as never, silences: [], sceneCuts: [], keyFrames: [] } }, ...extra } })).id;
    };
    await add("Part 1", 20); await add("Part 2", 15); await add("Part 3", 9);
    await add("Ref", 10, { kind: "reference" });
    ids.Busy = (await prisma.video.create({ data: { userId, name: `Busy ${run}`, seconds: 10, source: "local", status: "previewing" } })).id;
  });
  after(async () => {
    await prisma.project.deleteMany({ where: { userId } });
    await prisma.video.deleteMany({ where: { userId } });
    await prisma.user.deleteMany({ where: { id: userId } });
    await redis().quit().catch(() => {});
  });

  it("the app: parts in the order picked, each whole, after the first; v1 says so", async () => {
    const order = [ids["Part 2"], ids["Part 1"], ids["Part 3"]];
    const p = await createProject(userId, CreateProjectInput.parse({ videoIds: order }));
    assert.equal(p.videoId, ids["Part 2"]); // the first is the edit's footage
    assert.equal(p.name, `Part 2 ${run} + 2 more`);
    assert.equal(p.outputSeconds, 44);
    const v1 = await v1Of(p.id);
    const others = v1.filter((x) => x.sourceVideoId !== ids["Part 2"]);
    assert.deepEqual(others.map((x) => [x.sourceVideoId, x.sourceIn, x.sourceOut, x.label]), [[ids["Part 1"], 0, 20, `Part 1 ${run}`], [ids["Part 3"], 0, 9, `Part 3 ${run}`]]);
    assert.ok(v1.slice(0, v1.length - 2).every((x) => x.sourceVideoId === ids["Part 2"]));
    const versions = await prisma.projectVersion.findMany({ where: { projectId: p.id } });
    assert.deepEqual(versions.map((x) => [x.v, x.note]), [[1, "3 videos as recorded, back to back"]]);
  });

  it("one id in videoIds, or videoId, is the plain raw edit; none is refused", async () => {
    const a = await createProject(userId, CreateProjectInput.parse({ videoIds: [ids["Part 3"]] }));
    assert.equal(a.name, `Part 3 ${run} edit`);
    assert.ok((await v1Of(a.id)).every((x) => x.sourceVideoId === ids["Part 3"]));
    assert.throws(() => CreateProjectInput.parse({}), /Pick footage first/);
    assert.throws(() => CreateProjectInput.parse({ videoIds: Array.from({ length: 21 }, (_, i) => "v" + i) }), /up to 20 videos/);
  });

  it("refuses a part that is not ready, or a reference, by name", async () => {
    await assert.rejects(createProject(userId, { videoIds: [ids["Part 1"], ids.Busy] }), new RegExp(`"Busy ${run}" is not ready yet`));
    await assert.rejects(createProject(userId, { videoIds: [ids["Part 1"], ids.Ref] }), new RegExp(`"Ref ${run}" is a reference: an edit is made of footage`));
    await assert.rejects(createProject(userId, { videoIds: [ids["Part 1"], "nope"] }), /not in your library any more/);
  });

  it("the connector: create_project with videoIds names the parts' clips; get_project shows the sequence", async () => {
    const r = await TOOL_HANDLERS.create_project(c(), { videoIds: [ids["Part 1"], ids["Part 2"]], name: "Two parts" });
    assert.match(r.text, new RegExp(`Created edit "Two parts" \\(\\w+\\), v1 = 2 videos as recorded, back to back \\(the first is the edit's footage; then clip \\S+ = video ${ids["Part 2"]} 0-15s\\): nothing cut`));
    const pid = (r.data as { projectId: string }).projectId;
    const g = await TOOL_HANDLERS.get_project(c(), { projectId: pid });
    assert.match(g.text, new RegExp(`\\S+ ${ids["Part 2"]} 0\\.00-15\\.00 @20\\.00-35\\.00 "Part 2 ${run}"`));
    await assert.rejects(TOOL_HANDLERS.create_project(c(), {}), /Send videoId, or videoIds/);
  });

  it("the in-use query finds an edit that plays a video on V1 only", async () => {
    const rows = await prisma.$queryRaw<{ id: string }[]>`SELECT id FROM "Project" WHERE "userId" = ${userId} AND "deletedAt" IS NULL AND jsonb_path_exists(timeline, '$.tracks.v1[*] ? (@.sourceVideoId == $vid)', jsonb_build_object('vid', ${ids["Part 3"]}::text))`;
    const names = (await prisma.project.findMany({ where: { id: { in: rows.map((x) => x.id) } }, select: { name: true, videoId: true } }));
    assert.ok(names.some((x) => x.videoId !== ids["Part 3"] && x.name === `Part 2 ${run} + 2 more`), JSON.stringify(names));
  });
  it("deleting a part names the edits that play it, and goes with them when asked", async () => {
    const app = await buildServer();
    const headers = { "x-internal-secret": process.env.INTERNAL_API_SECRET!, "x-rendrr-clerk-id": `multi_${run}` };
    try {
      const del = await app.inject({ method: "DELETE", url: `/videos/${ids["Part 3"]}`, headers });
      assert.equal(del.statusCode, 409, del.body);
      assert.match(del.json().error.message, new RegExp(`"Part 3 ${run}" is used by 2 edits: .*"Part 2 ${run} \\+ 2 more"`));
      const gone = await app.inject({ method: "DELETE", url: `/videos/${ids["Part 3"]}?edits=delete`, headers });
      assert.equal(gone.statusCode, 200, gone.body);
      assert.equal(await prisma.project.count({ where: { userId, name: `Part 2 ${run} + 2 more`, deletedAt: null } }), 0);
    } finally { await app.close(); }
  });

});
