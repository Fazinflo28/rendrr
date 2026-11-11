// The Rendrr app inside the chat (an MCP App): every edit, each one's latest preview with its render progress, and its
// comments. The app calls these through the host and the MCP server, as the signed-in user; comments land in the same
// tables as the editor's (the Comments tab and the markers show them, and get_comments reads them for the AI).
import { AppError, applyTimelineChange, notFound, signGet } from "@rendrr/core";
import { prisma } from "@rendrr/db";
import { whereShort, type AppComment, type AppFolderCard, type AppOpen, type AppProjectCard, type AppProjectsPage, type AppProjectView } from "@rendrr/shared";
import { macStatus, renderWhere } from "./macExport";
import { getOwnedProject } from "./projects";
import { renderResult, renderStatus, startRender } from "./render";
import { addNote, commentMedia, deleteComment, editNote } from "./commentMedia";
import { createReviewLink } from "../routes/reviews";
import { samplesView } from "./samples";
import type { ToolCtx, ToolOut } from "../tools";

const WEB = () => (process.env.PUBLIC_WEB_URL || "").replace(/\/$/, "") || null;
const LINK_SECONDS = 6 * 3600;

/** The origins the app loads pictures and video from (signed storage links), for its content security policy. */
export async function appMediaOrigins(): Promise<string[]> {
  try { return [new URL(await signGet("app/origin-probe", 60)).origin]; } catch { return []; }
}

/** Client comments on an edit (its own review links and its folder's), as get_comments reads them. */
const clientCommentsWhere = (p: { id: string; folderId: string }) => ({ review: { OR: [{ projectId: p.id }, { folderId: p.folderId }] }, OR: [{ projectId: null }, { projectId: p.id }] });

/** The user's projects (folders of edits), the one worked on last first: how many edits, the newest one's picture,
 *  open comments and whether one is rendering. */
export async function appFolders(userId: string): Promise<AppFolderCard[]> {
  const [folders, edits, notes, client, running] = await Promise.all([
    prisma.folder.findMany({ where: { userId }, select: { id: true, name: true, updatedAt: true } }),
    prisma.project.findMany({ where: { userId, deletedAt: null }, orderBy: { updatedAt: "desc" }, select: { id: true, folderId: true, updatedAt: true, aspect: true, video: { select: { thumbKey: true } } } }),
    prisma.projectComment.groupBy({ by: ["projectId"], where: { project: { userId, deletedAt: null }, resolved: false }, _count: true }),
    prisma.reviewComment.groupBy({ by: ["projectId"], where: { projectId: { not: null }, review: { userId }, resolved: false }, _count: true }),
    prisma.render.findMany({ where: { project: { userId }, kind: "preview", status: { in: ["queued", "running"] }, createdAt: { gt: new Date(Date.now() - 3 * 3600_000) } }, select: { projectId: true } }),
  ]);
  const folderOf = new Map(edits.map((e) => [e.id, e.folderId]));
  const by = new Map(folders.map((f) => [f.id, { f, edits: [] as typeof edits, open: 0, rendering: false }]));
  for (const e of edits) by.get(e.folderId)?.edits.push(e);
  for (const r of [...notes, ...client]) { const f = r.projectId ? by.get(folderOf.get(r.projectId) ?? "") : null; if (f) f.open += r._count; }
  for (const r of running) { const f = by.get(folderOf.get(r.projectId) ?? ""); if (f) f.rendering = true; }
  const cards = await Promise.all([...by.values()].map(async ({ f, edits: es, open, rendering }) => {
    const newest = es[0];
    return { id: f.id, name: f.name, edits: es.length, updated: Math.max(f.updatedAt.getTime(), newest?.updatedAt.getTime() ?? 0), aspect: newest?.aspect ?? null,
      thumb: newest?.video?.thumbKey ? await signGet(newest.video.thumbKey, LINK_SECONDS) : null, openComments: open, rendering };
  }));
  return cards.sort((a, b) => b.updated - a.updated);
}

