// Database rows -> the exact shapes ui/rendrr-ui.html's fake api returned. Signed URLs only, never raw keys.
import { signGet } from "@rendrr/core";
import { commentMedia } from "./services/commentMedia";
import type { AiAction, Folder, GalleryItem, Project, ProjectComment, Review, ReviewComment, Style, User, Video } from "@rendrr/db";
import { DAY_MS, DRIVE_STEPS, fmtShortDate, fmtSize, LOCAL_STEPS, type ReferenceRef } from "@rendrr/shared";

const ms = (d: Date | null | undefined) => (d ? d.getTime() : null);
const num = (b: bigint | number | null | undefined) => (b == null ? null : Number(b));

export function stepInfo(v: Pick<Video, "source" | "status" | "step">) {
  const steps = v.source === "drive" ? DRIVE_STEPS : LOCAL_STEPS;
  const map: Record<string, number> = { linking: 0, preview: 1, previewing: 0, uploading: 1, paused: 0, processing: 2 + (v.step || 0) };
  const idx = map[v.status];
  if (idx == null) return {};
  return { steps: [...steps], idx: Math.min(idx, steps.length - 1), stepName: v.status === "paused" ? "Paused. Open this tab to continue" : steps[Math.min(idx, steps.length - 1)], total: steps.length };
}

export async function videoOut(v: Video) {
  const expires = ms(v.previewExpiresAt);
  return {
    id: v.id, name: v.name, seconds: Math.round(v.seconds * 100) / 100,
    size: fmtSize(v.originalSize ?? v.sizeBytes), orientation: v.orientation, date: v.createdAt.getTime(),
    status: v.status, step: v.step ?? undefined, progress: v.progress ?? undefined, error: v.error ?? undefined,
    art: v.art, source: v.source, sample: v.sample, kind: v.kind, driveFileId: v.driveFileId ?? undefined,
    originalName: v.originalName ?? undefined, originalSize: num(v.originalSize) ?? undefined,
    previewSize: fmtSize(v.previewSizeBytes), previewExpires: expires,
    previewDays: expires != null && v.status !== "expired" ? Math.max(0, Math.ceil((expires - Date.now()) / DAY_MS)) : v.status === "expired" ? 0 : null,
    width: v.width ?? undefined, height: v.height ?? undefined, fps: v.fps ?? undefined, hdr: v.hdr ?? undefined,
    thumb: v.thumbKey ? await signGet(v.thumbKey, 3600) : null,
    ...stepInfo(v),
  };
}

export function styleOut(s: Style) {
  return { id: s.id, name: s.name, type: s.type, vibe: s.vibe, ori: s.ori, platforms: s.platforms, captionLook: s.captionLook, cutPace: s.cutPace, captionRule: s.captionRule, zoomRules: s.zoomRules, musicVibe: s.musicVibe, art: s.art, rules: s.rules, mine: !!s.ownerId };
}

export function folderOut(f: Folder, extra: { count?: number; shares?: number } = {}) {
  return { id: f.id, name: f.name, workspace: f.workspace, cover: f.cover, members: f.members, updated: f.updatedAt.getTime(), ...extra };
}

export function projectOut(p: Project) {
  return { id: p.id, folderId: p.folderId, name: p.name, videoId: p.videoId, styleId: p.styleId, reference: (p.reference as ReferenceRef | null) ?? null, status: p.status, aspect: p.aspect, updated: p.updatedAt.getTime(), version: p.currentVersion, art: p.art, size: fmtSize(p.sizeBytes), seconds: p.outputSeconds || null };
}

export function commentOut(c: ReviewComment) {
  return { id: c.id, time: c.time, text: c.text, author: c.author, resolved: c.resolved, at: c.createdAt.getTime(), projectId: c.projectId ?? undefined };
}

/** The user's own note in the editor; same shape as a client comment, plus `mine`, and what the app in the chat can
 *  add to it (a drawing on the picture, pictures; edited). */
export async function noteOut(n: ProjectComment, author: string) {
  return { id: n.id, time: n.time, text: n.text, author: author || "You", mine: true, resolved: n.resolved, at: n.createdAt.getTime(), projectId: n.projectId, edited: !!n.editedAt, ...(await commentMedia(n)) };
}

export function activityOut(a: AiAction, project?: Project | null) {
  // Engine Part 6: tool names stay out of the user interface.
  return { id: a.id, projectId: a.projectId, ai: a.ai, text: a.text, at: a.createdAt.getTime(), undone: a.undone, ...(project ? { project: projectOut(project) } : {}) };
}

export async function brandLogo(u: Pick<User, "logoKey">) {
  return u.logoKey ? signGet(u.logoKey, 3600) : null;
}

/** Same shape as the UI's cloneReview(). `password` is true when one is set (the plain text is only returned once, at creation). */
export async function reviewOut(r: Review & { comments: ReviewComment[] }, ctx: { owner: Pick<User, "name" | "logoKey">; project?: Project | null; folder?: Folder | null; items?: Project[] }, plainPassword?: string | null) {
  const expired = !!(r.expiresAt && r.expiresAt.getTime() < Date.now());
  const items = ctx.items || [];
  return {
    token: r.token, projectId: r.projectId, folderId: r.folderId, version: r.version,
    status: expired ? "Expired" : "Active", views: r.views, approved: r.approved,
    password: plainPassword ?? (r.passwordHash ? true : null),
    expires: r.expiresLabel, allowDownload: r.allowDownload, showLogo: r.showLogo, created: r.createdAt.getTime(),
    comments: r.comments.map(commentOut).sort((a, b) => a.at - b.at),
    project: ctx.project ? projectOut(ctx.project) : items[0] ? projectOut(items[0]) : null,
    folder: ctx.folder ? folderOut(ctx.folder) : null,
    items: items.map(projectOut),
    logo: await brandLogo(ctx.owner), brand: ctx.owner.name,
  };
}

export function galleryOut(g: GalleryItem, me: string, liked: boolean, style: Style | undefined) {
  return {
    id: g.id, title: g.title, author: g.author, styleId: g.styleId, ori: g.ori, platforms: g.platforms,
    likes: g.likes, views: g.views, recreates: g.recreates, liked, mine: g.userId === me, allowRecreate: g.allowRecreate,
    at: g.createdAt.getTime(), projectId: g.projectId ?? undefined, style: style ? styleOut(style) : undefined,
  };
}

export async function userOut(u: User) {
  return { id: u.id, name: u.name, email: u.email, photo: u.photoKey ? await signGet(u.photoKey, 3600) : null, logo: u.logoKey ? await signGet(u.logoKey, 3600) : null, plan: u.plan };
}

export const shortDate = fmtShortDate;
