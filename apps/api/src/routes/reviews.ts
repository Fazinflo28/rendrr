import { AppError, checkPassword, env, hashPassword, notFound, sealLatestVersion, signGet, token as newToken } from "@rendrr/core";
import { prisma, type Project, type Review, type ReviewComment } from "@rendrr/db";
import { CreateReviewInput, PublishInput, REVIEW_SIGNED_URL_SECONDS, RequestChangesInput, ReviewCommentInput, ReviewPasswordInput, fmtShortDate, outputDuration, allWords, type Timeline, type Transcript, type V2Clip } from "@rendrr/shared";
import { createHmac } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { authenticate } from "../auth";
import { commentOut, galleryOut, reviewOut } from "../serialize";
import { latestRender } from "../services/projects";
import { startRender } from "../services/render";

const keyFor = (r: Review) => createHmac("sha256", env().ENCRYPTION_KEY || env().CLERK_SECRET_KEY || "dev").update(`${r.token}:${r.passwordHash || ""}`).digest("base64url");
const unlocked = (req: FastifyRequest, r: Review) => !r.passwordHash || req.headers["x-review-key"] === keyFor(r);

function parseExpiry(input: { expires?: string | null; expiresDays?: number }) {
  if (input.expiresDays) { const d = new Date(Date.now() + input.expiresDays * 86400_000); return { expiresAt: d, expiresLabel: fmtShortDate(d) }; }
  const s = (input.expires || "").trim();
  if (!s) return { expiresAt: null, expiresLabel: "No expiry" };
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(s) ? s + "T23:59:59Z" : s);
  if (isNaN(d.getTime())) throw new AppError("That expiry date does not look right.", 400);
  if (d.getTime() < Date.now()) throw new AppError("Pick an expiry date in the future.", 400);
  return { expiresAt: d, expiresLabel: fmtShortDate(d) };
}

async function reviewContext(r: Review) {
  const owner = await prisma.user.findUniqueOrThrow({ where: { id: r.userId } });
  const project = r.projectId ? await prisma.project.findUnique({ where: { id: r.projectId } }) : null;
  const folder = r.folderId ? await prisma.folder.findUnique({ where: { id: r.folderId } }) : null;
  const items = folder ? await prisma.project.findMany({ where: { folderId: folder.id, deletedAt: null }, orderBy: { updatedAt: "desc" } }) : [];
  return { owner, project, folder, items };
}

/** Short-lived video links for a review page. Final first, then preview. Never raw keys. */
async function reviewMedia(r: Review, projects: Project[]) {
  const out: Record<string, { latest: unknown; versions: Record<number, unknown> }> = {};
  for (const p of projects) {
    const versions: Record<number, unknown> = {};
    const top = r.projectId ? r.version : p.currentVersion;
    for (let v = 1; v <= top; v++) {
      const rr = (await latestRender(p.id, "final", v)) || (await latestRender(p.id, "preview", v));
      if (!rr?.outputKey) continue;
      versions[v] = {
        url: await signGet(rr.outputKey, REVIEW_SIGNED_URL_SECONDS), kind: rr.kind, quality: rr.quality,
        poster: (rr.framesKeys as string[])?.[0] ? await signGet((rr.framesKeys as string[])[0], REVIEW_SIGNED_URL_SECONDS) : null,
        download: r.allowDownload ? await signGet(rr.outputKey, REVIEW_SIGNED_URL_SECONDS, { download: `${p.name.replace(/[^\w\- ]+/g, "")} v${v}.mp4` }) : null,
        seconds: rr.seconds,
      };
    }
    const latestV = Math.max(0, ...Object.keys(versions).map(Number));
    const pending = await prisma.render.count({ where: { projectId: p.id, status: { in: ["queued", "running"] } } });
    out[p.id] = { latest: latestV ? versions[latestV] : null, versions, ...(pending ? { rendering: true } : {}) };
  }
  return out;
}

async function fullReview(r: Review & { comments: ReviewComment[] }, plain?: string | null) {
  const ctx = await reviewContext(r);
  const base = await reviewOut(r, ctx, plain);
  return { ...base, logo: r.showLogo ? base.logo : null, media: await reviewMedia(r, ctx.project ? [ctx.project] : ctx.items) };
}

async function setStatus(r: Review, status: string) {
  const where = r.projectId ? { id: r.projectId } : { folderId: r.folderId!, deletedAt: null };
  await prisma.project.updateMany({ where, data: { status } });
}

/** A review needs something to watch: render a preview for any version that has none. */
async function ensureRendered(userId: string, projects: Project[], version?: number) {
  for (const p of projects) {
    const v = version ?? p.currentVersion;
    const done = (await latestRender(p.id, "final", v)) || (await latestRender(p.id, "preview", v));
    if (!done) await startRender(userId, p.id, "preview", { version: v }).catch(() => {});
  }
}

