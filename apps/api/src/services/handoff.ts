import { AppError } from "@rendrr/core";
import { prisma } from "@rendrr/db";
import { aiName, handoffPrompt, handoffUrl, isHandoffAi, type HandoffAi } from "@rendrr/shared";
import { getOwnedProject } from "./projects";

// "Send to Claude" in the Rendrr app (web and Mac). MCP cannot push into a chat, so the app opens the AI's chat with
// the message ready (handoffUrl), and the AI hears it from Rendrr too: once, on its next Rendrr tool call
// (handoffNotice), and in get_comments (sentLines), which marks it read.

const NOTICE_DAYS = 3; // an older send is not brought up any more
const ago = (d: Date) => {
  const m = Math.max(0, Math.round((Date.now() - d.getTime()) / 60_000));
  return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 48 * 60 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`;
};
const idsOf = (j: unknown): string[] => (Array.isArray(j) ? j.filter((x): x is string => typeof x === "string") : []);

/** The open comments on an edit (the client's, from review links, and the user's own notes), in video order. */
async function openComments(p: { id: string; folderId: string }) {
  const [cs, notes] = await Promise.all([
    prisma.reviewComment.findMany({ where: { resolved: false, review: { OR: [{ projectId: p.id }, { folderId: p.folderId }] }, OR: [{ projectId: null }, { projectId: p.id }] }, take: 200 }),
    prisma.projectComment.findMany({ where: { projectId: p.id, resolved: false }, take: 200 }),
  ]);
  return [...cs.map((c) => ({ id: c.id, time: c.time, text: c.text, at: c.createdAt })), ...notes.map((n) => ({ id: n.id, time: n.time, text: n.text, drawing: n.drawing, images: Array.isArray(n.images) ? (n.images as unknown[]) : null, at: n.createdAt }))]
    .sort((a, b) => a.time - b.time || a.at.getTime() - b.at.getTime());
}

/** Send the edit's open comments (or only `ids` of them) to Claude or ChatGPT. */
export async function sendComments(userId: string, projectId: string, ai: unknown, ids?: unknown) {
  if (!isHandoffAi(ai)) throw new AppError("Pick Claude or ChatGPT.", 400, "ai");
  const p = await getOwnedProject(userId, projectId);
  const want = Array.isArray(ids) && ids.length ? new Set(ids.map(String)) : null;
  const open = (await openComments(p)).filter((c) => !want || want.has(c.id));
  if (!open.length) throw new AppError("There are no open comments to send.", 409, "no-comments");
  const conn = await prisma.aiConnection.findUnique({ where: { userId_client: { userId, client: ai } } });
  const preview = await prisma.render.findFirst({ where: { projectId: p.id, kind: "preview", status: "done" }, orderBy: { createdAt: "desc" }, select: { version: true } });
  const h = await prisma.aiHandoff.create({ data: { userId, projectId: p.id, ai, commentIds: open.map((c) => c.id) } });
  const prompt = handoffPrompt({ name: p.name, projectId: p.id, comments: open, version: preview?.version });
  return { id: h.id, ai, name: aiName(ai), count: open.length, commentIds: open.map((c) => c.id), at: h.createdAt.getTime(), prompt, url: handoffUrl(ai, prompt),
    connected: !!conn && !conn.revokedAt };
}

/** The comments of an edit that were sent, with the newest send for each: { commentId: { to, at } }. */
export async function sentByComment(projectId: string): Promise<Record<string, { to: HandoffAi; at: number }>> {
  const hs = await prisma.aiHandoff.findMany({ where: { projectId }, orderBy: { createdAt: "asc" }, take: 100 });
  const out: Record<string, { to: HandoffAi; at: number }> = {};
  for (const h of hs) for (const id of idsOf(h.commentIds)) out[id] = { to: isHandoffAi(h.ai) ? h.ai : "claude", at: h.createdAt.getTime() };
  return out;
}

/** For get_comments: which of these comments the user sent from the app and not yet read; marks them read. */
export async function sentLines(userId: string, projectId: string, ai: string | null): Promise<string> {
  const hs = await prisma.aiHandoff.findMany({ where: { userId, projectId, seenAt: null }, orderBy: { createdAt: "desc" } });
  if (!hs.length) return "";
  await prisma.aiHandoff.updateMany({ where: { id: { in: hs.map((h) => h.id) } }, data: { seenAt: new Date() } });
  const ids = [...new Set(hs.flatMap((h) => idsOf(h.commentIds)))];
  const to = hs[0].ai === (ai || "claude") ? "you" : aiName(hs[0].ai);
  return `The user sent ${ids.length === 1 ? "this comment" : `these ${ids.length} comments`} to ${to} from the Rendrr app ${ago(hs[0].createdAt)}, to be fixed: ${ids.join(", ")}.`;
}

/** Said once, on this AI's next Rendrr tool call after a send (not for the edit get_comments just read). */
export async function handoffNotice(userId: string, ai: string | null): Promise<string> {
  const since = new Date(Date.now() - NOTICE_DAYS * 86_400_000);
  const hs = await prisma.aiHandoff.findMany({ where: { userId, ai: ai || "claude", noticedAt: null, seenAt: null, createdAt: { gte: since } }, orderBy: { createdAt: "desc" }, take: 5 });
  if (!hs.length) return "";
  const claimed = await prisma.aiHandoff.updateMany({ where: { id: { in: hs.map((h) => h.id) }, noticedAt: null }, data: { noticedAt: new Date() } });
  if (!claimed.count) return ""; // another call said it first
  const ps = await prisma.project.findMany({ where: { id: { in: [...new Set(hs.map((h) => h.projectId))] } }, select: { id: true, name: true } });
  const what = ps.map((p) => {
    const n = new Set(hs.filter((h) => h.projectId === p.id).flatMap((h) => idsOf(h.commentIds))).size;
    return `${n} ${n === 1 ? "comment" : "comments"} on "${p.name}" (project ${p.id})`;
  }).join("; ");
  return `From the Rendrr app: the user sent you ${what} ${ago(hs[0].createdAt)}. Tell them, and once this request is done read them with get_comments and fix them (one apply_edits, check_edit, one preview, then resolve_comment).`;
}

/** For get_project: a send from the app the AI has not read yet (get_comments reads it). */
export async function pendingLine(projectId: string): Promise<string> {
  const hs = await prisma.aiHandoff.findMany({ where: { projectId, seenAt: null }, orderBy: { createdAt: "desc" }, take: 20 });
  if (!hs.length) return "";
  const n = new Set(hs.flatMap((h) => idsOf(h.commentIds))).size;
  return `Sent from the Rendrr app: ${n} ${n === 1 ? "comment" : "comments"} to fix, ${ago(hs[0].createdAt)} (get_comments).`;
}
