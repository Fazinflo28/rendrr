import { AppError, applyTimelineChange, matteBlockUrls, notFound, projectChannel, restoreVersion, signGet } from "@rendrr/core";
import { prisma, Prisma } from "@rendrr/db";
import { COMMENT_IMAGES_MAX, CommentImageInput, CreateFolderInput, CreateProjectInput, DrawingInput, ProjectCommentInput, RenameFolderInput, UpdateProjectInput, type Snapshot, type Timeline } from "@rendrr/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { faceTracks, skinFaceAreas, speakerCentres } from "../services/color";
import { createCanvas } from "../services/canvas";
import { autoPlan, syncAngle } from "../services/multicam";
import { authenticate } from "../auth";
import { listen, openSse } from "../live";
import { activityOut, commentOut, folderOut, noteOut, projectOut, styleOut } from "../serialize";
import { projectChat } from "../services/aiChat";
import { editorMarks } from "../services/marks";
import { createFolder, createProject, getOwnedProject, listProjects, projectFull, purgeProjectFiles, resolveReference, stylesById } from "../services/projects";
import { addNote, deleteComment, editNote } from "../services/commentMedia";

/** A picture of each edit for its card: a frame of its latest render (the edit as it looks), else its footage's
 *  thumbnail. Signed for an hour. */
async function editThumbs(ps: { id: string; videoId: string }[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!ps.length) return out;
  const renders = await prisma.render.findMany({ where: { projectId: { in: ps.map((p) => p.id) }, status: "done" }, orderBy: { createdAt: "desc" }, select: { projectId: true, framesKeys: true } });
  const videos = new Map((await prisma.video.findMany({ where: { id: { in: ps.map((p) => p.videoId) } }, select: { id: true, thumbKey: true } })).map((v) => [v.id, v.thumbKey]));
  await Promise.all(ps.map(async (p) => {
    const frames = renders.filter((r) => r.projectId === p.id).map((r) => (r.framesKeys as string[]) || []).find((k) => k.length);
    const key = frames?.[0] ?? videos.get(p.videoId);
    if (key) out.set(p.id, await signGet(key, 3600));
  }));
  return out;
}

/** Server-sent events on a raw response. Keeps CORS headers that Fastify already set. */
const SpeakerInput = z.object({ clips: z.array(z.object({ id: z.string().min(1).max(80), videoId: z.string().min(1).max(80), srcIn: z.number().min(0), srcOut: z.number().min(0), rotate: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]).default(0) })).min(1).max(400) });
const SkinAreasInput = z.object({ aspect: z.string().max(8).optional(), clips: z.array(z.object({ id: z.string().max(80), videoId: z.string().max(80), srcIn: z.number(), srcOut: z.number(), rotate: z.number().optional(), focus: z.object({ x: z.number(), y: z.number() }).nullable().optional() })).max(2000) });

