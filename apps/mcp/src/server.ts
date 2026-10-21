// Rendrr MCP server: one URL for everyone, OAuth login through Clerk (DCR/CIMD), Streamable HTTP.
// Every tool call is forwarded to the API server with the Clerk user it verified; the API does the work.
import { clerkClient, clerkMiddleware } from "@clerk/express";
import { authServerMetadataHandlerClerk, mcpAuthClerk, protectedResourceHandlerClerk } from "@clerk/mcp-tools/express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { HOW_TO_EDIT, MCP_RATE_LIMIT_PER_MIN, MCP_TOOLS } from "@rendrr/shared";
import express, { type NextFunction, type Request, type Response } from "express";
import { z } from "zod";

const API = (process.env.API_INTERNAL_URL || process.env.PUBLIC_API_URL || "http://localhost:4000").replace(/\/$/, "");
const SECRET = process.env.INTERNAL_API_SECRET || "";
const WEB = (process.env.PUBLIC_WEB_URL || "").replace(/\/$/, "");
if (!SECRET) console.warn("[mcp] INTERNAL_API_SECRET is not set: tool calls will be refused by the API");
if (!process.env.CLERK_SECRET_KEY || !process.env.CLERK_PUBLISHABLE_KEY) console.warn("[mcp] CLERK keys are not set: logins will fail");

type Who = { clerkId: string; kind: "claude" | "chatgpt"; name: string };

// ---------------- which AI is calling ----------------
const clientNames = new Map<string, { name: string; at: number }>();
async function oauthClientName(clientId: string): Promise<string | null> {
  const hit = clientNames.get("oa:" + clientId);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.name;
  try {
    const list = await clerkClient.oauthApplications.list({ limit: 200 } as never);
    const apps = (list as unknown as { data: { clientId: string; name: string }[] }).data || [];
    for (const a of apps) clientNames.set("oa:" + a.clientId, { name: a.name, at: Date.now() });
    return apps.find((a) => a.clientId === clientId)?.name ?? null;
  } catch { return null; }
}
async function who(req: Request): Promise<Who> {
  const auth = (req as Request & { auth?: AuthInfo }).auth!;
  const clerkId = String((auth.extra as { userId?: string })?.userId || "");
  const key = `${clerkId}:${auth.clientId}`;
  const body = req.body as { method?: string; params?: { clientInfo?: { name?: string } } } | undefined;
  if (body?.method === "initialize" && body.params?.clientInfo?.name) clientNames.set(key, { name: body.params.clientInfo.name, at: Date.now() });
  const name = clientNames.get(key)?.name || (await oauthClientName(auth.clientId)) || String(req.headers["user-agent"] || "AI").slice(0, 60);
  const kind = /openai|chatgpt|gpt/i.test(name) ? "chatgpt" : "claude";
  const display = /claude|anthropic/i.test(name) ? "Claude" : kind === "chatgpt" ? "ChatGPT" : name;
  return { clerkId, kind, name: display };
}

// ---------------- forwarding to the API ----------------
type ToolOut = { text: string; images?: string[] };
async function callApi(w: Who, path: string, body?: unknown, method = "POST"): Promise<{ ok: boolean; json: any }> {
  const r = await fetch(API + path, {
    method,
    headers: { "x-internal-secret": SECRET, "x-rendrr-clerk-id": w.clerkId, "x-rendrr-ai": w.kind, "x-rendrr-ai-name": w.name, "content-type": "application/json" },
    body: method === "GET" ? undefined : JSON.stringify(body ?? {}),
  }).catch(() => null);
  if (!r) return { ok: false, json: { error: { message: "Rendrr's server did not answer. Try again in a moment." } } };
  return { ok: r.ok, json: await r.json().catch(() => ({})) };
}

async function imageContent(urls: string[] = []) {
  const out: { type: "image"; data: string; mimeType: string }[] = [];
  for (const u of urls.slice(0, 5)) {
    try {
      const r = await fetch(u);
      if (!r.ok) continue;
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length > 900_000) continue;
      out.push({ type: "image", data: buf.toString("base64"), mimeType: r.headers.get("content-type") || "image/jpeg" });
    } catch { /* skip */ }
  }
  return out;
}

