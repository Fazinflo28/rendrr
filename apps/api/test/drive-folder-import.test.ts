// Importing a whole Google Drive folder into the Library: a library folder named after it, its Drive folders made
// inside the same way down, every video linked (its preview queued), a video already in the library moved in rather
// than linked twice, importing again adding only what is new, into a library folder, without its folders, an empty
// folder refused. Runs the real Drive code against a fake Google (fetch is replaced). Needs a database (as in .env).
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

process.env.INTERNAL_API_SECRET ||= "test-internal-secret";
process.env.GOOGLE_CLIENT_ID ||= "test-client";
process.env.GOOGLE_CLIENT_SECRET ||= "test-secret";
process.env.LOG_LEVEL = process.env.TEST_LOG || "silent";
const ready = !!process.env.DATABASE_URL && !!process.env.REDIS_URL;
const run = Math.random().toString(36).slice(2, 8);

// My Drive > Course (Intro.mp4, notes.pdf left out by the query) > Module 1 (Part 1, Part 2) > Extras (Bonus); Empty.
const FOLDER = "application/vnd.google-apps.folder";
const T = "2026-10-01T10:00:00.000Z";
const vid = (id: string, name: string, parent: string, secs: number) => ({ id, name, mimeType: "video/mp4", parents: [parent], size: "1000", modifiedTime: T, videoMediaMetadata: { durationMillis: String(secs * 1000), width: 1920, height: 1080 } });
const ITEMS = [
  { id: "cCourse", name: "Course", mimeType: FOLDER, parents: ["root"], modifiedTime: T },
  { id: "cMod1", name: "Module 1", mimeType: FOLDER, parents: ["cCourse"], modifiedTime: T },
  { id: "cExtras", name: "Extras", mimeType: FOLDER, parents: ["cMod1"], modifiedTime: T },
  { id: "cEmpty", name: "Empty", mimeType: FOLDER, parents: ["root"], modifiedTime: T },
  vid("vIntro", "Intro.mp4", "cCourse", 30), vid("vP1", "Part 1.mp4", "cMod1", 60), vid("vP2", "Part 2.mov", "cMod1", 90), vid("vBonus", "Bonus.mp4", "cExtras", 20),
];

