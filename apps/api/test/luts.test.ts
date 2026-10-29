// add_lut: a .cube LUT reaches Rendrr through the connector (its text, a link, or a file in the user's Drive), is
// checked, kept, replaced by name, listed, and graded with like one imported in the editor. Bad sources are refused
// with the reason. Needs a database and storage (as in .env). Run: pnpm --filter @rendrr/api test
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

const ready = !!process.env.DATABASE_URL && !!process.env.REDIS_URL && !!process.env.S3_BUCKET;
const run = Math.random().toString(36).slice(2, 8);
const cube = (title: string, lift = 0) => [`TITLE "${title}"`, "LUT_3D_SIZE 2", ...[0, 1].flatMap((b) => [0, 1].flatMap((g) => [0, 1].map((r) => `${Math.min(1, r + lift)} ${g} ${b * 0.9}`)))].join("\n");

describe("add_lut", { skip: !ready && "needs DATABASE_URL, REDIS_URL and storage" }, async () => {
  const { prisma } = await import("@rendrr/db");
  const { getText, redis } = await import("@rendrr/core");
  const { stubTranscript, MCP_TOOLS } = await import("@rendrr/shared");
  const { createProject } = await import("../src/services/projects");
  const { TOOL_HANDLERS } = await import("../src/tools");
  const { driveIdOf } = await import("../src/services/luts");
  let userId = "", projectId = "";
  const tool = (name: string, input: Record<string, unknown>) => TOOL_HANDLERS[name]({ userId, ai: "claude" as const }, MCP_TOOLS.find((t) => t.name === name)!.input.parse(input));
  before(async () => {
    userId = (await prisma.user.create({ data: { clerkId: `lut_${run}`, email: `lut-${run}@test.rendrr.dev`, name: "Ana" } })).id;
    const analysis = { create: { transcriber: "stub", transcript: stubTranscript(20) as never, silences: [] as never, sceneCuts: [], keyFrames: [] } };
    const videoId = (await prisma.video.create({ data: { userId, name: `Talk ${run}`, seconds: 20, width: 1920, height: 1080, source: "drive", status: "ready", proxyKey: `proxies/${run}.mp4`, analysis } })).id;
    projectId = (await createProject(userId, { videoId, name: `Graded ${run}` })).id;
  });
  after(async () => {
    await prisma.project.deleteMany({ where: { userId } });
    await prisma.video.deleteMany({ where: { userId } });
    await prisma.lut.deleteMany({ where: { userId } });
    await prisma.user.deleteMany({ where: { id: userId } });
    await redis().quit().catch(() => {});
  });

  it("adds a LUT from its text, named from the file's title, and the edit grades with it", async () => {
    const out = await tool("add_lut", { text: cube("Daydream 6K") });
    console.log(out.text);
    assert.match(out.text, /^Added LUT "Daydream 6K" \w+ \(3D, 2 points\)\. Put it on an edit: apply_edits set_grade\{all: true, lut: \{id: "\w+", amount: 1\}\}/);
    const id = (out.data as { lutId: string }).lutId;
    const row = await prisma.lut.findUniqueOrThrow({ where: { id } });
    assert.equal(row.userId, userId);
    assert.equal(await getText(row.key), cube("Daydream 6K"));
    const ed = await tool("apply_edits", { projectId, edits: [{ op: "set_grade", all: true, lut: { id, amount: 1 }, saturation: 112, temperature: -8 }] });
    assert.match(ed.text, /^Done \(v2,/);
    const p = await tool("get_project", { projectId });
    assert.match(p.text, new RegExp(`Your LUTs \\(set_grade lut id\\): ${id} "Daydream 6K"`));
    assert.match(p.text, /LUT "Daydream 6K"/);
  });

  it("the same name again replaces that LUT's file (same id, so grades using it update)", async () => {
    const first = await prisma.lut.findFirstOrThrow({ where: { userId, name: "Daydream 6K" } });
    const out = await tool("add_lut", { name: "Daydream 6K.cube", text: cube("whatever", 0.1) });
    assert.match(out.text, /^Replaced LUT "Daydream 6K" /);
    assert.equal((out.data as { lutId: string }).lutId, first.id);
    assert.equal(await prisma.lut.count({ where: { userId } }), 1);
    assert.equal(await getText(first.key), cube("whatever", 0.1));
  });

  it("refuses a broken file, a source that is not public https, two sources at once, and Drive without a connection", async () => {
    await assert.rejects(tool("add_lut", { name: "Bad", text: "LUT_3D_SIZE 2\n0 0 0\n1 1 1" }), /Nothing was saved/);
    await assert.rejects(tool("add_lut", { url: "http://example.com/look.cube" }), /LUT urls must start with https/);
    await assert.rejects(tool("add_lut", { url: "https://127.0.0.1/look.cube" }), /not on the public internet/);
    await assert.rejects(tool("add_lut", { url: "https://example.com/a.cube", text: cube("x") }), /one of the three/);
    await assert.rejects(tool("add_lut", {}), /one of the three/);
    await assert.rejects(tool("add_lut", { driveFileId: "1AbCdEfGhIjKlMnOp" }), /Connect Google Drive in Rendrr first/);
    assert.equal(await prisma.lut.count({ where: { userId } }), 1);
  });

  it("reads the file id out of Google Drive share links", () => {
    assert.equal(driveIdOf("https://drive.google.com/file/d/1AbCdEfGhIjKlMnOpQ/view?usp=sharing"), "1AbCdEfGhIjKlMnOpQ");
    assert.equal(driveIdOf("https://drive.google.com/open?id=1AbCdEfGhIjKlMnOpQ"), "1AbCdEfGhIjKlMnOpQ");
    assert.equal(driveIdOf("https://drive.google.com/uc?export=download&id=1AbCdEfGhIjKlMnOpQ"), "1AbCdEfGhIjKlMnOpQ");
    assert.equal(driveIdOf("https://docs.google.com/file/d/1AbCdEfGhIjKlMnOpQ/edit"), "1AbCdEfGhIjKlMnOpQ");
    assert.equal(driveIdOf("https://example.com/file/d/1AbCdEfGhIjKlMnOpQ"), null);
    assert.equal(driveIdOf("not a url"), null);
  });
});
