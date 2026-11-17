// Files from the user's Google Photos (add_footage from: google_photos, and the Library's and the editor's Google Photos
// tab), through the Photos Picker API: Google Photos needs its own permission once (Connect, keeping Drive's); the page
// sends the user to a picker session; Rendrr asks Google no more often than it says whether they have chosen, and the AI's
// look asks too; what they chose is brought in once (two at a time, each with the user's Google token), a photo as a JPEG
// at its own size and a video as its file; a video Google is still processing, and an expired choice, say so; a link
// Google refuses is fetched again from a fresh listing. Google is a stand-in (fetch is replaced). Needs a database,
// Redis, storage and FFmpeg (as in .env).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

process.env.INTERNAL_API_SECRET ||= "test-internal-secret";
process.env.GOOGLE_CLIENT_ID ||= "test-client";
process.env.GOOGLE_CLIENT_SECRET ||= "test-secret";
process.env.LOG_LEVEL = process.env.TEST_LOG || "silent";
const ready = !!process.env.DATABASE_URL && !!process.env.REDIS_URL && !!process.env.S3_BUCKET;
const ff = (() => { try { execFileSync("ffmpeg", ["-version"], { stdio: "ignore" }); return true; } catch { return false; } })();
const run = Math.random().toString(36).slice(2, 8);
const MEDIA = "https://93.184.215.14"; // a public address: the stand-in answers for it, nothing goes out
const PICKER = "https://photospicker.googleapis.com/v1";
const DRIVE_SCOPES = "https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/drive.file openid email";
const PHOTOS = "https://www.googleapis.com/auth/photospicker.mediaitems.readonly";