describe("importing a Drive folder", { skip: !ready && "needs DATABASE_URL and REDIS_URL" }, async () => {
  const { prisma } = await import("@rendrr/db");
  const { encrypt, redis } = await import("@rendrr/core");
  const { buildServer } = await import("../src/server");
  let app: Awaited<ReturnType<typeof buildServer>>;
  let userId = "";
  const clerkId = `dfi_${run}`;
  const headers = () => ({ "x-internal-secret": process.env.INTERNAL_API_SECRET!, "x-rendrr-clerk-id": clerkId });
  const realFetch = globalThis.fetch;
  const post = async (url: string, payload: object) => { const r = await app.inject({ method: "POST", url, headers: headers(), payload }); return { status: r.statusCode, body: JSON.parse(r.body) }; };
  const videosIn = async (folderId: string) => (await prisma.video.findMany({ where: { userId, libraryFolderId: folderId }, orderBy: { name: "asc" } })).map((v) => v.name);
  const child = async (parentId: string | null, name: string) => prisma.libraryFolder.findFirst({ where: { userId, parentId, name } });

  before(async () => {
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });
      if (url.href.startsWith("https://oauth2.googleapis.com/token")) return json({ access_token: "tok", expires_in: 3600 });
      if (url.pathname === "/drive/v3/files") {
        const parent = /^'([^']*)' in parents/.exec(url.searchParams.get("q") || "")?.[1];
        return json({ files: ITEMS.filter((f) => f.parents.includes(parent || "")) });
      }
      const one = /^\/drive\/v3\/files\/([^/]+)$/.exec(url.pathname)?.[1];
      if (one) { const f = ITEMS.find((x) => x.id === decodeURIComponent(one)); return f ? json(f) : new Response("{}", { status: 404 }); }
      return realFetch(input as never, init);
    }) as typeof fetch;
    app = await buildServer();
    userId = (await prisma.user.create({ data: { clerkId, email: `dfi-${run}@test.rendrr.dev`, name: "Dfi" } })).id;
    await prisma.folder.create({ data: { userId, name: "My edits", workspace: "Dfi's Workspace" } });
    await prisma.driveConnection.create({ data: { userId, googleEmail: "dfi@test.rendrr.dev", refreshToken: encrypt("refresh"), scopes: "drive.readonly", stub: false } });
  });
  after(async () => {
    globalThis.fetch = realFetch;
    await prisma.video.deleteMany({ where: { userId } });
    await prisma.libraryFolder.deleteMany({ where: { userId } });
    await prisma.driveConnection.deleteMany({ where: { userId } });
    await prisma.folder.deleteMany({ where: { userId } });
    await prisma.user.deleteMany({ where: { id: userId } });
    await app.close();
    await redis().quit().catch(() => {});
  });

  it("a whole folder: a library folder named after it, its folders inside, every video linked; again adds only what is new", async () => {
    // Part 1 was added on its own before, loose in the library.
    const before = await post("/videos/drive", { fileIds: ["vP1"] });
    assert.equal(before.status, 200, JSON.stringify(before.body));
    const r = await post("/videos/drive-folder", { folderId: "cCourse", name: "Course" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual([r.body.folder.name, r.body.added, r.body.moved, r.body.folders, r.body.truncated], ["Course", 3, 1, 3, false]);
    assert.deepEqual([r.body.folder.total, r.body.folder.folders], [4, 1]);
    const course = r.body.folder.id;
    const mod = (await child(course, "Module 1"))!, extras = (await child(mod.id, "Extras"))!;
    assert.deepEqual(await videosIn(course), ["Intro"]);
    assert.deepEqual(await videosIn(mod.id), ["Part 1", "Part 2"], "Part 1 moved in, not linked twice");
    assert.deepEqual(await videosIn(extras.id), ["Bonus"]);
    assert.equal(await prisma.video.count({ where: { userId, driveFileId: "vP1" } }), 1);
    const intro = await prisma.video.findFirstOrThrow({ where: { userId, driveFileId: "vIntro" } });
    assert.deepEqual([intro.status, intro.source, intro.seconds, intro.originalName], ["linking", "drive", 30, "Intro.mp4"]);
    // Again: the same folders, nothing new linked.
    const again = await post("/videos/drive-folder", { folderId: "cCourse", name: "Course" });
    assert.deepEqual([again.body.folder.id, again.body.added, again.body.moved, again.body.folders], [course, 0, 4, 0]);
    assert.equal(await prisma.video.count({ where: { userId } }), 4);
  });

  it("videos put in the Drive folder later come in by themselves; a video the user moved stays where they put it", async () => {
    const course = (await child(null, "Course"))!;
    const mod = (await child(course.id, "Module 1"))!;
    assert.equal(course.driveFolderId, "cCourse");
    assert.equal(course.driveKind, "footage");
    assert.equal(mod.driveFolderId, "cMod1", "a subfolder knows its Drive folder too");
    // The user moves Intro out to the top of the library.
    await prisma.video.updateMany({ where: { userId, driveFileId: "vIntro" }, data: { libraryFolderId: null } });
    // Later, in Drive: Part 3 in Module 1, and a new Module 2 with a video.
    ITEMS.push(vid("vP3", "Part 3.mp4", "cMod1", 45), { id: "cMod2", name: "Module 2", mimeType: FOLDER, parents: ["cCourse"], modifiedTime: T }, vid("vM2", "Lesson.mp4", "cMod2", 50));
    // Opening a subfolder syncs the whole import.
    const r = await post(`/library/folders/${mod.id}/sync`, {});
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual([r.body.folderId, r.body.added, r.body.folders], [course.id, 2, 1]);
    assert.deepEqual(await videosIn(mod.id), ["Part 1", "Part 2", "Part 3"]);
    const mod2 = (await child(course.id, "Module 2"))!;
    assert.deepEqual(await videosIn(mod2.id), ["Lesson"]);
    assert.deepEqual(await videosIn(course.id), [], "Intro stays where the user put it");
    assert.equal(await prisma.video.count({ where: { userId, driveFileId: "vIntro" } }), 1, "and is not linked again");
    // The folder list says it is linked and when it was looked at; a sync with nothing new adds nothing.
    const list = await app.inject({ method: "GET", url: "/library/folders", headers: headers() });
    const top = (JSON.parse(list.body) as { id: string; drive: { top: boolean; syncedAt: number } | null }[]).find((f) => f.id === course.id)!;
    assert.equal(top.drive!.top, true);
    assert.ok(Date.now() - top.drive!.syncedAt < 60_000);
    const again = await post(`/library/folders/${course.id}/sync`, {});
    assert.deepEqual([again.body.added, again.body.folders], [0, 0]);
    // The server's sweep: a folder not looked at for a while is synced on its own.
    ITEMS.push(vid("vP4", "Part 4.mp4", "cMod1", 40));
    await prisma.libraryFolder.update({ where: { id: course.id }, data: { driveSyncedAt: new Date(Date.now() - 3600_000) } });
    const { syncStaleDriveFolders } = await import("../src/services/driveLibrary");
    const swept = await syncStaleDriveFolders({ userId, age: 10 * 60_000 });
    assert.deepEqual(swept.map((x) => [x.folderId, x.added]), [[course.id, 1]]);
    assert.deepEqual(await videosIn(mod.id), ["Part 1", "Part 2", "Part 3", "Part 4"]);
    // A folder not imported from Drive is not linked.
    const plain = await prisma.libraryFolder.create({ data: { userId, name: `Plain ${run}` } });
    const no = await post(`/library/folders/${plain.id}/sync`, {});
    assert.equal(no.status, 400);
    assert.match(no.body.error.message, /not linked to a Google Drive folder/);
  });

  it("a video or folder the user deletes stays deleted: the sync does not bring it back; picking or importing again does", async () => {
    const course = (await child(null, "Course"))!;
    const mod = (await child(course.id, "Module 1"))!;
    const p2 = await prisma.video.findFirstOrThrow({ where: { userId, driveFileId: "vP2" } });
    const del = await app.inject({ method: "DELETE", url: `/videos/${p2.id}`, headers: headers() });
    assert.equal(del.statusCode, 200, del.body);
    // Module 2 deleted from the library too (its video moves up into Course).
    const mod2 = (await child(course.id, "Module 2"))!;
    const delF = await app.inject({ method: "DELETE", url: `/library/folders/${mod2.id}`, headers: headers() });
    assert.equal(delF.statusCode, 200, delF.body);
    // Opening the folder syncs it: Part 2 is still in the Drive folder, but it stays out; Module 2 is not made again.
    const r = await post(`/library/folders/${mod.id}/sync`, {});
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual([r.body.added, r.body.folders], [0, 0]);
    assert.equal(await prisma.video.count({ where: { userId, driveFileId: "vP2" } }), 0, "the deleted video is not linked again");
    assert.equal(await child(course.id, "Module 2"), null, "the deleted folder is not made again");
    // A new video put in the Drive folder still comes in.
    ITEMS.push(vid("vP5", "Part 5.mp4", "cMod1", 30));
    await prisma.libraryFolder.update({ where: { id: course.id }, data: { driveSyncedAt: new Date(Date.now() - 3600_000) } });
    const { syncStaleDriveFolders } = await import("../src/services/driveLibrary");
    const swept = await syncStaleDriveFolders({ userId, age: 10 * 60_000 });
    assert.deepEqual(swept.map((x) => [x.added, x.folders]), [[1, 0]]);
    assert.deepEqual(await videosIn(mod.id), ["Part 1", "Part 3", "Part 4", "Part 5"]);
    // Picked again on purpose: it comes back, and a later sync keeps it.
    const pick = await post("/videos/drive", { fileIds: ["vP2"] });
    assert.equal(pick.status, 200, JSON.stringify(pick.body));
    assert.equal(await prisma.driveRemoved.count({ where: { userId, itemId: "vP2" } }), 0);
    // Importing the folder again on purpose brings the deleted folder back.
    const again = await post("/videos/drive-folder", { folderId: "cCourse", name: "Course" });
    assert.equal(again.status, 200, JSON.stringify(again.body));
    assert.ok(await child(course.id, "Module 2"), "imported again: Module 2 is back");
    assert.equal(await prisma.driveRemoved.count({ where: { userId } }), 0);
  });

  it("another client's Drive folder of the same name gets a folder of its own; the same Drive folder again fills its own", async () => {
    ITEMS.push(
      { id: "cClientA", name: "Client A", mimeType: FOLDER, parents: ["root"], modifiedTime: T }, { id: "cBrA", name: "B-roll", mimeType: FOLDER, parents: ["cClientA"], modifiedTime: T },
      { id: "cClientB", name: "Client B", mimeType: FOLDER, parents: ["root"], modifiedTime: T }, { id: "cBrB", name: "B-roll", mimeType: FOLDER, parents: ["cClientB"], modifiedTime: T },
      vid("vA1", "Drone A.mp4", "cBrA", 10), vid("vA2", "City A.mp4", "cBrA", 10), vid("vB1", "Drone B.mp4", "cBrB", 10),
    );
    const a = await post("/videos/drive-folder", { folderId: "cBrA", name: "B-roll" });
    assert.equal(a.status, 200, JSON.stringify(a.body));
    const b = await post("/videos/drive-folder", { folderId: "cBrB", name: "B-roll" });
    assert.equal(b.status, 200, JSON.stringify(b.body));
    assert.deepEqual([a.body.folder.name, b.body.folder.name, b.body.added], ["B-roll", "B-roll (Client B)", 1], "named after the Drive folder it sits in");
    assert.notEqual(a.body.folder.id, b.body.folder.id);
    assert.deepEqual(await videosIn(a.body.folder.id), ["City A", "Drone A"], "client A's folder keeps only its own videos");
    assert.deepEqual(await videosIn(b.body.folder.id), ["Drone B"]);
    assert.equal((await prisma.libraryFolder.findUniqueOrThrow({ where: { id: a.body.folder.id } })).driveFolderId, "cBrA", "and stays linked to client A's Drive folder");
    const again = await post("/videos/drive-folder", { folderId: "cBrA", name: "B-roll" });
    assert.deepEqual([again.body.folder.id, again.body.added], [a.body.folder.id, 0], "the same Drive folder again: its own folder, nothing new");
    // A third one of the same name with no folder above it to tell it apart: a number.
    ITEMS.push({ id: "cBrC", name: "B-roll", mimeType: FOLDER, parents: ["root"], modifiedTime: T }, vid("vC1", "Drone C.mp4", "cBrC", 10));
    const c = await post("/videos/drive-folder", { folderId: "cBrC", name: "B-roll" });
    assert.equal(c.body.folder.name, "B-roll (2)");
  });

  it("a video moved to the Trash can be picked again (it comes back, wherever it is picked into); a sync leaves it in the Trash", async () => {
    const a = (await child(null, "B-roll"))!, b = (await child(null, "B-roll (Client B)"))!;
    const drone = await prisma.video.findFirstOrThrow({ where: { userId, driveFileId: "vA1" } });
    const trash = await app.inject({ method: "POST", url: `/assets/video/${drone.id}/trash`, headers: headers() });
    assert.equal(trash.statusCode, 200, trash.body);
    const list = await app.inject({ method: "GET", url: "/drive/files?folderId=cBrA", headers: headers() });
    const added = Object.fromEntries((JSON.parse(list.body).files as { id: string; added: boolean }[]).map((f) => [f.id, f.added]));
    assert.deepEqual(added, { vA1: false, vA2: true }, "the picker does not call a trashed video already added");
    await prisma.libraryFolder.update({ where: { id: a.id }, data: { driveSyncedAt: new Date(Date.now() - 3600_000) } });
    const s = await post(`/library/folders/${a.id}/sync`, {});
    assert.equal(s.body.added, 0);
    assert.ok((await prisma.video.findUniqueOrThrow({ where: { id: drone.id } })).deletedAt, "a sync leaves it in the Trash");
    // Picked into the other client's folder: the same video back, there, not a second copy.
    const pick = await post("/videos/drive", { fileIds: ["vA1"], libraryFolderId: b.id });
    assert.equal(pick.status, 200, JSON.stringify(pick.body));
    assert.equal(pick.body[0].id, drone.id);
    const back = await prisma.video.findUniqueOrThrow({ where: { id: drone.id } });
    assert.deepEqual([back.deletedAt, back.libraryFolderId], [null, b.id]);
    assert.equal(await prisma.video.count({ where: { userId, driveFileId: "vA1" } }), 1);
    // Importing its folder again brings a trashed one back into it.
    const city = await prisma.video.findFirstOrThrow({ where: { userId, driveFileId: "vA2" } });
    await prisma.video.update({ where: { id: city.id }, data: { deletedAt: new Date() } });
    const again = await post("/videos/drive-folder", { folderId: "cBrA", name: "B-roll" });
    assert.deepEqual([again.body.folder.id, again.body.restored, again.body.added], [a.id, 1, 0]);
    assert.deepEqual([(await prisma.video.findUniqueOrThrow({ where: { id: city.id } })).deletedAt, (await prisma.video.findUniqueOrThrow({ where: { id: city.id } })).libraryFolderId], [null, a.id]);
  });

  it("into a library folder, without its folders; the name from Drive when not sent; an empty folder is refused", async () => {
    const clients = await prisma.libraryFolder.create({ data: { userId, name: `Clients ${run}` } });
    const r = await post("/videos/drive-folder", { folderId: "cMod1", libraryFolderId: clients.id, subfolders: false });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual([r.body.folder.name, r.body.folder.parentId, r.body.folder.path, r.body.folders], ["Module 1", clients.id, `Clients ${run} / Module 1`, 1]);
    assert.equal(await child(r.body.folder.id, "Extras"), null, "its folders left out");
    const empty = await post("/videos/drive-folder", { folderId: "cEmpty", name: "Empty" });
    assert.equal(empty.status, 400);
    assert.match(empty.body.error.message, /"Empty" has no videos/);
    const theirs = await post("/videos/drive-folder", { folderId: "cCourse", libraryFolderId: "cnotyoursnotyoursnotyours" });
    assert.equal(theirs.status, 404);
  });
});
