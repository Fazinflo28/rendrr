import { AppError, deleteObjects, deletePrefix, drive, enqueue, env, features, headObject, notFound, signGet, signPut, type ProxyJob, type AnalyzeJob, encrypt } from "@rendrr/core";
import { prisma, type Video } from "@rendrr/db";
import { breakdownAsText, DAY_MS, DriveAddInput, DriveFolderImportInput, LIBRARY_FOLDER_MAX_DEPTH, FolderProjectInput, LibraryFolderInput, LibraryFolderPatchInput, MoveVideosInput, LocalCompleteInput, LocalFilesInput, LocalProgressInput, PREFIX, PREVIEW_RETENTION_DAYS, ReconnectInput, SampleAddInput, VideoPatchInput, fmtSize, orientationOf, type Breakdown, type Transcript, type VideoKind } from "@rendrr/shared";
import { createHmac } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { authenticate } from "../auth";
import { projectOut, videoOut } from "../serialize";
import { purgeProjectFiles } from "../services/projects";
import { createLibraryFolder, deleteLibraryFolder, folderTree, libraryFolderFull, libraryFolderOut, listLibraryFolders, moveVideos, ownLibraryFolder, projectFromLibraryFolder, updateLibraryFolder } from "../services/libraryFolders";

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

/** One Drive file linked as a video (its preview made by the worker), in a library folder or none. */
async function linkDriveFile(userId: string, f: drive.DriveFile & { sampleKey?: string }, o: { stub: boolean; kind?: VideoKind | null; libraryFolderId?: string | null }) {
  const v = await prisma.video.create({ data: {
    userId, name: stripExt(f.name), seconds: f.seconds, sizeBytes: BigInt(f.sizeBytes || 0), originalSize: BigInt(f.sizeBytes || 0), originalName: f.name,
    orientation: f.width && f.height ? orientationOf(f.width, f.height) : "Landscape", source: "drive", driveFileId: f.id, status: "linking", art: randomArt(), kind: o.kind || "footage", libraryFolderId: o.libraryFolderId ?? null,
    sourceKey: o.stub ? f.sampleKey ?? null : null,
  } });
  await enqueue<ProxyJob>("proxy", { videoId: v.id });
  return v;
}

/** The library folder called `name` inside `parentId` (any case), made if it is not there: importing the same Drive
 *  folder again fills the same library folder. */
