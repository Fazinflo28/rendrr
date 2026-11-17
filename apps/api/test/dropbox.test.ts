// Files from the user's Dropbox (add_footage from: dropbox, and the Library's and the editor's Dropbox tab): share links
// are brought in in the background, so a big video does not hold the page; each arrival goes in the library and the
// edit, a folder link and a bad link say why, add_footage pickId tells the AI what is still coming in and what failed,
// and only the pick's own account can send links to it. The download is a stand-in (fetch is replaced). Needs a
// database, Redis, storage and FFmpeg (as in .env).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

process.env.INTERNAL_API_SECRET ||= "test-internal-secret";
process.env.LOG_LEVEL = process.env.TEST_LOG || "silent";
const ready = !!process.env.DATABASE_URL && !!process.env.REDIS_URL && !!process.env.S3_BUCKET;
const ff = (() => { try { execFileSync("ffmpeg", ["-version"], { stdio: "ignore" }); return true; } catch { return false; } })();
const run = Math.random().toString(36).slice(2, 8);
const HOST = "https://93.184.215.14"; // a public address: the stand-in answers for it, nothing goes out
const FILE = `${HOST}/s/abc/Product%20shot.png`;
const SLOW = `${HOST}/s/def/Second%20shot.png`;
const MISSING = `${HOST}/s/ghi/Gone.png`;
const FOLDER = "https://www.dropbox.com/scl/fo/def456/Shoot%20day?rlkey=xyz&dl=0";

