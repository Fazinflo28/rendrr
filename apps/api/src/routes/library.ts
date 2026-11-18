import { AppError, deleteObjects, deletePrefix, drive, enqueue, env, features, headObject, notFound, redis, signGet, signPut, type ProxyJob, type AnalyzeJob, encrypt } from "@rendrr/core";
import { prisma, type Video } from "@rendrr/db";
import { breakdownAsText, BUSY_STATUSES, deviceName, macOriginalOf, DAY_MS, DriveAddInput, DriveFolderImportInput, LIBRARY_FOLDER_MAX_DEPTH, FolderProjectInput, LibraryFolderInput, LibraryFolderPatchInput, MoveVideosInput, LocalCompleteInput, LocalFilesInput, LocalProgressInput, PREFIX, PREVIEW_RETENTION_DAYS, ReconnectInput, SampleAddInput, VideoPatchInput, fmtSize, orientationOf, type Breakdown, type Transcript, type VideoKind } from "@rendrr/shared";
import { createHmac } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { isWebOrigin } from "../origins";
import { authenticate } from "../auth";
import { projectOut, videoOut } from "../serialize";
import { purgeProjectFiles } from "../services/projects";
import { deviceIdOf } from "../services/macExport";
import { DRIVE_SYNC_FRESH_MS, driveConn, importDriveFolder, linkDriveFile, newFolder, rememberRemoved, syncDriveFolder, syncStaleDriveFolders } from "../services/driveLibrary";
import { createLibraryFolder, deleteLibraryFolder, folderTree, libraryFolderFull, libraryFolderOut, listLibraryFolders, moveVideos, ownLibraryFolder, projectFromLibraryFolder, updateLibraryFolder } from "../services/libraryFolders";
import { assertMayAddFootage } from "../services/billing";
import { deleteVideoForGood } from "../services/deleting";

/** The folder new videos go in: the user's own, or none. */
async function intoFolder(userId: string, id?: string | null): Promise<string | null> {
  return id ? (await ownLibraryFolder(userId, id)).id : null;
}

const ART = ["c", "d", "e", "f", "a", "b"];
const randomArt = () => ART[Math.floor(Math.random() * ART.length)];
const stripExt = (n: string) => n.replace(/\.[^.]+$/, "");
const framesPrefix = (v: { userId: string; id: string }) => `${PREFIX.frames}${v.userId}/${v.id}/`;

async function ownedVideo(userId: string, id: string): Promise<Video> {
  const v = await prisma.video.findUnique({ where: { id } });
  if (!v || v.userId !== userId) throw notFound("That video is not in your library any more.");
  return v;
}

const DRIVE_OFF = "Google Drive is not set up on Rendrr yet. Add videos from your computer for now.";

// OAuth state: who started the flow, which web page to report back to, when. Signed, valid 15 minutes.
const stateSecret = () => env().ENCRYPTION_KEY || env().CLERK_SECRET_KEY || "dev";
const stateSig = (body: string) => createHmac("sha256", stateSecret()).update(body).digest("base64url").slice(0, 22);
const signState = (userId: string, origin: string) => {
  const body = `${userId}.${Date.now().toString(36)}.${Buffer.from(origin).toString("base64url")}`;
  return `${body}.${stateSig(body)}`;
};
const readState = (s: string) => {
  const parts = s.split(".");
  if (parts.length !== 4) return null;
  const [u, n, o, sig] = parts;
  if (sig !== stateSig(`${u}.${n}.${o}`) || Date.now() - parseInt(n, 36) > 15 * 60_000) return null;
  return { userId: u, origin: Buffer.from(o, "base64url").toString("utf8") };
};
// Where the consent reports back: the calling page only when it is one of the web app's own addresses (else anyone
// could start a consent with their own page as the origin and have a victim's Google code sent there).
const webOrigin = (req: { headers: Record<string, unknown> }) => {
  const o = String(req.headers.origin || "").replace(/\/$/, "");
  if (o && isWebOrigin(o)) return o;
  const own = String(env().PUBLIC_WEB_URL || "").replace(/\/$/, "");
  return /^https?:\/\/[a-z0-9.:-]+$/i.test(own) ? own : "";
};

