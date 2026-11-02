// Rendrr MCP server: one URL for everyone, OAuth login through Clerk (DCR/CIMD), Streamable HTTP.
// Every tool call is forwarded to the API server with the Clerk user it verified; the API does the work.
import { clerkClient, clerkMiddleware, getAuth } from "@clerk/express";
import { authServerMetadataHandlerClerk, protectedResourceHandlerClerk } from "@clerk/mcp-tools/express";
import { verifyClerkToken } from "@clerk/mcp-tools/server";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { MCP_RATE_LIMIT_PER_MIN } from "@rendrr/shared";
import express, { type NextFunction, type Request, type Response } from "express";
import { buildServer, type Who } from "./build";
import { internalSecret } from "./secret";

const API = (process.env.API_INTERNAL_URL || process.env.PUBLIC_API_URL || "http://localhost:4000").replace(/\/$/, "");
const SECRET = internalSecret();
const WEB = (process.env.PUBLIC_WEB_URL || "").replace(/\/$/, "");
if (!SECRET) console.warn("[mcp] neither INTERNAL_API_SECRET nor CLERK_SECRET_KEY is set: tool calls will be refused by the API");
if (!process.env.CLERK_SECRET_KEY || !process.env.CLERK_PUBLISHABLE_KEY) console.warn("[mcp] CLERK keys are not set: logins will fail");

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

// ---------------- HTTP ----------------
const app = express();
app.set("trust proxy", true);
app.use(express.json({ limit: "8mb" })); // a create_graphic call carries up to 1 MB of code; a comment from the app up to 4 pictures
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

// Same checks as Clerk's mcpAuthClerk, but every failure is a 401. (mcpAuthClerk does not await its own work, so a
// malformed "Authorization: Bearer" header became an unhandled rejection that stopped the whole server.)
function requireAuth(req: Request, res: Response, next: NextFunction) {
  const deny = () => {
    res.status(401).set({ "WWW-Authenticate": `Bearer resource_metadata=${req.protocol}://${req.get("host")}/.well-known/oauth-protected-resource${req.originalUrl}` }).json({ error: "Unauthorized" });
  };
  try {
    const m = /^Bearer ([A-Za-z0-9._~+/=-]+)$/.exec(String(req.headers.authorization || ""));
    if (!m) return deny();
    const info = verifyClerkToken(getAuth(req, { acceptsToken: "oauth_token" }), m[1]);
    if (!info) return deny();
    (req as Request & { auth?: AuthInfo }).auth = info;
    next();
  } catch (e) {
    console.error("[mcp] auth check failed:", (e as Error).message);
    deny();
  }
}

app.post("/mcp", requireAuth, rateLimit, async (req, res) => {
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

// A stray promise must never take the connector down for everyone.
process.on("unhandledRejection", (e) => console.error("[mcp] unhandled rejection:", (e as Error)?.message || e));

const port = Number(process.env.PORT || 4100);
const host = process.env.HOST || "::";
const srv = app.listen(port, host, () => console.log(`[mcp] listening on ${port}`));
srv.on("error", (e: NodeJS.ErrnoException) => {
  if (e.code === "EAFNOSUPPORT") app.listen(port, "0.0.0.0", () => console.log(`[mcp] listening on ${port} (IPv4)`));
  else throw e;
});
