// add_lut: a .cube LUT reaches Rendrr through the connector (its text, a link, a file in the user's Drive, or an upload
// link the AI's workspace sends the file to), is
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
    await assert.rejects(tool("add_lut", { url: "https://example.com/a.cube", text: cube("x") }), /one of the four/);
    await assert.rejects(tool("add_lut", {}), /one of the four/);
    await assert.rejects(tool("add_lut", { driveFileId: "1AbCdEfGhIjKlMnOp" }), /Connect Google Drive in Rendrr first/);
    assert.equal(await prisma.lut.count({ where: { userId } }), 1);
  });

  it("upload: a one-time link the AI's workspace sends the .cube to, with curl, as it is", async () => {
    const { buildServer } = await import("../src/server");
    const app = await buildServer();
    await app.listen({ port: 0, host: "127.0.0.1" });
    try {
      const out = await tool("add_lut", { upload: true, name: "Ronnii 6K Daydream" });
      console.log(out.text);
      const url = (out.data as { uploadUrl: string }).uploadUrl;
      assert.match(url, /^https?:\/\/[^/]+\/luts\/upload\/[\w-]{32}$/);
      assert.match(out.text, /curl -sS -X PUT --data-binary @"<file>\.cube"/);
      assert.match(out.text, /allowed domains/);
      const local = (u: string) => u.replace(/^https?:\/\/[^/]+/, `http://127.0.0.1:${(app.server.address() as { port: number }).port}`);
      // A big LUT (33 points, about 1 MB) the way curl sends it: --data-binary with curl's own content type.
      const big = ["TITLE \"from the workspace\"", "LUT_3D_SIZE 33", ...Array.from({ length: 33 ** 3 }, (_, i) => { const r = i % 33, g = Math.floor(i / 33) % 33, b = Math.floor(i / 1089); return `${(r / 32).toFixed(6)} ${(g / 32 * 0.95).toFixed(6)} ${(b / 32).toFixed(6)}`; })].join("\n");
      const file = `${process.env.TMPDIR || "/tmp"}/lut-${run}.cube`;
      (await import("node:fs")).writeFileSync(file, big);
      // curl runs beside the server (a blocking call would stop the server from answering).
      const { execFile } = await import("node:child_process");
      const curl = (args: string[]) => new Promise<string>((ok, no) => execFile("curl", ["-sS", "--max-time", "20", ...args], { encoding: "utf8" }, (e, out) => (e ? no(e) : ok(out))));
      const sent = JSON.parse(await curl(["-X", "PUT", "--data-binary", `@${file}`, local(url)]));
      console.log(sent.text);
      assert.equal(sent.name, "Ronnii 6K Daydream");
      assert.equal(sent.kind, "3d"); assert.equal(sent.size, 33);
      assert.match(sent.text, /^Added LUT "Ronnii 6K Daydream" \w+ \(3D, 33 points\)\. Put it on the edit: apply_edits set_grade\{all: true, lut: \{id: "\w+"/);
      const row = await prisma.lut.findUniqueOrThrow({ where: { id: sent.id } });
      assert.equal(row.userId, userId);
      assert.equal((await getText(row.key)).length, big.length);
      // One file per link.
      const again = await curl(["-X", "PUT", "--data-binary", `@${file}`, local(url)]);
      assert.match(again, /expired or was used already/);
      // curl -T (no content type), named by ?name=, and the file's TITLE when no name is given.
      const l2 = (await tool("add_lut", { upload: true })).data as { uploadUrl: string };
      const t2 = JSON.parse(await curl(["-T", file, local(l2.uploadUrl) + "?name=Workspace%20look"]));
      assert.equal(t2.name, "Workspace look");
      const l3 = (await tool("add_lut", { upload: true })).data as { uploadUrl: string };
      const t3 = await app.inject({ method: "POST", url: new URL(l3.uploadUrl).pathname, headers: { "content-type": "application/octet-stream" }, payload: cube("Titled in the file") });
      assert.equal(t3.json().name, "Titled in the file");
      // A form, an empty body, a broken file, a made-up link: refused, nothing kept.
      const l4 = (await tool("add_lut", { upload: true })).data as { uploadUrl: string };
      const form = await curl(["-F", `file=@${file}`, local(l4.uploadUrl)]);
      assert.match(form, /Send the \.cube file itself as the body/);
      const empty = await app.inject({ method: "PUT", url: new URL(l4.uploadUrl).pathname });
      assert.match(empty.json().error.message, /Nothing came with the upload/);
      const broken = await app.inject({ method: "PUT", url: new URL(l4.uploadUrl).pathname, headers: { "content-type": "text/plain" }, payload: "LUT_3D_SIZE 2\n0 0 0" });
      assert.match(broken.json().error.message, /Nothing was saved/);
      const fake = await app.inject({ method: "PUT", url: "/luts/upload/not-a-real-link-at-all-0123456789", payload: cube("x") });
      assert.equal(fake.statusCode, 404);
      assert.equal(await prisma.lut.count({ where: { userId } }), 4); // Daydream 6K, Ronnii 6K Daydream, Workspace look, Titled in the file
      // The link still works after a refused file (it is spent only by a saved one).
      const ok = await app.inject({ method: "PUT", url: new URL(l4.uploadUrl).pathname, payload: cube("After a mistake") });
      assert.equal(ok.statusCode, 200);
    } finally { await app.close(); }
  });

  it("apply_edits set_grade takes the LUT's own text or its name, so any chat can apply a LUT from its workspace", async () => {
    const file = (await import("node:fs")).readFileSync(new URL("./fixtures/ronnii-6k-daydream.cube", import.meta.url), "utf8");
    const out = await tool("apply_edits", { projectId, edits: [{ op: "set_grade", all: true, reset: true, lut: { cube: file, amount: 1 } }, { op: "set_effects", all: true, effects: [{ type: "sharpen", amount: 25 }] }] });
    console.log(out.text.split("\n")[0]);
    assert.match(out.text, /^Done \(v\d+,.*LUT "Ronnii 6K Daydream"/);
    const l = await prisma.lut.findFirstOrThrow({ where: { userId, name: "Ronnii 6K Daydream" } });
    assert.equal(l.size, 9);
    const p = await prisma.project.findUniqueOrThrow({ where: { id: projectId } });
    const v1 = (p.timeline as { tracks: { v1: { grade?: { lut?: { id: string; cube?: string } }; effects?: unknown[] }[] } }).tracks.v1;
    assert.ok(v1.every((c) => c.grade?.lut?.id === l.id && !("cube" in (c.grade?.lut ?? {}))), "every clip keeps the LUT's id, not its text");
    assert.ok(v1.every((c) => JSON.stringify(c.effects) === JSON.stringify([{ type: "sharpen", amount: 25 }])));
    // The activity log keeps how long the file was, not the file.
    const acts = await prisma.aiAction.findMany({ where: { projectId } });
    assert.ok(acts.length > 0 && !acts.some((a) => /LUT_3D_SIZE 9/.test(JSON.stringify(a))), "the log has no LUT file in it");
    // By name (any case), and a name Rendrr does not have.
    const byName = await tool("apply_edits", { projectId, edits: [{ op: "set_grade", all: true, lut: { name: "ronnii 6k daydream", amount: 0.8 } }] });
    assert.match(byName.text, /LUT "Ronnii 6K Daydream" 80%/);
    await assert.rejects(tool("apply_edits", { projectId, edits: [{ op: "set_grade", all: true, lut: { name: "Nope" } }] }), /There is no LUT named "Nope" in Rendrr\. Yours: .*Ronnii 6K Daydream/);
    await assert.rejects(tool("apply_edits", { projectId, edits: [{ op: "set_grade", all: true, lut: { amount: 1 } }] }), /lut needs its id, its name, or the \.cube text/);
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