describe("files from Dropbox", { skip: (!ready || !ff) && "needs a database, Redis, storage and FFmpeg" }, async () => {
  const { prisma } = await import("@rendrr/db");
  const { stubTranscript, MCP_TOOLS } = await import("@rendrr/shared");
  const { createProject } = await import("../src/services/projects");
  const { TOOL_HANDLERS } = await import("../src/tools");
  const { deletePrefix, redis } = await import("@rendrr/core");
  const { buildServer } = await import("../src/server");
  let app: Awaited<ReturnType<typeof buildServer>>;
  let userId = "", otherId = "", projectId = "", pickId = "";
  const clerkId = `dbx_${run}`;
  const c = () => ({ userId, ai: "claude" as const, clerkId });
  const as = (id: string) => ({ "x-internal-secret": process.env.INTERNAL_API_SECRET!, "x-rendrr-clerk-id": id });
  const dir = mkdtempSync(join(tmpdir(), "dropbox-"));
  const realFetch = globalThis.fetch;
  let png = Buffer.alloc(0);
  let letSlowGo: () => void = () => {};
  const slowGate = new Promise<void>((ok) => { letSlowGo = ok; });
  const fetched: string[] = [];
  const view = async () => (await app.inject({ method: "GET", url: `/picks/${pickId}`, headers: as(clerkId) })).json() as { pending: number; errors: { name: string; message: string }[]; videos: { id: string; name: string; still: boolean; status: string }[] };
  const until = async (f: () => Promise<boolean>, ms = 20000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await f()) return true; await new Promise((r) => setTimeout(r, 150)); } return false; };

  before(async () => {
    execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=800x600:d=1", "-frames:v", "1", join(dir, "shot.png")]);
    png = readFileSync(join(dir, "shot.png"));
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      if (url.origin !== HOST) return realFetch(input as never, init);
      fetched.push(url.href);
      if (url.pathname.includes("/ghi/")) return new Response("gone", { status: 404 });
      if (url.pathname.includes("/def/")) await slowGate;
      return new Response(png, { status: 200, headers: { "content-type": "image/png", "content-length": String(png.length) } });
    }) as typeof fetch;
    app = await buildServer();
    userId = (await prisma.user.create({ data: { clerkId, email: `dbx-${run}@test.rendrr.dev`, name: "Dee" } })).id;
    otherId = (await prisma.user.create({ data: { clerkId: `dbxo_${run}`, email: `dbxo-${run}@test.rendrr.dev`, name: "Other" } })).id;
    await prisma.folder.create({ data: { userId, name: "Edits", workspace: "Personal" } });
    const base = await prisma.video.create({ data: { userId, name: "Base", seconds: 20, width: 1280, height: 720, source: "local", status: "ready", proxyKey: `proxies/${run}.mp4`, analysis: { create: { transcriber: "stub", transcript: stubTranscript(20) as never, silences: [] as never, sceneCuts: [], keyFrames: [] } } } });
    projectId = (await createProject(userId, { videoId: base.id, name: `Reel ${run}` })).id;
  });
  after(async () => {
    letSlowGo();
    globalThis.fetch = realFetch;
    await new Promise((r) => setTimeout(r, 500));
    await prisma.project.deleteMany({ where: { userId: { in: [userId, otherId] } } });
    await prisma.folder.deleteMany({ where: { userId: { in: [userId, otherId] } } });
    await prisma.video.deleteMany({ where: { userId: { in: [userId, otherId] } } });
    await prisma.libraryFolder.deleteMany({ where: { userId } });
    await prisma.user.deleteMany({ where: { id: { in: [userId, otherId] } } });
    for (const p of ["uploads/", "proxies/", "frames/"]) await deletePrefix(`${p}${userId}/`).catch(() => {});
    await app.close(); await redis().quit().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });

  it("add_footage offers Dropbox in a sentence and takes from: dropbox", () => {
    const t = MCP_TOOLS.find((x) => x.name === "add_footage")!;
    assert.match(t.description, /\(on their computer, too big to attach; in their Dropbox\): from gives a link to send them/);
    assert.ok(t.input.safeParse({ from: "dropbox" }).success);
    assert.ok(!t.input.safeParse({ from: "box" }).success);
  });

  it("from: dropbox gives the user a link to paste or choose their Dropbox files", async () => {
    const r = await TOOL_HANDLERS.add_footage(c(), { from: "dropbox", projectId });
    pickId = (r.data as { pickId: string }).pickId;
    assert.match(r.text, new RegExp(`^Give the user this link to add files from their Dropbox \\(open it where they are signed in to Rendrr; it works for 60 minutes\\): https?://\\S+/add/${pickId}\\n`));
    assert.match(r.text, /They paste a Dropbox link there, or choose the files from their Dropbox\. They go in the edit's Media panel too\./);
    const v = await view();
    assert.equal(v.pending, 0); assert.deepEqual(v.errors, []); assert.equal(v.videos.length, 0);
  });

  it("only https links, and only from the pick's own account", async () => {
    const bad = await app.inject({ method: "POST", url: `/picks/${pickId}/links`, headers: as(clerkId), payload: { urls: ["http://example.com/a.mp4"] } });
    assert.equal(bad.statusCode, 400); assert.match(bad.json().error.message, /That is not a link/);
    const other = await app.inject({ method: "POST", url: `/picks/${pickId}/links`, headers: as(`dbxo_${run}`), payload: { urls: [FILE] } });
    assert.equal(other.statusCode, 403); assert.equal(other.json().error.code, "pick-other-account");
    assert.equal((await app.inject({ method: "POST", url: `/picks/${pickId}/links`, headers: as(clerkId), payload: { urls: [] } })).statusCode, 400);
    assert.equal(fetched.length, 0, "nothing was downloaded");
  });

  it("links come in in the background: the page says what is coming, what arrived (in the edit) and what failed", async () => {
    const r = await app.inject({ method: "POST", url: `/picks/${pickId}/links`, headers: as(clerkId), payload: { urls: [FILE, FOLDER, MISSING, SLOW, FILE] } });
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(r.json().pending, 4, "the same link twice is brought in once");
    assert.ok(await until(async () => (await view()).pending === 1), "all but the slow one are done");
    const v = await view();
    assert.deepEqual(v.videos.map((x) => [x.name, x.still]), [["Product shot", true]], "a picture (its preview is made by the worker, as for any file)");
    assert.deepEqual(v.errors.map((e) => e.name), ["Shoot day", "Gone.png"]);
    assert.match(v.errors[0].message, /^That is a link to a Dropbox folder, not a file: share each video's own link, or choose the files with the Dropbox button/);
    assert.match(v.errors[1].message, /answered 404/);
    assert.ok(!fetched.some((u) => u.includes("dropbox.com")), "a folder link is not downloaded");
    const tl = (await prisma.project.findUniqueOrThrow({ where: { id: projectId } })).timeline as { media?: string[] };
    assert.ok(tl.media?.includes(v.videos[0].id), "it went in the edit's Media panel");

    const mid = await TOOL_HANDLERS.add_footage(c(), { pickId });
    assert.match(mid.text, new RegExp(`^From their Dropbox, 1 file so far:\\n- In the library and this edit's Media panel: the picture "Product shot" ${v.videos[0].id}`));
    assert.match(mid.text, /\n1 file is still coming in \(a big video takes a while: wait_seconds waits\)\./);
    assert.match(mid.text, /\nCould not be brought in: "Shoot day": That is a link to a Dropbox folder, not a file[^;]*; "Gone\.png": The footage url answered 404\./);

    letSlowGo();
    const done = await TOOL_HANDLERS.add_footage(c(), { pickId, wait_seconds: 15 });
    assert.match(done.text, /^From their Dropbox, 2 files so far:/);
    assert.ok(!/still coming in/.test(done.text));
    assert.deepEqual((done.data as { videoIds: string[] }).videoIds.length, 2);
    assert.equal((await view()).pending, 0);
  });

  it("the Library's own Dropbox tab makes a pick of its own (no edit), for this account", async () => {
    const r = await app.inject({ method: "POST", url: "/picks", headers: as(clerkId), payload: { source: "dropbox" } });
    assert.equal(r.statusCode, 200, r.body);
    const p = r.json() as { id: string; source: string; project: unknown };
    assert.equal(p.source, "dropbox"); assert.equal(p.project, null);
    assert.equal((await app.inject({ method: "GET", url: `/picks/${p.id}`, headers: as(`dbxo_${run}`) })).statusCode, 403);
    assert.equal((await app.inject({ method: "POST", url: "/picks", headers: as(clerkId), payload: { source: "box" } })).statusCode, 400);
  });
});
