import { AppError, checkPassword, env, hashPassword, notFound, redis, sealLatestVersion, signGet, token as newToken } from "@rendrr/core";
import { prisma, type Project, type Review, type ReviewComment } from "@rendrr/db";
import { CreateReviewInput, DEFAULT_STYLE_ID, PublishInput, REVIEW_SIGNED_URL_SECONDS, RequestChangesInput, ReviewCommentInput, ReviewPasswordInput, fmtShortDate, outputDuration, allWords, type ReferenceRef, type Timeline, type Transcript, type V2Clip } from "@rendrr/shared";
import { createHmac } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { authenticate } from "../auth";
import { commentOut, galleryOut, reviewOut } from "../serialize";
import { latestRender } from "../services/projects";
import { startRender } from "../services/render";
import { deleteGalleryMedia, galleryMedia, prepareGalleryMedia } from "../services/galleryMedia";

const keyFor = (r: Review) => createHmac("sha256", env().ENCRYPTION_KEY || env().CLERK_SECRET_KEY || "dev").update(`${r.token}:${r.passwordHash || ""}`).digest("base64url");
const unlocked = (req: FastifyRequest, r: Review) => !r.passwordHash || req.headers["x-review-key"] === keyFor(r);
/** Explore files every video under a style's category: the style the edit applied, else its style reference, else
 *  the default category. */
const galleryStyleOf = (p: Project) => p.styleId ?? ((p.reference as ReferenceRef | null)?.kind === "style" ? (p.reference as ReferenceRef).id : DEFAULT_STYLE_ID);

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
  if (!projects.length) return out;
  // One query for every finished render of these projects, newest first; the first hit per version wins.
  const renders = await prisma.render.findMany({
    where: { projectId: { in: projects.map((p) => p.id) }, status: "done", outputKey: { not: null } },
    orderBy: { createdAt: "desc" },
    select: { projectId: true, version: true, kind: true, quality: true, outputKey: true, framesKeys: true, seconds: true },
  });
  const pending = new Set((await prisma.render.findMany({ where: { projectId: { in: projects.map((p) => p.id) }, status: { in: ["queued", "running"] }, kind: { not: "sample" } }, select: { projectId: true } })).map((x) => x.projectId));
  for (const p of projects) {
    const top = r.projectId ? r.version : p.currentVersion;
    const best = new Map<number, (typeof renders)[number]>();
    for (const rr of renders) {
      if (rr.projectId !== p.id || rr.version > top) continue;
      const have = best.get(rr.version);
      if (!have || (have.kind !== "final" && rr.kind === "final")) best.set(rr.version, rr);
    }
    const versions: Record<number, unknown> = {};
    for (const [v, rr] of [...best.entries()].sort((a, b) => a[0] - b[0])) {
      versions[v] = {
        url: await signGet(rr.outputKey!, REVIEW_SIGNED_URL_SECONDS), kind: rr.kind, quality: rr.quality,
        poster: (rr.framesKeys as string[])?.[0] ? await signGet((rr.framesKeys as string[])[0], REVIEW_SIGNED_URL_SECONDS) : null,
        download: r.allowDownload ? await signGet(rr.outputKey!, REVIEW_SIGNED_URL_SECONDS, { download: `${p.name.replace(/[^\w\- ]+/g, "")} v${v}.mp4` }) : null,
        seconds: rr.seconds,
      };
    }
    const latestV = Math.max(0, ...Object.keys(versions).map(Number));
    out[p.id] = { latest: latestV ? versions[latestV] : null, versions, ...(pending.has(p.id) ? { rendering: true } : {}) };
  }
  return out;
}

/** The public page never needs internal ids beyond the project's own. */
function publicShape<T extends { project?: unknown; items?: unknown[] }>(o: T): T {
  const strip = (p: unknown) => {
    if (!p || typeof p !== "object") return p;
    const { videoId: _v, folderId: _f, ...rest } = p as Record<string, unknown>;
    return rest;
  };
  return { ...o, project: strip(o.project), items: (o.items || []).map(strip) };
}

async function fullReview(r: Review & { comments: ReviewComment[] }, plain?: string | null) {
  const ctx = await reviewContext(r);
  const base = await reviewOut(r, ctx, plain);
  return publicShape({ ...base, logo: r.showLogo ? base.logo : null, media: await reviewMedia(r, ctx.project ? [ctx.project] : ctx.items) });
}

async function setStatus(r: Review, status: string) {
  const where = r.projectId ? { id: r.projectId } : { folderId: r.folderId!, deletedAt: null };
  await prisma.project.updateMany({ where, data: { status } });
}

/**
 * A review needs something to watch: render a preview for any version that has none. From the public page (anyone
 * with the link, polling every few seconds) a version whose preview failed in the last half hour is not tried again,
 * and one review starts at most 3 renders an hour (a waiting or running render is joined, never doubled).
 */