async function folderNamed(userId: string, name: string, parentId: string | null) {
  const n = name.replace(/\//g, "-").trim().slice(0, 80) || "Untitled folder";
  const same = await prisma.libraryFolder.findFirst({ where: { userId, parentId, name: { equals: n, mode: "insensitive" } }, orderBy: { createdAt: "asc" } });
  return { folder: same ?? (await createLibraryFolder(userId, n, parentId)), made: !same };
}

async function driveConn(userId: string) {
  const c = await prisma.driveConnection.findUnique({ where: { userId } });
  if (!c || c.stub) throw new AppError("Connect Google Drive first.", 400, "drive");
  return c;
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
const webOrigin = (req: { headers: Record<string, unknown> }) => {
  const o = String(req.headers.origin || env().PUBLIC_WEB_URL || "").replace(/\/$/, "");
  return /^https?:\/\/[a-z0-9.:-]+$/i.test(o) ? o : "";
};

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
      const vs = await prisma.video.findMany({ where: { userId: req.user!.id, kind: { not: "canvas" } }, orderBy: { createdAt: "desc" } });
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
    a.get("/library/folders", async (req) => listLibraryFolders(req.user!.id));
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
      if (v.source === "drive" || v.sample) {
        await prisma.video.update({ where: { id: v.id }, data: { status: v.sample ? "previewing" : "linking", progress: 0, step: null, error: null } });
        await enqueue<ProxyJob>("proxy", { videoId: v.id });
      } else if (v.proxyKey && v.audioKey) {
        await prisma.video.update({ where: { id: v.id }, data: { status: "processing", step: 0, error: null } });
        await enqueue<AnalyzeJob>("analyze", { videoId: v.id });
      } else {
        await prisma.video.update({ where: { id: v.id }, data: { status: "previewing", progress: 0, error: null } });
      }
      return videoOut(await prisma.video.findUniqueOrThrow({ where: { id: v.id } }));
    });

    // ?edits=delete: the edits made from it go too (the app asks first, naming them). Without it, footage in use stays.
    a.delete("/videos/:id", async (req) => {
      const v = await ownedVideo(req.user!.id, (req.params as { id: string }).id);
      // Edits made from it, and edits that play it on V1 (one of the parts of a several-video edit, an added clip).
      const onV1 = await prisma.$queryRaw<{ id: string }[]>`SELECT id FROM "Project" WHERE "userId" = ${v.userId} AND "deletedAt" IS NULL AND jsonb_path_exists(timeline, '$.tracks.v1[*] ? (@.sourceVideoId == $vid)', jsonb_build_object('vid', ${v.id}::text))`;
      const edits = await prisma.project.findMany({ where: { OR: [{ videoId: v.id }, { id: { in: onV1.map((r) => r.id) } }], deletedAt: null }, select: { id: true, name: true }, orderBy: { updatedAt: "desc" } });
      if (edits.length && (req.query as { edits?: string }).edits !== "delete") {
        const names = edits.slice(0, 5).map((p) => `"${p.name}"`).join(", ") + (edits.length > 5 ? ` and ${edits.length - 5} more` : "");
        throw new AppError(`"${v.name}" is used by ${edits.length} ${edits.length === 1 ? "edit" : "edits"}: ${names}. Deleting it deletes ${edits.length === 1 ? "that edit" : "those edits"} too.`, 409, "in-use");
      }
      if (edits.length) await prisma.project.updateMany({ where: { id: { in: edits.map((p) => p.id) } }, data: { deletedAt: new Date() } });
      const an = await prisma.footageAnalysis.findUnique({ where: { videoId: v.id } });
      await deleteObjects([v.proxyKey, v.audioKey, v.thumbKey, ...(((an?.keyFrames as { key: string }[]) || []).map((k) => k.key))]);
      await deletePrefix(framesPrefix(v)); // key frames, contact sheets, frames taken for the AI
      await purgeProjectFiles({ videoId: v.id, deletedAt: { not: null } });
      await prisma.project.deleteMany({ where: { videoId: v.id, deletedAt: { not: null } } });
      await prisma.video.delete({ where: { id: v.id } });
      return { ok: true };
    });

    a.post("/videos/drive", async (req) => {
      const { fileIds, kind, libraryFolderId } = DriveAddInput.parse(req.body);
      const userId = req.user!.id;
      const conn = await driveConn(userId);
      const inFolder = await intoFolder(userId, libraryFolderId);
      const out: Video[] = [];
      for (const fid of Array.from(new Set(fileIds))) {
        const f = await drive.getFile(userId, fid, conn.stub);
        if (!f) continue;
        out.push(await linkDriveFile(userId, f, { stub: conn.stub, kind, libraryFolderId: inFolder }));
      }
      if (!out.length) throw new AppError("Pick at least one video.", 400);
      return Promise.all(out.map(videoOut));
    });

    // A whole Drive folder: a library folder named after it, every video in it linked, its folders made the same way
    // down (up to 200 videos and the library's depth). A video already in the library is moved into its folder, not
    // linked twice. Importing the same folder again adds only what is new.
    a.post("/videos/drive-folder", async (req) => {
      const b = DriveFolderImportInput.parse(req.body);
      const userId = req.user!.id;
      const conn = await driveConn(userId);
      const parent = b.libraryFolderId ? await ownLibraryFolder(userId, b.libraryFolderId) : null;
      const depthLeft = LIBRARY_FOLDER_MAX_DEPTH - (parent ? (await folderTree(userId)).depth(parent) : 0);
      if (depthLeft < 1) throw new AppError("That folder is as deep as folders go. Import into a folder higher up.", 400, "too-deep");
      const name = (b.name || "").trim() || (await drive.folderName(userId, b.folderId, conn.stub));
      const walked = await drive.walkFolder(userId, { id: b.folderId, name, driveId: b.driveId }, conn.stub, { maxDepth: b.subfolders === false ? 1 : depthLeft, maxFiles: 200 });
      if (!walked.files) throw new AppError(`"${name}" has no videos${b.subfolders === false || !walked.folders ? "" : ", its folders neither"}.`, 400, "folder-empty");
      const linked = new Map((await prisma.video.findMany({ where: { userId, source: "drive", status: { not: "missing" }, driveFileId: { not: null } }, select: { id: true, driveFileId: true } })).map((v) => [v.driveFileId!, v.id]));
      let added = 0, moved = 0, made = 0;
      const put = async (node: drive.DriveTree, parentId: string | null): Promise<string> => {
        const { folder, made: isNew } = await folderNamed(userId, node.name, parentId);
        if (isNew) made++;
        for (const f of node.files) {
          const have = linked.get(f.id);
          if (have) { await prisma.video.update({ where: { id: have }, data: { libraryFolderId: folder.id } }); moved++; continue; }
          const full = conn.stub ? await drive.getFile(userId, f.id, true) : f; // the fake Drive keeps its sample file on the file
          const v = await linkDriveFile(userId, full ?? f, { stub: conn.stub, kind: b.kind, libraryFolderId: folder.id });
          linked.set(f.id, v.id); added++;
        }
        for (const sub of node.folders) await put(sub, folder.id);
        return folder.id;
      };
      const topId = await put(walked.tree, parent?.id ?? null);
      return { folder: await libraryFolderFull(userId, topId), added, moved, folders: made, truncated: walked.truncated };
    });

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

    // ---------------- local files: the browser makes the preview, we only receive it ----------------
    a.post("/videos/local", async (req) => {
      const { files, kind, libraryFolderId } = LocalFilesInput.parse(req.body);
      const userId = req.user!.id;
      const inFolder = await intoFolder(userId, libraryFolderId);
      // A folder picked whole: the same folders in the Library (inside the open one), each file in its own. A level
      // deeper than folders go lands in the deepest one allowed.
      const room = LIBRARY_FOLDER_MAX_DEPTH - (inFolder ? (await folderTree(userId)).depth(await ownLibraryFolder(userId, inFolder)) : 0);
      const made_folders = new Map<string, string>();
      const folderFor = async (path?: string): Promise<string | null> => {
        const parts = (path || "").split("/").map((x) => x.trim()).filter(Boolean).slice(0, Math.max(0, room));
        if (!parts.length) return inFolder;
        const key = parts.join("/").toLowerCase();
        if (made_folders.has(key)) return made_folders.get(key)!;
        let parent = inFolder;
        for (const p of parts) parent = (await folderNamed(userId, p, parent)).folder.id;
        made_folders.set(key, parent!);
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
      if (v.source === "drive" || v.sample) {
        const u = await prisma.video.update({ where: { id: v.id }, data: { status: v.sample ? "previewing" : "preview", progress: 0, error: null } });
        await enqueue<ProxyJob>("proxy", { videoId: v.id });
        return videoOut(u);
      }
      return videoOut(await prisma.video.update({ where: { id: v.id }, data: { status: "previewing", progress: 0, error: null } }));
    });

    // ---------------- Google Drive ----------------
    a.get("/drive/status", async (req) => {
      const c = await prisma.driveConnection.findUnique({ where: { userId: req.user!.id } });
      const real = c && !c.stub ? c : null;
      // saveAnywhere: Google lets Rendrr add files to the user's own folders (finals saved where they say), not only to
      // folders Rendrr made.
      return { connected: !!real, email: real?.googleEmail || null, stub: false, available: features().drive, saveAnywhere: !!real && drive.canSaveAnywhere(real.scopes) };
    });
    a.post("/drive/connect", async (req) => {
      const userId = req.user!.id;
      if (features().drive) {
        const origin = webOrigin(req);
        if (!origin) throw new AppError("Open Rendrr from its own address to connect Google Drive.", 400, "drive");
        // write: also ask to add files to the user's own folders (saving finals where they say in their Drive).
        return { connected: false, authUrl: drive.authUrl(signState(userId, origin), (req.body as { write?: unknown } | undefined)?.write === true) };
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
      const linked = new Set((await prisma.video.findMany({ where: { userId: req.user!.id, source: "drive", status: { not: "missing" } }, select: { driveFileId: true } })).map((v) => v.driveFileId));
      return { folders, files: files.map((f) => ({ id: f.id, folderId: f.folderId, name: f.name, size: fmtSize(f.sizeBytes), seconds: f.seconds, date: f.date, added: linked.has(f.id) })), truncated, ...(drives ? { drives } : {}) };
    });
  });
}
