// The editor's AI tab: what a connected AI (Claude or ChatGPT through the connector) did to this edit, with the
// notes it left for the user. Read only: Rendrr runs no AI of its own, and the user does not chat here.
import { prisma, type AiAction, type AiChatMessage } from "@rendrr/db";

type ChatOut = { id: string; role: "user" | "ai"; ai?: string; text: string; workflow?: string[]; changed?: boolean; at: number };

export function chatOut(m: AiChatMessage): ChatOut {
  return m.role === "user"
    ? { id: m.id, role: "user", text: m.text, at: m.createdAt.getTime() }
    : { id: m.id, role: "ai", ai: m.ai || "Claude", text: m.text, workflow: (m.workflow as string[]) || [], changed: m.changed, at: m.createdAt.getTime() };
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * Connector changes that have no message of their own (single-step tools from before apply_edits, undo), grouped
 * into one message per sitting. apply_edits leaves its own message with the steps and the AI's note.
 */
function connectorMessages(actions: AiAction[]): ChatOut[] {
  const out: (ChatOut & { last: number })[] = [];
  for (const a of [...actions].sort((x, y) => x.createdAt.getTime() - y.createdAt.getTime())) {
    const t = a.createdAt.getTime();
    const prev = out[out.length - 1];
    if (prev && prev.ai === a.ai && t - prev.last < 15 * 60_000) { prev.workflow!.push(cap(a.text)); prev.last = t; prev.at = t; continue; }
    out.push({ id: "act-" + a.id, role: "ai", ai: a.ai, text: "", workflow: [cap(a.text)], changed: true, at: t, last: t });
  }
  return out.map(({ last: _l, ...m }) => ({ ...m, text: `Made ${m.workflow!.length === 1 ? "a change" : m.workflow!.length + " changes"} through the ${m.ai} connector.` }));
}

/** The editor's AI tab: messages from connected AIs plus their other changes, oldest first. */
export async function projectChat(userId: string, projectId: string): Promise<ChatOut[]> {
  const [msgs, actions] = await Promise.all([
    prisma.aiChatMessage.findMany({ where: { projectId, userId }, orderBy: { createdAt: "asc" }, take: 200 }),
    prisma.aiAction.findMany({ where: { projectId, userId, ai: { in: ["Claude", "ChatGPT"] }, via: null, toolName: { not: "apply_edits" } }, orderBy: { createdAt: "desc" }, take: 100 }),
  ]);
  return [...msgs.map(chatOut), ...connectorMessages(actions)].sort((a, b) => a.at - b.at);
}
