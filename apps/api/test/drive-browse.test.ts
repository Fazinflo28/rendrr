// The Drive picker's listing: folders at any depth, Shared with me, recent videos, name search, shared drives.
// Runs the real Drive code against a fake Google (fetch is replaced). Needs a database (as in .env).
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

process.env.INTERNAL_API_SECRET ||= "test-internal-secret";
process.env.GOOGLE_CLIENT_ID ||= "test-client";
process.env.GOOGLE_CLIENT_SECRET ||= "test-secret";
process.env.LOG_LEVEL = "silent";
const ready = !!process.env.DATABASE_URL && !!process.env.REDIS_URL;
const run = Math.random().toString(36).slice(2, 8);

// A small Drive: My Drive > Clients > BFS > heel pain.mp4, a video at the top, a shared folder, one shared drive.
const FOLDER = "application/vnd.google-apps.folder";
const T = "2026-10-01T10:00:00.000Z";
const ITEMS = [
  { id: "fA", name: "Clients", mimeType: FOLDER, parents: ["root"], modifiedTime: T },
  { id: "fB", name: "BFS", mimeType: FOLDER, parents: ["fA"], modifiedTime: T },
  { id: "v1", name: "Top reel.mp4", mimeType: "video/mp4", parents: ["root"], size: "1000", modifiedTime: "2026-10-03T10:00:00.000Z", videoMediaMetadata: { durationMillis: "14000" } },
  { id: "v2", name: "heel pain.MOV", mimeType: "video/quicktime", parents: ["fB"], size: "2000", modifiedTime: "2026-10-04T10:00:00.000Z", videoMediaMetadata: { durationMillis: "65000" } },
  { id: "v3", name: "Team cut.mp4", mimeType: "video/mp4", parents: ["sd1"], driveId: "sd1", size: "3000", modifiedTime: T },
];
const SHARED = [{ id: "fS", name: "From Sam", mimeType: FOLDER, modifiedTime: T }];