export async function createReviewLink(userId: string, raw: unknown) {
  const input = CreateReviewInput.parse(raw);
  if (!input.projectId && !input.folderId) throw new AppError("Pick a project or a folder to share.", 400);
  let projects: Project[] = [];
  let version = 1;
  if (input.projectId) {
    const p = await prisma.project.findUnique({ where: { id: input.projectId } });
    if (!p || p.userId !== userId || p.deletedAt) throw notFound("We could not find that project.");
    const sealed = await sealLatestVersion(p.id);
    version = Math.min(input.version || sealed, sealed);
    projects = [p];
  } else {
    const f = await prisma.folder.findUnique({ where: { id: input.folderId! } });
    if (!f || f.userId !== userId) throw notFound("That project folder is gone.");
    projects = await prisma.project.findMany({ where: { folderId: f.id, deletedAt: null } });
    for (const p of projects) await sealLatestVersion(p.id);
  }
  const pw = input.password ? input.password.trim() : "";
  const r = await prisma.review.create({
    data: {
      token: newToken(10), userId, projectId: input.projectId || null, folderId: input.projectId ? null : input.folderId!, version,
      passwordHash: pw ? hashPassword(pw) : null, ...parseExpiry(input), allowDownload: !!input.allowDownload, showLogo: input.showLogo !== false,
    },
    include: { comments: true },
  });
  for (const p of projects) if (p.status !== "Approved") await prisma.project.update({ where: { id: p.id }, data: { status: "In review" } });
  await ensureRendered(userId, projects, input.projectId ? version : undefined);
  const ctx = await reviewContext(r);
  return reviewOut(r, ctx, pw || null);
}

async function publicReview(tok: string) {
  const r = await prisma.review.findUnique({ where: { token: tok }, include: { comments: true } });
  if (!r || (r.expiresAt && r.expiresAt.getTime() < Date.now())) throw notFound("This review link does not exist or has expired.");
  return r;
}

