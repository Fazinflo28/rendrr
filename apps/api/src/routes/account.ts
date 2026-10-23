import { AppError, deleteObject, env, putObject } from "@rendrr/core";
import { prisma, type Prisma } from "@rendrr/db";
import { fmtShortDate, LoginInput, LogoInput, PlanInput, PLANS, PREFIX, ProfilePatch, SettingsPatch, SignupInput } from "@rendrr/shared";
import type { FastifyInstance } from "fastify";
import { authenticate, clerk, forgetUser } from "../auth";
import { userOut } from "../serialize";
import { createLinkCode, listLogins, unlinkLogin } from "../services/logins";

const TOOLS: [string, string][] = [
  ["Read footage", "Each video as text and frames: shots, pacing, transcript, silences"],
  ["Read styles", "Know your style packs and save new ones"],
  ["Edit in one go", "Cut, zoom, add captions and music in a single step"],
  ["Render and check", "Make a preview and read a check of what it does"],
  ["Read client comments", "See what your client asked for"],
];

function decodeImage(dataUrl: string): { buf: Buffer; ext: string; type: string } {
  const m = /^data:(image\/(png|jpe?g|webp|gif|svg\+xml));base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!m) throw new AppError("That image type is not supported. Use PNG, JPG, WebP or SVG.", 400);
  const buf = Buffer.from(m[3], "base64");
  if (buf.length > 3 * 1024 * 1024) throw new AppError("That image is too big. Pick one under 3 MB.", 400);
  return { buf, ext: m[2] === "svg+xml" ? "svg" : m[2].replace("jpeg", "jpg"), type: m[1] };
}

const clerkError = (e: unknown) => {
  const errs = (e as { errors?: { code?: string; message?: string; longMessage?: string }[] })?.errors || [];
  const c = errs[0]?.code || "";
  if (c === "form_identifier_exists") return "An account with that email already exists. Log in instead.";
  if (c === "form_password_pwned") return "That password has appeared in a data breach somewhere. Pick a different one.";
  if (c.startsWith("form_password")) return errs[0]?.longMessage || "Pick a stronger password (at least 8 characters).";
  if (c === "form_param_format_invalid") return "That email does not look right.";
  return null;
};

