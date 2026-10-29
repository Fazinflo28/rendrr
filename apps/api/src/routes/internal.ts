import { AppError, toFriendly, usage } from "@rendrr/core";
import { prisma } from "@rendrr/db";
import { APP_TOOLS, MCP_TOOLS } from "@rendrr/shared";
import type { FastifyInstance } from "fastify";
import { authenticate } from "../auth";
import { clip, TOOL_HANDLERS } from "../tools";
import { APP_HANDLERS, appMediaOrigins } from "../services/claudeApp";

// MCP tool calls arrive here from the MCP server (shared secret + the Clerk user it verified).
export default async function internal(app: FastifyInstance) {
  app.register(async (a) => {
    a.addHook("preHandler", authenticate);
    a.addHook("preHandler", async (req) => {
      if (!req.headers["x-internal-secret"]) throw new AppError("Not found.", 404);
    });

    a.get("/internal/resources/styles", async (req) => {
      const ss = await prisma.style.findMany({ where: { OR: [{ ownerId: null }, { ownerId: req.user!.id }] }, orderBy: { sortOrder: "asc" } });
      return { text: "# Rendrr style packs\n\n" + ss.map((s) => `## ${s.name} (${s.id})\n${s.vibe}. Type ${s.type}. Shapes ${s.ori.join(", ")}. Best on ${s.platforms.join(", ")}.\n- Cut pace: ${s.cutPace}\n- Captions: ${s.captionRule} (look ${s.captionLook})\n- Zooms: ${s.zoomRules}\n- Music: ${s.musicVibe}\n- Machine rules: \`${JSON.stringify(s.rules)}\``).join("\n\n") };
    });

    // The Rendrr app in the chat: where its pictures and video come from (its content security policy).
    a.get("/internal/app-config", async () => ({ mediaOrigins: await appMediaOrigins() }));

    a.get("/internal/whoami", async (req) => ({ userId: req.user!.id, email: req.user!.email, name: req.user!.name, ai: req.ai }));

    a.post("/internal/tools/:name", async (req) => {
      const name = (req.params as { name: string }).name;
      // The AI's tools, and the ones only the Rendrr app in the chat calls.
      const def = MCP_TOOLS.find((t) => t.name === name) ?? APP_TOOLS.find((t) => t.name === name);
      const handler = TOOL_HANDLERS[name] ?? (def?.app ? APP_HANDLERS[name] : undefined);
      if (!def || !handler) throw new AppError(`There is no tool called ${name}.`, 404);
      const userId = req.user!.id;
      const client = req.ai || "claude";
      // Connect AI page: remember which AI is connected; refuse if the user turned it off.
      const conn = await prisma.aiConnection.upsert({
        where: { userId_client: { userId, client } },
        create: { userId, client, clientName: req.aiName || client },
        update: { lastSeenAt: new Date(), ...(req.aiName ? { clientName: req.aiName } : {}) },
      });
      if (conn.revokedAt) throw new AppError(`Rendrr access is turned off for ${client === "chatgpt" ? "ChatGPT" : "Claude"}. Turn it back on in Rendrr > Connect AI > Test connection.`, 403, "revoked");
      const input = def.input.parse(req.body ?? {});
      const t0 = Date.now();
      try {
        const out = await handler({ userId, loginId: req.loginId, ai: req.ai ?? null, aiName: req.aiName }, input);
        // The app polls while a preview renders: its reads are not logged as tool calls.
        if (def.app && !def.write) return { ...out, text: clip(out.text) };
        await usage(userId, "mcp_tool", 0, { tool: name, ai: req.aiName || client, ms: Date.now() - t0, ok: true });
        return { ...out, text: clip(out.text) }; // every answer stays under ~6k tokens
      } catch (e) {
        await usage(userId, "mcp_tool", 0, { tool: name, ai: req.aiName || client, ms: Date.now() - t0, ok: false, error: toFriendly(e).message.slice(0, 200) });
        throw e;
      }
    });
  });
}
