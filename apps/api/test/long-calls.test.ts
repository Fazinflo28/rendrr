// Long jobs never hold a tool call past the client's timeout: create_graphic, render_preview and render_final answer
// within 10 s with the id and where the job is, and get_graphic / get_render say how far it got and, once done,
// the result. No worker runs here, so every job stays unfinished (as a long recording or render would).
// Needs a database and Redis (as in .env). Run: pnpm --filter @rendrr/api test
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

const ready = !!process.env.DATABASE_URL && !!process.env.REDIS_URL && !!process.env.S3_BUCKET;
const run = Math.random().toString(36).slice(2, 8);

describe("long tool calls answer at once", { skip: !ready && "needs DATABASE_URL, REDIS_URL and storage" }, async () => {
  const { prisma } = await import("@rendrr/db");
  const { stubTranscript, MCP_TOOLS } = await import("@rendrr/shared");
  const { createProject } = await import("../src/services/projects");
  const { TOOL_HANDLERS } = await import("../src/tools");
  const { publishGraphic, queue, redis } = await import("@rendrr/core");

  let userId = "", videoId = "";
  const c = () => ({ userId, ai: "claude" as const, clerkId: `long_${run}` });
  const timed = async <T>(p: Promise<T>) => { const t0 = Date.now(); const v = await p; return { v, ms: Date.now() - t0 }; };
  before(async () => {
    userId = (await prisma.user.create({ data: { clerkId: `long_${run}`, email: `long-${run}@test.rendrr.dev`, name: "Long" } })).id;
    await prisma.folder.create({ data: { userId, name: "My edits", workspace: "Long's Workspace" } });
    const analysis = { create: { transcriber: "stub", transcript: stubTranscript(20) as never, silences: [] as never, sceneCuts: [], keyFrames: [] } };
    videoId = (await prisma.video.create({ data: { userId, name: `Talk ${run}`, seconds: 20, width: 1920, height: 1080, source: "drive", status: "ready", proxyKey: `proxies/${run}.mp4`, analysis } })).id;
  });
  after(async () => {
    for (const j of await queue("graphic").getJobs(["waiting", "delayed"])) if ((j.data as { graphicId?: string }).graphicId && (await prisma.graphic.findFirst({ where: { id: (j.data as { graphicId: string }).graphicId, ownerId: userId } }))) await j.remove().catch(() => {});
    for (const j of await queue("render").getJobs(["waiting", "delayed"])) if (await prisma.render.findFirst({ where: { id: (j.data as { renderId: string }).renderId, userId } })) await j.remove().catch(() => {});
    await prisma.project.deleteMany({ where: { userId } });
    await prisma.graphic.deleteMany({ where: { ownerId: userId } });
    await prisma.video.deleteMany({ where: { userId } });
    await prisma.user.deleteMany({ where: { id: userId } });
    await redis().quit().catch(() => {});
  });

  it("create_graphic returns the id in under 10 s; get_graphic shows its progress, then the result", async () => {
    // A 3 minute 1080x1920 graphic: minutes of recording.
    const { v, ms } = await timed(TOOL_HANDLERS.create_graphic(c(), { code: "<div id=a>Hi</div>", durationSec: 180, width: 1080, height: 1920, params: { title: "Hi" } }));
    const id = (v.data as { graphicId: string }).graphicId;
    console.log(`create_graphic answered in ${ms} ms: ${v.text}`);
    assert.ok(ms < 10_000, `took ${ms} ms`);
    assert.match(v.text, new RegExp(`^Graphic ${id} is recording`));
    assert.match(v.text, /get_graphic/);
    assert.match((await TOOL_HANDLERS.get_graphic(c(), { graphicId: id })).text, new RegExp(`^${id} \\| Custom graphic \\| queued`));
    // The worker's progress, as it publishes it.
    await prisma.graphic.update({ where: { id }, data: { status: "rendering" } });
    await publishGraphic(id, { percent: 42, etaSec: 95 });
    assert.match((await TOOL_HANDLERS.get_graphic(c(), { graphicId: id })).text, /recording: 42% done, about 2 min left/);
    // Done, with a warning from the recording.
    await prisma.graphic.update({ where: { id }, data: { status: "ready", renderedKey: `graphics/${userId}/${id}.webm`, warnings: ["Fonts not installed, drawn with a fallback: X."] } });
    const done = (await TOOL_HANDLERS.get_graphic(c(), { graphicId: id })).text;
    assert.match(done, new RegExp(`^${id} \\| Custom graphic \\| ready \\| 180s \\| 1080x1920, transparent \\| params \\{"title":"Hi"\\}`));
    assert.match(done, /Warning: Fonts not installed, drawn with a fallback: X\./);
    assert.match(done, /Place it with apply_edits add_graphic/);
    await prisma.graphic.update({ where: { id }, data: { status: "failed", error: "The graphic code threw an error: boom" } });
    assert.match((await TOOL_HANDLERS.get_graphic(c(), { graphicId: id })).text, /failed: The graphic code threw an error: boom\. Fix the code and call create_graphic again\./);
    await assert.rejects(TOOL_HANDLERS.get_graphic({ ...c(), userId: "someone-else" }, { graphicId: id }), /does not exist/);
  });

  it("render_preview and render_final return the render id in under 10 s; get_render says where it is", async () => {
    const p = await createProject(userId, { videoId });
    for (const tool of ["render_preview", "render_final"] as const) {
      const { v, ms } = await timed(TOOL_HANDLERS[tool](c(), { projectId: p.id }));
      console.log(`${tool} answered in ${ms} ms: ${v.text}`);
      assert.ok(ms < 10_000, `${tool} took ${ms} ms`);
      const id = /render id (\w+)/.exec(v.text)?.[1];
      assert.ok(id, v.text);
      assert.match((await TOOL_HANDLERS.get_render(c(), { renderId: id })).text, new RegExp(`render is queued \\(render id ${id}`));
    }
  });

  it("the tool list says they answer at once", () => {
    const doc = (n: string) => MCP_TOOLS.find((t) => t.name === n)!.description;
    assert.match(doc("create_graphic"), /get_graphic/);
    assert.match(doc("render_preview"), /get_render/);
    assert.match(doc("get_graphic"), /progress/);
  });
});