export { webOrigin as driveWebOrigin };

export default async function library(app: FastifyInstance) {
  // Google redirects the popup here after consent. This page does not finish the connection itself: it hands the
  // code to the Rendrr tab that opened it (or, without one, to the web app's /drive-done page), which finishes it with
  // the user's own login (POST /drive/complete). A consent link sent by someone else can never attach your Drive to
  // their account: the account that finishes must be the one that started.
  app.get("/drive/callback", async (req, reply) => {
    const q = req.query as { code?: string; state?: string; error?: string };
    const st = q.state ? readState(q.state) : null;
    const page = (body: string) => reply.type("text/html").header("cache-control", "no-store").header("referrer-policy", "no-referrer")
      .send(`<!doctype html><meta charset=utf8><title>Rendrr</title><body style="font:15px system-ui;padding:40px;background:#f7f7f8">${body}`);
    if (q.error || !q.code || !q.state || !st?.origin) return page("<p>Google Drive was not connected. You can close this window and try again.</p>");
    const msg = JSON.stringify({ rendrrDrive: true, code: q.code, state: q.state }).replace(/</g, "\\u003c");
    const origin = JSON.stringify(st.origin);
    const done = JSON.stringify(`${st.origin}/drive-done?code=${encodeURIComponent(q.code)}&state=${encodeURIComponent(q.state)}`);
    return page(`<p>Finishing in Rendrr…</p><script>try{if(window.opener&&!window.opener.closed){window.opener.postMessage(${msg},${origin});setTimeout(function(){window.close()},800)}else{location.replace(${done})}}catch(e){location.replace(${done})}</script>`);
  });

  app.register(async (a) => {
    a.addHook("preHandler", authenticate);

    // ---------------- library ----------------
    a.get("/videos", async (req) => {
      const vs = await prisma.video.findMany({ where: { userId: req.user!.id, kind: { not: "canvas" }, deletedAt: null }, orderBy: { createdAt: "desc" } }); // the Trash is listed apart
      return Promise.all(vs.map(videoOut));
    });

    a.get("/videos/:id", async (req) => {
      const v = await ownedVideo(req.user!.id, (req.params as { id: string }).id);
      const an = await prisma.footageAnalysis.findUnique({ where: { videoId: v.id } });
      let driveFile = null;
      if (v.source === "drive" && v.driveFileId) {
        const conn = await prisma.driveConnection.findUnique({ where: { userId: v.userId } });
        const f = await Promise.race([drive.getFile(v.userId, v.driveFileId, !conn || conn.stub).catch(() => null), new Promise<null>((r) => setTimeout(() => r(null), 3000))]);
        const folder = f ? await Promise.race([drive.folderName(v.userId, f.folderId, !conn || conn.stub).catch(() => "Google Drive"), new Promise<string>((r) => setTimeout(() => r("Google Drive"), 2000))]) : "My Drive";
        driveFile = f ? { id: f.id, name: f.name, size: fmtSize(f.sizeBytes), seconds: f.seconds, date: f.date, folder, webViewLink: f.webViewLink || `https://drive.google.com/file/d/${f.id}/view` } : { id: v.driveFileId, folder, webViewLink: `https://drive.google.com/file/d/${v.driveFileId}/view` };
      }
      const keyFrames = await Promise.all(((an?.keyFrames as { t: number; key: string }[]) || []).slice(0, 5).map(async (k, i) => ({ t: k.t, art: ["a", "b", "c", "d", "e"][i % 5], url: await signGet(k.key, 3600) })));
      // What the AI reads instead of watching: the breakdown as text, plus its contact sheets.
      const b0 = an?.breakdown as unknown as Breakdown | null;
      const b = b0?.v ? { ...b0, video: { ...b0.video, name: v.name, kind: v.kind as VideoKind } } : null;
      const breakdown = b ? {
        pacing: b.pacing, hook: b.hook, shots: b.shots, beat: b.audio.beat ? { bpm: b.audio.beat.bpm, confidence: b.audio.beat.confidence } : null, musicLikely: b.audio.musicLikely,
        frames: { interval: b.frames.interval, count: b.frames.count },
        sheets: await Promise.all(b.frames.sheets.map(async (s) => ({ from: s.from, to: s.to, times: s.times, cols: s.cols, rows: s.rows, url: await signGet(s.key, 3600) }))),
        text: breakdownAsText(b),
      } : null;
      return {
        ...(await videoOut(v)), driveFile,
        transcript: (an?.transcript as unknown as Transcript) || [],
        sceneCuts: (an?.sceneCuts as number[]) || [],
        silences: an?.silences || [],
        keyFrames,
        proxyUrl: v.proxyKey && v.status !== "expired" ? await signGet(v.proxyKey, 6 * 3600) : null,
        transcriber: an?.transcriber,
        breakdown,
      };
    });

    // Rename, switch between footage and reference (a video whose style to copy), or move it to a folder (null: out).
    a.patch("/videos/:id", async (req) => {
      const v = await ownedVideo(req.user!.id, (req.params as { id: string }).id);
      const b = VideoPatchInput.parse(req.body);
      const folder = b.libraryFolderId !== undefined ? { libraryFolderId: await intoFolder(v.userId, b.libraryFolderId) } : {};
      return videoOut(await prisma.video.update({ where: { id: v.id }, data: { ...(b.kind ? { kind: b.kind } : {}), ...(b.name ? { name: b.name } : {}), ...folder } }));
    });

    // ---------------- library folders: videos of one kind together; a whole folder to a new edit ----------------
    a.get("/library/folders", async (req) => {
      // Folders linked to Google Drive not looked at for a couple of minutes: brought up to date in the background (the
      // Library asks again a moment later; its own sync of the open folder says what came in).
      const userId = req.user!.id;
      if (await redis().set(`drive-look:${userId}`, "1", "PX", 60_000, "NX").catch(() => null)) {
        void syncStaleDriveFolders({ userId, age: DRIVE_SYNC_FRESH_MS, limit: 10 }).catch((e) => req.log.warn({ err: e }, "drive sync"));
      }
      return listLibraryFolders(userId);
    });
    // A folder imported from Google Drive brought up to date now: new videos put there come in.
    a.post("/library/folders/:id/sync", async (req) => {
      const r = await syncDriveFolder(req.user!.id, (req.params as { id: string }).id);
      return { ...r, folder: await libraryFolderFull(req.user!.id, r.folderId) };
    });
    // parentId: a subfolder inside that folder.
    a.post("/library/folders", async (req) => {
      const b = LibraryFolderInput.parse(req.body);
      return libraryFolderFull(req.user!.id, (await createLibraryFolder(req.user!.id, b.name, b.parentId)).id);
    });
    // Rename, or move inside another folder (parentId null: to the top).
    a.patch("/library/folders/:id", async (req) => {
      const f = await updateLibraryFolder(req.user!.id, (req.params as { id: string }).id, LibraryFolderPatchInput.parse(req.body));
      return libraryFolderFull(req.user!.id, f.id);
    });
    a.delete("/library/folders/:id", async (req) => deleteLibraryFolder(req.user!.id, (req.params as { id: string }).id));
    a.post("/videos/move", async (req) => {
      const b = MoveVideosInput.parse(req.body);
      const r = await moveVideos(req.user!.id, b.videoIds, b.libraryFolderId);
      return { moved: r.moved, folder: r.folder ? await libraryFolderFull(req.user!.id, r.folder.id) : null };
    });
    // Every ready video in the folder, in name order, as one new edit. Videos not ready yet and references are left
    // out and named.
    a.post("/library/folders/:id/project", async (req) => {
      const b = FolderProjectInput.parse(req.body ?? {});
      const r = await projectFromLibraryFolder(req.user!.id, (req.params as { id: string }).id, b);
      return { project: projectOut(r.project), videos: r.videos.length, subfolders: r.subfolders, skipped: r.skipped };
    });

    a.post("/videos/:id/retry", async (req) => {
      const v = await ownedVideo(req.user!.id, (req.params as { id: string }).id);
      // Rendrr has the raw (Drive, a sample, footage brought in from the chat): the preview is made again from it.
      // Only from a state no job is working on: a double click, or Retry while it is already being made, would run the
      // job twice (two previews on the same files, two paid transcriptions). The status change is the claim.
      const idle = { id: v.id, status: { notIn: BUSY_STATUSES } };
      if (v.source === "drive" || v.sample || (v.source === "upload" && v.sourceKey)) {
        const won = await prisma.video.updateMany({ where: idle, data: { status: v.sample ? "previewing" : "linking", progress: 0, step: null, error: null } });
        if (won.count) await enqueue<ProxyJob>("proxy", { videoId: v.id });
      } else if (v.proxyKey && v.audioKey) {
        const won = await prisma.video.updateMany({ where: idle, data: { status: "processing", step: 0, error: null } });
        if (won.count) await enqueue<AnalyzeJob>("analyze", { videoId: v.id });
      } else {
        await prisma.video.update({ where: { id: v.id }, data: { status: "previewing", progress: 0, error: null } });
      }
      return videoOut(await prisma.video.findUniqueOrThrow({ where: { id: v.id } }));
    });

    // ?edits=delete: the edits made from it go too (the app asks first, naming them). Without it, footage in use stays.
    a.delete("/videos/:id", async (req) => {
      const v = await ownedVideo(req.user!.id, (req.params as { id: string }).id);
      await deleteVideoForGood(v, (req.query as { edits?: string }).edits === "delete");
      return { ok: true };
    });

    a.post("/videos/drive", async (req) => {
      const { fileIds, kind, libraryFolderId } = DriveAddInput.parse(req.body);
      const userId = req.user!.id;
      const conn = await driveConn(userId);
      const inFolder = await intoFolder(userId, libraryFolderId);
      // Billing: room for new footage (each file's length is checked again when it is processed).
      await assertMayAddFootage(userId, 0);
      const out: Video[] = [];
      for (const fid of Array.from(new Set(fileIds))) {
        const f = await drive.getFile(userId, fid, conn.stub);
        if (!f) continue;
        // Already linked, or in the Trash: that video (brought back, into the folder it was picked into), not a copy.
        const have = await prisma.video.findFirst({ where: { userId, source: "drive", driveFileId: f.id, status: { not: "missing" } }, orderBy: { deletedAt: { sort: "asc", nulls: "first" } } });
        if (have) { out.push(await prisma.video.update({ where: { id: have.id }, data: { deletedAt: null, ...(inFolder ? { libraryFolderId: inFolder } : {}) } })); continue; }
        out.push(await linkDriveFile(userId, f, { stub: conn.stub, kind, libraryFolderId: inFolder }));
      }
      if (!out.length) throw new AppError("Pick at least one video.", 400);
      return Promise.all(out.map(videoOut));
    });

    // A whole Drive folder: a library folder of its own named after it (never mixed into another of the same name),
    // every video in it linked, its folders made the same way down (up to 200 videos and the library's depth). A video
    // already in the library is moved into its folder, not linked twice; one in the Trash comes back. Importing the
    // same Drive folder again adds only what is new; the folder stays linked to Drive, so videos put in the Drive
    // folder later come in by themselves (services/driveLibrary.ts).
    a.post("/videos/drive-folder", async (req) => importDriveFolder(req.user!.id, DriveFolderImportInput.parse(req.body)));

    // Built-in sample footage: processed on the server, original kept so exports work without asking.
    a.post("/videos/sample", async (req) => {
      const { kind, libraryFolderId } = SampleAddInput.parse(req.body ?? {});
      const inFolder = await intoFolder(req.user!.id, libraryFolderId);
      const v = await prisma.video.create({ data: { kind: kind || "footage", libraryFolderId: inFolder,
        userId: req.user!.id, name: "Sample footage", seconds: 41, sizeBytes: BigInt(989_324), originalSize: BigInt(989_324), originalName: "sample-footage.mp4",
        orientation: "Landscape", source: "local", sample: true, sourceKey: drive.SAMPLE_KEYS.talking, status: "previewing", progress: 0, art: randomArt(),
      } });
      await enqueue<ProxyJob>("proxy", { videoId: v.id });
      return [await videoOut(v)];
    });

    // ------- the original kept on the user's computer (added in the Rendrr Mac or Windows app, never uploaded) -------
    a.post("/videos/:id/mac-original", async (req) => {
      const v = await prisma.video.findFirst({ where: { id: (req.params as { id: string }).id, userId: req.user!.id } });
      if (!v) throw notFound("video");
      if (v.source !== "local") return { kept: false };
      const b = (req.body ?? {}) as Record<string, unknown>;
      const name = deviceName(String(b.device ?? ""));
      const mo = macOriginalOf({ macOriginal: { ...b, device: name, deviceId: deviceIdOf(b.deviceId, name), at: Date.now() } });
      if (!mo) throw new AppError("That does not describe a video file.", 400, "bad-request");
      await prisma.video.update({ where: { id: v.id }, data: { macOriginal: mo } });
      return { kept: true };
    });

    // ---------------- local files: the browser makes the preview, we only receive it ----------------
    a.post("/videos/local", async (req) => {
      const { files, kind, libraryFolderId } = LocalFilesInput.parse(req.body);
      const userId = req.user!.id;
      const inFolder = await intoFolder(userId, libraryFolderId);
      // A folder picked whole: the same folders in the Library (inside the open one), each file in its own. Always new
      // folders: one of the same name already there is left alone (the new one is "B-roll (2)"), so two clients'
      // folders never mix. A level deeper than folders go lands in the deepest one allowed.
      const room = LIBRARY_FOLDER_MAX_DEPTH - (inFolder ? (await folderTree(userId)).depth(await ownLibraryFolder(userId, inFolder)) : 0);
      const made_folders = new Map<string, string>();
      const folderFor = async (path?: string): Promise<string | null> => {
        const parts = (path || "").split("/").map((x) => x.trim()).filter(Boolean).slice(0, Math.max(0, room));
        let parent = inFolder;
        for (let i = 0; i < parts.length; i++) {
          const key = parts.slice(0, i + 1).join("/").toLowerCase();
          if (!made_folders.has(key)) made_folders.set(key, (await newFolder(userId, parts[i], parent)).id);
          parent = made_folders.get(key)!;
        }
        return parent;
      };
      const where: (string | null)[] = [];
      for (const f of files) where.push(await folderFor(f.folder));
      const made = await Promise.all(files.map((f, i) => prisma.video.create({ data: { kind: kind || "footage", libraryFolderId: where[i],
        userId: req.user!.id, name: stripExt(f.name).slice(0, 200), sizeBytes: BigInt(f.size), originalSize: BigInt(f.size), originalName: f.name,
        source: "local", status: "previewing", progress: 0, art: randomArt(),
      } })));
      return Promise.all(made.map(videoOut));
    });

    a.post("/videos/:id/local/progress", async (req) => {
      const v = await ownedVideo(req.user!.id, (req.params as { id: string }).id);
      const b = LocalProgressInput.parse(req.body);
      if (!["previewing", "uploading", "paused", "failed"].includes(v.status)) return videoOut(v);
      const u = await prisma.video.update({ where: { id: v.id }, data: { status: b.status, progress: b.progress != null ? Math.round(b.progress) : v.progress, error: b.status === "failed" ? (b.error || "We could not read this file. Check it plays on your computer, then add it again.") : null } });
      return videoOut(u);
    });

    a.post("/videos/pause", async (req) => {
      const raw = (req.body as { ids?: unknown })?.ids;
      const ids = (Array.isArray(raw) ? raw : []).filter((x): x is string => typeof x === "string").slice(0, 50);
      await prisma.video.updateMany({ where: { id: { in: ids }, userId: req.user!.id, status: { in: ["previewing", "uploading"] }, sample: false }, data: { status: "paused" } });
      return { ok: true };
    });

    a.post("/videos/:id/resume", async (req) => {
      const v = await ownedVideo(req.user!.id, (req.params as { id: string }).id);
      if (v.status !== "paused") return videoOut(v);
      return videoOut(await prisma.video.update({ where: { id: v.id }, data: { status: "previewing" } }));
    });

    a.post("/videos/:id/local/upload-urls", async (req) => {
      const v = await ownedVideo(req.user!.id, (req.params as { id: string }).id);
      if (v.source !== "local") throw new AppError("That footage lives in Google Drive.", 400);
      const base = `${req.user!.id}/${v.id}`;
      const proxyKey = `${PREFIX.proxies}${base}.mp4`, audioKey = `${PREFIX.audio}${base}.m4a`;
      await prisma.video.update({ where: { id: v.id }, data: { status: "uploading", progress: 0 } });
      return { proxy: { url: await signPut(proxyKey, "video/mp4", 3 * 3600), contentType: "video/mp4" }, audio: { url: await signPut(audioKey, "audio/mp4", 3 * 3600), contentType: "audio/mp4" } };
    });

    a.post("/videos/:id/local/complete", async (req) => {
      const v = await ownedVideo(req.user!.id, (req.params as { id: string }).id);
      const b = LocalCompleteInput.parse(req.body);
      const base = `${req.user!.id}/${v.id}`;
      const proxyKey = `${PREFIX.proxies}${base}.mp4`, audioKey = `${PREFIX.audio}${base}.m4a`;
      const [ph, ah] = await Promise.all([headObject(proxyKey), headObject(audioKey)]);
      if (!ph || !ah) throw new AppError("The preview did not finish uploading. Try again.", 400, "upload");
      await assertMayAddFootage(req.user!.id, b.seconds / 60, v.id);
      const u = await prisma.video.update({ where: { id: v.id }, data: {
        proxyKey, audioKey, seconds: b.seconds, width: b.width, height: b.height, fps: b.fps ?? 30, orientation: orientationOf(b.width, b.height),
        previewSizeBytes: BigInt(ph.size + ah.size), status: "processing", step: 0, progress: null, error: null,
        previewExpiresAt: new Date(Date.now() + PREVIEW_RETENTION_DAYS * DAY_MS), // a fresh copy gets the full 30 days
      } });
      await enqueue<AnalyzeJob>("analyze", { videoId: v.id });
      return videoOut(u);
    });

    a.post("/videos/:id/reconnect", async (req) => {
      const v = await ownedVideo(req.user!.id, (req.params as { id: string }).id);
      const { fileId } = ReconnectInput.parse(req.body);
      const conn = await driveConn(req.user!.id);
      const f = await drive.getFile(req.user!.id, fileId, conn.stub);
      if (!f) throw new AppError("Pick the file in Drive to reconnect it.", 400, "drive");
      const u = await prisma.video.update({ where: { id: v.id }, data: { driveFileId: f.id, status: "linking", error: null, step: null, sourceKey: conn.stub ? (f as { sampleKey?: string }).sampleKey ?? v.sourceKey : null } });
      await enqueue<ProxyJob>("proxy", { videoId: v.id });
      return videoOut(u);
    });

    a.post("/videos/:id/rebuild", async (req) => {
      const v = await ownedVideo(req.user!.id, (req.params as { id: string }).id);
      if (v.source === "drive" || v.sample || (v.source === "upload" && v.sourceKey)) {
        // Once: a second press while the preview is being made again joins it.
        const won = await prisma.video.updateMany({ where: { id: v.id, status: { notIn: BUSY_STATUSES } }, data: { status: v.sample ? "previewing" : "preview", progress: 0, error: null } });
        if (won.count) await enqueue<ProxyJob>("proxy", { videoId: v.id });
        return videoOut(await prisma.video.findUniqueOrThrow({ where: { id: v.id } }));
      }
      return videoOut(await prisma.video.update({ where: { id: v.id }, data: { status: "previewing", progress: 0, error: null } }));
    });

    // ---------------- Google Drive ----------------
    a.get("/drive/status", async (req) => {
      const c = await prisma.driveConnection.findUnique({ where: { userId: req.user!.id } });
      const real = c && !c.stub ? c : null;
      // saveAnywhere: Google lets Rendrr add files to the user's own folders (finals saved where they say), not only to
      // folders Rendrr made.
      return { connected: !!real, email: real?.googleEmail || null, stub: false, available: features().drive, saveAnywhere: !!real && drive.canSaveAnywhere(real.scopes), photos: !!real && drive.canPickPhotos(real.scopes) };
    });
    a.post("/drive/connect", async (req) => {
      const userId = req.user!.id;
      if (features().drive) {
        const origin = webOrigin(req);
        if (!origin) throw new AppError("Open Rendrr from its own address to connect Google Drive.", 400, "drive");
        // write: also ask to add files to the user's own folders (saving finals where they say in their Drive);
        // photos: also ask to choose from Google Photos. What was allowed before is kept (include_granted_scopes).
        const b = (req.body || {}) as { write?: unknown; photos?: unknown };
        const had = await prisma.driveConnection.findUnique({ where: { userId } });
        const keep = had && !had.stub ? had.scopes : "";
        return { connected: false, authUrl: drive.authUrl(signState(userId, origin), { write: b.write === true || drive.canSaveAnywhere(keep), photos: b.photos === true || drive.canPickPhotos(keep) }) };
      }
      // TODO(key): GOOGLE_CLIENT_ID/SECRET unset. No fake Drive: the user is told Drive is not set up yet.
      throw new AppError(DRIVE_OFF, 409, "drive-off");
    });
    // Second half of the Google consent: only the Rendrr account that started it can finish it.
    a.post("/drive/complete", async (req) => {
      const { code, state } = (req.body || {}) as { code?: unknown; state?: unknown };
      const st = typeof state === "string" ? readState(state) : null;
      if (typeof code !== "string" || !code || !st) throw new AppError("Google Drive was not connected. Try again.", 400, "drive");
      if (st.userId !== req.user!.id) throw new AppError("This Google Drive link was started from a different Rendrr account. Connect again from your own Rendrr.", 403, "drive");
      const userId = req.user!.id;
      const t = await drive.exchangeCode(code).catch(() => null);
      if (!t) throw new AppError("Google Drive was not connected. Try again.", 400, "drive");
      if (!t.refreshToken) throw new AppError("Google did not give Rendrr lasting access. Remove Rendrr from your Google account's connected apps, then connect again.", 400, "drive");
      const c = await prisma.driveConnection.upsert({ where: { userId }, create: { userId, googleEmail: t.email, refreshToken: encrypt(t.refreshToken), scopes: t.scope, stub: false }, update: { googleEmail: t.email, refreshToken: encrypt(t.refreshToken), scopes: t.scope, stub: false, connectedAt: new Date() } });
      return { connected: true, email: c.googleEmail, stub: false };
    });
    a.post("/drive/disconnect", async (req) => {
      await prisma.driveConnection.deleteMany({ where: { userId: req.user!.id } });
      return { connected: false, email: null };
    });
    a.get("/drive/files", async (req) => {
      const qs = req.query as { folderId?: string; driveId?: string; view?: string; q?: string; drives?: string };
      const view = (["folder", "shared", "recent", "search"] as const).find((v) => v === qs.view) || "folder";
      const conn = await driveConn(req.user!.id);
      const [{ folders, files, truncated }, drives] = await Promise.all([
        drive.browse(req.user!.id, { view, folderId: String(qs.folderId || "root").slice(0, 200), driveId: qs.driveId ? String(qs.driveId).slice(0, 200) : undefined, q: String(qs.q || "").slice(0, 100) }, conn.stub),
        qs.drives ? drive.sharedDrives(req.user!.id, conn.stub).catch(() => []) : Promise.resolve(undefined),
      ]);
      // In the library already (one in the Trash is not: it can be picked again, and comes back).
      const linked = new Set((await prisma.video.findMany({ where: { userId: req.user!.id, source: "drive", status: { not: "missing" }, deletedAt: null }, select: { driveFileId: true } })).map((v) => v.driveFileId));
      return { folders, files: files.map((f) => ({ id: f.id, folderId: f.folderId, name: f.name, size: fmtSize(f.sizeBytes), seconds: f.seconds, date: f.date, added: linked.has(f.id) })), truncated, ...(drives ? { drives } : {}) };
    });
  });
}
