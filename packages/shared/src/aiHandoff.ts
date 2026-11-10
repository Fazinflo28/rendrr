// "Send to Claude" from the Rendrr app (web and Mac): the comments go to the AI the user connected.
// MCP cannot push into a chat, so the app opens the AI's chat with this message ready, and Rendrr also tells that AI
// on its next Rendrr tool call (see the API's handoff notice). The same words as the Claude card's button.

export type HandoffAi = "claude" | "chatgpt";

export const HANDOFF_AIS: Record<HandoffAi, { name: string; chat: string }> = {
  claude: { name: "Claude", chat: "https://claude.ai/new?q=" },
  chatgpt: { name: "ChatGPT", chat: "https://chatgpt.com/?q=" },
};

export const aiName = (ai: string | null | undefined) => (ai === "chatgpt" ? "ChatGPT" : "Claude");
export const isHandoffAi = (x: unknown): x is HandoffAi => x === "claude" || x === "chatgpt";

/** What a comment needs for the message: its time in the edit, words, and what else it carries. */
export type HandoffComment = { time: number; text: string; drawing?: unknown; images?: unknown[] | null };

/** A prefilled chat link stays short: at most this many comments are written out, each cut to COMMENT_CHARS. */
export const HANDOFF_LIST_MAX = 12;
const COMMENT_CHARS = 180;

const clock = (s: number) => {
  const t = Math.max(0, s || 0), m = Math.floor(t / 60), sec = Math.floor(t % 60);
  return `${m}:${String(sec).padStart(2, "0")}`;
};

const carries = (c: HandoffComment) => {
  const n = Array.isArray(c.images) ? c.images.length : 0;
  const w = [c.drawing ? "drawing" : "", n ? `${n} ${n === 1 ? "picture" : "pictures"}` : ""].filter(Boolean);
  return w.length ? ` (${w.join(", ")})` : "";
};

/** The message for the AI. `version`: the preview the comments were made on, when there is one. */
export function handoffPrompt(p: { name: string; projectId: string; comments: HandoffComment[]; version?: number | null }): string {
  const cs = p.comments, n = cs.length;
  const lines = cs.slice(0, HANDOFF_LIST_MAX).map((c) => {
    const t = (c.text || "").replace(/\s+/g, " ").trim();
    return `- ${clock(c.time)} ${t ? (t.length > COMMENT_CHARS ? t.slice(0, COMMENT_CHARS) + "…" : t) : "(no words)"}${carries(c)}`;
  });
  if (n > HANDOFF_LIST_MAX) lines.push(`- and ${n - HANDOFF_LIST_MAX} more`);
  const media = cs.some((c) => c.drawing || (Array.isArray(c.images) && c.images.length));
  const name = (p.name || "Untitled").replace(/"/g, "'").slice(0, 80);
  return `Please work through the ${n} open ${n === 1 ? "comment" : "comments"} on my Rendrr edit "${name}" (project ${p.projectId})${p.version ? `, made on preview v${p.version}` : ""}:\n${lines.join("\n")}\n\n` +
    `Read them with get_comments${media ? " (images true shows the drawings and pictures)" : ""}, fix each one and the same kind of mistake everywhere in one apply_edits, check it with check_edit, render one preview, then resolve the comments you fixed.`;
}

/** The AI's chat with the message typed in. */
export function handoffUrl(ai: HandoffAi, prompt: string): string {
  return HANDOFF_AIS[ai].chat + encodeURIComponent(prompt);
}

/** Which AI the button sends to: the one the user picked before if still connected, else Claude if connected, else
 *  ChatGPT if connected, else null (nothing connected: the button leads to Connect AI). */
export function handoffTarget(connected: { claude?: boolean; chatgpt?: boolean }, last?: string | null): HandoffAi | null {
  if (isHandoffAi(last) && connected[last]) return last;
  if (connected.claude) return "claude";
  if (connected.chatgpt) return "chatgpt";
  return null;
}

/** Said on the comment: "Sent to Claude · 2m ago" is built by the app from this. */
export const sentLabel = (ai: string | null | undefined) => `Sent to ${aiName(ai)}`;