export default async function account(app: FastifyInstance) {
  // ---------------- login (public) ----------------
  // Email + password are checked by Clerk on the server, then the browser signs in with a one-time ticket.
  app.register(async (pub) => {
    pub.post("/auth/login", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req) => {
      const { email, password } = LoginInput.parse(req.body);
      const list = await clerk().users.getUserList({ emailAddress: [email.toLowerCase()] });
      const u = list.data[0];
      if (!u) throw new AppError("We could not find an account with that email. Sign up first.", 400, "no-account");
      if (!u.passwordEnabled) throw new AppError("This account uses Google to log in. Use 'Log in with Google'.", 400, "use-google");
      const ok = await clerk().users.verifyPassword({ userId: u.id, password }).then(() => true).catch(() => false);
      if (!ok) throw new AppError("That password is not right.", 400, "bad-password");
      const t = await clerk().signInTokens.createSignInToken({ userId: u.id, expiresInSeconds: 120 });
      return { ticket: t.token };
    });
    pub.post("/auth/signup", { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } }, async (req) => {
      const { name, email, password } = SignupInput.parse(req.body);
      const allow = (env().SIGNUP_ALLOWLIST || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
      if (allow.length && !allow.includes(email.toLowerCase())) throw new AppError("Sign ups are invite only for now.", 403, "invite-only");
      const [first, ...rest] = (name || "").trim().split(/\s+/);
      let u;
      try {
        u = await clerk().users.createUser({ emailAddress: [email.toLowerCase()], password, firstName: first || undefined, lastName: rest.join(" ") || undefined });
      } catch (e) {
        throw new AppError(clerkError(e) || "We could not create your account. Try again.", 400, "signup");
      }
      const t = await clerk().signInTokens.createSignInToken({ userId: u.id, expiresInSeconds: 120 });
      return { ticket: t.token };
    });
  });

  app.register(async (a) => {
    a.addHook("preHandler", authenticate);

    // ---------------- usage ----------------
    a.get("/account/usage", async (req) => {
      const userId = req.user!.id;
      const u = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
      const monthStart = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1));
      const [minutes, finalsThisMonth, previewVideos, previewRenders, finals] = await Promise.all([
        prisma.usageEvent.aggregate({ where: { userId, kind: { in: ["render_preview", "render_final"] }, createdAt: { gte: monthStart } }, _sum: { amount: true } }),
        prisma.render.findMany({ where: { userId, kind: "final", status: "done", finishedAt: { gte: monthStart } }, select: { projectId: true }, distinct: ["projectId"] }),
        prisma.video.aggregate({ where: { userId, status: { not: "expired" } }, _sum: { previewSizeBytes: true } }),
        prisma.render.aggregate({ where: { userId, kind: "preview", outputKey: { not: null } }, _sum: { sizeBytes: true } }),
        prisma.render.aggregate({ where: { userId, kind: "final", outputKey: { not: null } }, _sum: { sizeBytes: true } }),
      ]);
      const gb = (b: bigint | null | undefined) => Math.round((Number(b || 0) / 1e9) * 100) / 100;
      const previewsGB = Math.round((gb(previewVideos._sum.previewSizeBytes) + gb(previewRenders._sum.sizeBytes)) * 100) / 100;
      const finalsGB = gb(finals._sum.sizeBytes);
      return {
        renderMinutes: Math.round((minutes._sum.amount || 0) * 10) / 10, videosEdited: finalsThisMonth.length, plan: u.plan,
        planRenew: fmtShortDate(u.planRenewsAt), previewsGB, finalsGB, storageTotalGB: u.storageLimitGB,
        // One decimal like the UI, but two below 1 GB so it matches the breakdown shown next to it.
        storageUsedGB: previewsGB + finalsGB < 1 ? Math.round((previewsGB + finalsGB) * 100) / 100 : Math.round((previewsGB + finalsGB) * 10) / 10,
      };
    });

    // ---------------- billing (payments not switched on: no card, no invoices, plans switch freely) ----------------
    const billingOut = (u: { plan: string; planRenewsAt: Date }) => {
      const plan = PLANS.find((p) => p.name === u.plan) || PLANS[PLANS.length - 1];
      return { plan: plan.name, price: plan.price, period: "month", renew: fmtShortDate(u.planRenewsAt), card: null, invoices: [], payments: false, plans: PLANS.map(({ name, price, note }) => ({ name, price, note })) };
    };
    a.get("/billing", async (req) => billingOut(await prisma.user.findUniqueOrThrow({ where: { id: req.user!.id } })));
    a.post("/billing/plan", async (req) => {
      const { plan } = PlanInput.parse(req.body);
      const storageLimitGB = PLANS.find((p) => p.name === plan)!.storageGB;
      return billingOut(await prisma.user.update({ where: { id: req.user!.id }, data: { plan, storageLimitGB } }));
    });

    a.get("/account/usage/history", async (req) => {
      const today = new Date(); today.setUTCHours(0, 0, 0, 0);
      const from = new Date(today.getTime() - 83 * 86400_000);
      const ev = await prisma.usageEvent.findMany({ where: { userId: req.user!.id, kind: { in: ["render_preview", "render_final"] }, createdAt: { gte: from } }, select: { amount: true, createdAt: true } });
      const days = new Map<string, { renders: number; minutes: number }>();
      for (const e of ev) { const k = e.createdAt.toISOString().slice(0, 10); const d = days.get(k) || { renders: 0, minutes: 0 }; d.renders++; d.minutes += e.amount; days.set(k, d); }
      return Array.from({ length: 84 }, (_, i) => {
        const date = new Date(from.getTime() + i * 86400_000).toISOString().slice(0, 10);
        const d = days.get(date);
        return { date, renders: d?.renders || 0, minutes: d ? Math.round(d.minutes * 10) / 10 : 0 };
      });
    });

    // ---------------- profile, brand, settings ----------------
    a.get("/account/profile", async (req) => userOut(await prisma.user.findUniqueOrThrow({ where: { id: req.user!.id } })));

    a.patch("/account/profile", async (req) => {
      const patch = ProfilePatch.parse(req.body);
      const u = await prisma.user.findUniqueOrThrow({ where: { id: req.user!.id } });
      const data: Prisma.UserUpdateInput = {};
      if (patch.name && patch.name !== u.name) {
        data.name = patch.name;
        const [first, ...rest] = patch.name.split(/\s+/);
        await clerk().users.updateUser(u.clerkId, { firstName: first, lastName: rest.join(" ") || undefined }).catch(() => {});
      }
      if (patch.email && patch.email.toLowerCase() !== u.email.toLowerCase()) {
        // The browser proves the new address first (Clerk emails a code, the web app makes it primary).
        // Here we only copy it once Clerk says it is verified and primary, so nobody can claim an address they do not own.
        const cu = await clerk().users.getUser(u.clerkId);
        const primary = cu.emailAddresses.find((x) => x.id === cu.primaryEmailAddressId);
        const ok = primary && primary.emailAddress.toLowerCase() === patch.email.toLowerCase() && primary.verification?.status === "verified";
        if (!ok) throw new AppError("Confirm the new email with the code we send to it first.", 400, "email-unverified");
        data.email = patch.email.toLowerCase();
      }
      if (patch.photo !== undefined) {
        if (patch.photo === null) { await deleteObject(u.photoKey); data.photoKey = null; }
        else { const img = decodeImage(patch.photo); const key = `${PREFIX.brand}${u.id}/photo-${Date.now()}.${img.ext}`; await putObject(key, img.buf, img.type); await deleteObject(u.photoKey); data.photoKey = key; }
      }
      const updated = await prisma.user.update({ where: { id: u.id }, data });
      forgetUser(u.clerkId);
      return userOut(updated);
    });

    a.post("/account/logo", async (req) => {
      const { dataUrl } = LogoInput.parse(req.body);
      const u = await prisma.user.findUniqueOrThrow({ where: { id: req.user!.id } });
      let logoKey: string | null = null;
      if (dataUrl) { const img = decodeImage(dataUrl); logoKey = `${PREFIX.brand}${u.id}/logo-${Date.now()}.${img.ext}`; await putObject(logoKey, img.buf, img.type); }
      await deleteObject(u.logoKey);
      return userOut(await prisma.user.update({ where: { id: u.id }, data: { logoKey } }));
    });

    a.get("/account/settings", async (req) => (await prisma.user.findUniqueOrThrow({ where: { id: req.user!.id } })).settings);
    a.patch("/account/settings", async (req) => {
      const patch = SettingsPatch.parse(req.body);
      const u = await prisma.user.findUniqueOrThrow({ where: { id: req.user!.id } });
      const settings = { ...(u.settings as object), ...patch };
      await prisma.user.update({ where: { id: u.id }, data: { settings } });
      return settings;
    });

    // ---------------- Connect AI ----------------
    const connectStatus = async (userId: string) => {
      const cs = await prisma.aiConnection.findMany({ where: { userId } });
      const st = (k: string) => { const c = cs.find((x) => x.client === k); return c && !c.revokedAt ? "connected" : "disconnected"; };
      return { url: env().PUBLIC_MCP_URL.replace(/\/$/, "") + "/mcp", claude: st("claude"), chatgpt: st("chatgpt"), tools: TOOLS,
        lastSeen: Object.fromEntries(cs.map((c) => [c.client, c.lastSeenAt.getTime()])) };
    };
    a.get("/connect", async (req) => connectStatus(req.user!.id));
    a.post("/connect/:which/test", async (req) => {
      const which = (req.params as { which: string }).which === "chatgpt" ? "chatgpt" : "claude";
      const name = which === "claude" ? "Claude" : "ChatGPT";
      const c = await prisma.aiConnection.findUnique({ where: { userId_client: { userId: req.user!.id, client: which } } });
      if (!c) throw new AppError(`We have not heard from ${name} yet. Add the connector in ${name}, then ask it to list your footage.`, 404, "not-connected");
      await prisma.aiConnection.update({ where: { id: c.id }, data: { revokedAt: null } });
      return connectStatus(req.user!.id);
    });
    a.post("/connect/:which/disconnect", async (req) => {
      const which = (req.params as { which: string }).which === "chatgpt" ? "chatgpt" : "claude";
      await prisma.aiConnection.updateMany({ where: { userId: req.user!.id, client: which }, data: { revokedAt: new Date() } });
      return connectStatus(req.user!.id);
    });

    // ---------------- logins (several logins, one account) ----------------
    a.get("/account/logins", async (req) => ({ logins: await listLogins(req.user!.id), current: req.loginId }));
    a.post("/account/link-code", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req) => createLinkCode(req.user!.id));
    a.delete("/account/logins/:clerkId", async (req) => {
      await unlinkLogin(req.user!.id, (req.params as { clerkId: string }).clerkId);
      return { logins: await listLogins(req.user!.id), current: req.loginId };
    });

    // ---------------- search ----------------
    a.get("/search", async (req) => {
      const s = String((req.query as { q?: string }).q || "").trim().slice(0, 100);
      if (!s) return [];
      const userId = req.user!.id;
      const like = { contains: s, mode: "insensitive" as const };
      const [vs, fs, ps, ss] = await Promise.all([
        prisma.video.findMany({ where: { userId, name: like }, take: 8, select: { id: true, name: true } }),
        prisma.folder.findMany({ where: { userId, name: like }, take: 8, select: { id: true, name: true } }),
        prisma.project.findMany({ where: { userId, deletedAt: null, name: like }, take: 8, select: { id: true, name: true } }),
        prisma.style.findMany({ where: { name: like, OR: [{ ownerId: null }, { ownerId: userId }] }, take: 8, select: { id: true, name: true } }),
      ]);
      return [
        ...vs.map((v) => ({ kind: "Footage", id: v.id, name: v.name, path: "/library/" + v.id })),
        ...fs.map((f) => ({ kind: "Project", id: f.id, name: f.name, path: "/projects/" + f.id })),
        ...ps.map((p) => ({ kind: "Edit", id: p.id, name: p.name, path: "/editor/" + p.id })),
        ...ss.map((x) => ({ kind: "Style", id: x.id, name: x.name, path: "/styles" })),
      ].slice(0, 8);
    });
  });
}
