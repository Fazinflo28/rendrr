// One custom graphic placed many times through the connector: create_graphic params are kept as the graphic's
// defaults and listed; apply_edits places it with from and params, queues one recording for the placement with its
// own values, get_project says which placements have no file yet, and the editor gets each placement's file.
// Needs a database, Redis and storage (as in .env). Run: pnpm --filter @rendrr/api test
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

const ready = !!process.env.DATABASE_URL && !!process.env.REDIS_URL && !!process.env.S3_BUCKET;
const run = Math.random().toString(36).slice(2, 8);

describe("one graphic placed many times", { skip: !ready && "needs DATABASE_URL, REDIS_URL and storage" }, async () => {
  const { prisma } = await import("@rendrr/db");
  const { stubTranscript, customParamsSchema, CreateGraphicInput, PREFIX } = await import("@rendrr/shared");
  const { createProject, projectFull } = await import("../src/services/projects");
  const { TOOL_HANDLERS } = await import("../src/tools");
  const { deletePrefix, graphicVariant, putObject, queue, redis } = await import("@rendrr/core");

  let userId = "", videoId = "", graphicId = "";
  const c = () => ({ userId, ai: "claude" as const, clerkId: `greuse_${run}` });
  before(async () => {
    userId = (await prisma.user.create({ data: { clerkId: `greuse_${run}`, email: `greuse-${run}@test.rendrr.dev`, name: "Reuse" } })).id;
    await prisma.folder.create({ data: { userId, name: "My edits", workspace: "Reuse's Workspace" } });
    const analysis = { create: { transcriber: "stub", transcript: stubTranscript(30) as never, silences: [] as never, sceneCuts: [], keyFrames: [] } };
    videoId = (await prisma.video.create({ data: { userId, name: `Talk ${run}`, seconds: 30, width: 1920, height: 1080, source: "drive", status: "ready", analysis } })).id;
    // As the worker leaves a recorded graphic: ready, with its file in storage.
    const key = `${PREFIX.graphics}${userId}/g-${run}.webm`;
    await putObject(key, Buffer.from("webm"), "video/webm");
    graphicId = (await prisma.graphic.create({ data: { ownerId: userId, name: "Chapter card", kind: "custom", code: "<div></div>", paramsSchema: customParamsSchema({ title: "Chapter", color: "#ffffff" }), durationSec: 20, width: 1920, height: 1080, status: "ready", renderedKey: key } })).id;
  });
  after(async () => {
    await prisma.project.deleteMany({ where: { userId } });
    await prisma.graphic.deleteMany({ where: { ownerId: userId } });
    await prisma.video.deleteMany({ where: { userId } });
    await prisma.user.deleteMany({ where: { id: userId } });
    await deletePrefix(`${PREFIX.graphics}${userId}/`).catch(() => {});
    await redis().quit().catch(() => {});
  });

  it("create_graphic takes params as names and default values, within limits", () => {
    const base = { code: "<div></div>", durationSec: 5, width: 1080, height: 1920 };
    assert.deepEqual(CreateGraphicInput.parse({ ...base, params: { title: "Hi", n: 2 } }).params, { title: "Hi", n: 2 });
    assert.deepEqual(CreateGraphicInput.parse(base).params, {});
    assert.throws(() => CreateGraphicInput.parse({ ...base, params: { "bad name": 1 } }), /like JavaScript names/);
    assert.throws(() => CreateGraphicInput.parse({ ...base, params: { big: "x".repeat(9000) } }), /8 KB/);
  });

  it("places the graphic four times with offsets; only the placement with its own params gets a recording queued", async () => {
    const p = await createProject(userId, { videoId });
    const listed = (await TOOL_HANDLERS.list_graphics(c(), {})).text;
    // The defaults as stored (the database keeps its own key order).
    const row = listed.split("\n").find((l) => l.startsWith(graphicId))!;
    assert.match(row, /\| Chapter card \| ready \| 20s \| 1920x1080 \| \{.*\}$/);
    assert.deepEqual(JSON.parse(row.slice(row.lastIndexOf("| ") + 2)), { title: "Chapter", color: "#ffffff" });
    const edits = [0, 5, 10, 15].map((from, i) => ({ op: "add_graphic", graphicId, start: 1 + i * 5, end: 4 + i * 5, from, ...(i === 3 ? { params: { title: "The end" } } : {}) }));
    const r = await TOOL_HANDLERS.apply_edits(c(), { projectId: p.id, edits });
    assert.match(r.text, /added graphic Chapter card at 0:16 from 15\.00s of it \(clip \w+\)/);
    const g = await prisma.graphic.findUniqueOrThrow({ where: { id: graphicId } });
    const v = graphicVariant(g, { title: "The end" })!;
    const job = await queue("graphic").getJob(v.jobId);
    assert.ok(job, "a recording is queued for the placement's own params");
    assert.deepEqual(job!.data, { graphicId, params: { title: "The end", color: "#ffffff" } });
    // A wrong name is refused with the graphic's params.
    await assert.rejects(TOOL_HANDLERS.apply_edits(c(), { projectId: p.id, edits: [{ op: "add_graphic", graphicId, start: 1, end: 2, params: { colour: "#000000" } }] }), /no param "colour"\. Its params: (title, color|color, title)\./);

    // get_project names the placement still waiting for its file; the editor gets the three that have one.
    const proj = (await TOOL_HANDLERS.get_project(c(), { projectId: p.id })).text;
    const clips = ((await prisma.project.findUniqueOrThrow({ where: { id: p.id } })).timeline as { tracks: { v3: { id: string; kind?: string; sourceStart?: number }[] } }).tracks.v3.filter((x) => x.kind === "graphic");
    assert.deepEqual(clips.map((x) => x.sourceStart ?? 0), [0, 5, 10, 15]);
    assert.match(proj, new RegExp(`Graphic placements with no file yet: ${clips[3].id} queued \\(its params\\)`));
    assert.match(proj, /graphic=\w+ from 15s params=\{"title":"The end"\}/);
    const full = await projectFull(userId, p.id) as unknown as { graphicClipMedia: Record<string, { url: string; seconds: number }> };
    assert.deepEqual(Object.keys(full.graphicClipMedia).sort(), clips.slice(0, 3).map((x) => x.id).sort());
    // Once the recording is stored, the editor plays it on that placement and nothing more is queued.
    await job!.remove();
    await putObject(v.key, Buffer.from("webm"), "video/webm");
    const again = await projectFull(userId, p.id) as unknown as { graphicClipMedia: Record<string, { url: string }> };
    assert.ok(again.graphicClipMedia[clips[3].id]?.url.includes(`-v-${v.hash}.webm`));
    await TOOL_HANDLERS.apply_edits(c(), { projectId: p.id, edits: [{ op: "rename", name: "Reused" }] });
    assert.equal(await queue("graphic").getJob(v.jobId), undefined);
  });
});