function buildServer(w: Who) {
  const server = new McpServer({ name: "rendrr", version: "1.0.0", title: "Rendrr" }, {
    instructions: "Rendrr edits video. You decide the edit with small instructions; Rendrr renders. Start with list_footage and read rendrr://how-to-edit. All clip times are seconds in the ORIGINAL footage.",
  });

  for (const def of MCP_TOOLS) {
    server.registerTool(def.name, {
      title: def.title,
      description: def.description,
      inputSchema: def.input.shape,
      annotations: { readOnlyHint: !def.write && !def.long, destructiveHint: false, openWorldHint: false },
    }, async (args: Record<string, unknown>, extra) => {
      // Long tools (renders, graphics) keep the client's timeout alive with progress notifications.
      const token = extra?._meta?.progressToken;
      let n = 0;
      const tick = token != null ? setInterval(() => { n++; extra.sendNotification({ method: "notifications/progress", params: { progressToken: token, progress: n, message: "Still working…" } }).catch(() => {}); }, 5000) : null;
      try {
        const r = await callApi(w, `/internal/tools/${def.name}`, args);
        if (!r.ok) return { content: [{ type: "text" as const, text: r.json?.error?.message || "That did not work. Try again." }], isError: true };
        const out = r.json as ToolOut;
        return { content: [{ type: "text" as const, text: out.text }, ...(await imageContent(out.images))] };
      } finally {
        if (tick) clearInterval(tick);
      }
    });
  }

  server.registerResource("styles", "rendrr://styles", { title: "Style packs", description: "Every style pack with its rules, as text and machine rules.", mimeType: "text/markdown" }, async (uri) => {
    const r = await callApi(w, "/internal/resources/styles", undefined, "GET");
    return { contents: [{ uri: uri.href, mimeType: "text/markdown", text: r.ok ? r.json.text : "Could not load the styles right now." }] };
  });
  server.registerResource("how-to-edit", "rendrr://how-to-edit", { title: "How to edit with Rendrr", description: "A short guide: read footage, read style, plan the hook, cut, caption, render a preview, check frames, fix, hand off.", mimeType: "text/markdown" }, async (uri) => ({
    contents: [{ uri: uri.href, mimeType: "text/markdown", text: HOW_TO_EDIT }],
  }));

  server.registerPrompt("edit-footage", {
    title: "Edit footage",
    description: "Walk through a first pass of an edit: read the footage and style, plan the hook, cut, caption, render a preview and check it.",
    argsSchema: { videoId: z.string().describe("Footage id from list_footage"), styleId: z.string().describe("Style id from list_styles, for example s1") },
  }, ({ videoId, styleId }) => ({
    messages: [{ role: "user", content: { type: "text", text:
      `Edit my footage ${videoId} in style ${styleId} with Rendrr.\n\n` +
      `1. get_footage("${videoId}") and get_style("${styleId}"). Tell me in two lines what the video is about and what the strongest hook is.\n` +
      `2. create_project with videoId ${videoId} and styleId ${styleId}, then apply_style.\n` +
      `3. Cut so the first 3 seconds are the hook. Remove rambling with cut_words (use detail "words" for word ids). Keep sentences whole.\n` +
      `4. Fix any caption wording with edit_caption. Add zooms on the key lines.\n` +
      `5. render_preview, then get_preview_frames. Check framing, captions and the opening. Fix and render again if needed.\n` +
      `6. Give me the preview link and a short list of what you did. Ask before rendering the final.\n\nGuide: rendrr://how-to-edit` } }],
  }));
  return server;
}

// ---------------- HTTP ----------------
const app = express();
app.set("trust proxy", true);
app.use(express.json({ limit: "1mb" }));
app.use(clerkMiddleware());

const prm = protectedResourceHandlerClerk({ scopes_supported: ["openid", "profile", "email"], resource_name: "Rendrr" });
app.get("/.well-known/oauth-protected-resource", prm);
app.get("/.well-known/oauth-protected-resource/mcp", prm);
app.get("/.well-known/oauth-authorization-server", authServerMetadataHandlerClerk);
app.get("/health", (_req, res) => { res.json({ ok: true, service: "rendrr-mcp", api: API.replace(/\/\/.*@/, "//") }); });
app.get("/", (req, res) => {
  const url = `${req.protocol}://${req.get("host")}/mcp`;
  res.type("text/html").send(`<!doctype html><meta charset=utf8><title>Rendrr MCP</title><body style="font:15px system-ui;padding:40px;max-width:640px;line-height:1.6"><h1>Rendrr for Claude and ChatGPT</h1><p>Add this URL as a custom connector:</p><pre style="background:#f4f4f5;padding:12px;border-radius:8px">${url}</pre><p>Claude Code: <code>claude mcp add --transport http rendrr ${url}</code></p>${WEB ? `<p><a href="${WEB}/connect">Open Rendrr</a></p>` : ""}`);
});

// Per user: 120 tool calls a minute.
const hits = new Map<string, number[]>();
function rateLimit(req: Request, res: Response, next: NextFunction) {
  const auth = (req as Request & { auth?: AuthInfo }).auth;
  const key = String((auth?.extra as { userId?: string })?.userId || req.ip);
  const now = Date.now();
  const list = (hits.get(key) || []).filter((t) => now - t < 60_000);
  const isCall = (req.body as { method?: string })?.method === "tools/call";
  if (isCall && list.length >= MCP_RATE_LIMIT_PER_MIN) {
    res.status(429).json({ jsonrpc: "2.0", error: { code: -32000, message: "Too many Rendrr tool calls. Wait a minute and try again." }, id: (req.body as { id?: unknown })?.id ?? null });
    return;
  }
  if (isCall) list.push(now);
  hits.set(key, list);
  next();
}
setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (!v.some((t) => now - t < 60_000)) hits.delete(k); }, 60_000).unref();

app.post("/mcp", mcpAuthClerk, rateLimit, async (req, res) => {
  try {
    const w = await who(req);
    if (!w.clerkId) { res.status(401).json({ error: "Unauthorized" }); return; }
    const server = buildServer(w);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => { transport.close().catch(() => {}); server.close().catch(() => {}); });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (e) {
    console.error("[mcp] request failed:", (e as Error).message);
    if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Rendrr hit a problem. Try again." }, id: null });
  }
});
// Stateless server: no server-initiated streams or sessions to delete.
app.get("/mcp", (_req, res) => { res.status(405).set("Allow", "POST").json({ jsonrpc: "2.0", error: { code: -32000, message: "Use POST." }, id: null }); });
app.delete("/mcp", (_req, res) => { res.status(405).set("Allow", "POST").end(); });

const port = Number(process.env.PORT || 4100);
const host = process.env.HOST || "::";
const srv = app.listen(port, host, () => console.log(`[mcp] listening on ${port}`));
srv.on("error", (e: NodeJS.ErrnoException) => {
  if (e.code === "EAFNOSUPPORT") app.listen(port, "0.0.0.0", () => console.log(`[mcp] listening on ${port} (IPv4)`));
  else throw e;
});
