// Saving a final into the user's Google Drive where they said: a path, a shared drive, a folder link, a name found
// anywhere, folders made on request, a refused folder, a chunk that fails and is picked up again, a final still
// rendering. The real Drive code and the worker's job run against a stand-in Google (an HTTP server) and the local
// storage. Needs a database, Redis and storage (as in .env).
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

const ready = !!process.env.DATABASE_URL && !!process.env.REDIS_URL && !!process.env.S3_BUCKET;
const run = Math.random().toString(36).slice(2, 8);
const FOLDER = "application/vnd.google-apps.folder";

// The stand-in Google: a small Drive, upload sessions with byte ranges.
type Item = { id: string; name: string; mimeType: string; parents: string[]; driveId?: string; locked?: boolean; bytes?: Buffer; type?: string };
const id = (s: string) => (s + "0".repeat(25)).slice(0, 25);
const items: Item[] = [
  { id: id("1Clients"), name: "Clients", mimeType: FOLDER, parents: ["root"] },
  { id: id("1BFS"), name: "BFS Health", mimeType: FOLDER, parents: [id("1Clients")] },
  { id: id("1Finals"), name: "Finals", mimeType: FOLDER, parents: [id("1BFS")] },
  { id: id("1RawTop"), name: "Raw", mimeType: FOLDER, parents: [id("1Clients")] },
  { id: id("1RawBFS"), name: "Raw", mimeType: FOLDER, parents: [id("1BFS")] },
  { id: id("1Unique"), name: "Unique Folder", mimeType: FOLDER, parents: [id("1BFS")] },
  { id: id("1Locked"), name: "Locked", mimeType: FOLDER, parents: ["root"], locked: true },
  { id: id("0ATeam"), name: "Team", mimeType: FOLDER, parents: [], driveId: id("0ATeam") },
  { id: id("1Deliv"), name: "Deliveries", mimeType: FOLDER, parents: [id("0ATeam")], driveId: id("0ATeam") },
];
const sessions = new Map<string, { name: string; parent: string; size: number; got: Buffer[]; received: number; type: string }>();
let failNextChunk = 0, chunks = 0, nextId = 1;
const body = (req: IncomingMessage) => new Promise<Buffer>((ok) => { const b: Buffer[] = []; req.on("data", (c) => b.push(c)); req.on("end", () => ok(Buffer.concat(b))); });
const google = createServer(async (req, res) => {
  const url = new URL(req.url!, "http://x");
  const json = (s: number, b: unknown, h: Record<string, string> = {}) => { res.writeHead(s, { "content-type": "application/json", ...h }); res.end(JSON.stringify(b)); };
  const raw = await body(req);
  if (url.pathname === "/token") return json(200, { access_token: "tok", expires_in: 3600 });
  if (req.headers.authorization !== "Bearer tok" && !url.pathname.startsWith("/upload/session/")) return json(401, {});
  const meta = (f: Item) => ({ id: f.id, name: f.name, mimeType: f.mimeType, parents: f.parents.length ? f.parents : undefined, driveId: f.driveId, trashed: false, capabilities: { canAddChildren: true } });
  if (req.method === "GET" && url.pathname === "/drive/v3/drives") return json(200, { drives: [{ id: id("0ATeam"), name: "Team" }] });
  if (req.method === "GET" && url.pathname.startsWith("/drive/v3/drives/")) return json(200, { name: "Team" });
  if (req.method === "GET" && url.pathname === "/drive/v3/files") {
    const q = url.searchParams.get("q") || "";
    const parent = /^'([^']*)' in parents/.exec(q)?.[1];
    const name = /name = '((?:[^'\\]|\\.)*)'/.exec(q)?.[1]?.replace(/\\(.)/g, "$1");
    let fs = items.filter((f) => f.mimeType === FOLDER);
    if (parent) fs = fs.filter((f) => f.parents.includes(parent));
    if (name !== undefined) fs = fs.filter((f) => f.name === name);
    return json(200, { files: fs.map(meta) });
  }
  if (req.method === "GET" && url.pathname.startsWith("/drive/v3/files/")) {
    const f = items.find((x) => x.id === decodeURIComponent(url.pathname.split("/").pop()!));
    return f ? json(200, meta(f)) : json(404, {});
  }
  if (req.method === "POST" && url.pathname === "/drive/v3/files") {
    const b = JSON.parse(raw.toString()) as { name: string; parents?: string[] };
    const parent = b.parents?.[0] ?? "root";
    if (items.find((x) => x.id === parent)?.locked) return json(403, { error: { errors: [{ reason: "appNotAuthorizedToFile" }] } });
    const f: Item = { id: id(`1Made${nextId++}`), name: b.name, mimeType: FOLDER, parents: [parent] };
    items.push(f);
    return json(200, { id: f.id });
  }
  if (req.method === "POST" && url.pathname === "/upload/drive/v3/files") {
    const b = JSON.parse(raw.toString()) as { name: string; parents?: string[] };
    const parent = b.parents?.[0] ?? "root";
    const p = items.find((x) => x.id === parent);
    if (parent !== "root" && !p) return json(404, {});
    if (p?.locked) return json(403, { error: { errors: [{ reason: "appNotAuthorizedToFile" }] } });
    const sid = randomBytes(6).toString("hex");
    sessions.set(sid, { name: b.name, parent, size: Number(req.headers["x-upload-content-length"]), got: [], received: 0, type: String(req.headers["x-upload-content-type"] || "") });
    return json(200, {}, { location: `${base}/upload/session/${sid}` });
  }
  if (url.pathname.startsWith("/upload/session/")) {
    const s = sessions.get(url.pathname.split("/").pop()!);
    if (!s) return json(404, {});
    if (req.method === "DELETE") { sessions.delete(url.pathname.split("/").pop()!); res.writeHead(499); return res.end(); }
    const cr = String(req.headers["content-range"] || "");
    const range = (n: number) => (n > 0 ? { range: `bytes=0-${n - 1}` } : {});
    if (/^bytes \*\//.test(cr)) return json(308, {}, range(s.received));
    const m = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(cr);
    if (!m || Number(m[1]) !== s.received) return json(400, {});
    chunks++;
    // A chunk that gets lost on the way: Google never got it.
    if (failNextChunk > 0 && chunks === failNextChunk) { failNextChunk = 0; return json(503, {}); }
    s.got.push(raw); s.received += raw.length;
    if (s.received < s.size) return json(308, {}, range(s.received));
    const f: Item = { id: id(`1File${nextId++}`), name: s.name, mimeType: "video/mp4", parents: [s.parent], bytes: Buffer.concat(s.got), type: s.type };
    items.push(f);
    return json(200, { id: f.id, name: f.name, webViewLink: `https://drive.google.com/file/d/${f.id}/view` });
  }
  json(404, {});
});
let base = "";

