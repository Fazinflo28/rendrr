// Samples (render_samples): what Claude reads about a set of samples (rendering, done, the user's changes placed on
// each sample), and with a database: a set of samples is a render of kind "sample" holding what was asked; the same ask
// on the same version joins it (new notes kept); a frame past the end or a clip over 6 s is refused before anything
// renders; the app's view and get_samples read it; samples are not previews (open_projects and the review page do not
// count them). The pure part always runs; the rest needs a database, Redis and storage (as in .env).
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { AppSamples } from "@rendrr/shared";
import { samplesOut } from "../src/services/samples";

const base: AppSamples = {
  renderId: "rs1", project: { id: "p1", name: "Promo", aspect: "16:9", version: 3, editorUrl: null }, version: 3, status: "done", percent: 100, step: null, etaSec: null, error: null,
  width: 960, height: 540, comments: [],
  items: [{ kind: "frame", at: 1, end: null, note: "the hook", still: "u0", clip: null }, { kind: "clip", at: 6, end: 10, note: null, still: "u1", clip: "c1" }],
};
const comment = (id: string, time: number, text: string, resolved = false) => ({ id, time, text, author: "Ana", mine: true, resolved, at: 0, edited: false, renderId: "rs1", drawing: null, images: [] });

describe("what Claude reads about samples", () => {
  it("rendering: where it is and how to wait for it", () => {
    const t = samplesOut({ ...base, status: "running", percent: 40, step: "Rendering samples" });
    assert.match(t, /at 40% \(Rendering samples\)/);
    assert.match(t, /get_samples \{renderId: "rs1", wait_seconds: 60\}/);
    assert.match(t, /1\. frame 0:01\.0 - the hook\n2\. clip 0:06\.0-0:10\.0/);
  });
  it("done: each sample, and the user's open changes placed on their samples", () => {
    const t = samplesOut({ ...base, comments: [comment("c1", 1, "Bigger title"), comment("c2", 7.5, "Faster"), comment("c3", 20, "Somewhere else"), comment("c4", 1, "Done already", true)] });
    assert.match(t, /^Samples of v3 \(edit seconds, 960x540\)/);
    assert.match(t, /c1 \| sample 1 at 0:01\.0 \| Bigger title/);
    assert.match(t, /c2 \| sample 2 at 0:07\.5 \| Faster/);
    assert.match(t, /c3 \| 0:20\.0 at 0:20\.0 \| Somewhere else/);
    assert.doesNotMatch(t, /Done already/);
    assert.match(t, /one apply_edits, then render_samples again/);
  });
  it("done with no changes; failed", () => {
    assert.match(samplesOut(base), /No changes asked on them yet/);
    assert.match(samplesOut({ ...base, status: "failed", error: "Sample 2 could not be rendered." }), /failed: Sample 2 could not be rendered/);
  });
});

const ready = !!process.env.DATABASE_URL && !!process.env.REDIS_URL && !!process.env.S3_BUCKET;
const run = Math.random().toString(36).slice(2, 8);

