// Billing on the API: the checks before a render or new footage (a clear 402 the web app and the AI show as it is),
// the Usage & billing page's data, and admins made "comp" when the server starts.
import { AppError, adminEmails, billingEnforced, checkUsage, currentPeriod, currentStatement, features, planOf, storageBytes } from "@rendrr/core";
import { prisma } from "@rendrr/db";
import { DEFAULT_SPEND_LIMIT_CENTS, PAYG, PLAN_INFO, TRIAL_DAYS, type Ask } from "@rendrr/shared";

/** 402 with the reason and what to do, when the plan does not allow this and billing is enforced. */
export async function assertMay(userId: string, ask: Ask) {
  const c = await checkUsage(userId, ask);
  if (!c.ok && c.enforced) throw new AppError(c.message, 402, "billing_" + c.code, { billing: true });
}

/** New footage (an upload, a Drive file, a local preview): a video already counted is never checked again. */
export async function assertMayAddFootage(userId: string, minutes: number, videoId?: string) {
  if (videoId) {
    const counted = await prisma.usageRecord.findUnique({ where: { metric_refId: { metric: "footage", refId: videoId } } });
    if (counted) return;
  }
  await assertMay(userId, { metric: "footage", minutes: Math.max(0.05, minutes) });
}

/** Admins (ADMIN_EMAILS) get role admin and, while they are on the trial, the comp plan. */
export async function ensureAdmins(): Promise<number> {
  const emails = adminEmails();
  if (!emails.length) return 0;
  const users = await prisma.user.findMany({ where: { email: { in: emails, mode: "insensitive" } } });
  let n = 0;
  for (const u of users) {
    const data: Record<string, unknown> = {};
    if (u.role !== "admin") data.role = "admin";
    if (planOf(u) === "trial") Object.assign(data, { plan: "comp", billingStatus: "active", periodStart: new Date(), periodEnd: new Date(Date.now() + 30 * 86_400_000) });
    if (Object.keys(data).length) { await prisma.user.update({ where: { id: u.id }, data }); n++; }
  }
  return n;
}

const DAY = 86_400_000;
const r2 = (n: number) => Math.round(n * 100) / 100;

