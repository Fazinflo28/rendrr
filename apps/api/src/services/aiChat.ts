// The AI chat inside the editor. Claude edits the open project with the same tools the AI connector (MCP) has,
// run on this server; every change goes through applyTimelineChange, so it is a new version the user can undo.
// Without ANTHROPIC_API_KEY the chat answers with a short note on how to turn it on.
import Anthropic from "@anthropic-ai/sdk";
import { betaTool } from "@anthropic-ai/sdk/helpers/beta/json-schema";
import { AppError, env, toFriendly, usage } from "@rendrr/core";
import { prisma, type AiAction, type AiChatMessage } from "@rendrr/db";
import { MCP_TOOLS } from "@rendrr/shared";
import { zodToJsonSchema } from "zod-to-json-schema";
import { clip, TOOL_HANDLERS, type ToolCtx } from "../tools";
import { getOwnedProject } from "./projects";

const MODEL = "claude-opus-5-5";
const AI_NAME = "Claude";
const HISTORY = 20; // earlier chat messages sent along, oldest dropped first
// Editing tools only: no renders (the editor makes previews), no new projects, no review links.
const CHAT_TOOLS = [
  "get_project", "get_footage", "list_footage", "list_styles", "get_style", "list_graphics", "get_comments",
  "apply_style", "cut_words", "restore_words", "cut_silences", "remove_fillers", "set_clips", "split_clip", "trim_clip", "delete_clip",
  "add_zoom", "add_broll", "set_captions", "edit_caption", "add_music", "add_graphic", "set_aspect", "rename_project", "undo", "resolve_comment",
];

const SYSTEM = `You are the editing assistant inside Rendrr, a video editor. The user has one edit open in the editor and asks you, in plain words, for changes to it.

How to work:
- Make the change with the tools. Every write tool saves a new version, and the user can undo it.
- The tools always work on the open edit; you never pass a project id.
- Start with get_project to see the clips, and get_footage (detail "words" when you need word ids) before cutting words or placing things at a moment.
- Times in the tools are seconds in the ORIGINAL footage, not the edited output.
- Do only what was asked. If the request is unclear or the tools cannot do it, say so in one sentence and change nothing.
- Do not render. The editor makes its own previews.

Reply in one to three short, plain sentences that say what you changed. No lists, no markdown.`;

let client: Anthropic | null = null;
const anthropic = () => (client ??= new Anthropic({ apiKey: env().ANTHROPIC_API_KEY, timeout: 90_000, maxRetries: 2 }));

type ChatOut = { id: string; role: "user" | "ai"; ai?: string; text: string; workflow?: string[]; changed?: boolean; at: number };

export function chatOut(m: AiChatMessage): ChatOut {
  return m.role === "user"
    ? { id: m.id, role: "user", text: m.text, at: m.createdAt.getTime() }
    : { id: m.id, role: "ai", ai: m.ai || AI_NAME, text: m.text, workflow: (m.workflow as string[]) || [], changed: m.changed, at: m.createdAt.getTime() };
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Changes a connected AI (Claude or ChatGPT through the connector) made, grouped into one message per sitting. */
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

/** The editor's AI tab: chat messages plus what connected AIs did, oldest first. */
export async function projectChat(userId: string, projectId: string): Promise<ChatOut[]> {
  const [msgs, actions] = await Promise.all([
    prisma.aiChatMessage.findMany({ where: { projectId, userId }, orderBy: { createdAt: "asc" }, take: 200 }),
    prisma.aiAction.findMany({ where: { projectId, userId, ai: { in: ["Claude", "ChatGPT"] }, via: null }, orderBy: { createdAt: "desc" }, take: 100 }),
  ]);
  return [...msgs.map(chatOut), ...connectorMessages(actions)].sort((a, b) => a.at - b.at);
}

function toolSchema(name: string) {
  const def = MCP_TOOLS.find((t) => t.name === name)!;
  const scoped = "projectId" in def.input.shape;
  const shape = scoped ? def.input.omit({ projectId: true } as never) : def.input;
  const schema = zodToJsonSchema(shape, { target: "jsonSchema7", $refStrategy: "none" }) as Record<string, unknown>;
  delete schema.$schema;
  return { def, scoped, schema: { ...schema, type: "object" as const } };
}
const TOOL_SPECS = CHAT_TOOLS.map(toolSchema);

/** One line per tool call for the "Workflow" list under the reply. */
function stepLine(title: string, write: boolean | undefined, text: string) {
  const first = text.split("\n")[0].trim();
  if (write && first.startsWith("Done: ")) return cap(first.slice(6).replace(/\.$/, ""));
  if (write) return cap(first.replace(/\.$/, "")).slice(0, 200);
  return title;
}

function friendlyApiError(e: unknown): AppError {
  if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) return new AppError("The Anthropic key on the server was refused. Check ANTHROPIC_API_KEY.", 502, "ai-key");
  if (e instanceof Anthropic.RateLimitError) return new AppError("Claude is busy right now. Try again in a minute.", 503, "ai-busy");
  if (e instanceof Anthropic.APIConnectionTimeoutError) return new AppError("Claude took too long to answer. Try a smaller change.", 504, "ai-timeout");
  if (e instanceof Anthropic.APIError && e.status === 529) return new AppError("Claude is busy right now. Try again in a minute.", 503, "ai-busy");
  if (e instanceof Anthropic.APIError) return new AppError("Claude did not answer. Try again.", 502, "ai-error");
  return e instanceof AppError ? e : new AppError(toFriendly(e).message, toFriendly(e).status);
}

