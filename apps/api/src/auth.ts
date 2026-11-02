import { createClerkClient, verifyToken } from "@clerk/backend";
import { env, internalSecrets, safeEqual, unauthorized, AppError } from "@rendrr/core";
import { prisma, type User } from "@rendrr/db";
import type { FastifyReply, FastifyRequest } from "fastify";

export type ReqUser = Pick<User, "id" | "clerkId" | "email" | "name">;
export type AiClient = "claude" | "chatgpt" | null;
declare module "fastify" {
  interface FastifyRequest { user?: ReqUser; loginId?: string; ai?: AiClient; aiName?: string } // loginId: the Clerk user who called
}

let clerkClient: ReturnType<typeof createClerkClient> | null = null;
export function clerk() {
  if (!clerkClient) clerkClient = createClerkClient({ secretKey: env().CLERK_SECRET_KEY, publishableKey: env().CLERK_PUBLISHABLE_KEY });
  return clerkClient;
}

const cache = new Map<string, { user: ReqUser; until: number }>();

const SELECT = { id: true, clerkId: true, email: true, name: true } as const;

/** The login's email, only when Clerk has verified it (only a verified email may open an existing account). */
export function verifiedEmail(cu: { primaryEmailAddress?: { emailAddress: string; verification?: { status?: string } | null } | null; emailAddresses: { emailAddress: string; verification?: { status?: string } | null }[] }): string | null {
  const e = cu.primaryEmailAddress ?? cu.emailAddresses[0];
  return e && e.verification?.status === "verified" ? e.emailAddress.trim().toLowerCase() : null;
}

/**
 * Finds the Rendrr user for a Clerk user: its own account, or the account this login was linked to (UserLogin).
 * A login Rendrr has never seen opens the account that already has its verified email (the website and the AI
 * connector then always share one account); otherwise it gets a new account (and a first folder).
 */
export async function ensureUser(clerkId: string): Promise<ReqUser> {
  const c = cache.get(clerkId);
  if (c && c.until > Date.now()) return c.user;
  let u = await prisma.user.findUnique({ where: { clerkId }, select: SELECT });
  if (!u) u = (await prisma.userLogin.findUnique({ where: { clerkId }, select: { user: { select: SELECT } } }))?.user ?? null;
  if (!u) {
    const cu = await clerk().users.getUser(clerkId);
    const email = cu.primaryEmailAddress?.emailAddress || cu.emailAddresses[0]?.emailAddress || "";
    const name = [cu.firstName, cu.lastName].filter(Boolean).join(" ") || email.split("@")[0] || "You";
    const same = verifiedEmail(cu);
    const owner = same ? await sameEmailAccount(same) : null;
    if (owner) {
      await prisma.userLogin.upsert({ where: { clerkId }, create: { clerkId, userId: owner.id }, update: { userId: owner.id } });
      cache.set(clerkId, { user: owner, until: Date.now() + 60_000 });
      return owner;
    }
    try {
      u = await prisma.user.create({ data: { clerkId, email, name }, select: SELECT });
    } catch {
      // Two first requests at once: the other one created it.
      u = await prisma.user.findUniqueOrThrow({ where: { clerkId }, select: SELECT });
    }
    const existing = await prisma.folder.count({ where: { userId: u.id } });
    if (!existing) await prisma.folder.create({ data: { userId: u.id, name: "My edits", workspace: `${name.split(" ")[0]}'s Workspace`, cover: 1 } });
  }
  cache.set(clerkId, { user: u, until: Date.now() + 60_000 });
  return u;
}
export function forgetUser(clerkId: string) { cache.delete(clerkId); }

/** The account a verified email opens: the one with videos or edits in it, else the oldest. */
async function sameEmailAccount(email: string): Promise<ReqUser | null> {
  const users = await prisma.user.findMany({ where: { email: { equals: email, mode: "insensitive" } }, orderBy: { createdAt: "asc" }, take: 5, select: SELECT });
  for (const u of users) if ((await prisma.video.count({ where: { userId: u.id } })) + (await prisma.project.count({ where: { userId: u.id } })) > 0) return u;
  return users[0] ?? null;
}

/** Web app: Clerk session token. MCP server: internal secret + the Clerk user it verified. */
export async function authenticate(req: FastifyRequest, _reply: FastifyReply) {
  const internal = req.headers["x-internal-secret"];
  if (typeof internal === "string") {
    if (!internalSecrets().some((s) => safeEqual(internal, s))) throw unauthorized();
    const clerkId = String(req.headers["x-rendrr-clerk-id"] || "");
    if (!clerkId) throw unauthorized();
    req.user = await ensureUser(clerkId);
    req.loginId = clerkId;
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
  req.loginId = payload.sub;
}
