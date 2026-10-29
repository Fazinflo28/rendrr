// The Rendrr app inside the chat (an MCP App): every edit, each one's latest preview with its render progress, and its
// comments. The app calls these through the host and the MCP server, as the signed-in user; comments land in the same
// tables as the editor's (the Comments tab and the markers show them, and get_comments reads them for the AI).
import { notFound, signGet } from "@rendrr/core";
import { prisma } from "@rendrr/db";
import type { AppComment, AppOpen, AppProjectCard, AppProjectsPage, AppProjectView } from "@rendrr/shared";
import { getOwnedProject } from "./projects";
import { renderStatus, startRender } from "./render";
import type { ToolCtx, ToolOut } from "../tools";

const WEB = () => (process.env.PUBLIC_WEB_URL || "").replace(/\/$/, "") || null;
const LINK_SECONDS = 6 * 3600;

/** The origins the app loads pictures and video from (signed storage links), for its content security policy. */
export async function appMediaOrigins(): Promise<string[]> {
  try { return [new URL(await signGet("app/origin-probe", 60)).origin]; } catch { return []; }
}

/** Client comments on an edit (its own review links and its folder's), as get_comments reads them. */
const clientCommentsWhere = (p: { id: string; folderId: string }) => ({ review: { OR: [{ projectId: p.id }, { folderId: p.folderId }] }, OR: [{ projectId: null }, { projectId: p.id }] });

export async function appProjects(userId: string, i: { offset?: number; limit?: number; query?: string }): Promise<AppProjectsPage> {
  const where = { userId, deletedAt: null, ...(i.query?.trim() ? { name: { contains: i.query.trim(), mode: "insensitive" as const } } : {}) };
  const offset = i.offset ?? 0, limit = i.limit ?? 24;
  const [total, ps] = await Promise.all([
    prisma.project.count({ where }),
    prisma.project.findMany({ where, orderBy: { updatedAt: "desc" }, skip: offset, take: limit, include: { folder: true, video: { select: { thumbKey: true } } } }),
  ]);
  const ids = ps.map((p) => p.id);
  const [notes, client, previews, running] = await Promise.all([
    prisma.projectComment.groupBy({ by: ["projectId"], where: { projectId: { in: ids }, resolved: false }, _count: true }),
    prisma.reviewComment.groupBy({ by: ["projectId"], where: { projectId: { in: ids }, resolved: false }, _count: true }),
    prisma.render.findMany({ where: { projectId: { in: ids }, kind: "preview", status: "done", outputKey: { not: null } }, orderBy: { createdAt: "desc" }, select: { projectId: true, version: true } }),
    prisma.render.findMany({ where: { projectId: { in: ids }, kind: "preview", status: { in: ["queued", "running"] }, createdAt: { gt: new Date(Date.now() - 3 * 3600_000) } }, select: { projectId: true } }),
  ]);
  const open = new Map<string, number>();
  for (const r of [...notes, ...client]) if (r.projectId) open.set(r.projectId, (open.get(r.projectId) ?? 0) + r._count);
  const lastPreview = new Map<string, number>();
  for (const r of previews) if (!lastPreview.has(r.projectId)) lastPreview.set(r.projectId, r.version);
  const busy = new Set(running.map((r) => r.projectId));
  const projects: AppProjectCard[] = await Promise.all(ps.map(async (p) => ({
    id: p.id, name: p.name, folder: p.folder.name, aspect: p.aspect, status: p.status, version: p.currentVersion, updated: p.updatedAt.getTime(),
    seconds: p.outputSeconds || null, thumb: p.video.thumbKey ? await signGet(p.video.thumbKey, LINK_SECONDS) : null,
    previewVersion: lastPreview.get(p.id) ?? null, rendering: busy.has(p.id), openComments: open.get(p.id) ?? 0,
  })));
  return { projects, total, offset };
}