async function ensureRendered(userId: string, projects: Project[], version?: number, publicReviewId?: string) {
  for (const p of projects) {
    const v = version ?? p.currentVersion;
    const done = (await latestRender(p.id, "final", v)) || (await latestRender(p.id, "preview", v));
    if (done) continue;
    if (publicReviewId) {
      const busy = await prisma.render.count({ where: { projectId: p.id, version: v, kind: "preview", OR: [{ status: { in: ["queued", "running"] } }, { status: "failed", finishedAt: { gt: new Date(Date.now() - 30 * 60_000) } }] } });
      if (busy) continue;
      const key = `review-renders:${publicReviewId}`;
      const n = await redis().incr(key);
      if (n === 1) await redis().expire(key, 3600);
      if (n > 3) continue;
    }
    await startRender(userId, p.id, "preview", { version: v }).catch(() => {});
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
  const gone = () => notFound("This review link does not exist or has expired.");
  if (!r || (r.expiresAt && r.expiresAt.getTime() < Date.now())) throw gone();
  // A deleted edit stops being shared, even though its review row is kept for the owner's history.
  if (r.projectId && !(await prisma.project.count({ where: { id: r.projectId, deletedAt: null } }))) throw gone();
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
    // ?v=N asks for one version of a single-edit review: if it was never rendered, a preview is made now
    // (the page shows "Rendering the preview…" and asks again until it is there).
    pub.get("/public/reviews/:token/media", async (req) => {
      const r = await publicReview((req.params as { token: string }).token);
      if (!unlocked(req, r)) throw new AppError("This review is locked.", 401, "locked");
      const ctx = await reviewContext(r);
      const v = Number((req.query as { v?: string }).v);
      if (ctx.project && Number.isInteger(v) && v >= 1 && v <= r.version) await ensureRendered(r.userId, [ctx.project], v, r.token);
      return reviewMedia(r, ctx.project ? [ctx.project] : ctx.items);
    });
    // Password guesses: 10 a minute per address (the rest of the review page allows 90).
    pub.post("/public/reviews/:token/unlock", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req) => {
      const r = await publicReview((req.params as { token: string }).token);
      const { password } = ReviewPasswordInput.parse(req.body);
      if (r.passwordHash && !checkPassword(password, r.passwordHash)) throw new AppError("That password is not right.", 401, "bad-password");
      return { ok: true, key: keyFor(r) };
    });
    pub.post("/public/reviews/:token/comments", async (req) => {
      const r = await publicReview((req.params as { token: string }).token);
      if (!unlocked(req, r)) throw new AppError("This review is locked.", 401, "locked");
      const b = ReviewCommentInput.parse(req.body);
      const raw = (req.body as { projectId?: unknown }).projectId;
      const projectId = typeof raw === "string" && raw.length <= 64 ? raw : undefined; // anything else: the review's own edit
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
      // The newest 200 share links (each is signed and counted below; an old account's full history is not needed here).
      const rs = await prisma.review.findMany({ where: { userId: req.user!.id }, include: { comments: true }, orderBy: { createdAt: "desc" }, take: 200 });
      return Promise.all(rs.map(async (r) => reviewOut(r, await reviewContext(r))));
    });
    a.post("/reviews", async (req) => createReviewLink(req.user!.id, req.body));
    a.delete("/reviews/:token", async (req) => {
      const r = await prisma.review.findUnique({ where: { token: (req.params as { token: string }).token } });
      if (!r || r.userId !== req.user!.id) throw notFound("That review link is already gone.");
      await prisma.review.delete({ where: { token: r.token } });
      return { ok: true };
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
        projectId: p.id, userId: me.id, author: me.name || "Someone", title: (input.title || p.name).slice(0, 200), styleId: galleryStyleOf(p), ori: p.aspect,
        platforms: input.platforms?.length ? input.platforms : ["instagram"], allowRecreate: input.allowRecreate !== false, recipe,
      } });
      await prisma.reference.create({ data: { id: g.id, userId: me.id, name: g.title, recipe } }).catch(() => {});
      // The real video: the edit's export copied to the item now, or a preview started if it has none yet.
      const ready = await prepareGalleryMedia(g, me.id);
      const style = await prisma.style.findUnique({ where: { id: g.styleId } });
      return galleryOut(ready, me.id, false, style || undefined, await galleryMedia(ready));
    });

    a.delete("/gallery/:id", async (req) => {
      const g = await prisma.galleryItem.findUnique({ where: { id: (req.params as { id: string }).id } });
      if (!g || g.userId !== req.user!.id) throw notFound("That video is not in the gallery any more.");
      await prisma.galleryItem.delete({ where: { id: g.id } });
      await deleteGalleryMedia(g);
      await prisma.reference.deleteMany({ where: { id: g.id, userId: g.userId } });
      return { ok: true };
    });

    a.post("/gallery/:id/like", async (req) => {
      const me = req.user!.id;
      const id = (req.params as { id: string }).id;
      const g = await prisma.galleryItem.findUnique({ where: { id } });
      if (!g) throw notFound("That video is not in the gallery any more.");
      // A toggle that a double click cannot break: the like is added only if it is not there (and taken away only if
      // it is), and the count moves only by what changed.
      const key = { galleryItemId_userId: { galleryItemId: id, userId: me } };
      const { u, liked } = await prisma.$transaction(async (tx) => {
        const gone = await tx.galleryLike.deleteMany({ where: { galleryItemId: id, userId: me } });
        if (gone.count) return { u: await tx.galleryItem.update({ where: { id }, data: { likes: { decrement: gone.count } } }), liked: false };
        const made = await tx.galleryLike.createMany({ data: [{ galleryItemId: id, userId: me }], skipDuplicates: true });
        return { u: made.count ? await tx.galleryItem.update({ where: { id }, data: { likes: { increment: 1 } } }) : await tx.galleryItem.findUniqueOrThrow({ where: { id } }), liked: !!made.count || !!(await tx.galleryLike.findUnique({ where: key })) };
      });
      const style = await prisma.style.findUnique({ where: { id: u.styleId } });
      return galleryOut(u, me, liked, style || undefined, await galleryMedia(u));
    });

    a.post("/gallery/:id/recreate", async (req) => {
      await prisma.galleryItem.updateMany({ where: { id: (req.params as { id: string }).id }, data: { recreates: { increment: 1 } } });
      return { ok: true };
    });
  });
}
