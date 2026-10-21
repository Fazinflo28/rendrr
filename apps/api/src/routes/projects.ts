import { AppError, applyTimelineChange, notFound, projectChannel, restoreVersion } from "@rendrr/core";
import { prisma, type Prisma } from "@rendrr/db";
import { CreateFolderInput, CreateProjectInput, PLATFORMS, RenameFolderInput, STYLE_TYPES, UpdateProjectInput, type Snapshot } from "@rendrr/shared";
import type { FastifyInstance } from "fastify";
import { authenticate } from "../auth";
import { listen, openSse } from "../live";
import { activityOut, commentOut, folderOut, projectOut, styleOut } from "../serialize";
import { createProject, getOwnedProject, listProjects, projectFull, purgeProjectFiles } from "../services/projects";

/** Server-sent events on a raw response. Keeps CORS headers that Fastify already set. */
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
    const styles = new Map((await prisma.style.findMany()).map((s) => [s.id, s]));
    const reviews = await prisma.review.findMany({ where: { OR: [{ folderId: f.id }, { projectId: { in: ps.map((p) => p.id) } }] }, include: { comments: { select: { projectId: true } } }, orderBy: { createdAt: "desc" } });
    return {
      ...folderOut(f),
      assets: ps.map((p) => ({ ...projectOut(p), style: styles.get(p.styleId) ? styleOut(styles.get(p.styleId)!) : undefined,
        comments: reviews.filter((r) => r.projectId === p.id || r.folderId === f.id).reduce((n, r) => n + r.comments.filter((c) => !c.projectId || c.projectId === p.id).length, 0) })),
      shares: reviews.map((r) => ({ token: r.token, folderId: r.folderId, projectId: r.projectId, approved: r.approved, version: r.version })),
    };
  });

  app.post("/folders", async (req) => {
    const { name } = CreateFolderInput.parse(req.body);
    const count = await prisma.folder.count({ where: { userId: req.user!.id } });
    const first = (req.user!.name || "My").split(" ")[0];
    const f = await prisma.folder.create({ data: { userId: req.user!.id, name, workspace: `${first}'s Workspace`, cover: 1 + (count % 6) } });
    return folderOut(f);
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

  app.get("/projects/:id", async (req) => projectFull(req.user!.id, (req.params as { id: string }).id));

  app.post("/projects", async (req) => {
    const input = CreateProjectInput.parse(req.body);
    const p = await createProject(req.user!.id, input, { autoStyle: true });
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
      await applyTimelineChange(id, { op: "replace", timeline: patch.timeline, name: patch.name, aspect: patch.aspect, styleId: patch.styleId }, actor, { baseVersion: patch.baseVersion });
    } else {
      if (patch.name && patch.name !== p.name) await applyTimelineChange(id, { op: "rename", name: patch.name }, actor);
      if (patch.aspect && patch.aspect !== p.aspect) await applyTimelineChange(id, { op: "set_aspect", aspect: patch.aspect }, actor);
      if (patch.styleId && patch.styleId !== p.styleId) {
        const snap = { timeline: p.timeline, name: p.name, aspect: p.aspect, styleId: patch.styleId } as unknown as Snapshot;
        await applyTimelineChange(id, { op: "replace", timeline: snap.timeline, styleId: patch.styleId }, actor);
      }
    }
    if (patch.status && patch.status !== p.status) await prisma.project.update({ where: { id }, data: { status: patch.status } });
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
    const r = await restoreVersion(id, Number(v), { kind: "user", userId: req.user!.id }, `Restored V${v}`);
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

  // ---------------- styles ----------------
  app.get("/styles", async (req) => {
    const ss = await prisma.style.findMany({ where: { OR: [{ ownerId: null }, { ownerId: req.user!.id }] }, orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] });
    return ss.map(styleOut);
  });
  app.get("/styles/filters", async () => ({ types: STYLE_TYPES, platforms: PLATFORMS }));
  app.get("/styles/:id", async (req) => {
    const s = await prisma.style.findFirst({ where: { id: (req.params as { id: string }).id, OR: [{ ownerId: null }, { ownerId: req.user!.id }] } });
    if (!s) throw notFound("That style does not exist.");
    return styleOut(s);
  });

  // ---------------- comments (editor side) ----------------
  app.patch("/comments/:id", async (req) => {
    const c = await prisma.reviewComment.findUnique({ where: { id: (req.params as { id: string }).id }, include: { review: true } });
    if (!c || c.review.userId !== req.user!.id) throw notFound("That comment is gone.");
    const resolved = (req.body as { resolved?: boolean })?.resolved !== false;
    return commentOut(await prisma.reviewComment.update({ where: { id: c.id }, data: { resolved } }));
  });
}

export type { Prisma };
