// The billing state of an account from the database: its period, what it used in it, its storage, and whether
// something may happen now. The rules and numbers are in @rendrr/shared (billing.ts); this file only reads and writes.
import { prisma, type User } from "@rendrr/db";
import { mayUse, PLAN_INFO, statement, TRIAL_DAYS, type Account, type Ask, type BillingStatus, type PeriodUsage, type PlanId, type Verdict } from "@rendrr/shared";
import { env } from "./env";

const DAY = 86_400_000;
const GB = 1024 ** 3;

export const planOf = (u: Pick<User, "plan">): PlanId => (u.plan === "starter" || u.plan === "comp" ? u.plan : "trial");

/** Blocking is on when payments are set up (a Stripe key), unless BILLING_ENFORCE=off; BILLING_ENFORCE=on forces it. */
export function billingEnforced(): boolean {
  const v = (process.env.BILLING_ENFORCE || "").toLowerCase();
  if (v === "on" || v === "true" || v === "1") return true;
  if (v === "off" || v === "false" || v === "0") return false;
  return !!env().STRIPE_SECRET_KEY;
}

/** Admins: role "admin", or an email in ADMIN_EMAILS (comma separated). */
export function adminEmails(): string[] {
  return (process.env.ADMIN_EMAILS || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
}
export const isAdmin = (u: Pick<User, "role" | "email">) => u.role === "admin" || adminEmails().includes((u.email || "").toLowerCase());

/**
 * The period the account is in now: the trial's 7 days, the Stripe subscription's period, or 30-day periods for a
 * granted (comp) plan, rolled forward and saved when one has ended.
 */
export async function currentPeriod(u: User, now = new Date()): Promise<{ start: Date; end: Date; user: User }> {
  const plan = planOf(u);
  if (plan === "trial") return { start: u.periodStart, end: u.trialEndsAt, user: u };
  if (u.periodEnd.getTime() > now.getTime()) return { start: u.periodStart, end: u.periodEnd, user: u };
  if (plan === "starter" && u.stripeSubscriptionId) {
    // Stripe moves the period (webhook); until it does, the next 30 days.
  }
  let start = u.periodEnd;
  while (start.getTime() + 30 * DAY <= now.getTime()) start = new Date(start.getTime() + 30 * DAY);
  const end = new Date(start.getTime() + 30 * DAY);
  const user = await prisma.user.update({ where: { id: u.id }, data: { periodStart: start, periodEnd: end, billingNotes: {} } });
  return { start, end, user };
}

/** Bytes kept for a user now, by kind (what the storage bill and the admin panel count). */
export async function storageBytes(userId: string): Promise<{ total: number; byKind: Record<string, number> }> {
  const now = new Date();
  const [proxies, previews, finals, originals, sounds, luts, fonts] = await Promise.all([
    prisma.video.aggregate({ where: { userId, status: { not: "expired" } }, _sum: { previewSizeBytes: true } }),
    prisma.render.aggregate({ where: { userId, kind: "preview", outputKey: { not: null } }, _sum: { sizeBytes: true } }),
    prisma.render.aggregate({ where: { userId, kind: "final", outputKey: { not: null } }, _sum: { sizeBytes: true } }),
    prisma.tempOriginal.aggregate({ where: { video: { userId }, completed: true, expiresAt: { gt: now } }, _sum: { sizeBytes: true } }),
    prisma.sound.aggregate({ where: { userId }, _sum: { sizeBytes: true } }),
    prisma.lut.aggregate({ where: { userId }, _sum: { size: true } }),
    prisma.font.aggregate({ where: { userId }, _sum: { size: true } }),
  ]);
  const byKind = {
    footage: Number(proxies._sum.previewSizeBytes ?? 0),
    previews: Number(previews._sum.sizeBytes ?? 0),
    finals: Number(finals._sum.sizeBytes ?? 0),
    originals: Number(originals._sum.sizeBytes ?? 0),
    audio: Number(sounds._sum.sizeBytes ?? 0),
    other: Number(luts._sum.size ?? 0) + Number(fonts._sum.size ?? 0),
  };
  return { total: Object.values(byKind).reduce((s, n) => s + n, 0), byKind };
}

/** What the account used between two dates (billable minutes; storage one value a day from the daily snapshots). */
export async function periodUsage(userId: string, start: Date, end: Date, storageGBNow?: number): Promise<PeriodUsage> {
  const rows = await prisma.usageRecord.groupBy({ by: ["metric"], where: { userId, createdAt: { gte: start, lt: end }, metric: { in: ["export", "preview", "footage"] } }, _sum: { billable: true } });
  const sum = (m: string) => rows.find((r) => r.metric === m)?._sum.billable ?? 0;
  const days = await prisma.usageRecord.findMany({ where: { userId, metric: "storage", createdAt: { gte: start, lt: end } }, select: { billable: true }, orderBy: { createdAt: "asc" } });
  const now = storageGBNow ?? (await storageBytes(userId)).total / GB;
  return { exportMinutes: sum("export"), previewMinutes: sum("preview"), footageMinutes: sum("footage"), storageGbByDay: days.map((d) => d.billable), storageGBNow: now };
}

export function accountOf(u: User): Account {
  const plan = planOf(u);
  const status = (plan === "trial" && u.trialEndsAt.getTime() <= Date.now() ? "expired" : u.billingStatus) as BillingStatus;
  return {
    plan, status, trialEndsAt: u.trialEndsAt, spendLimitCents: u.spendLimitCents,
    canPay: plan === "starter" && status === "active" && !!u.stripeSubscriptionId,
    bonusExportMinutes: u.bonusExportMinutes, bonusFootageMinutes: u.bonusFootageMinutes,
  };
}

/** The account's bill so far this period. */
export async function currentStatement(userId: string) {
  const u0 = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  const { start, end, user } = await currentPeriod(u0);
  const usage = await periodUsage(userId, start, end);
  const acct = accountOf(user);
  return { user, start, end, usage, account: acct, statement: statement(acct.plan, usage, { exportMinutes: user.bonusExportMinutes, footageMinutes: user.bonusFootageMinutes }) };
}

export type Check = Verdict & { enforced: boolean };

/**
 * May the user do this now? Always answers; whether a "no" stops anything is billingEnforced() (the caller throws on
 * { ok: false, enforced: true }). A "no" while not enforced is logged, so the admin panel can show who would be stopped.
 */
export async function checkUsage(userId: string, ask: Ask): Promise<Check> {
  const { usage, account } = await currentStatement(userId);
  const v = mayUse(account, usage, ask);
  const enforced = billingEnforced();
  if (!v.ok && !enforced) console.log(`[billing] would stop ${userId}: ${v.code} (${ask.metric} ${ask.minutes} min)`);
  return { ...v, enforced };
}

/** One usage row; a second one for the same (metric, refId) is ignored, so retried jobs never bill twice. */
export async function recordUsage(r: { userId: string; metric: "export" | "preview" | "footage" | "storage"; quantity: number; billable?: number; refId: string; meta?: Record<string, unknown>; at?: Date }) {
  try {
    await prisma.usageRecord.createMany({
      data: [{ userId: r.userId, metric: r.metric, quantity: r.quantity, billable: r.billable ?? r.quantity, refId: r.refId, meta: (r.meta ?? {}) as object, ...(r.at ? { createdAt: r.at } : {}) }],
      skipDuplicates: true,
    });
  } catch (e) { console.error("[billing] usage not recorded:", (e as Error).message); }
}

/** A new account's trial: 7 days from now. */
export function trialFields(now = new Date()) {
  const end = new Date(now.getTime() + TRIAL_DAYS * DAY);
  return { plan: "trial", billingStatus: "trialing", trialEndsAt: end, periodStart: now, periodEnd: end, storageLimitGB: PLAN_INFO.trial.allowance!.storageGB };
}

/** Today's storage for every user: a snapshot row and the day's storage usage (GB). Run once a day. */
export async function snapshotStorage(day = new Date()): Promise<number> {
  const key = day.toISOString().slice(0, 10);
  const users = await prisma.user.findMany({ select: { id: true } });
  for (const { id } of users) {
    const s = await storageBytes(id);
    await prisma.storageSnapshot.upsert({ where: { userId_day: { userId: id, day: key } }, create: { userId: id, day: key, bytes: BigInt(Math.round(s.total)), byKind: s.byKind }, update: { bytes: BigInt(Math.round(s.total)), byKind: s.byKind } });
    await recordUsage({ userId: id, metric: "storage", quantity: s.total / GB, refId: `${id}:${key}`, meta: { byKind: s.byKind }, at: new Date(`${key}T12:00:00Z`) });
  }
  return users.length;
}