export default async function projects(app: FastifyInstance) {
  app.addHook("preHandler", authenticate);

  // ---------------- folders (client projects) ----------------
  app.get("/folders", async (req) => {
    const userId = req.user!.id;
    const fs = await prisma.folder.findMany({ where: { userId }, orderBy: { updatedAt: "desc" } });
    if ((req.query as { lite?: string }).lite) return fs.map((f) => ({ id: f.id, name: f.name }));
    const counts = await prisma.project.groupBy({ by: ["folderId"], where: { userId, deletedAt: null }, _count: true });
    const reviews = await prisma.review.findMany({ where: { userId }, select: { folderId: true, projectId: true, project: { select: { folderId: true } } } });
    return fs.map((f) => folderOut(f, {
      count: counts.find((c) => c.folderId === f.id)?._count ?? 0,
      shares: reviews.filter((r) => r.folderId === f.id || r.project?.folderId === f.id).length,
    }));
  });

  app.get("/folders/:id", async (req) => {
    const userId = req.user!.id;
    const f = await prisma.folder.findUnique({ where: { id: (req.params as { id: string }).id } });
    if (!f || f.userId !== userId) throw notFound("That project folder is gone.");
    const ps = await prisma.project.findMany({ where: { folderId: f.id, deletedAt: null }, orderBy: { updatedAt: "desc" } });
    const styles = await stylesById(ps.map((p) => p.styleId));
    const reviews = await prisma.review.findMany({ where: { OR: [{ folderId: f.id }, { projectId: { in: ps.map((p) => p.id) } }] }, include: { comments: { select: { projectId: true } } }, orderBy: { createdAt: "desc" } });
    const thumbs = await editThumbs(ps);
    return {
      ...folderOut(f),
      assets: ps.map((p) => ({ ...projectOut(p), style: p.styleId && styles.get(p.styleId) ? styleOut(styles.get(p.styleId)!) : undefined, thumb: thumbs.get(p.id) ?? null,
        comments: reviews.filter((r) => r.projectId === p.id || r.folderId === f.id).reduce((n, r) => n + r.comments.filter((c) => !c.projectId || c.projectId === p.id).length, 0) })),
      shares: reviews.map((r) => ({ token: r.token, folderId: r.folderId, projectId: r.projectId, approved: r.approved, version: r.version })),
    };
  });

  app.post("/folders", async (req) => {
    const { name } = CreateFolderInput.parse(req.body);
    return folderOut(await createFolder(req.user!.id, name));
  });

  app.patch("/folders/:id", async (req) => {
    const { name } = RenameFolderInput.parse(req.body);
    const f = await prisma.folder.findUnique({ where: { id: (req.params as { id: string }).id } });
    if (!f || f.userId !== req.user!.id) throw notFound("That project folder is gone.");
    return folderOut(await prisma.folder.update({ where: { id: f.id }, data: { name } }));
  });

  app.delete("/folders/:id", async (req) => {
    const f = await prisma.folder.findUnique({ where: { id: (req.params as { id: string }).id } });
    if (!f || f.userId !== req.user!.id) throw notFound("That project folder is gone.");
    await purgeProjectFiles({ folderId: f.id });
    await prisma.folder.delete({ where: { id: f.id } });
    return { ok: true };
  });

  // ---------------- projects (edits inside folders) ----------------
  app.get("/projects", async (req) => listProjects(req.user!.id));

  app.get("/projects/:id", async (req) => {
    const p = await projectFull(req.user!.id, (req.params as { id: string }).id);
    return { ...p, aiChat: await projectChat(req.user!.id, p.id) };
  });

  // Engine Part 6: the marks on the edit's videos where they play in the edit, for the timeline (thin lines with a note).
  app.get("/projects/:id/marks", async (req) => editorMarks(req.user!.id, (req.params as { id: string }).id));

  app.post("/projects", async (req) => {
    const input = CreateProjectInput.parse(req.body);
    if (input.blank) {
      // From scratch: the blank canvas first, then the edit on it.
      const name = (input.name || "").trim() || "New video", aspect = input.aspect ?? "16:9";
      const canvas = await createCanvas(req.user!.id, { seconds: input.blank.seconds, aspect, color: input.blank.color, name });
      return projectOut(await createProject(req.user!.id, { videoId: canvas.id, name, folderId: input.folderId, aspect, length: input.blank.seconds, reference: input.reference }));
    }
    const p = await createProject(req.user!.id, input);
    return projectOut(p);
  });

  // Editor autosave and status changes. Timeline writes go through applyTimelineChange only.
  app.patch("/projects/:id", async (req) => {
    const userId = req.user!.id;
    const id = (req.params as { id: string }).id;
    const patch = UpdateProjectInput.parse(req.body);
    const p = await getOwnedProject(userId, id);
    const actor = { kind: "user" as const, userId };
    if (patch.timeline) {
      await applyTimelineChange(id, { op: "replace", timeline: patch.timeline, name: patch.name, aspect: patch.aspect, styleId: patch.styleId }, actor, { baseVersion: patch.baseVersion, baseAt: patch.baseAt });
    } else {
      if (patch.name && patch.name !== p.name) await applyTimelineChange(id, { op: "rename", name: patch.name }, actor);
      if (patch.aspect && patch.aspect !== p.aspect) await applyTimelineChange(id, { op: "set_aspect", aspect: patch.aspect }, actor);
      if (patch.styleId && patch.styleId !== p.styleId) {
        const snap = { timeline: p.timeline, name: p.name, aspect: p.aspect, styleId: patch.styleId } as unknown as Snapshot;
        await applyTimelineChange(id, { op: "replace", timeline: snap.timeline, styleId: patch.styleId }, actor);
      }
    }
    if (patch.status && patch.status !== p.status) await prisma.project.update({ where: { id }, data: { status: patch.status } });
    // A reference is attached for the AI to read, or taken off. It changes nothing in the edit.
    if (patch.reference !== undefined) await prisma.project.update({ where: { id }, data: { reference: patch.reference ? await resolveReference(userId, patch.reference) : Prisma.DbNull } });
    return projectOut(await prisma.project.findUniqueOrThrow({ where: { id } }));
  });

  app.delete("/projects/:id", async (req) => {
    const p = await getOwnedProject(req.user!.id, (req.params as { id: string }).id);
    await prisma.project.update({ where: { id: p.id }, data: { deletedAt: new Date() } });
    return { ok: true };
  });

  app.post("/projects/:id/restore", async (req) => {
    const p = await prisma.project.findUnique({ where: { id: (req.params as { id: string }).id } });
    if (!p || p.userId !== req.user!.id) throw notFound("That edit is gone for good.");
    return projectOut(await prisma.project.update({ where: { id: p.id }, data: { deletedAt: null } }));
  });

  // Auto reframe in the editor: where the speaker's face is in these clips (the editor's own clips, saved or not).
  app.post("/projects/:id/speaker", async (req) => {
    await getOwnedProject(req.user!.id, (req.params as { id: string }).id);
    const { clips } = SpeakerInput.parse(req.body);
    const mine = await prisma.video.findMany({ where: { id: { in: Array.from(new Set(clips.map((c) => c.videoId))) }, userId: req.user!.id }, select: { id: true } });
    const ok = new Set(mine.map((v) => v.id));
    return { centers: await speakerCentres(clips.filter((c) => ok.has(c.videoId))) };
  });

  // Skin retouch in the editor: each clip's face area (the editor's own clips, saved or not), as retouch_skin takes it.
  app.post("/projects/:id/skin-areas", async (req) => {
    const p = await getOwnedProject(req.user!.id, (req.params as { id: string }).id);
    const { clips, aspect } = SkinAreasInput.parse(req.body);
    const mine = await prisma.video.findMany({ where: { id: { in: Array.from(new Set(clips.map((c) => c.videoId))) }, userId: req.user!.id }, select: { id: true } });
    const ok = new Set(mine.map((v) => v.id));
    const areas = await skinFaceAreas(clips.filter((c) => ok.has(c.videoId)).map((c) => ({ id: c.id, sourceVideoId: c.videoId, sourceIn: c.srcIn, sourceOut: c.srcOut, rotate: c.rotate, framing: c.focus ? { focus: c.focus } : undefined })), "", aspect ?? p.aspect);
    return { areas };
  });

  // Phase 3 in the editor: each clip's face over it (the editor's own clips, saved or not), as set_masks and set_effects
  // take it for a shape that follows the face.
  app.post("/projects/:id/face-tracks", async (req) => {
    const p = await getOwnedProject(req.user!.id, (req.params as { id: string }).id);
    const { clips, aspect } = SkinAreasInput.parse(req.body);
    const mine = await prisma.video.findMany({ where: { id: { in: Array.from(new Set(clips.map((c) => c.videoId))) }, userId: req.user!.id }, select: { id: true } });
    const ok = new Set(mine.map((v) => v.id));
    const tracks = await faceTracks(clips.filter((c) => ok.has(c.videoId)).map((c) => ({ id: c.id, sourceVideoId: c.videoId, sourceIn: c.srcIn, sourceOut: c.srcOut, rotate: c.rotate, framing: c.focus ? { focus: c.focus } : undefined })), "", aspect ?? p.aspect);
    return { tracks };
  });

  // Phase 10 in the editor: an angle's sync to the edit's main video by their sound (the editor then sends multicam with
  // the offset, as its other ops).
  app.post("/projects/:id/multicam-sync", async (req) => {
    const p = await getOwnedProject(req.user!.id, (req.params as { id: string }).id);
    const { videoId } = z.object({ videoId: z.string().min(1).max(80) }).parse(req.body);
    const main = ((p.timeline as unknown as { mainVideoId?: string }).mainVideoId) || p.videoId;
    return syncAngle(req.user!.id, main, videoId);
  });

  // Phase 13: cut to whoever speaks. The editor sends the settings; the plan comes back and goes in a multicam_auto.
  app.post("/projects/:id/multicam-auto", async (req) => {
    const p = await getOwnedProject(req.user!.id, (req.params as { id: string }).id);
    const b = z.object({ cameras: z.array(z.string().min(1).max(80)).max(9).optional(), wide: z.string().min(1).max(80).optional(), minShot: z.number().min(0.5).max(30).optional(), start: z.number().min(0).optional(), end: z.number().min(0).optional() }).parse(req.body ?? {});
    const tl = p.timeline as unknown as Timeline;
    return { plan: await autoPlan(req.user!.id, tl.mainVideoId || p.videoId, tl as never, b) };
  });

  // remove_background in the editor: the links of a video's matte blocks over footage from..to (null: being made).
  app.get("/projects/:id/matte", async (req) => {
    await getOwnedProject(req.user!.id, (req.params as { id: string }).id);
    const q = z.object({ video: z.string().min(1).max(80), from: z.coerce.number().min(0), to: z.coerce.number().min(0), rotate: z.coerce.number().int().optional() }).parse(req.query);
    const out = await matteBlockUrls(req.user!.id, q.video, q.from, Math.max(q.from, q.to), q.rotate ?? 0);
    if (!out) throw notFound("That video is not in your library.");
    return out;
  });

  app.get("/projects/:id/versions", async (req) => {
    const p = await getOwnedProject(req.user!.id, (req.params as { id: string }).id);
    const vs = await prisma.projectVersion.findMany({ where: { projectId: p.id }, orderBy: { v: "asc" }, select: { v: true, note: true, updatedAt: true, createdBy: true } });
    return vs.map((x) => ({ v: x.v, note: x.note, at: x.updatedAt.getTime(), by: x.createdBy }));
  });

  app.get("/projects/:id/versions/:v", async (req) => {
    const { id, v } = req.params as { id: string; v: string };
    await getOwnedProject(req.user!.id, id);
    if (!/^\d{1,9}$/.test(v)) throw notFound(`Version ${v.slice(0, 20)} does not exist.`);
    const ver = await prisma.projectVersion.findUnique({ where: { projectId_v: { projectId: id, v: Number(v) } } });
    if (!ver) throw notFound(`Version ${v} does not exist.`);
    return { v: ver.v, note: ver.note, at: ver.updatedAt.getTime(), snapshot: ver.timeline };
  });

  app.post("/projects/:id/versions/:v/restore", async (req) => {
    const { id, v } = req.params as { id: string; v: string };
    await getOwnedProject(req.user!.id, id);
    if (!/^\d{1,9}$/.test(v)) throw notFound(`Version ${v.slice(0, 20)} does not exist.`);
    const r = await restoreVersion(id, Number(v), { kind: "user", userId: req.user!.id }, `Restored V${v}`, { keepName: true });
    return { ok: true, version: r.version };
  });

  // Live: tells an open editor when an AI (or a render) changed this edit.
  app.get("/projects/:id/events", async (req, reply) => {
    const p = await getOwnedProject(req.user!.id, (req.params as { id: string }).id);
    const s = openSse(req, reply);
    if (s.isClosed()) return;
    s.onClose(await listen(projectChannel(p.id), (msg) => s.send("change", JSON.parse(msg))));
    s.send("hello", { version: p.currentVersion });
  });

  // ---------------- AI activity ----------------
  app.get("/ai/activity", async (req) => {
    const projectId = (req.query as { projectId?: string }).projectId;
    const list = await prisma.aiAction.findMany({ where: { userId: req.user!.id, undone: false, ...(projectId ? { projectId } : {}) }, orderBy: { createdAt: "desc" }, take: 50, include: { project: true } });
    return list.filter((a) => !a.project.deletedAt).map((a) => activityOut(a, a.project));
  });

  app.post("/ai/activity/:id/undo", async (req) => {
    const a = await prisma.aiAction.findUnique({ where: { id: (req.params as { id: string }).id } });
    if (!a || a.userId !== req.user!.id) throw notFound("That AI change is gone.");
    if (a.undone) throw new AppError("That change was already undone.", 409);
    const r = await restoreVersion(a.projectId, a.beforeVersion, { kind: "user", userId: req.user!.id }, `Undid: ${a.text}`.slice(0, 280));
    await prisma.aiAction.update({ where: { id: a.id }, data: { undone: true } });
    return { ok: true, version: r.version };
  });

  // ---------------- comments (editor side) ----------------
  // The user's own notes on an edit, at a moment of the video. Client comments arrive through review links.
  // A drawing on the picture and pictures (up to 4) can come with it, as from the app in the chat; then the text may be
  // empty.
  const NoteInput = z.object({ time: ProjectCommentInput.shape.time, text: z.string().trim().max(2000, "That comment is too long.").default(""), drawing: DrawingInput.optional(), images: z.array(CommentImageInput).max(COMMENT_IMAGES_MAX).optional() });
  app.post("/projects/:id/comments", { bodyLimit: 8 * 1024 * 1024 }, async (req) => {
    const p = await getOwnedProject(req.user!.id, (req.params as { id: string }).id);
    const i = NoteInput.parse(req.body);
    const n = await addNote(req.user!.id, p.id, i);
    return noteOut(n, req.user!.name);
  });

  // Resolve or open again; the user's own note can also get new text (drawings and pictures come from the app in the chat).
  app.patch("/comments/:id", async (req) => {
    const id = (req.params as { id: string }).id;
    const body = (req.body ?? {}) as { resolved?: boolean; text?: string };
    if (typeof body.text === "string") {
      const text = ProjectCommentInput.shape.text.parse(body.text);
      return noteOut(await editNote(req.user!.id, id, { text }), req.user!.name);
    }
    const resolved = body.resolved !== false;
    const c = await prisma.reviewComment.findUnique({ where: { id }, include: { review: true } });
    if (c && c.review.userId === req.user!.id) return commentOut(await prisma.reviewComment.update({ where: { id: c.id }, data: { resolved } }));
    const n = await prisma.projectComment.findUnique({ where: { id } });
    if (!n || n.userId !== req.user!.id) throw notFound("That comment is gone.");
    return noteOut(await prisma.projectComment.update({ where: { id: n.id }, data: { resolved } }), req.user!.name);
  });

  app.delete("/comments/:id", async (req) => {
    await deleteComment(req.user!.id, (req.params as { id: string }).id);
    return { ok: true };
  });

  // ---------------- AI tab (read only: what a connected AI did, and its notes) ----------------
  app.get("/projects/:id/ai-chat", async (req) => {
    const p = await getOwnedProject(req.user!.id, (req.params as { id: string }).id);
    return projectChat(req.user!.id, p.id);
  });
}

export type { Prisma };