describe("Drive picker listing", { skip: !ready && "needs DATABASE_URL and REDIS_URL" }, async () => {
  const { prisma } = await import("@rendrr/db");
  const { encrypt, redis } = await import("@rendrr/core");
  const { buildServer } = await import("../src/server");
  let app: Awaited<ReturnType<typeof buildServer>>;
  let userId = "";
  const clerkId = `drv_${run}`;
  const headers = () => ({ "x-internal-secret": process.env.INTERNAL_API_SECRET!, "x-rendrr-clerk-id": clerkId });
  const seen: URLSearchParams[] = [];
  const realFetch = globalThis.fetch;
  const list = async (qs: string) => {
    const r = await app.inject({ method: "GET", url: `/drive/files${qs}`, headers: headers() });
    assert.equal(r.statusCode, 200, r.body);
    return JSON.parse(r.body) as { folders: { id: string; name: string; driveId?: string }[]; files: { id: string; name: string; seconds: number; folderId: string }[]; drives?: { id: string; name: string }[]; truncated: boolean };
  };
  const names = (xs: { name: string }[]) => xs.map((x) => x.name);

  before(async () => {
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });
      if (url.href.startsWith("https://oauth2.googleapis.com/token")) return json({ access_token: "tok", expires_in: 3600 });
      if (url.pathname === "/drive/v3/drives") return json({ drives: [{ id: "sd1", name: "Team" }] });
      if (url.pathname === "/drive/v3/files") {
        seen.push(url.searchParams);
        const q = url.searchParams.get("q") || "";
        const parent = /^'([^']*)' in parents/.exec(q)?.[1];
        const text = /name contains '((?:[^'\\]|\\.)*)'/.exec(q)?.[1]?.replace(/\\(.)/g, "$1");
        let files = q.includes("sharedWithMe") ? SHARED
          : parent ? ITEMS.filter((f) => f.parents?.includes(parent))
          : text !== undefined ? ITEMS.filter((f) => f.name.toLowerCase().includes(text.toLowerCase()))
          : ITEMS.filter((f) => f.mimeType.startsWith("video/"));
        if (q.includes("mimeType contains 'video/'") && !q.includes(FOLDER)) files = files.filter((f) => f.mimeType.startsWith("video/"));
        if (url.searchParams.get("orderBy") === "modifiedTime desc") files = [...files].sort((a, b) => b.modifiedTime.localeCompare(a.modifiedTime));
        return json({ files });
      }
      return realFetch(input as never, init);
    }) as typeof fetch;
    app = await buildServer();
    userId = (await prisma.user.create({ data: { clerkId, email: `drv-${run}@test.rendrr.dev`, name: "Drv" } })).id;
    await prisma.folder.create({ data: { userId, name: "My edits", workspace: "Drv's Workspace" } });
    await prisma.driveConnection.create({ data: { userId, googleEmail: "drv@test.rendrr.dev", refreshToken: encrypt("refresh"), scopes: "drive.readonly", stub: false } });
  });
  after(async () => {
    globalThis.fetch = realFetch;
    await prisma.driveConnection.deleteMany({ where: { userId } });
    await prisma.folder.deleteMany({ where: { userId } });
    await prisma.user.deleteMany({ where: { id: userId } });
    await app.close();
    await redis().quit().catch(() => {});
  });

  it("My Drive shows its folders and videos, plus the shared drives", async () => {
    const r = await list("?drives=1");
    assert.deepEqual(names(r.folders), ["Clients"]);
    assert.deepEqual(names(r.files), ["Top reel.mp4"]);
    assert.equal(r.files[0].seconds, 14);
    assert.deepEqual(r.drives, [{ id: "sd1", name: "Team" }]);
  });

  it("a folder lists the folders inside it, and a video two folders down is found", async () => {
    const a = await list("?folderId=fA");
    assert.deepEqual(names(a.folders), ["BFS"]);
    assert.equal(a.files.length, 0);
    const b = await list("?folderId=fB");
    assert.deepEqual(names(b.files), ["heel pain.MOV"]);
    assert.equal(b.files[0].folderId, "fB");
  });

  it("search finds videos in any folder; quotes in the text cannot break the query", async () => {
    const r = await list("?view=search&q=HEEL");
    assert.deepEqual(names(r.files), ["heel pain.MOV"]);
    assert.equal(r.files[0].folderId, "fB");
    await list("?view=search&q=" + encodeURIComponent("O'Brien \\ cut"));
    assert.match(seen.at(-1)!.get("q")!, /^name contains 'O\\'Brien \\\\ cut' and trashed = false/);
    assert.equal(seen.at(-1)!.get("corpora"), "allDrives");
    const empty = await list("?view=search&q=");
    assert.equal(empty.files.length + empty.folders.length, 0);
  });

  it("recent lists videos from everywhere, newest first", async () => {
    const r = await list("?view=recent");
    assert.deepEqual(names(r.files), ["heel pain.MOV", "Top reel.mp4", "Team cut.mp4"]);
    assert.equal(r.folders.length, 0);
    assert.equal(seen.at(-1)!.get("orderBy"), "modifiedTime desc");
  });

  it("shared with me, and a shared drive opened by its id", async () => {
    assert.deepEqual(names((await list("?view=shared")).folders), ["From Sam"]);
    const d = await list("?folderId=sd1&driveId=sd1");
    assert.deepEqual(names(d.files), ["Team cut.mp4"]);
    assert.equal(seen.at(-1)!.get("corpora"), "drive");
    assert.equal(seen.at(-1)!.get("driveId"), "sd1");
  });

  it("a folder id cannot inject into the query", async () => {
    await list("?folderId=" + encodeURIComponent("x' in parents or 'a"));
    assert.match(seen.at(-1)!.get("q")!, /^'xinparentsora' in parents and trashed = false/);
  });
});