export async function appProjects(userId: string, i: { offset?: number; limit?: number; query?: string; folderId?: string }): Promise<AppProjectsPage> {
  const folder = i.folderId ? await prisma.folder.findFirst({ where: { id: i.folderId, userId }, select: { id: true, name: true } }) : null;
  if (i.folderId && !folder) throw notFound("That project is gone, or is not yours.");
  const where = { userId, deletedAt: null, ...(folder ? { folderId: folder.id } : {}), ...(i.query?.trim() ? { name: { contains: i.query.trim(), mode: "insensitive" as const } } : {}) };
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
    id: p.id, name: p.name, folder: p.folder.name, folderId: p.folderId, aspect: p.aspect, status: p.status, version: p.currentVersion, updated: p.updatedAt.getTime(),
    seconds: p.outputSeconds || null, thumb: p.video.thumbKey ? await signGet(p.video.thumbKey, LINK_SECONDS) : null,
    previewVersion: lastPreview.get(p.id) ?? null, rendering: busy.has(p.id), openComments: open.get(p.id) ?? 0,
  })));
  // The first page of all edits also brings the projects, for the app's first page.
  const folders = !folder && offset === 0 && !i.query?.trim() ? await appFolders(userId) : undefined;
  return { projects, total, offset, ...(folders ? { folders } : {}), folder };
}