export async function appProject(userId: string, projectId: string): Promise<AppProjectView> {
  const p = await getOwnedProject(userId, projectId);
  const [folder, user, latest, done, live, failed, notes, client] = await Promise.all([
    prisma.folder.findUnique({ where: { id: p.folderId }, select: { name: true } }),
    prisma.user.findUnique({ where: { id: userId }, select: { name: true } }),
    prisma.projectVersion.findFirst({ where: { projectId: p.id }, orderBy: { v: "desc" }, select: { v: true } }),
    prisma.render.findFirst({ where: { projectId: p.id, kind: "preview", status: "done", outputKey: { not: null } }, orderBy: { createdAt: "desc" } }),
    prisma.render.findFirst({ where: { projectId: p.id, kind: "preview", status: { in: ["queued", "running"] }, createdAt: { gt: new Date(Date.now() - 3 * 3600_000) } }, orderBy: { createdAt: "desc" } }),
    prisma.render.findFirst({ where: { projectId: p.id, kind: "preview", status: "failed" }, orderBy: { createdAt: "desc" } }),
    prisma.projectComment.findMany({ where: { projectId: p.id }, orderBy: { createdAt: "asc" }, take: 300 }),
    prisma.reviewComment.findMany({ where: clientCommentsWhere(p), orderBy: { createdAt: "asc" }, take: 300 }),
  ]);
  const st = live ? await renderStatus(live) : null;
  const version = latest?.v ?? p.currentVersion;
  const comments: AppComment[] = [
    ...notes.map((n) => ({ id: n.id, time: n.time, text: n.text, author: user?.name || "You", mine: true, resolved: n.resolved, at: n.createdAt.getTime() })),
    ...client.map((c) => ({ id: c.id, time: c.time, text: c.text, author: c.author, mine: false, resolved: c.resolved, at: c.createdAt.getTime() })),
  ].sort((a, b) => a.time - b.time || a.at - b.at);
  return {
    project: { id: p.id, name: p.name, folder: folder?.name ?? "", aspect: p.aspect, status: p.status, version, updated: p.updatedAt.getTime(), seconds: p.outputSeconds || null, editorUrl: WEB() ? `${WEB()}/editor/${p.id}` : null },
    preview: done?.outputKey ? { renderId: done.id, version: done.version, url: await signGet(done.outputKey, LINK_SECONDS, { contentType: "video/mp4" }), seconds: done.seconds, quality: done.quality ?? "540p", at: done.createdAt.getTime() } : null,
    rendering: live && st ? { renderId: live.id, version: live.version, percent: Math.round(st.percent ?? 0), step: st.steps[st.step] ?? null, etaSec: st.etaSec, queued: st.status === "queued" } : null,
    // A failed render is only news while nothing newer worked.
    failed: failed && (!done || failed.createdAt > done.createdAt) && (!live || failed.createdAt > live.createdAt) ? { version: failed.version, error: failed.error || "The render failed." } : null,
    comments,
  };
}

async function setResolved(userId: string, commentId: string, resolved: boolean) {
  const c = await prisma.reviewComment.findUnique({ where: { id: commentId }, include: { review: true } });
  if (c && c.review.userId === userId) return prisma.reviewComment.update({ where: { id: c.id }, data: { resolved } });
  const n = await prisma.projectComment.findUnique({ where: { id: commentId } });
  if (!n || n.userId !== userId) throw notFound("That comment is gone.");
  return prisma.projectComment.update({ where: { id: n.id }, data: { resolved } });
}

/** A short line for the AI next to the app (open_projects): what the user sees. */
function openText(page: AppProjectsPage, open: AppProjectView | null): string {
  const head = `Showing the Rendrr app with ${page.total} ${page.total === 1 ? "edit" : "edits"}.`;
  if (!open) return `${head} Newest: ${page.projects.slice(0, 5).map((p) => `${p.name} (${p.id}, v${p.version}${p.openComments ? `, ${p.openComments} open comments` : ""})`).join("; ") || "none"}.`;
  const o = open.comments.filter((c) => !c.resolved).length;
  return `${head} Open: "${open.project.name}" (${open.project.id}), v${open.project.version}; ${open.preview ? `preview v${open.preview.version}` : "no preview yet"}${open.rendering ? `, rendering v${open.rendering.version} (${open.rendering.percent}%)` : ""}; ${o} open ${o === 1 ? "comment" : "comments"} (get_comments reads them).`;
}

export async function openProjects(c: ToolCtx, i: { projectId?: string }): Promise<ToolOut> {
  const open = i.projectId ? await appProject(c.userId, i.projectId) : null;
  const page = await appProjects(c.userId, {});
  const data: AppOpen = { ...page, open, webUrl: WEB() };
  return { text: openText(page, open), data };
}

export const APP_HANDLERS: Record<string, (c: ToolCtx, input: any) => Promise<ToolOut>> = {
  async app_list_projects(c, i) {
    const page = await appProjects(c.userId, i);
    return { text: `${page.projects.length} of ${page.total} edits.`, data: page };
  },
  async app_get_project(c, i) {
    const view = await appProject(c.userId, i.projectId);
    return { text: `"${view.project.name}" v${view.project.version}.`, data: view };
  },
  async app_add_comment(c, i) {
    const p = await getOwnedProject(c.userId, i.projectId);
    await prisma.projectComment.create({ data: { projectId: p.id, userId: c.userId, time: i.time, text: i.text } });
    return { text: "Comment added.", data: await appProject(c.userId, p.id) };
  },
  async app_resolve_comment(c, i) {
    const p = await getOwnedProject(c.userId, i.projectId);
    await setResolved(c.userId, i.commentId, i.resolved !== false);
    return { text: i.resolved === false ? "Comment opened again." : "Comment resolved.", data: await appProject(c.userId, p.id) };
  },
  async app_render_preview(c, i) {
    await startRender(c.userId, i.projectId, "preview");
    return { text: "Rendering a preview.", data: await appProject(c.userId, i.projectId) };
  },
};