describe("save a final into Google Drive", { skip: !ready && "needs a database, Redis and storage" }, async () => {
  await new Promise<void>((r) => google.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(google.address() as { port: number }).port}`;
  Object.assign(process.env, { GOOGLE_CLIENT_ID: "test-client", GOOGLE_CLIENT_SECRET: "test-secret", GOOGLE_API_URL: base, GOOGLE_TOKEN_URL: `${base}/token`, DRIVE_CHUNK_BYTES: String(256 * 1024), PUBLIC_WEB_URL: "https://app.rendrr.test" });
  const { prisma } = await import("@rendrr/db");
  const { MCP_TOOLS, QUEUES } = await import("@rendrr/shared");
  const { TOOL_HANDLERS } = await import("../src/tools");
  const { deletePrefix, encrypt, newRedis, putObject, redis, driveSaveOf, queueDriveSave } = await import("@rendrr/core");
  const { Worker } = await import("bullmq");
  const { driveSaveJob, driveSaveFailed } = await import("../../worker/src/jobs/driveSave");
  const { renderFailed } = await import("../../worker/src/jobs/render");

  let userId = "", projectId = "", worker: InstanceType<typeof Worker> | null = null;
  const dir = mkdtempSync(join(tmpdir(), "drive-save-"));
  const file = randomBytes(1_300_000); // five full chunks and a short one
  const tool = (name: string, input: Record<string, unknown>) => TOOL_HANDLERS[name]({ userId, ai: "claude" as const }, MCP_TOOLS.find((t) => t.name === name)!.input.parse(input));
  const saved = () => items.filter((f) => f.bytes);
  const final = async (version: number, status = "done") => {
    const key = `renders/test-drive-${run}-${version}.mp4`;
    if (status === "done") await putObject(key, file, "video/mp4");
    return prisma.render.create({ data: { projectId, userId, kind: "final", version, status, steps: [], quality: "1080p", ...(status === "done" ? { outputKey: key, sizeBytes: BigInt(file.length), seconds: 12, finishedAt: new Date() } : {}) } });
  };

  before(async () => {
    const u = await prisma.user.create({ data: { clerkId: `dsv_${run}`, email: `dsv-${run}@test.rendrr.dev`, name: "Ana" } });
    userId = u.id;
    const folder = await prisma.folder.create({ data: { userId, name: "Edits", workspace: "Personal" } });
    const v = await prisma.video.create({ data: { userId, name: "Talk", source: "local", status: "ready", seconds: 30 } });
    projectId = (await prisma.project.create({ data: { userId, folderId: folder.id, videoId: v.id, name: `Launch ${run}`, timeline: {}, currentVersion: 3 } })).id;
    await prisma.driveConnection.create({ data: { userId, googleEmail: "ana@gmail.test", refreshToken: encrypt("refresh"), scopes: "https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/drive.file" } });
    worker = new Worker(QUEUES.drive.name, async (job) => {
      try { return await driveSaveJob({ job, dir, signal: new AbortController().signal, isLastAttempt: true } as never); }
      catch (e) { await driveSaveFailed((job.data as { renderId: string }).renderId, (e as Error).message, (e as { code?: string }).code); throw e; }
    }, { connection: newRedis() as never });
  });
  after(async () => {
    await worker?.close();
    await prisma.project.deleteMany({ where: { userId } });
    await prisma.folder.deleteMany({ where: { userId } });
    await prisma.video.deleteMany({ where: { userId } });
    await prisma.driveConnection.deleteMany({ where: { userId } });
    await prisma.user.deleteMany({ where: { id: userId } });
    await deletePrefix(`renders/test-drive-${run}`).catch(() => {});
    await redis().quit().catch(() => {});
    google.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("saves the latest final into a path from My Drive, sent in chunks, the bytes exactly", async () => {
    const r = await final(2);
    const out = await tool("save_to_drive", { projectId, folder: "Clients/BFS Health/Finals" });
    assert.match(out.text, new RegExp(`^Final v2 \\(render id ${r.id}\\): Saved to Google Drive › Clients/BFS Health/Finals/Launch ${run} final v2\\.mp4: https://drive\\.google\\.com/file/d/\\S+/view$`), out.text);
    const f = saved().pop()!;
    assert.deepEqual(f.parents, [id("1Finals")]);
    assert.ok(f.bytes!.equals(file), "the same bytes");
    assert.equal(chunks, 5, "sent in five chunks of 256 KiB"); // 1.3 MB
    // get_render says it too.
    assert.match((await tool("get_render", { renderId: r.id })).text, /Saved to Google Drive › Clients\/BFS Health\/Finals\/Launch \w+ final v2\.mp4: https:/);
  });

  it("says what is there when a folder is not, and makes the missing ones when asked", async () => {
    const before = saved().length;
    const no = await tool("save_to_drive", { projectId, folder: "Clients/BFS Health/2026/Finals" });
    assert.equal(no.text, 'No folder "2026" in Clients/BFS Health. Folders there: Finals, Raw, Unique Folder. Send createFolders: true to make "2026/Finals" there. Nothing was rendered or saved.');
    assert.equal(saved().length, before);
    const yes = await tool("save_to_drive", { projectId, folder: "Clients/BFS Health/2026/Finals", createFolders: true, fileName: "BFS launch cut" });
    assert.match(yes.text, /Saved to Google Drive › Clients\/BFS Health\/2026\/Finals\/BFS launch cut\.mp4 \(made "Clients\/BFS Health\/2026", "Clients\/BFS Health\/2026\/Finals"\): https:/, yes.text);
    const made = items.find((x) => x.name === "2026")!;
    assert.deepEqual(made.parents, [id("1BFS")]);
    assert.deepEqual(saved().pop()!.parents, [items.find((x) => x.name === "Finals" && x.parents[0] === made.id)!.id]);
  });

  it("finds a folder by its name anywhere, a shared drive's folder, a folder link; asks when a name is not unique", async () => {
    assert.match((await tool("save_to_drive", { projectId, folder: "Unique Folder" })).text, /Saved to Google Drive › Clients\/BFS Health\/Unique Folder\//);
    assert.match((await tool("save_to_drive", { projectId, folder: "Team/Deliveries" })).text, /Saved to Google Drive › Team\/Deliveries\//);
    assert.deepEqual(saved().pop()!.parents, [id("1Deliv")]);
    assert.match((await tool("save_to_drive", { projectId, folder: `https://drive.google.com/drive/folders/${id("1Finals")}?usp=sharing` })).text, /Saved to Google Drive › Clients\/BFS Health\/Finals\//);
    const two = await tool("save_to_drive", { projectId, folder: "Raw" });
    assert.match(two.text, new RegExp(`^Several folders are called "Raw": Clients/Raw \\(id ${id("1RawTop")}\\); Clients/BFS Health/Raw \\(id ${id("1RawBFS")}\\)\\. Send the full path or the id of the one to use\\.`), two.text);
    // No folder: My Drive.
    assert.match((await tool("save_to_drive", { projectId })).text, /Saved to Google Drive › My Drive\//);
    assert.deepEqual(saved().pop()!.parents, ["root"]);
  });

  it("a folder Google refuses is said at once, with how the user allows it", async () => {
    const before = saved().length;
    const out = await tool("save_to_drive", { projectId, folder: "Locked" });
    assert.match(out.text, /^Google Drive did not let Rendrr save into "Locked"\. Nothing was rendered or saved\.\nRendrr's Google Drive access lets it add files only to folders it made itself\. .*Settings › Google Drive › Allow saving to my folders \(https:\/\/app\.rendrr\.test\/settings\)/s);
    assert.equal(saved().length, before);
    assert.ok(![...sessions.values()].some((s) => s.name === "Rendrr check"), "the checks' upload sessions are cancelled");
  });

  it("a chunk that fails is sent again from where Google has the file", async () => {
    chunks = 0; failNextChunk = 3;
    assert.match((await tool("save_to_drive", { projectId, folder: "Clients/BFS Health/Finals" })).text, /Saved to Google Drive/);
    assert.ok(saved().pop()!.bytes!.equals(file), "the same bytes after the failed chunk");
    assert.equal(failNextChunk, 0, "a chunk did fail");
  });

  it("a final still rendering is saved when it is done; one that fails says nothing was saved", async () => {
    const r = await final(3, "running");
    const out = await tool("save_to_drive", { projectId, folder: "Clients/BFS Health/Finals" });
    assert.match(out.text, /When the final is done, Rendrr saves it to Google Drive › Clients\/BFS Health\/Finals as "Launch \w+ final v3\.mp4"\./, out.text);
    // The render finishes (what the render job does at its end).
    await prisma.render.update({ where: { id: r.id }, data: { status: "done", outputKey: (await final(99)).outputKey, sizeBytes: BigInt(file.length) } });
    await queueDriveSave(r.id, driveSaveOf(await prisma.render.findUniqueOrThrow({ where: { id: r.id } }))!);
    for (let i = 0; i < 50 && driveSaveOf(await prisma.render.findUniqueOrThrow({ where: { id: r.id } }))?.state !== "saved"; i++) await new Promise((ok) => setTimeout(ok, 200));
    assert.match((await tool("get_render", { renderId: r.id })).text, /Saved to Google Drive › Clients\/BFS Health\/Finals\/Launch \w+ final v3\.mp4: https:/);
    const r4 = await final(4, "running");
    await tool("save_to_drive", { projectId, version: 4, folder: "Clients" });
    await renderFailed(r4.id, "Render failed at 'Cutting clips'. Nothing was lost. Try again.");
    assert.match((await tool("get_render", { renderId: r4.id })).text, /Saving to Google Drive › Clients failed: The final did not finish, so nothing was saved to Google Drive\./);
  });

  it("a GIF final is saved as a .gif of type image/gif, even when the name given ends in .mp4", async () => {
    const key = `renders/test-drive-${run}-gif.gif`;
    await putObject(key, file, "image/gif");
    await prisma.render.create({ data: { projectId, userId, kind: "final", version: 5, status: "done", steps: [], quality: "1080p", outputKey: key, sizeBytes: BigInt(file.length), seconds: 12, finishedAt: new Date() } });
    const out = await tool("save_to_drive", { projectId, version: 5, folder: "Clients/BFS Health/Finals", fileName: "Teaser.mp4" });
    assert.match(out.text, /Saved to Google Drive › Clients\/BFS Health\/Finals\/Teaser\.gif: https:/, out.text);
    const f = saved().pop()!;
    assert.equal(f.name, "Teaser.gif");
    assert.equal(f.type, "image/gif");
  });

  it("asking again for the same folder while a copy is running joins it; another folder starts a new copy", async () => {
    const r = await final(6);
    const target = { folderId: id("1Finals"), path: "Clients/BFS Health/Finals", name: `Launch ${run} final v6.mp4` };
    await prisma.render.update({ where: { id: r.id }, data: { driveSave: { ...target, state: "saving", percent: 40, at: Date.now() } } });
    const before = saved().length;
    await queueDriveSave(r.id, { ...target, state: "waiting", at: Date.now() });
    const still = driveSaveOf(await prisma.render.findUniqueOrThrow({ where: { id: r.id } }))!;
    assert.equal(still.state, "saving");
    assert.equal(still.percent, 40, "the running copy is left as it is");
    await new Promise((ok) => setTimeout(ok, 600));
    assert.equal(saved().length, before, "no second copy");
    // A different folder is a new copy.
    await queueDriveSave(r.id, { folderId: id("1Unique"), path: "Clients/BFS Health/Unique Folder", name: target.name, state: "waiting", at: Date.now() });
    for (let i = 0; i < 50 && driveSaveOf(await prisma.render.findUniqueOrThrow({ where: { id: r.id } }))?.state !== "saved"; i++) await new Promise((ok) => setTimeout(ok, 200));
    assert.deepEqual(saved().pop()!.parents, [id("1Unique")]);
  });

  it("without Drive connected, says how to connect it", async () => {
    await prisma.driveConnection.deleteMany({ where: { userId } });
    const out = await tool("save_to_drive", { projectId, folder: "Clients" });
    assert.match(out.text, /^Google Drive is not connected\. The user connects it once in Rendrr: Settings › Google Drive › Connect \(https:\/\/app\.rendrr\.test\/settings\)\. Nothing was rendered or saved\./);
  });
});