describe("files from Google Photos", { skip: (!ready || !ff) && "needs a database, Redis, storage and FFmpeg" }, async () => {
  const { prisma } = await import("@rendrr/db");
  const { stubTranscript, MCP_TOOLS } = await import("@rendrr/shared");
  const { createProject } = await import("../src/services/projects");
  const { TOOL_HANDLERS } = await import("../src/tools");
  const { deletePrefix, encrypt, redis } = await import("@rendrr/core");
  const { buildServer } = await import("../src/server");
  let app: Awaited<ReturnType<typeof buildServer>>;
  let userId = "", projectId = "", pickId = "";
  const clerkId = `gph_${run}`;
  const c = () => ({ userId, ai: "claude" as const, clerkId });
  const as = () => ({ "x-internal-secret": process.env.INTERNAL_API_SECRET!, "x-rendrr-clerk-id": clerkId, origin: (process.env.PUBLIC_WEB_URL || "http://localhost:3000").replace(/\/$/, "") });
  const dir = mkdtempSync(join(tmpdir(), "gphotos-"));
  const realFetch = globalThis.fetch;
  let png = Buffer.alloc(0), mp4 = Buffer.alloc(0);
  // The stand-in Google: sessions, what was picked, and the files (each link once refused when asked, to test a fresh listing).
  const g = { sessions: new Map<string, { set: boolean; gone?: boolean }>(), creates: [] as unknown[], lists: 0, deletes: [] as string[], gets: 0, refuseOnce: new Set<string>(), media: [] as { path: string; auth: string | null }[] };
  let items: unknown[] = [];
  const item = (id: string, type: "PHOTO" | "VIDEO", filename: string, extra: Record<string, unknown> = {}) => ({ id, type, createTime: "2026-11-01T10:00:00Z", mediaFile: { baseUrl: `${MEDIA}/lh/${id}-${g.lists}`, mimeType: type === "PHOTO" ? "image/heic" : "video/mp4", filename, mediaFileMetadata: { width: 800, height: 600, ...extra } } });
  const view = async () => (await app.inject({ method: "GET", url: `/picks/${pickId}`, headers: as() })).json() as { pending: number; errors: { name: string; message: string }[]; videos: { id: string; name: string; still: boolean }[]; photos: { pickerUri: string; imported: boolean; error: string | null } | null; photosReady?: boolean };
  const until = async (f: () => Promise<boolean>, ms = 20000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await f()) return true; await new Promise((r) => setTimeout(r, 200)); } return false; };
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  before(async () => {
    execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=800x600:d=1", "-frames:v", "1", join(dir, "p.png")]);
    execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=640x360:r=30:d=2", "-f", "lavfi", "-i", "sine=f=330:d=2", "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-shortest", join(dir, "v.mp4")]);
    png = readFileSync(join(dir, "p.png")); mp4 = readFileSync(join(dir, "v.mp4"));
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
      if (url.href.startsWith("https://oauth2.googleapis.com/token")) return json({ access_token: "tok", expires_in: 3600 });
      const auth = new Headers(init?.headers).get("authorization");
      if (url.href.startsWith(PICKER)) {
        assert.equal(auth, "Bearer tok", "Google Photos is asked with the user's token");
        const path = url.pathname.replace(/^\/v1/, "");
        if (path === "/sessions" && init?.method === "POST") {
          const id = `s${g.creates.length + 1}`; g.creates.push(JSON.parse(String(init.body))); g.sessions.set(id, { set: false });
          return json({ id, pickerUri: `https://photos.google.com/picker/${id}`, pollingConfig: { pollInterval: "2s", timeoutIn: "1800s" }, mediaItemsSet: false });
        }
        const sid = /^\/sessions\/(\w+)$/.exec(path)?.[1];
        if (sid && init?.method === "DELETE") { g.deletes.push(sid); return json({}); }
        if (sid) { g.gets++; const s = g.sessions.get(sid); return !s || s.gone ? json({ error: { code: 404 } }, 404) : json({ id: sid, pickerUri: `https://photos.google.com/picker/${sid}`, mediaItemsSet: s.set, ...(s.set ? {} : { pollingConfig: { pollInterval: "2s", timeoutIn: "1800s" } }) }); }
        if (path === "/mediaItems") {
          g.lists++;
          const all = items.map((x) => { const it = x as ReturnType<typeof item>; return { ...it, mediaFile: { ...it.mediaFile, baseUrl: `${MEDIA}/lh/${it.id}-${g.lists}` } }; });
          const tok = url.searchParams.get("pageToken");
          return tok ? json({ mediaItems: all.slice(2) }) : json({ mediaItems: all.slice(0, 2), ...(all.length > 2 ? { nextPageToken: "p2" } : {}) });
        }
        return json({}, 404);
      }
      if (url.origin === MEDIA) {
        g.media.push({ path: url.pathname, auth });
        const id = /\/lh\/(\w+)-\d+=/.exec(url.pathname)?.[1] ?? "";
        if (g.refuseOnce.has(id)) { g.refuseOnce.delete(id); return new Response("expired", { status: 403 }); }
        const video = url.pathname.endsWith("=dv");
        const body = video ? mp4 : png;
        return new Response(body, { status: 200, headers: { "content-type": video ? "video/mp4" : "image/jpeg", "content-length": String(body.length) } });
      }
      return realFetch(input as never, init);
    }) as typeof fetch;
    app = await buildServer();
    userId = (await prisma.user.create({ data: { clerkId, email: `gph-${run}@test.rendrr.dev`, name: "Gee" } })).id;
    await prisma.folder.create({ data: { userId, name: "Edits", workspace: "Personal" } });
    await prisma.driveConnection.create({ data: { userId, googleEmail: "gee@test.rendrr.dev", refreshToken: encrypt("refresh"), scopes: DRIVE_SCOPES, stub: false } });
    const base = await prisma.video.create({ data: { userId, name: "Base", seconds: 20, width: 1280, height: 720, source: "local", status: "ready", proxyKey: `proxies/${run}.mp4`, analysis: { create: { transcriber: "stub", transcript: stubTranscript(20) as never, silences: [] as never, sceneCuts: [], keyFrames: [] } } } });
    projectId = (await createProject(userId, { videoId: base.id, name: `Reel ${run}` })).id;
  });
  after(async () => {
    globalThis.fetch = realFetch;
    await sleep(300);
    await prisma.project.deleteMany({ where: { userId } });
    await prisma.folder.deleteMany({ where: { userId } });
    await prisma.video.deleteMany({ where: { userId } });
    await prisma.libraryFolder.deleteMany({ where: { userId } });
    await prisma.driveConnection.deleteMany({ where: { userId } });
    await prisma.user.deleteMany({ where: { id: userId } });
    for (const p of ["uploads/", "proxies/", "frames/"]) await deletePrefix(`${p}${userId}/`).catch(() => {});
    await app.close(); await redis().quit().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });

  it("add_footage takes from: google_photos and gives the user a link to choose there", async () => {
    assert.ok(MCP_TOOLS.find((x) => x.name === "add_footage")!.input.safeParse({ from: "google_photos" }).success);
    const r = await TOOL_HANDLERS.add_footage(c(), { from: "google_photos", projectId });
    pickId = (r.data as { pickId: string }).pickId;
    assert.match(r.text, new RegExp(`^Give the user this link to add files from their Google Photos \\(open it where they are signed in to Rendrr; it works for 60 minutes\\): https?://\\S+/add/${pickId}\\n`));
    assert.match(r.text, /They choose the photos and videos in Google Photos from there\. They go in the edit's Media panel too\./);
  });

  it("Google Photos needs its own permission once: Connect asks for it and keeps Drive's", async () => {
    assert.equal((await view()).photosReady, false);
    const no = await app.inject({ method: "POST", url: `/picks/${pickId}/photos`, headers: as() });
    assert.equal(no.statusCode, 409); assert.equal(no.json().error.code, "photos-connect");
    const st = (await app.inject({ method: "GET", url: "/drive/status", headers: as() })).json();
    assert.equal(st.connected, true); assert.equal(st.photos, false);
    const con = await app.inject({ method: "POST", url: "/drive/connect", headers: as(), payload: { photos: true } });
    assert.equal(con.statusCode, 200, con.body);
    const scope = new URL(con.json().authUrl).searchParams.get("scope")!.split(" ");
    assert.ok(scope.includes(PHOTOS) && scope.includes("https://www.googleapis.com/auth/drive.readonly"), scope.join(" "));
    assert.equal(new URL(con.json().authUrl).searchParams.get("include_granted_scopes"), "true");
    // The user allows it (what /drive/complete stores from Google's answer); Drive's own Connect keeps asking for Photos.
    await prisma.driveConnection.update({ where: { userId }, data: { scopes: `${DRIVE_SCOPES} ${PHOTOS}` } });
    assert.equal((await app.inject({ method: "GET", url: "/drive/status", headers: as() })).json().photos, true);
    const again = await app.inject({ method: "POST", url: "/drive/connect", headers: as(), payload: {} });
    assert.ok(new URL(again.json().authUrl).searchParams.get("scope")!.split(" ").includes(PHOTOS), "reconnecting Drive keeps Google Photos");
    assert.equal((await view()).photosReady, true);
  });

  it("the page gets a choice to send the user to, once; Google is asked no more often than it says", async () => {
    const r = await app.inject({ method: "POST", url: `/picks/${pickId}/photos`, headers: as() });
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(r.json().photos.pickerUri, "https://photos.google.com/picker/s1");
    assert.deepEqual(g.creates, [{ pickingConfig: { maxItemCount: "50" } }]);
    assert.equal((await app.inject({ method: "POST", url: `/picks/${pickId}/photos`, headers: as() })).json().photos.pickerUri, "https://photos.google.com/picker/s1", "the same choice again while it is open");
    assert.equal(g.creates.length, 1);
    for (let k = 0; k < 4; k++) await view();
    assert.equal(g.gets, 0, "not asked again within its 2 s");
    await sleep(2100); await view();
    assert.equal(g.gets, 1);
    const none = await TOOL_HANDLERS.add_footage(c(), { pickId });
    assert.match(none.text, /^Nothing has arrived from their Google Photos yet\./);
  });

  it("what the user chose is brought in once (page and AI looking at the same time), a photo as a JPEG and a video as its file", async () => {
    items = [item("ph1", "PHOTO", "IMG_0001.HEIC"), item("vd1", "VIDEO", "Clip 1.mp4", { videoMetadata: { fps: 30, processingStatus: "READY" } }), item("vd2", "VIDEO", "Clip 2.mov", { videoMetadata: { processingStatus: "PROCESSING" } }), item("ph2", "PHOTO", "Beach.jpg")];
    g.refuseOnce.add("ph2");
    g.sessions.get("s1")!.set = true;
    await sleep(2100);
    const [, ai] = await Promise.all([view(), TOOL_HANDLERS.add_footage(c(), { pickId }), view()]);
    assert.ok(ai.text.length > 0);
    assert.ok(await until(async () => (await view()).pending === 0 && (await view()).photos?.imported === true), "all brought in");
    const v = await view();
    assert.deepEqual(v.videos.map((x) => x.name).sort(), ["Beach", "Clip 1", "IMG_0001"]);
    assert.deepEqual(v.errors.map((e) => [e.name, e.message]), [["Clip 2.mov", "Google Photos is still processing this video: add it again in a few minutes."]]);
    assert.equal(g.lists, 4, "listed once (two pages) and once more (two pages) for the refused link");
    assert.ok(g.media.every((m) => m.auth === "Bearer tok"), "each file is fetched with the user's Google token");
    assert.ok(g.media.some((m) => /\/lh\/ph1-\d+=w800-h600$/.test(m.path)), "a photo at its own size (Google sends a JPEG)");
    assert.ok(g.media.some((m) => /\/lh\/vd1-\d+=dv$/.test(m.path)), "a video as its file");
    assert.ok(!g.media.some((m) => m.path.includes("vd2")), "a video still processing is not fetched");
    assert.ok(g.media.some((m) => /\/lh\/ph2-2=/.test(m.path)) && g.media.some((m) => /\/lh\/ph2-4=/.test(m.path)), "the refused one came again from the fresh listing");
    assert.ok(await until(async () => g.deletes.includes("s1")), "the choice is closed at Google once done");
    const tl = (await prisma.project.findUniqueOrThrow({ where: { id: projectId } })).timeline as { media?: string[] };
    assert.ok(v.videos.every((x) => tl.media?.includes(x.id)), "each went in the edit's Media panel");
    const r = await TOOL_HANDLERS.add_footage(c(), { pickId });
    assert.match(r.text, /^From their Google Photos, 3 files so far:\n/);
    assert.match(r.text, /\nCould not be brought in: "Clip 2\.mov": Google Photos is still processing this video/);
  });

  it("choosing again makes a new choice; an expired one says so to the page and the AI", async () => {
    const r = await app.inject({ method: "POST", url: `/picks/${pickId}/photos`, headers: as() });
    assert.equal(r.json().photos.pickerUri, "https://photos.google.com/picker/s2");
    assert.equal(r.json().photos.imported, false);
    g.sessions.get("s2")!.gone = true;
    await sleep(2100);
    const v = await view();
    assert.equal(v.photos?.error, "That Google Photos choice has expired. Choose again.");
    assert.match((await TOOL_HANDLERS.add_footage(c(), { pickId })).text, /\nGoogle Photos: That Google Photos choice has expired\. Choose again\./);
    assert.equal((await app.inject({ method: "POST", url: `/picks/${pickId}/photos`, headers: as() })).json().photos.pickerUri, "https://photos.google.com/picker/s3", "after an expired choice, a new one");
  });

  it("a Dropbox or computer pick has no Google Photos choice", async () => {
    const r = await app.inject({ method: "POST", url: "/picks", headers: as(), payload: { source: "dropbox" } });
    const bad = await app.inject({ method: "POST", url: `/picks/${r.json().id}/photos`, headers: as() });
    assert.equal(bad.statusCode, 400); assert.equal(bad.json().error.code, "pick-source");
  });
});