/** Sends one chat message. Returns [the user's message, the AI's reply], both saved (except the no-key note). */
export async function sendChat(userId: string, projectId: string, text: string): Promise<[ChatOut, ChatOut]> {
  const p = await getOwnedProject(userId, projectId);
  const ask = text.trim().slice(0, 4000);
  if (!ask) throw new AppError("Write what you want changed first.", 400);

  if (!env().ANTHROPIC_API_KEY) {
    const now = Date.now();
    return [
      { id: "u" + now, role: "user", text: ask, at: now },
      { id: "a" + now, role: "ai", ai: "Rendrr", text: "The AI chat is not switched on yet: it needs an Anthropic API key on the server (ANTHROPIC_API_KEY). Until then, connect Claude or ChatGPT on the Connect AI page and ask for edits there.", workflow: [], changed: false, at: now + 1 },
    ];
  }

  const ctx: ToolCtx = { userId, ai: "claude", aiName: AI_NAME, via: "chat" };
  const steps: string[] = [];
  const tools = TOOL_SPECS.map(({ def, scoped, schema }) => betaTool({
    name: def.name, description: def.description, inputSchema: schema,
    run: async (args) => {
      try {
        const input = def.input.parse(scoped ? { ...(args as object), projectId } : args);
        const out = await TOOL_HANDLERS[def.name](ctx, input);
        steps.push(stepLine(def.title, def.write, out.text));
        return clip(out.text);
      } catch (e) {
        return `Error: ${toFriendly(e).message}`;
      }
    },
  }));

  const earlier = await prisma.aiChatMessage.findMany({ where: { projectId, userId }, orderBy: { createdAt: "desc" }, take: HISTORY });
  const history = earlier.reverse().map((m) => ({ role: m.role === "user" ? ("user" as const) : ("assistant" as const), content: m.text }));
  while (history.length && history[0].role !== "user") history.shift();
  const v = await prisma.video.findUnique({ where: { id: p.videoId }, select: { id: true, name: true } });
  const where = `[Open edit: "${p.name}", version ${p.currentVersion}, footage ${v?.id} "${v?.name ?? ""}".]`;

  const t0 = Date.now();
  let final: Anthropic.Beta.BetaMessage;
  try {
    final = await anthropic().beta.messages.toolRunner({
      model: MODEL,
      max_tokens: 16000,
      output_config: { effort: env().AI_CHAT_EFFORT },
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      cache_control: { type: "ephemeral" },
      system: SYSTEM,
      tools,
      max_iterations: 16,
      messages: [...history, { role: "user", content: `${where}\n\n${ask}` }],
    });
  } catch (e) {
    await usage(userId, "ai_chat", 0, { ms: Date.now() - t0, ok: false, steps: steps.length, error: (e as Error).message?.slice(0, 200) });
    if (steps.length) throw new AppError(`Claude stopped part way (${steps.length} ${steps.length === 1 ? "step" : "steps"} done; they are in the version history). Try again.`, 502, "ai-partial");
    throw friendlyApiError(e);
  }

  const said = final.content.filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text").map((b) => b.text).join("\n").trim();
  const reply = final.stop_reason === "refusal" ? "I can't help with that request."
    : said || (final.stop_reason === "tool_use" ? `I stopped after ${steps.length} steps. Ask me to carry on.` : steps.length ? "Done." : "I did not change anything.");
  const after = await prisma.project.findUnique({ where: { id: projectId }, select: { currentVersion: true } });
  const changed = !!after && after.currentVersion !== p.currentVersion;
  await usage(userId, "ai_chat", 0, { ms: Date.now() - t0, ok: true, steps: steps.length, changed, stop: final.stop_reason, usage: final.usage });

  const [u, a] = await prisma.$transaction([
    prisma.aiChatMessage.create({ data: { projectId, userId, role: "user", text: ask, createdAt: new Date(t0) } }),
    prisma.aiChatMessage.create({ data: { projectId, userId, role: "ai", ai: AI_NAME, text: reply.slice(0, 4000), workflow: steps.slice(0, 60), changed } }),
  ]);
  return [chatOut(u), chatOut(a)];
}
