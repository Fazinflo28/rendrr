// The project bin and the reference from the AI: apply_edits add_media / remove_media keep library videos with the
// edit (the editor's Media panel), set_reference attaches a reference video (the editor's Reference monitor) and is
// kept on the project, not in the edit; get_project lists both. Needs a database (as in .env).
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

const ready = !!process.env.DATABASE_URL && !!process.env.REDIS_URL && !!process.env.S3_BUCKET;
const run = Math.random().toString(36).slice(2, 8);

describe("project bin and reference", { skip: !ready && "needs DATABASE_URL, REDIS_URL and storage" }, async () => {
  const { prisma } = await import("@rendrr/db");
  const { redis } = await import("@rendrr/core");
  const { stubTranscript, MCP_TOOLS } = await import("@rendrr/shared");
  const { createProject } = await import("../src/services/projects");
  const { TOOL_HANDLERS } = await import("../src/tools");
  let userId = "", projectId = "", broll = "", ref = "", other = "";
  const tool = (name: string, input: Record<string, unknown>) => TOOL_HANDLERS[name]({ userId, ai: "claude" as const }, MCP_TOOLS.find((t) => t.name === name)!.input.parse(input));
  before(async () => {
    userId = (await prisma.user.create({ data: { clerkId: `bin_${run}`, email: `bin-${run}@test.rendrr.dev`, name: "Ana" } })).id;
    const otherUser = (await prisma.user.create({ data: { clerkId: `bin2_${run}`, email: `bin2-${run}@test.rendrr.dev`, name: "Other" } })).id;
    const analysis = () => ({ create: { transcriber: "stub", transcript: stubTranscript(20) as never, silences: [] as never, sceneCuts: [], keyFrames: [] } });
    const mk = (u: string, name: string, kind = "footage") => prisma.video.create({ data: { userId: u, name, kind, seconds: 20, width: 1920, height: 1080, source: "drive", status: "ready", proxyKey: `proxies/${run}-${name}.mp4`, analysis: analysis() } });
    const main = await mk(userId, `Talk ${run}`);
    broll = (await mk(userId, `Office ${run}`)).id;
    ref = (await mk(userId, `Hormozi ref ${run}`, "reference")).id;
    other = (await mk(otherUser, `Not mine ${run}`)).id;
    projectId = (await createProject(userId, { videoId: main.id, name: `Bin ${run}` })).id;
  });
  after(async () => {
    await prisma.project.deleteMany({ where: { userId } });
    await prisma.video.deleteMany({ where: { name: { endsWith: run } } });
    await prisma.user.deleteMany({ where: { clerkId: { in: [`bin_${run}`, `bin2_${run}`] } } });
    await redis().quit().catch(() => {});
  });

  it("add_media keeps library videos in the project bin; get_project lists them; another user's video is refused", async () => {
    const out = await tool("apply_edits", { projectId, edits: [{ op: "add_media", videoIds: [broll, ref, broll] }] });
    assert.match(out.text, new RegExp(`project bin: added "Office ${run}", "Hormozi ref ${run}", "Office ${run}"`));
    const p = await prisma.project.findUniqueOrThrow({ where: { id: projectId } });
    assert.deepEqual((p.timeline as { media?: string[] }).media, [broll, ref]);
    const gp = await tool("get_project", { projectId, clipsLimit: 1 });
    assert.match(gp.text, new RegExp(`Project bin \\(add_media / remove_media; add_clip videoId puts one in the edit\\): ${broll} "Office ${run}" 20\\.0s; ${ref} "Hormozi ref ${run}" 20\\.0s \\(reference\\)`));
    await assert.rejects(tool("apply_edits", { projectId, edits: [{ op: "add_media", videoIds: [other] }] }), /no video/);
    const rm = await tool("apply_edits", { projectId, edits: [{ op: "remove_media", videoIds: [broll] }] });
    assert.match(rm.text, /project bin: took off 1 video/);
  });

  it("set_reference attaches a reference video (kept on the project, with other edits in the same call)", async () => {
    const out = await tool("apply_edits", { projectId, edits: [{ op: "set_reference", videoId: ref }] });
    assert.equal(out.text, `Reference set: video "Hormozi ref ${run}" (shown in the editor's Reference monitor, never applied).`);
    const p = await prisma.project.findUniqueOrThrow({ where: { id: projectId } });
    assert.deepEqual(p.reference, { kind: "video", id: ref, name: `Hormozi ref ${run}` });
    const gp = await tool("get_project", { projectId, clipsLimit: 1 });
    assert.match(gp.text, new RegExp(`Reference the user attached, not applied: reference video ${ref} "Hormozi ref ${run}"`));
    const both = await tool("apply_edits", { projectId, edits: [{ op: "set_reference", videoId: null }, { op: "rename", name: `Bin ${run} v2` }] });
    assert.match(both.text, /^Reference taken off\.\nDone \(v\d+/);
    assert.equal((await prisma.project.findUniqueOrThrow({ where: { id: projectId } })).reference, null);
    await assert.rejects(tool("apply_edits", { projectId, edits: [{ op: "set_reference", videoId: other }] }), /not available/);
  });
});