describe("samples in Rendrr", { skip: !ready && "needs DATABASE_URL, REDIS_URL and storage" }, async () => {
  const { prisma } = await import("@rendrr/db");
  const { stubTranscript, MCP_TOOLS, APP_TOOLS } = await import("@rendrr/shared");
  const { createProject } = await import("../src/services/projects");
  const { TOOL_HANDLERS } = await import("../src/tools");
  const { APP_HANDLERS } = await import("../src/services/claudeApp");
  const { queue, redis } = await import("@rendrr/core");
  let userId = "", projectId = "";
  const c = () => ({ userId, ai: "claude" as const });
  const tool = (name: string, input: Record<string, unknown>) => TOOL_HANDLERS[name](c(), MCP_TOOLS.find((t) => t.name === name)!.input.parse(input));
  const app = (name: string, input: Record<string, unknown>) => APP_HANDLERS[name](c(), APP_TOOLS.find((t) => t.name === name)!.input.parse(input));
  before(async () => {
    userId = (await prisma.user.create({ data: { clerkId: `smp_${run}`, email: `smp-${run}@test.rendrr.dev`, name: "Ana" } })).id;
    await prisma.folder.create({ data: { userId, name: "Client", workspace: "Ana's Workspace" } });
    const analysis = { create: { transcriber: "stub", transcript: stubTranscript(20) as never, silences: [] as never, sceneCuts: [], keyFrames: [] } };
    const videoId = (await prisma.video.create({ data: { userId, name: `Talk ${run}`, seconds: 20, width: 1920, height: 1080, source: "drive", status: "ready", proxyKey: `proxies/${run}.mp4`, analysis } })).id;
    projectId = (await createProject(userId, { videoId, styleId: null })).id;
  });
  after(async () => {
    await prisma.render.deleteMany({ where: { userId } }).catch(() => {});
    await prisma.user.deleteMany({ where: { id: userId } }).catch(() => {});
    await queue("render").obliterate({ force: true }).catch(() => {});
    redis.disconnect();
  });

  it("render_samples makes a sample render holding what was asked; the same ask joins it; a bad ask renders nothing", async () => {
    const out = await tool("render_samples", { projectId, frames: [{ at: 2, note: "hook" }], clips: [{ start: 5 }] });
    const r = await prisma.render.findFirstOrThrow({ where: { projectId, kind: "sample" } });
    assert.deepEqual((r.plan as { samples: { items: unknown[] } }).samples.items, [{ kind: "frame", at: 2, note: "hook" }, { kind: "clip", at: 5, end: 9 }]);
    assert.equal(r.status === "queued" || r.status === "running", true);
    assert.equal((out.data as { samples: { renderId: string } }).samples.renderId, r.id);
    await tool("render_samples", { projectId, frames: [{ at: 2, note: "the hook, bigger" }], clips: [{ start: 5 }] });
    assert.equal(await prisma.render.count({ where: { projectId, kind: "sample" } }), 1, "the same ask joins it");
    assert.equal(((await prisma.render.findUniqueOrThrow({ where: { id: r.id } })).plan as { samples: { items: { note?: string }[] } }).samples.items[0].note, "the hook, bigger");
    const bad = await tool("render_samples", { projectId, clips: [{ start: 1, end: 9 }] });
    assert.match(bad.text, /at most 6 s/);
    assert.equal(await prisma.render.count({ where: { projectId, kind: "sample" } }), 1);
  });

  it("the app's view and get_samples read it; a change on a sample is listed for Claude; samples are not previews", async () => {
    const r = await prisma.render.findFirstOrThrow({ where: { projectId, kind: "sample" } });
    await prisma.render.update({ where: { id: r.id }, data: { status: "done", framesKeys: [`previews/${run}-s0.jpg`], plan: { samples: { items: (r.plan as { samples: { items: unknown[] } }).samples.items, done: [{ kind: "frame", at: 2, still: `previews/${run}-s0.jpg` }, { kind: "clip", at: 5, end: 9, still: `previews/${run}-s1.jpg`, clip: `previews/${run}-c1.mp4` }], width: 960, height: 540 } } as never } });
    await app("app_add_comment", { projectId, time: 2, text: "Yellow title", renderId: r.id });
    const v = (await app("app_get_samples", { renderId: r.id })).data as AppSamples;
    assert.equal(v.status, "done"); assert.equal(v.items.length, 2); assert.ok(v.items[1].clip && v.items[1].still);
    assert.equal(v.comments[0].text, "Yellow title");
    const g = await tool("get_samples", { renderId: r.id, images: false });
    assert.match(g.text, /sample 1 at 0:02\.0 \| Yellow title/);
    const open = await app("app_get_project", { projectId });
    assert.equal((open.data as { versions: unknown[] }).versions.length, 0, "a sample is not a version to watch");
    const cm = await tool("get_comments", { projectId });
    assert.match(cm.text, /on samples .* \(get_samples\)/);
  });
});