export async function appProject(userId: string, projectId: string, renderId?: string): Promise<AppProjectView> {
  const p = await getOwnedProject(userId, projectId);
  const [folder, user, latest, done, live, failed, notes, client, all] = await Promise.all([
    prisma.folder.findUnique({ where: { id: p.folderId }, select: { name: true } }),
    prisma.user.findUnique({ where: { id: userId }, select: { name: true } }),
    prisma.projectVersion.findFirst({ where: { projectId: p.id }, orderBy: { v: "desc" }, select: { v: true } }),
    prisma.render.findFirst({ where: { projectId: p.id, kind: "preview", status: "done", outputKey: { not: null } }, orderBy: { createdAt: "desc" } }),
    prisma.render.findFirst({ where: { projectId: p.id, kind: { in: ["preview", "final"] }, status: { in: ["queued", "running"] }, createdAt: { gt: new Date(Date.now() - 3 * 3600_000) } }, orderBy: { createdAt: "desc" } }),
    prisma.render.findFirst({ where: { projectId: p.id, kind: "preview", status: "failed" }, orderBy: { createdAt: "desc" } }),
    prisma.projectComment.findMany({ where: { projectId: p.id }, orderBy: { createdAt: "asc" }, take: 300 }),
    prisma.reviewComment.findMany({ where: clientCommentsWhere(p), orderBy: { createdAt: "asc" }, take: 300 }),
    prisma.render.findMany({ where: { projectId: p.id, status: "done", outputKey: { not: null } }, orderBy: { createdAt: "desc" }, take: 120 }),
  ]);
  const st = live ? await renderStatus(live) : null;
  const mac = await macStatus(userId);
  // The versions to pick from: the newest render of each version and kind.
  const seen = new Set<string>();
  const versions = all.filter((r) => { const k = `${r.kind}:${r.version}`; if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 40);
  // Watching: the render picked (one of this edit's), else the latest preview, else the latest final.
  const shown = (renderId && all.find((r) => r.id === renderId)) || done || all.find((r) => r.kind === "final") || null;
  const res = shown ? await renderResult(shown) : null;
  const version = latest?.v ?? p.currentVersion;
  const comments: AppComment[] = [
    ...(await Promise.all(notes.map(async (n) => ({ id: n.id, time: n.time, text: n.text, author: user?.name || "You", mine: true, resolved: n.resolved, at: n.createdAt.getTime(), edited: !!n.editedAt, renderId: n.renderId, ...(await commentMedia(n)) })))),
    ...client.map((c) => ({ id: c.id, time: c.time, text: c.text, author: c.author, mine: false, resolved: c.resolved, at: c.createdAt.getTime(), edited: false, renderId: null, drawing: null, images: [] })),
  ].sort((a, b) => a.time - b.time || a.at - b.at);
  return {
    project: { id: p.id, name: p.name, folder: folder?.name ?? "", folderId: p.folderId, aspect: p.aspect, status: p.status, version, updated: p.updatedAt.getTime(), seconds: p.outputSeconds || null, editorUrl: WEB() ? `${WEB()}/editor/${p.id}` : null },
    preview: shown?.outputKey && res ? { renderId: shown.id, version: shown.version, kind: shown.kind === "final" ? "final" : "preview", url: await signGet(shown.outputKey, LINK_SECONDS, { contentType: "video/mp4" }), download: res.downloadUrl!, fileName: res.fileName, seconds: shown.seconds, quality: shown.quality ?? (shown.kind === "final" ? "1080p" : "540p"), at: shown.createdAt.getTime(), where: whereShort(renderWhere(shown), shown.kind) } : null,
    versions: versions.map((r) => ({ renderId: r.id, version: r.version, kind: r.kind === "final" ? "final" as const : "preview" as const, quality: r.quality ?? (r.kind === "final" ? "1080p" : "540p"), at: r.createdAt.getTime() })),
    rendering: live && st ? { renderId: live.id, version: live.version, percent: Math.round(st.percent ?? 0), step: st.steps[st.step] ?? null, etaSec: st.etaSec, queued: st.status === "queued", kind: live.kind === "final" ? "final" : "preview", where: whereShort(st.where, live.kind) } : null,
    mac: { online: mac.online, device: mac.device, renders: !!mac.renders },
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
function openText(page: AppProjectsPage | null, open: AppProjectView | null): string {
  const nf = page?.folders?.length ?? 0;
  if (!open) return `Showing the Rendrr app: ${nf} ${nf === 1 ? "project" : "projects"}, ${page?.total ?? 0} ${page?.total === 1 ? "edit" : "edits"} (the user opens a project to see its videos). Newest: ${(page?.projects ?? []).slice(0, 5).map((p) => `${p.name} (${p.id}, v${p.version}${p.openComments ? `, ${p.openComments} open comments` : ""})`).join("; ") || "none"}.`;
  const o = open.comments.filter((c) => !c.resolved).length;
  return `Showing "${open.project.name}" (${open.project.id}) in the Rendrr app, v${open.project.version}; ${open.preview ? `preview v${open.preview.version}` : "no preview yet"}${open.rendering ? `, rendering ${open.rendering.kind === "final" ? "the final of " : ""}v${open.rendering.version} (${open.rendering.percent}%) on Rendrr's cloud server` : ""}; ${o} open ${o === 1 ? "comment" : "comments"} (get_comments reads them). The Rendrr Mac app is ${open.mac?.online ? `open${open.mac.device ? ` on "${open.mac.device}"` : ""}: finals go to that Mac's Downloads` : "not open: finals go to Google Drive or a download"}.`;
}

/**
 * The app with the user's edits, or one edit open (projectId): then only that edit and its preview are sent, not the
 * list and its picture links (the app loads the list when the user goes back to it).
 */
export async function openProjects(c: ToolCtx, i: { projectId?: string; folderId?: string }): Promise<ToolOut> {
  // The AI often has a project (folder) where an edit is meant, or a name: whatever it gives opens what it names,
  // and an id that names nothing shows the list with a line saying so (the call never fails on it).
  const asked = (i.projectId || i.folderId || "").trim();
  let note = "";
  if (asked) {
    const named = { equals: asked, mode: "insensitive" as const };
    const edit = !i.folderId ? await prisma.project.findFirst({ where: { userId: c.userId, deletedAt: null, OR: [{ id: asked }, { name: named }] }, orderBy: { updatedAt: "desc" }, select: { id: true } }) : null;
    if (edit) {
      const open = await appProject(c.userId, edit.id);
      const data: AppOpen = { open, webUrl: WEB() };
      return { text: openText(null, open), data };
    }
    const folder = await prisma.folder.findFirst({ where: { userId: c.userId, OR: [{ id: asked }, { name: named }] }, orderBy: { createdAt: "desc" }, select: { id: true } });
    if (folder) {
      const page = await appProjects(c.userId, { folderId: folder.id });
      const data: AppOpen = { ...page, open: null, webUrl: WEB() };
      return { text: folderText(page), data };
    }
    note = ` No edit or project is called "${asked.slice(0, 80)}", so the list is shown (list_projects has the ids).`;
  }
  const page = await appProjects(c.userId, {});
  const data: AppOpen = { ...page, open: null, webUrl: WEB() };
  return { text: openText(page, null) + note, data };
}

/** The line for the AI when one project (folder) is open in the app: its edits. */
function folderText(page: AppProjectsPage): string {
  const f = page.folder!;
  return `Showing the project "${f.name}" (${f.id}) in the Rendrr app: ${page.total} ${page.total === 1 ? "edit" : "edits"}. ${page.projects.slice(0, 5).map((p) => `${p.name} (${p.id}, v${p.version}${p.openComments ? `, ${p.openComments} open comments` : ""})`).join("; ") || "No edits yet."}`;
}

export const APP_HANDLERS: Record<string, (c: ToolCtx, input: any) => Promise<ToolOut>> = {
  async app_list_projects(c, i) {
    const page = await appProjects(c.userId, i);
    return { text: `${page.projects.length} of ${page.total} edits.`, data: page };
  },
  async app_get_samples(c, i) {
    const v = await samplesView(c.userId, i.renderId);
    return { text: `Samples of "${v.project.name}" v${v.version}: ${v.status}.`, data: v };
  },
  async app_get_project(c, i) {
    const view = await appProject(c.userId, i.projectId, i.renderId);
    return { text: `"${view.project.name}" v${view.project.version}.`, data: view };
  },
  async app_rename_project(c, i) {
    const p = await getOwnedProject(c.userId, i.projectId);
    if (i.name !== p.name) await applyTimelineChange(p.id, { op: "rename", name: i.name }, { kind: "user", userId: c.userId });
    return { text: `Renamed to "${i.name}".`, data: await appProject(c.userId, p.id) };
  },
  async app_add_comment(c, i) {
    const p = await getOwnedProject(c.userId, i.projectId);
    await addNote(c.userId, p.id, i);
    return { text: "Comment added.", data: await appProject(c.userId, p.id) };
  },
  async app_edit_comment(c, i) {
    const p = await getOwnedProject(c.userId, i.projectId);
    await editNote(c.userId, i.commentId, i);
    return { text: "Comment changed.", data: await appProject(c.userId, p.id) };
  },
  async app_delete_comment(c, i) {
    const p = await getOwnedProject(c.userId, i.projectId);
    await deleteComment(c.userId, i.commentId);
    return { text: "Comment deleted.", data: await appProject(c.userId, p.id) };
  },
  async app_resolve_comment(c, i) {
    const p = await getOwnedProject(c.userId, i.projectId);
    await setResolved(c.userId, i.commentId, i.resolved !== false);
    return { text: i.resolved === false ? "Comment opened again." : "Comment resolved.", data: await appProject(c.userId, p.id) };
  },
  // Share: the review link for the version being watched (one made before and still good, else a new one).
  async app_share_link(c, i) {
    const now = new Date();
    // A whole project folder: its link (made before and still good, else a new one) shows every edit in it.
    if (i.folderId) {
      const f = await prisma.folder.findUnique({ where: { id: i.folderId } });
      if (!f || f.userId !== c.userId) throw notFound("That project is gone, or is not yours.");
      const had = await prisma.review.findFirst({ where: { userId: c.userId, folderId: f.id, passwordHash: null, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] }, orderBy: { createdAt: "desc" } });
      const r = had ?? (await prisma.review.findUniqueOrThrow({ where: { token: (await createReviewLink(c.userId, { folderId: f.id })).token } }));
      const edits = await prisma.project.count({ where: { folderId: f.id, deletedAt: null } });
      const url = `${WEB() ?? ""}/review/${r.token}`;
      return { text: `Review link for ${f.name} (${edits} edits): ${url}`, data: { url, folder: { id: f.id, name: f.name }, edits, created: !had, expires: r.expiresAt ? r.expiresAt.getTime() : null, allowDownload: r.allowDownload } };
    }
    if (!i.projectId) throw new AppError("Pick an edit or a project to share.", 400);
    const p = await getOwnedProject(c.userId, i.projectId);
    const had = await prisma.review.findFirst({ where: { userId: c.userId, projectId: p.id, passwordHash: null, ...(i.version ? { version: i.version } : {}), OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] }, orderBy: { createdAt: "desc" } });
    const r = had ?? (await prisma.review.findUniqueOrThrow({ where: { token: (await createReviewLink(c.userId, { projectId: p.id, ...(i.version ? { version: i.version } : {}) })).token } }));
    const url = `${WEB() ?? ""}/review/${r.token}`;
    return { text: `Review link: ${url}`, data: { url, version: r.version, created: !had, expires: r.expiresAt ? r.expiresAt.getTime() : null, allowDownload: r.allowDownload } };
  },
  async app_render_preview(c, i) {
    await startRender(c.userId, i.projectId, "preview");
    return { text: "Rendering a preview.", data: await appProject(c.userId, i.projectId) };
  },
};
