import { AppError, deleteObjects, drive, enqueue, env, features, headObject, notFound, signGet, signPut, type ProxyJob, type AnalyzeJob, encrypt } from "@rendrr/core";
import { prisma, type Video } from "@rendrr/db";
import { DriveAddInput, LocalCompleteInput, LocalFilesInput, LocalProgressInput, PREFIX, ReconnectInput, fmtSize, orientationOf, type Transcript } from "@rendrr/shared";
import { createHmac } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { authenticate } from "../auth";
import { videoOut } from "../serialize";
import { purgeProjectFiles } from "../services/projects";

const ART = ["c", "d", "e", "f", "a", "b"];
const randomArt = () => ART[Math.floor(Math.random() * ART.length)];
const stripExt = (n: string) => n.replace(/\.[^.]+$/, "");

async function ownedVideo(userId: string, id: string): Promise<Video> {
  const v = await prisma.video.findUnique({ where: { id } });
  if (!v || v.userId !== userId) throw notFound("That video is not in your library any more.");
  return v;
}

async function driveConn(userId: string) {
  const c = await prisma.driveConnection.findUnique({ where: { userId } });
  if (!c) throw new AppError("Connect Google Drive first.", 400, "drive");
  return c;
}

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
      const vs = await prisma.video.findMany({ where: { userId: req.user!.id }, orderBy: { createdAt: "desc" } });
      return Promise.all(vs.map(videoOut));
    });

    a.get("/videos/:id", async (req) => {
      const v = await ownedVideo(req.user!.id, (req.params as { id: string }).id);
      const an = await prisma.footageAnalysis.findUnique({ where: { videoId: v.id } });
      let driveFile = null;
      if (v.source === "drive" && v.driveFileId) {
        const conn = await prisma.driveConnection.findUnique({ where: { userId: v.userId } });
        const f = await Promise.race([drive.getFile(v.userId, v.driveFileId, !conn || conn.stub).catch(() => null), new Promise<null>((r) => setTimeout(() => r(null), 3000))]);
        const folder = f ? drive.STUB_FOLDERS.find((x) => x.id === f.folderId)?.name || "My Drive" : "My Drive";
        driveFile = f ? { id: f.id, name: f.name, size: fmtSize(f.sizeBytes), seconds: f.seconds, date: f.date, folder, webViewLink: f.webViewLink || `https://drive.google.com/file/d/${f.id}/view` } : { id: v.driveFileId, folder, webViewLink: `https://drive.google.com/file/d/${v.driveFileId}/view` };
      }
      const keyFrames = await Promise.all(((an?.keyFrames as { t: number; key: string }[]) || []).slice(0, 5).map(async (k, i) => ({ t: k.t, art: ["a", "b", "c", "d", "e"][i % 5], url: await signGet(k.key, 3600) })));
      return {
        ...(await videoOut(v)), driveFile,
        transcript: (an?.transcript as unknown as Transcript) || [],
        sceneCuts: (an?.sceneCuts as number[]) || [],
        silences: an?.silences || [],
        keyFrames,
        proxyUrl: v.proxyKey && v.status !== "expired" ? await signGet(v.proxyKey, 6 * 3600) : null,
        transcriber: an?.transcriber,
      };
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

    a.delete("/videos/:id", async (req) => {
      const v = await ownedVideo(req.user!.id, (req.params as { id: string }).id);
      const used = await prisma.project.count({ where: { videoId: v.id, deletedAt: null } });
      if (used) throw new AppError(`This footage is used by ${used} ${used === 1 ? "edit" : "edits"}. Delete ${used === 1 ? "it" : "them"} first.`, 409, "in-use");
      const an = await prisma.footageAnalysis.findUnique({ where: { videoId: v.id } });
      await deleteObjects([v.proxyKey, v.audioKey, v.thumbKey, ...(((an?.keyFrames as { key: string }[]) || []).map((k) => k.key))]);
      await purgeProjectFiles({ videoId: v.id, deletedAt: { not: null } });
      await prisma.project.deleteMany({ where: { videoId: v.id, deletedAt: { not: null } } });
      await prisma.video.delete({ where: { id: v.id } });
      return { ok: true };
    });

    a.post("/videos/drive", async (req) => {
      const { fileIds } = DriveAddInput.parse(req.body);
      const userId = req.user!.id;
      const conn = await driveConn(userId);
      const out: Video[] = [];
      for (const fid of Array.from(new Set(fileIds))) {
        const f = await drive.getFile(userId, fid, conn.stub);
        if (!f) continue;
        const v = await prisma.video.create({ data: {
          userId, name: stripExt(f.name), seconds: f.seconds, sizeBytes: BigInt(f.sizeBytes || 0), originalSize: BigInt(f.sizeBytes || 0), originalName: f.name,
          orientation: f.width && f.height ? orientationOf(f.width, f.height) : "Landscape", source: "drive", driveFileId: f.id, status: "linking", art: randomArt(),
          sourceKey: conn.stub ? (f as { sampleKey?: string }).sampleKey ?? null : null,
        } });
        await enqueue<ProxyJob>("proxy", { videoId: v.id });
        out.push(v);
      }
      if (!out.length) throw new AppError("Pick at least one video.", 400);
      return Promise.all(out.map(videoOut));
    });

    // Built-in sample footage: processed on the server, original kept so exports work without asking.
    a.post("/videos/sample", async (req) => {
      const v = await prisma.video.create({ data: {
        userId: req.user!.id, name: "Sample footage", seconds: 41, sizeBytes: BigInt(989_324), originalSize: BigInt(989_324), originalName: "sample-footage.mp4",
        orientation: "Landscape", source: "local", sample: true, sourceKey: drive.SAMPLE_KEYS.talking, status: "previewing", progress: 0, art: randomArt(),
      } });
      await enqueue<ProxyJob>("proxy", { videoId: v.id });
      return [await videoOut(v)];
    });

    // ---------------- local files: the browser makes the preview, we only receive it ----------------
    a.post("/videos/local", async (req) => {
      const { files } = LocalFilesInput.parse(req.body);
      const made = await Promise.all(files.map((f) => prisma.video.create({ data: {
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
      return { connected: !!c, email: c?.googleEmail || null, stub: c ? c.stub : !features().drive };
    });
    a.post("/drive/connect", async (req) => {
      const userId = req.user!.id;
      if (features().drive) {
        const origin = webOrigin(req);
        if (!origin) throw new AppError("Open Rendrr from its own address to connect Google Drive.", 400, "drive");
        return { connected: false, authUrl: drive.authUrl(signState(userId, origin)) };
      }
      // TODO(key): GOOGLE_CLIENT_ID/SECRET unset, so this connects the fake Drive with sample files.
      const c = await prisma.driveConnection.upsert({ where: { userId }, create: { userId, googleEmail: req.user!.email || "demo@drive", refreshToken: "", scopes: "stub", stub: true }, update: {} });
      return { connected: true, email: c.googleEmail, stub: true };
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
      const folderId = String((req.query as { folderId?: string }).folderId || "root").slice(0, 200);
      const conn = await driveConn(req.user!.id);
      const { folders, files } = await drive.listFolder(req.user!.id, folderId, conn.stub);
      const linked = new Set((await prisma.video.findMany({ where: { userId: req.user!.id, source: "drive", status: { not: "missing" } }, select: { driveFileId: true } })).map((v) => v.driveFileId));
      return { folders, files: files.map((f) => ({ id: f.id, folderId: f.folderId, name: f.name, size: fmtSize(f.sizeBytes), seconds: f.seconds, date: f.date, added: linked.has(f.id) })) };
    });
  });
}