export default async function reviews(app: FastifyInstance) {
  // ---------------- public: the client's review page (no login) ----------------
  app.register(async (pub) => {
    pub.get("/public/reviews/:token", async (req) => {
      const r = await publicReview((req.params as { token: string }).token);
      if (!unlocked(req, r)) {
        const ctx = await reviewContext(r);
        return { token: r.token, locked: true, password: true, brand: ctx.owner.name, showLogo: r.showLogo, logo: null, version: r.version, approved: false, allowDownload: false,
          project: ctx.project ? { name: ctx.project.name, aspect: ctx.project.aspect } : null, folder: ctx.folder ? { name: ctx.folder.name } : null, items: [], comments: [] };
      }
      await prisma.review.update({ where: { token: r.token }, data: { views: { increment: 1 } } });
      return fullReview({ ...r, views: r.views + 1 });
    });
    pub.get("/public/reviews/:token/media", async (req) => {
      const r = await publicReview((req.params as { token: string }).token);
      if (!unlocked(req, r)) throw new AppError("This review is locked.", 401, "locked");
      const ctx = await reviewContext(r);
      return reviewMedia(r, ctx.project ? [ctx.project] : ctx.items);
    });
    pub.post("/public/reviews/:token/unlock", async (req) => {
      const r = await publicReview((req.params as { token: string }).token);
      const { password } = ReviewPasswordInput.parse(req.body);
      if (r.passwordHash && !checkPassword(password, r.passwordHash)) throw new AppError("That password is not right.", 401, "bad-password");
      return { ok: true, key: keyFor(r) };
    });
    pub.post("/public/reviews/:token/comments", async (req) => {
      const r = await publicReview((req.params as { token: string }).token);
      if (!unlocked(req, r)) throw new AppError("This review is locked.", 401, "locked");
      const b = ReviewCommentInput.parse(req.body);
      const projectId = (req.body as { projectId?: string }).projectId;
      const valid = projectId && (r.projectId === projectId || (r.folderId && (await prisma.project.count({ where: { id: projectId, folderId: r.folderId } }))));
      const c = await prisma.reviewComment.create({ data: { reviewToken: r.token, projectId: valid ? projectId! : r.projectId, time: Math.round(b.time * 100) / 100, text: b.text, author: "Client" } });
      return commentOut(c);
    });
    pub.post("/public/reviews/:token/approve", async (req) => {
      const r = await publicReview((req.params as { token: string }).token);
      if (!unlocked(req, r)) throw new AppError("This review is locked.", 401, "locked");
      const u = await prisma.review.update({ where: { token: r.token }, data: { approved: true }, include: { comments: true } });
      await setStatus(r, "Approved");
      return fullReview(u);
    });
    pub.post("/public/reviews/:token/changes", async (req) => {
      const r = await publicReview((req.params as { token: string }).token);
      if (!unlocked(req, r)) throw new AppError("This review is locked.", 401, "locked");
      const { note } = RequestChangesInput.parse(req.body);
      if (note?.trim()) await prisma.reviewComment.create({ data: { reviewToken: r.token, projectId: r.projectId, time: 0, text: note.trim().slice(0, 4000), author: "Client" } });
      const u = await prisma.review.update({ where: { token: r.token }, data: { approved: false }, include: { comments: true } });
      await setStatus(r, "Changes requested");
      return fullReview(u);
    });
  });

  // ---------------- signed in: share links and the community gallery ----------------
  app.register(async (a) => {
    a.addHook("preHandler", authenticate);

    a.get("/reviews", async (req) => {
      const rs = await prisma.review.findMany({ where: { userId: req.user!.id }, include: { comments: true }, orderBy: { createdAt: "desc" } });
      return Promise.all(rs.map(async (r) => reviewOut(r, await reviewContext(r))));
    });
    a.post("/reviews", async (req) => createReviewLink(req.user!.id, req.body));

    a.get("/gallery", async (req) => {
      const me = req.user!.id;
      const items = await prisma.galleryItem.findMany({ orderBy: { createdAt: "desc" }, take: 200 });
      const likes = new Set((await prisma.galleryLike.findMany({ where: { userId: me, galleryItemId: { in: items.map((i) => i.id) } } })).map((l) => l.galleryItemId));
      const styles = new Map((await prisma.style.findMany()).map((s) => [s.id, s]));
      return items.filter((g) => styles.has(g.styleId)).map((g) => galleryOut(g, me, likes.has(g.id), styles.get(g.styleId)));
    });

    a.post("/gallery", async (req) => {
      const me = req.user!;
      const input = PublishInput.parse(req.body);
      const p = await prisma.project.findUnique({ where: { id: input.projectId }, include: { video: { include: { analysis: true } } } });
      if (!p || p.userId !== me.id || p.deletedAt) throw new AppError("Pick a project to publish.", 400);
      const tl = p.timeline as unknown as Timeline;
      const tr = (p.video.analysis?.transcript as unknown as Transcript) || [];
      const out = outputDuration(tl, allWords(tr));
      const zooms = (tl.tracks.v2 as V2Clip[]).filter((c) => c.kind === "zoom");
      // The recipe others recreate: rhythm, caption look, zoom pattern, structure. Never the footage.
      const recipe = {
        styleId: p.styleId, aspect: p.aspect, outputSeconds: Math.round(out * 10) / 10,
        cutRhythm: { mainClips: tl.tracks.v1.length, avgClipSeconds: tl.tracks.v1.length ? Math.round((out / tl.tracks.v1.length) * 10) / 10 : 0, wordsCut: tl.cut.length },
        captions: { on: tl.captionsOn, look: tl.captionLook },
        zoomPattern: { count: zooms.length, everySeconds: zooms.length ? Math.round((out / zooms.length) * 10) / 10 : null, scales: Array.from(new Set(zooms.map((z) => z.zoom ?? 1.15))) },
        structure: { lines: tr.length, broll: tl.tracks.v2.filter((c) => (c as V2Clip).kind === "broll").length, graphics: tl.tracks.v3.filter((c) => (c as { kind?: string }).kind === "graphic").length, music: tl.tracks.a2.map((c) => (c as { label: string }).label) },
      };
      const g = await prisma.galleryItem.create({ data: {
        projectId: p.id, userId: me.id, author: me.name || "Someone", title: (input.title || p.name).slice(0, 200), styleId: p.styleId, ori: p.aspect,
        platforms: input.platforms?.length ? input.platforms : ["instagram"], allowRecreate: input.allowRecreate !== false, recipe,
      } });
      await prisma.reference.create({ data: { id: g.id, userId: me.id, name: g.title, recipe } }).catch(() => {});
      const style = await prisma.style.findUnique({ where: { id: g.styleId } });
      return galleryOut(g, me.id, false, style || undefined);
    });

    a.delete("/gallery/:id", async (req) => {
      const g = await prisma.galleryItem.findUnique({ where: { id: (req.params as { id: string }).id } });
      if (!g || g.userId !== req.user!.id) throw notFound("That video is not in the gallery any more.");
      await prisma.galleryItem.delete({ where: { id: g.id } });
      return { ok: true };
    });

    a.post("/gallery/:id/like", async (req) => {
      const me = req.user!.id;
      const id = (req.params as { id: string }).id;
      const g = await prisma.galleryItem.findUnique({ where: { id } });
      if (!g) throw notFound("That video is not in the gallery any more.");
      const existing = await prisma.galleryLike.findUnique({ where: { galleryItemId_userId: { galleryItemId: id, userId: me } } });
      const u = await prisma.$transaction(async (tx) => {
        if (existing) await tx.galleryLike.delete({ where: { galleryItemId_userId: { galleryItemId: id, userId: me } } });
        else await tx.galleryLike.create({ data: { galleryItemId: id, userId: me } });
        return tx.galleryItem.update({ where: { id }, data: { likes: { increment: existing ? -1 : 1 } } });
      });
      const style = await prisma.style.findUnique({ where: { id: u.styleId } });
      return galleryOut(u, me, !existing, style || undefined);
    });

    a.post("/gallery/:id/recreate", async (req) => {
      await prisma.galleryItem.updateMany({ where: { id: (req.params as { id: string }).id }, data: { recreates: { increment: 1 } } });
      return { ok: true };
    });
  });
}