/** Everything the Usage & billing page shows. */
export async function billingOverview(userId: string) {
  const { user, start, end, usage, account, statement } = await currentStatement(userId);
  const plan = account.plan;
  const info = PLAN_INFO[plan];
  const storage = await storageBytes(userId);
  // Day by day this period: export, preview and footage minutes.
  const rows = await prisma.usageRecord.findMany({ where: { userId, createdAt: { gte: start, lt: end }, metric: { in: ["export", "preview", "footage"] } }, select: { metric: true, billable: true, createdAt: true, meta: true, refId: true } });
  const days: { date: string; export: number; preview: number; footage: number }[] = [];
  const lastDay = Math.min(end.getTime(), Date.now());
  for (let t = Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()); t <= lastDay; t += DAY) days.push({ date: new Date(t).toISOString().slice(0, 10), export: 0, preview: 0, footage: 0 });
  for (const r of rows) {
    const d = days.find((x) => x.date === r.createdAt.toISOString().slice(0, 10));
    if (d) d[r.metric as "export" | "preview" | "footage"] = r2(d[r.metric as "export" | "preview" | "footage"] + r.billable);
  }
  // By project: export and preview minutes per edit's project (folder), footage per video.
  const projectIds = Array.from(new Set(rows.map((r) => (r.meta as { projectId?: string })?.projectId).filter((x): x is string => !!x)));
  const projects = projectIds.length ? await prisma.project.findMany({ where: { id: { in: projectIds } }, select: { id: true, name: true, folder: { select: { id: true, name: true } } } }) : [];
  const byFolder = new Map<string, { id: string; name: string; export: number; preview: number; edits: Set<string> }>();
  for (const r of rows) {
    const pid = (r.meta as { projectId?: string })?.projectId;
    const p = pid ? projects.find((x) => x.id === pid) : null;
    if (!p) continue;
    const f = byFolder.get(p.folder.id) ?? { id: p.folder.id, name: p.folder.name, export: 0, preview: 0, edits: new Set<string>() };
    if (r.metric === "export") f.export += r.billable; else if (r.metric === "preview") f.preview += r.billable;
    f.edits.add(p.id);
    byFolder.set(p.folder.id, f);
  }
  const invoices = await prisma.billingInvoice.findMany({ where: { userId }, orderBy: { createdAt: "desc" }, take: 24 });
  const daysLeft = Math.max(0, Math.ceil((end.getTime() - Date.now()) / DAY));
  return {
    plan, planName: info.name, status: account.status, blurb: info.blurb, priceCents: info.priceCents,
    period: { start: start.toISOString(), end: end.toISOString(), daysLeft },
    trial: plan === "trial" ? { endsAt: user.trialEndsAt.toISOString(), daysLeft: Math.max(0, Math.ceil((user.trialEndsAt.getTime() - Date.now()) / DAY)), days: TRIAL_DAYS, ended: account.status === "expired" } : null,
    meters: statement.meters,
    lines: statement.lines,
    baseCents: statement.baseCents, usageCents: statement.usageCents, totalCents: statement.totalCents,
    // The bill if the rest of the period goes on like the days so far.
    projectedCents: projected(statement.baseCents, statement.usageCents, start, end),
    spendLimitCents: user.spendLimitCents, defaultSpendLimitCents: DEFAULT_SPEND_LIMIT_CENTS,
    bonus: { exportMinutes: user.bonusExportMinutes, footageMinutes: user.bonusFootageMinutes },
    rates: { exportMinuteCents: PAYG.exportMinuteCents, footageHourCents: PAYG.footageHourCents, storageGbMonthCents: PAYG.storageGbMonthCents, fourKMultiplier: 2 },
    plans: (["trial", "starter"] as const).map((id) => ({ id, name: PLAN_INFO[id].name, priceCents: PLAN_INFO[id].priceCents, allowance: PLAN_INFO[id].allowance, blurb: PLAN_INFO[id].blurb, payAsYouGo: PLAN_INFO[id].payAsYouGo, fourK: PLAN_INFO[id].fourK })),
    storage: { totalGB: r2(storage.total / 1024 ** 3), byKind: Object.fromEntries(Object.entries(storage.byKind).map(([k, v]) => [k, r2(v / 1024 ** 3)])) },
    days,
    byProject: Array.from(byFolder.values()).map((f) => ({ id: f.id, name: f.name, exportMinutes: r2(f.export), previewMinutes: r2(f.preview), edits: f.edits.size })).sort((a, b) => b.exportMinutes - a.exportMinutes),
    payments: { enabled: features().billing, enforced: billingEnforced(), card: !!user.stripeSubscriptionId && account.canPay, customer: !!user.stripeCustomerId },
    invoices: invoices.map((i) => ({ id: i.id, number: i.number, periodStart: i.periodStart.toISOString(), periodEnd: i.periodEnd.toISOString(), totalCents: i.totalCents, usageCents: i.usageCents, status: i.status, url: i.hostedUrl, pdf: i.pdfUrl, paidAt: i.paidAt?.toISOString() ?? null })),
  };
}

function projected(base: number, usage: number, start: Date, end: Date): number {
  const total = end.getTime() - start.getTime(), gone = Math.min(total, Math.max(DAY, Date.now() - start.getTime()));
  return Math.round(base + (usage * total) / gone);
}

export async function setSpendLimit(userId: string, cents: number) {
  const v = Math.max(0, Math.min(100_000, Math.round(cents)));
  await prisma.user.update({ where: { id: userId }, data: { spendLimitCents: v } });
  return v;
}

/** Keeps the period moving (a granted plan's 30 days) when the page is opened. */
export async function touchPeriod(userId: string) {
  const u = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  return currentPeriod(u);
}
