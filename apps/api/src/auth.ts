import { createClerkClient, verifyToken } from "@clerk/backend";
import { env, safeEqual, unauthorized, AppError } from "@rendrr/core";
import { prisma, type User } from "@rendrr/db";
import type { FastifyReply, FastifyRequest } from "fastify";

export type ReqUser = Pick<User, "id" | "clerkId" | "email" | "name">;
export type AiClient = "claude" | "chatgpt" | null;
declare module "fastify" {
  interface FastifyRequest { user?: ReqUser; ai?: AiClient; aiName?: string }
}

let clerkClient: ReturnType<typeof createClerkClient> | null = null;
export function clerk() {
  if (!clerkClient) clerkClient = createClerkClient({ secretKey: env().CLERK_SECRET_KEY, publishableKey: env().CLERK_PUBLISHABLE_KEY });
  return clerkClient;
}

const cache = new Map<string, { user: ReqUser; until: number }>();

/** Finds the Rendrr user for a Clerk user, creating it (and a first folder) on first sight. */
export async function ensureUser(clerkId: string): Promise<ReqUser> {
  const c = cache.get(clerkId);
  if (c && c.until > Date.now()) return c.user;
  let u = await prisma.user.findUnique({ where: { clerkId }, select: { id: true, clerkId: true, email: true, name: true } });
  if (!u) {
    const cu = await clerk().users.getUser(clerkId);
    const email = cu.primaryEmailAddress?.emailAddress || cu.emailAddresses[0]?.emailAddress || "";
    const name = [cu.firstName, cu.lastName].filter(Boolean).join(" ") || email.split("@")[0] || "You";
    try {
      u = await prisma.user.create({ data: { clerkId, email, name }, select: { id: true, clerkId: true, email: true, name: true } });
    } catch {
      // Two first requests at once: the other one created it.
      u = await prisma.user.findUniqueOrThrow({ where: { clerkId }, select: { id: true, clerkId: true, email: true, name: true } });
    }
    const existing = await prisma.folder.count({ where: { userId: u.id } });
    if (!existing) await prisma.folder.create({ data: { userId: u.id, name: "My edits", workspace: `${name.split(" ")[0]}'s Workspace`, cover: 1 } });
  }
  cache.set(clerkId, { user: u, until: Date.now() + 60_000 });
  return u;
}
export function forgetUser(clerkId: string) { cache.delete(clerkId); }

/** Web app: Clerk session token. MCP server: internal secret + the Clerk user it verified. */
export async function authenticate(req: FastifyRequest, _reply: FastifyReply) {
  const internal = req.headers["x-internal-secret"];
  if (typeof internal === "string") {
    const secret = env().INTERNAL_API_SECRET;
    if (!secret || !safeEqual(internal, secret)) throw unauthorized();
    const clerkId = String(req.headers["x-rendrr-clerk-id"] || "");
    if (!clerkId) throw unauthorized();
    req.user = await ensureUser(clerkId);
    const ai = String(req.headers["x-rendrr-ai"] || "");
    req.ai = ai === "claude" || ai === "chatgpt" ? ai : null;
    req.aiName = String(req.headers["x-rendrr-ai-name"] || "").slice(0, 80) || undefined;
    return;
  }
  const h = req.headers.authorization || "";
  const tok = h.startsWith("Bearer ") ? h.slice(7) : "";
  if (!tok) throw unauthorized("Please log in to continue.");
  if (!env().CLERK_SECRET_KEY) throw new AppError("Login is not set up on the server yet.", 500, "auth-config");
  const r = await verifyToken(tok, { secretKey: env().CLERK_SECRET_KEY }).catch(() => null);
  const payload = (r && typeof r === "object" && "data" in r ? (r as { data?: { sub?: string } }).data : (r as { sub?: string } | null)) || null;
  if (!payload?.sub) throw unauthorized();
  req.user = await ensureUser(payload.sub);
}
