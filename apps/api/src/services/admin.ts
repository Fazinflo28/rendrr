// The admin panel's numbers: users and their plans, revenue, what each user and each kind of job costs Rendrr
// (measured, see apps/worker/src/lib/cost.ts), usage, storage, and the things going wrong (failed jobs grouped by
// error, stuck work, AI tool errors, errors in people's browsers).
import { AppError, currentStatement, isAdmin, queue, storageBytes, type QueueName } from "@rendrr/core";
import { prisma } from "@rendrr/db";
import { COST_RATES, PLAN_INFO, QUEUES, storageCost } from "@rendrr/shared";
import { createHash } from "node:crypto";

const DAY = 86_400_000;
const r2 = (n: number) => Math.round(n * 100) / 100;
const r4 = (n: number) => Math.round(n * 10000) / 10000;
const GB = 1024 ** 3;
const dayKey = (d: Date) => d.toISOString().slice(0, 10);
/** Railway's base cost for the always-on services (API, web, connector, database, Redis), a month, in dollars. */
export const fixedMonthly = () => Number(process.env.FIXED_COST_MONTHLY_USD || 15);

export async function assertAdmin(userId: string) {
  const u = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { role: true, email: true } });
  if (!isAdmin(u)) throw new AppError("This page is for Rendrr's team.", 403, "forbidden");
}

/** Errors with their ids and numbers taken out, so the same failure groups together. */
export function normalizeError(s: string | null | undefined): string {
  return String(s || "unknown").replace(/\b[a-z]{1,4}_[A-Za-z0-9]{8,}\b/g, "<id>").replace(/\bc[a-z0-9]{20,}\b/g, "<id>").replace(/\b[0-9a-f]{8,}\b/gi, "<id>").replace(/\d+(\.\d+)?/g, "#").replace(/\s+/g, " ").trim().slice(0, 180);
}

async function storageTotals(days: number) {
  const from = dayKey(new Date(Date.now() - days * DAY));
  const rows = await prisma.storageSnapshot.findMany({ where: { day: { gte: from } }, select: { userId: true, day: true, bytes: true, byKind: true } });
  const byDay = new Map<string, number>();
  for (const r of rows) byDay.set(r.day, (byDay.get(r.day) ?? 0) + Number(r.bytes));
  const gbDays = Array.from(byDay.values()).reduce((s, b) => s + b / GB, 0);
  return { rows, byDay, gbDays };
}

/** The overview: users, money in, money out, usage, storage, queues, problems. */
export async function overview() {
  const now = new Date(), d30 = new Date(now.getTime() - 30 * DAY), d7 = new Date(now.getTime() - 7 * DAY), d1 = new Date(now.getTime() - DAY);
  const users = await prisma.user.findMany({ select: { id: true, plan: true, billingStatus: true, trialEndsAt: true, createdAt: true, lastActiveAt: true } });
  const count = (f: (u: (typeof users)[number]) => boolean) => users.filter(f).length;
  const trialing = count((u) => u.plan === "trial" && u.trialEndsAt > now);
  const starter = count((u) => u.plan === "starter" && u.billingStatus === "active");
  const [paid30, costs30, costsToday, usage30, renders30, failedRenders1, failedJobs1, clientErrors1, mcpErrors1, stuck] = await Promise.all([
    prisma.billingInvoice.aggregate({ where: { status: "paid", paidAt: { gte: d30 } }, _sum: { totalCents: true } }),
    prisma.jobCost.aggregate({ where: { createdAt: { gte: d30 } }, _sum: { costCompute: true, costMemory: true, costTranscribe: true, costEgress: true, costTotal: true, cpuSeconds: true, transcribeSeconds: true, egressBytes: true } }),
    prisma.jobCost.aggregate({ where: { createdAt: { gte: d1 } }, _sum: { costTotal: true } }),
    prisma.usageRecord.groupBy({ by: ["metric"], where: { createdAt: { gte: d30 }, metric: { in: ["export", "preview", "footage"] } }, _sum: { billable: true, quantity: true }, _count: true }),
    prisma.render.groupBy({ by: ["status"], where: { createdAt: { gte: d30 } }, _count: true }),
    prisma.render.count({ where: { status: "failed", createdAt: { gte: d1 } } }),
    prisma.jobLog.count({ where: { event: "fail", createdAt: { gte: d1 } } }),
    prisma.clientError.count({ where: { lastSeen: { gte: d1 }, resolved: false } }),
    prisma.usageEvent.count({ where: { kind: "mcp_tool", createdAt: { gte: d1 }, meta: { path: ["ok"], equals: false } } }),
    prisma.render.count({ where: { status: { in: ["queued", "running"] }, createdAt: { lt: new Date(now.getTime() - 3600_000) } } }),
  ]);
  const st = await storageTotals(30);
  const storage30 = storageCost(st.gbDays);
  const fixed30 = fixedMonthly();
  const jobs30 = costs30._sum.costTotal ?? 0;
  const cost30 = jobs30 + storage30 + fixed30;
  const revenue30 = (paid30._sum.totalCents ?? 0) / 100;
  const latestDay = Array.from(st.byDay.keys()).sort().pop();
  const exportMin = usage30.find((u) => u.metric === "export")?._sum.billable ?? 0;
  return {
    users: {
      total: users.length, new7d: count((u) => u.createdAt >= d7), active7d: count((u) => !!u.lastActiveAt && u.lastActiveAt >= d7),
      trialing, trialEnded: count((u) => u.plan === "trial" && u.trialEndsAt <= now), starter,
      pastDue: count((u) => u.plan === "starter" && u.billingStatus === "past_due"), canceled: count((u) => u.plan === "starter" && u.billingStatus === "canceled"), comp: count((u) => u.plan === "comp"),
    },
    money: {
      mrr: r2((starter * PLAN_INFO.starter.priceCents) / 100), revenue30: r2(revenue30),
      cost30: r2(cost30), margin30: revenue30 > 0 ? r2(((revenue30 - cost30) / revenue30) * 100) : null,
      costParts30: { compute: r2(costs30._sum.costCompute ?? 0), memory: r2(costs30._sum.costMemory ?? 0), transcription: r2(costs30._sum.costTranscribe ?? 0), egress: r2(costs30._sum.costEgress ?? 0), storage: r2(storage30), fixed: r2(fixed30) },
      costToday: r4(costsToday._sum.costTotal ?? 0),
      costPerExportMinute: exportMin > 0 ? r4((jobs30 + storage30) / exportMin) : null,
    },
    usage30: Object.fromEntries(["export", "preview", "footage"].map((m) => { const u = usage30.find((x) => x.metric === m); return [m, { minutes: r2(u?._sum.billable ?? 0), count: u?._count ?? 0 }]; })),
    renders30: Object.fromEntries(renders30.map((r) => [r.status, r._count])),
    storage: { totalGB: r2((latestDay ? st.byDay.get(latestDay)! : 0) / GB), day: latestDay ?? null },
    issues: { failedRenders24h: failedRenders1, failedJobs24h: failedJobs1, clientErrors24h: clientErrors1, aiToolErrors24h: mcpErrors1, stuckRenders: stuck },
    queues: await queueHealth(),
    rates: { ...COST_RATES, fixedMonthly: fixed30 },
    series: await dailySeries(30),
  };
}

/** Each queue's waiting, running, failed and delayed jobs. */
export async function queueHealth() {
  const out: Record<string, Record<string, number>> = {};
  for (const name of Object.keys(QUEUES) as QueueName[]) {
    try { out[name] = await queue(name).getJobCounts("waiting", "active", "failed", "delayed"); } catch { out[name] = { error: 1 }; }
  }
  return out;
}

/** Day by day: our cost by part, money paid, minutes used, new users. */
export async function dailySeries(days: number) {
  const from = new Date(Date.now() - (days - 1) * DAY); from.setUTCHours(0, 0, 0, 0);
  const [costs, usage, paid, signups] = await Promise.all([
    prisma.jobCost.findMany({ where: { createdAt: { gte: from } }, select: { createdAt: true, costCompute: true, costMemory: true, costTranscribe: true, costEgress: true } }),
    prisma.usageRecord.findMany({ where: { createdAt: { gte: from }, metric: { in: ["export", "preview", "footage"] } }, select: { createdAt: true, metric: true, billable: true } }),
    prisma.billingInvoice.findMany({ where: { status: "paid", paidAt: { gte: from } }, select: { paidAt: true, totalCents: true } }),
    prisma.user.findMany({ where: { createdAt: { gte: from } }, select: { createdAt: true } }),
  ]);
  const st = await storageTotals(days);
  const fixedDay = fixedMonthly() / 30;
  const out = Array.from({ length: days }, (_, i) => ({ date: dayKey(new Date(from.getTime() + i * DAY)), compute: 0, memory: 0, transcription: 0, egress: 0, storage: 0, fixed: fixedDay, revenue: 0, exportMinutes: 0, previewMinutes: 0, footageMinutes: 0, signups: 0 }));
  const at = (d: Date) => out.find((x) => x.date === dayKey(d));
  for (const c of costs) { const d = at(c.createdAt); if (d) { d.compute += c.costCompute; d.memory += c.costMemory; d.transcription += c.costTranscribe; d.egress += c.costEgress; } }
  for (const u of usage) { const d = at(u.createdAt); if (d) d[(u.metric + "Minutes") as "exportMinutes"] += u.billable; }
  for (const p of paid) { const d = p.paidAt && at(p.paidAt); if (d) d.revenue += p.totalCents / 100; }
  for (const s of signups) { const d = at(s.createdAt); if (d) d.signups++; }
  for (const d of out) d.storage = storageCost((st.byDay.get(d.date) ?? 0) / GB);
  return out.map((d) => Object.fromEntries(Object.entries(d).map(([k, v]) => [k, typeof v === "number" ? r4(v) : v])));
}

const SORTS = ["recent", "cost", "usage", "storage", "revenue", "name"] as const;
export type UserSort = (typeof SORTS)[number];

/** Users with their plan, last 30 days' usage, our cost, their payments and storage. */
export async function listUsers(o: { q?: string; sort?: string; plan?: string; offset?: number; limit?: number }) {
  const d30 = new Date(Date.now() - 30 * DAY);
  const where = {
    ...(o.q?.trim() ? { OR: [{ email: { contains: o.q.trim(), mode: "insensitive" as const } }, { name: { contains: o.q.trim(), mode: "insensitive" as const } }, { id: o.q.trim() }] } : {}),
    ...(o.plan && ["trial", "starter", "comp"].includes(o.plan) ? { plan: o.plan } : {}),
  };
  const users = await prisma.user.findMany({ where, select: { id: true, name: true, email: true, plan: true, billingStatus: true, trialEndsAt: true, createdAt: true, lastActiveAt: true, role: true, spendLimitCents: true, stripeCustomerId: true } });
  const ids = users.map((u) => u.id);
  const [cost, usage, paid, videos, projects] = await Promise.all([
    prisma.jobCost.groupBy({ by: ["userId"], where: { userId: { in: ids }, createdAt: { gte: d30 } }, _sum: { costTotal: true } }),
    prisma.usageRecord.groupBy({ by: ["userId", "metric"], where: { userId: { in: ids }, createdAt: { gte: d30 }, metric: { in: ["export", "preview", "footage"] } }, _sum: { billable: true } }),
    prisma.billingInvoice.groupBy({ by: ["userId"], where: { userId: { in: ids }, status: "paid" }, _sum: { totalCents: true } }),
    prisma.video.groupBy({ by: ["userId"], where: { userId: { in: ids } }, _count: true }),
    prisma.project.groupBy({ by: ["userId"], where: { userId: { in: ids }, deletedAt: null }, _count: true }),
  ]);
  const latest = await prisma.storageSnapshot.findMany({ where: { userId: { in: ids } }, orderBy: { day: "desc" }, distinct: ["userId"], select: { userId: true, bytes: true } });
  const st = await storageTotals(30);
  const gbDaysByUser = new Map<string, number>();
  for (const r of st.rows) gbDaysByUser.set(r.userId, (gbDaysByUser.get(r.userId) ?? 0) + Number(r.bytes) / GB);
  const rows = users.map((u) => {
    const use = (m: string) => r2(usage.find((x) => x.userId === u.id && x.metric === m)?._sum.billable ?? 0);
    const jobs = cost.find((x) => x.userId === u.id)?._sum.costTotal ?? 0;
    const storage = storageCost(gbDaysByUser.get(u.id) ?? 0);
    const revenue = (paid.find((x) => x.userId === u.id)?._sum.totalCents ?? 0) / 100;
    const costTotal = jobs + storage;
    return {
      id: u.id, name: u.name, email: u.email, plan: u.plan, status: u.plan === "trial" && u.trialEndsAt <= new Date() ? "expired" : u.billingStatus, role: u.role,
      trialEndsAt: u.trialEndsAt.toISOString(), createdAt: u.createdAt.toISOString(), lastActiveAt: u.lastActiveAt?.toISOString() ?? null,
      usage30: { exportMinutes: use("export"), previewMinutes: use("preview"), footageMinutes: use("footage") },
      cost30: r4(costTotal), revenueAll: r2(revenue), marginAll: revenue > 0 ? r2(((revenue - costTotal) / revenue) * 100) : null,
      storageGB: r2(Number(latest.find((x) => x.userId === u.id)?.bytes ?? 0) / GB),
      videos: videos.find((x) => x.userId === u.id)?._count ?? 0, edits: projects.find((x) => x.userId === u.id)?._count ?? 0,
      hasCard: !!u.stripeCustomerId,
    };
  });
  const sort = (SORTS as readonly string[]).includes(o.sort ?? "") ? (o.sort as UserSort) : "recent";
  const key: Record<UserSort, (r: (typeof rows)[number]) => number | string> = {
    recent: (r) => r.lastActiveAt ?? r.createdAt, cost: (r) => r.cost30, usage: (r) => r.usage30.exportMinutes + r.usage30.footageMinutes, storage: (r) => r.storageGB, revenue: (r) => r.revenueAll, name: (r) => (r.name || r.email).toLowerCase(),
  };
  rows.sort((a, b) => { const x = key[sort](a), y = key[sort](b); return sort === "name" ? String(x).localeCompare(String(y)) : x < y ? 1 : x > y ? -1 : 0; });
  const offset = Math.max(0, o.offset ?? 0), limit = Math.min(200, Math.max(1, o.limit ?? 50));
  return { total: rows.length, offset, users: rows.slice(offset, offset + limit) };
}

/** One user: plan and bill, usage, costs by kind of job, renders with their cost, storage, problems, admin changes. */
export async function userDetail(userId: string) {
  const d30 = new Date(Date.now() - 30 * DAY);
  const { user, start, end, usage, account, statement } = await currentStatement(userId);
  const [records, costsByKind, renders, failures, invoices, actions, storage, videos, toolErrors] = await Promise.all([
    prisma.usageRecord.findMany({ where: { userId, metric: { not: "storage" } }, orderBy: { createdAt: "desc" }, take: 60 }),
    prisma.jobCost.groupBy({ by: ["kind"], where: { userId, createdAt: { gte: d30 } }, _sum: { costTotal: true, cpuSeconds: true, transcribeSeconds: true, egressBytes: true }, _count: true }),
    prisma.render.findMany({ where: { userId }, orderBy: { createdAt: "desc" }, take: 25, select: { id: true, kind: true, status: true, quality: true, seconds: true, sizeBytes: true, error: true, errorCode: true, by: true, createdAt: true, finishedAt: true, project: { select: { name: true } } } }),
    prisma.jobLog.findMany({ where: { userId, event: "fail", createdAt: { gte: d30 } }, orderBy: { createdAt: "desc" }, take: 30 }),
    prisma.billingInvoice.findMany({ where: { userId }, orderBy: { createdAt: "desc" }, take: 24 }),
    prisma.adminAction.findMany({ where: { targetId: userId }, orderBy: { createdAt: "desc" }, take: 30 }),
    storageBytes(userId),
    prisma.video.count({ where: { userId } }),
    prisma.usageEvent.findMany({ where: { userId, kind: "mcp_tool", createdAt: { gte: d30 }, meta: { path: ["ok"], equals: false } }, orderBy: { createdAt: "desc" }, take: 20, select: { meta: true, createdAt: true } }),
  ]);
  const renderCosts = await prisma.jobCost.groupBy({ by: ["refId"], where: { refId: { in: renders.map((r) => r.id) } }, _sum: { costTotal: true, cpuSeconds: true } });
  return {
    user: { id: user.id, name: user.name, email: user.email, role: user.role, createdAt: user.createdAt.toISOString(), lastActiveAt: user.lastActiveAt?.toISOString() ?? null, stripeCustomerId: user.stripeCustomerId, stripeSubscriptionId: user.stripeSubscriptionId },
    billing: { plan: account.plan, status: account.status, trialEndsAt: user.trialEndsAt.toISOString(), period: { start: start.toISOString(), end: end.toISOString() }, spendLimitCents: user.spendLimitCents, bonus: { exportMinutes: user.bonusExportMinutes, footageMinutes: user.bonusFootageMinutes }, statement, usage },
    costsByKind: costsByKind.map((c) => ({ kind: c.kind, jobs: c._count, cost: r4(c._sum.costTotal ?? 0), cpuSeconds: r2(c._sum.cpuSeconds ?? 0), transcribeMinutes: r2((c._sum.transcribeSeconds ?? 0) / 60), egressGB: r4(Number(c._sum.egressBytes ?? 0) / GB) })).sort((a, b) => b.cost - a.cost),
    renders: renders.map((r) => { const c = renderCosts.find((x) => x.refId === r.id); return { id: r.id, project: r.project.name, kind: r.kind, status: r.status, quality: r.quality, seconds: r.seconds, sizeMB: r2(Number(r.sizeBytes) / 1024 ** 2), by: r.by, error: r.error, errorCode: r.errorCode, createdAt: r.createdAt.toISOString(), tookSeconds: r.finishedAt ? Math.round((r.finishedAt.getTime() - r.createdAt.getTime()) / 1000) : null, cost: c ? r4(c._sum.costTotal ?? 0) : null, cpuSeconds: c ? r2(c._sum.cpuSeconds ?? 0) : null }; }),
    usageRecords: records.map((r) => ({ id: r.id, metric: r.metric, quantity: r4(r.quantity), billable: r4(r.billable), refId: r.refId, meta: r.meta, createdAt: r.createdAt.toISOString() })),
    storage: { totalGB: r2(storage.total / GB), byKind: Object.fromEntries(Object.entries(storage.byKind).map(([k, v]) => [k, r2(v / GB)])), videos },
    failures: failures.map((f) => ({ queue: f.queue, jobId: f.jobId, error: f.error, at: f.createdAt.toISOString() })),
    toolErrors: toolErrors.map((t) => ({ ...(t.meta as object), at: t.createdAt.toISOString() })),
    invoices: invoices.map((i) => ({ id: i.id, number: i.number, totalCents: i.totalCents, usageCents: i.usageCents, status: i.status, url: i.hostedUrl, periodStart: i.periodStart.toISOString(), periodEnd: i.periodEnd.toISOString() })),
    actions: actions.map((a) => ({ action: a.action, meta: a.meta, adminId: a.adminId, at: a.createdAt.toISOString() })),
  };
}

/** What an admin may change on an account (starting Starter is always the user's own payment). */
export async function adminChange(adminId: string, userId: string, change: { plan?: "trial" | "comp"; trialDays?: number; bonusExportMinutes?: number; bonusFootageMinutes?: number; spendLimitCents?: number; role?: "user" | "admin" }) {
  const u = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  const data: Record<string, unknown> = {};
  if (change.plan === "comp") Object.assign(data, { plan: "comp", billingStatus: "active", periodStart: new Date(), periodEnd: new Date(Date.now() + 30 * DAY) });
  if (change.plan === "trial") {
    if (u.plan === "starter" && u.stripeSubscriptionId) throw new AppError("This account pays for Starter. Cancel it in Stripe first.", 400, "paying");
    const end = new Date(Math.max(Date.now(), u.trialEndsAt.getTime()));
    Object.assign(data, { plan: "trial", billingStatus: "trialing", trialEndsAt: end, periodStart: u.plan === "trial" ? u.periodStart : new Date(), periodEnd: end });
  }
  if (change.trialDays) {
    const base = Math.max(Date.now(), u.trialEndsAt.getTime());
    const end = new Date(base + change.trialDays * DAY);
    Object.assign(data, { trialEndsAt: end, ...(u.plan === "trial" || change.plan === "trial" ? { periodEnd: end, billingStatus: "trialing" } : {}) });
  }
  if (change.bonusExportMinutes) data.bonusExportMinutes = Math.max(0, u.bonusExportMinutes + change.bonusExportMinutes);
  if (change.bonusFootageMinutes) data.bonusFootageMinutes = Math.max(0, u.bonusFootageMinutes + change.bonusFootageMinutes);
  if (change.spendLimitCents != null) data.spendLimitCents = Math.max(0, Math.round(change.spendLimitCents));
  if (change.role) { if (userId === adminId && change.role !== "admin") throw new AppError("You cannot take away your own admin access.", 400); data.role = change.role; }
  if (!Object.keys(data).length) throw new AppError("Nothing to change.", 400);
  await prisma.user.update({ where: { id: userId }, data });
  await prisma.adminAction.create({ data: { adminId, targetId: userId, action: Object.keys(change).join(","), meta: change as object } });
  return userDetail(userId);
}

/** Our costs by day and part, by kind of job, the users who cost most, and the cost of a minute exported. */
export async function costs(days = 30) {
  const from = new Date(Date.now() - days * DAY);
  const [byKind, byUser, exportMin] = await Promise.all([
    prisma.jobCost.groupBy({ by: ["kind"], where: { createdAt: { gte: from } }, _sum: { costTotal: true, costCompute: true, costMemory: true, costTranscribe: true, costEgress: true, cpuSeconds: true, memGbSeconds: true, wallMs: true, egressBytes: true }, _count: true }),
    prisma.jobCost.groupBy({ by: ["userId"], where: { createdAt: { gte: from }, userId: { not: null } }, _sum: { costTotal: true }, orderBy: { _sum: { costTotal: "desc" } }, take: 15 }),
    prisma.usageRecord.aggregate({ where: { createdAt: { gte: from }, metric: "export" }, _sum: { billable: true } }),
  ]);
  const names = await prisma.user.findMany({ where: { id: { in: byUser.map((u) => u.userId!).filter(Boolean) } }, select: { id: true, name: true, email: true, plan: true } });
  const st = await storageTotals(days);
  const jobs = byKind.reduce((s, k) => s + (k._sum.costTotal ?? 0), 0);
  const storage = storageCost(st.gbDays), fixed = (fixedMonthly() * days) / 30;
  return {
    days, total: r2(jobs + storage + fixed), jobs: r4(jobs), storage: r4(storage), fixed: r2(fixed),
    perExportMinute: (exportMin._sum.billable ?? 0) > 0 ? r4((jobs + storage) / exportMin._sum.billable!) : null,
    byKind: byKind.map((k) => ({
      kind: k.kind, jobs: k._count, cost: r4(k._sum.costTotal ?? 0), perJob: r4((k._sum.costTotal ?? 0) / Math.max(1, k._count)),
      parts: { compute: r4(k._sum.costCompute ?? 0), memory: r4(k._sum.costMemory ?? 0), transcription: r4(k._sum.costTranscribe ?? 0), egress: r4(k._sum.costEgress ?? 0) },
      cpuSecondsPerJob: r2((k._sum.cpuSeconds ?? 0) / Math.max(1, k._count)), avgSeconds: r2((k._sum.wallMs ?? 0) / 1000 / Math.max(1, k._count)), egressGB: r4(Number(k._sum.egressBytes ?? 0) / GB),
    })).sort((a, b) => b.cost - a.cost),
    topUsers: byUser.map((u) => { const n = names.find((x) => x.id === u.userId); return { id: u.userId, name: n?.name ?? "", email: n?.email ?? "", plan: n?.plan ?? "", cost: r4(u._sum.costTotal ?? 0) }; }),
    series: await dailySeries(Math.min(days, 90)),
  };
}

/** Storage now by kind, the users with the most, and how it grew. */
export async function storageReport() {
  const latest = await prisma.storageSnapshot.findMany({ orderBy: { day: "desc" }, distinct: ["userId"], select: { userId: true, bytes: true, byKind: true, day: true } });
  const byKind: Record<string, number> = {};
  for (const r of latest) for (const [k, v] of Object.entries((r.byKind ?? {}) as Record<string, number>)) byKind[k] = (byKind[k] ?? 0) + Number(v);
  const top = [...latest].sort((a, b) => Number(b.bytes) - Number(a.bytes)).slice(0, 15);
  const names = await prisma.user.findMany({ where: { id: { in: top.map((t) => t.userId) } }, select: { id: true, name: true, email: true, plan: true } });
  const st = await storageTotals(60);
  return {
    totalGB: r2(latest.reduce((s, r) => s + Number(r.bytes), 0) / GB),
    byKindGB: Object.fromEntries(Object.entries(byKind).map(([k, v]) => [k, r2(v / GB)])),
    monthlyCost: r2((latest.reduce((s, r) => s + Number(r.bytes), 0) / GB) * COST_RATES.storagePerGBMonth),
    top: top.map((t) => { const n = names.find((x) => x.id === t.userId); return { id: t.userId, name: n?.name ?? "", email: n?.email ?? "", plan: n?.plan ?? "", gb: r2(Number(t.bytes) / GB), day: t.day }; }),
    series: Array.from(st.byDay.entries()).sort(([a], [b]) => a.localeCompare(b)).map(([day, b]) => ({ day, gb: r2(b / GB) })),
  };
}

/** What is going wrong: failed jobs grouped by error, failed renders, stuck work, AI tool errors, browser errors, slow queues. */
export async function issues(days = 7) {
  const from = new Date(Date.now() - days * DAY);
  const [fails, renderFails, stuckRenders, stuckVideos, toolErrors, client, durations] = await Promise.all([
    prisma.jobLog.findMany({ where: { event: "fail", createdAt: { gte: from } }, select: { queue: true, error: true, userId: true, jobId: true, createdAt: true, meta: true }, orderBy: { createdAt: "desc" }, take: 2000 }),
    prisma.render.findMany({ where: { status: "failed", createdAt: { gte: from } }, select: { id: true, error: true, errorCode: true, userId: true, kind: true, createdAt: true }, orderBy: { createdAt: "desc" }, take: 500 }),
    prisma.render.findMany({ where: { status: { in: ["queued", "running"] }, createdAt: { lt: new Date(Date.now() - 3600_000) } }, select: { id: true, status: true, kind: true, userId: true, createdAt: true }, take: 50 }),
    prisma.video.findMany({ where: { status: { in: ["linking", "preview", "previewing", "uploading", "processing"] }, updatedAt: { lt: new Date(Date.now() - 2 * 3600_000) } }, select: { id: true, name: true, status: true, userId: true, updatedAt: true }, take: 50 }),
    prisma.usageEvent.findMany({ where: { kind: "mcp_tool", createdAt: { gte: from }, meta: { path: ["ok"], equals: false } }, select: { meta: true, userId: true, createdAt: true }, orderBy: { createdAt: "desc" }, take: 1000 }),
    prisma.clientError.findMany({ where: { resolved: false }, orderBy: { lastSeen: "desc" }, take: 50 }),
    prisma.jobLog.groupBy({ by: ["queue"], where: { event: "finish", createdAt: { gte: from } }, _avg: { durationMs: true }, _max: { durationMs: true }, _count: true }),
  ]);
  type G = { key: string; where: string; error: string; count: number; users: Set<string>; last: Date; sample: string; final: number };
  const group = <T>(xs: T[], where: (x: T) => string, err: (x: T) => string | null | undefined, user: (x: T) => string | null, at: (x: T) => Date, sample: (x: T) => string, final?: (x: T) => boolean) => {
    const m = new Map<string, G>();
    for (const x of xs) {
      const e = normalizeError(err(x)), w = where(x), k = `${w}|${e}`;
      const g = m.get(k) ?? { key: createHash("sha1").update(k).digest("hex").slice(0, 10), where: w, error: e, count: 0, users: new Set<string>(), last: at(x), sample: sample(x), final: 0 };
      g.count++; const u = user(x); if (u) g.users.add(u); if (at(x) > g.last) g.last = at(x); if (final?.(x)) g.final++;
      m.set(k, g);
    }
    return Array.from(m.values()).sort((a, b) => b.count - a.count).slice(0, 40).map((g) => ({ key: g.key, where: g.where, error: g.error, count: g.count, users: g.users.size, last: g.last.toISOString(), sample: g.sample, ...(final ? { final: g.final } : {}) }));
  };
  return {
    days,
    failedJobs: group(fails, (f) => f.queue, (f) => f.error, (f) => f.userId, (f) => f.createdAt, (f) => f.jobId, (f) => !!(f.meta as { final?: boolean })?.final),
    failedRenders: group(renderFails, (r) => `render ${r.kind}${r.errorCode ? ` (${r.errorCode})` : ""}`, (r) => r.error, (r) => r.userId, (r) => r.createdAt, (r) => r.id),
    aiToolErrors: group(toolErrors, (t) => `tool ${(t.meta as { tool?: string })?.tool ?? "?"}`, (t) => (t.meta as { error?: string })?.error ?? "", (t) => t.userId, (t) => t.createdAt, (t) => (t.meta as { ai?: string })?.ai ?? ""),
    stuck: [
      ...stuckRenders.map((r) => ({ type: "render", id: r.id, what: `${r.kind} render ${r.status}`, userId: r.userId as string | null, since: r.createdAt.toISOString() })),
      ...stuckVideos.map((v) => ({ type: "video", id: v.id, what: `${v.name}: ${v.status}`, userId: v.userId as string | null, since: v.updatedAt.toISOString() })),
    ],
    clientErrors: client.map((c) => ({ id: c.id, message: c.message, url: c.url, count: c.count, userId: c.userId, firstSeen: c.firstSeen.toISOString(), lastSeen: c.lastSeen.toISOString(), stack: c.stack?.split("\n").slice(0, 4).join("\n") ?? null })),
    queueTimes: durations.map((d) => ({ queue: d.queue, jobs: d._count, avgSeconds: r2((d._avg.durationMs ?? 0) / 1000), maxSeconds: r2((d._max.durationMs ?? 0) / 1000) })).sort((a, b) => b.maxSeconds - a.maxSeconds),
  };
}

export async function recentJobs(o: { queue?: string; event?: string; userId?: string; limit?: number }) {
  const rows = await prisma.jobLog.findMany({ where: { ...(o.queue ? { queue: o.queue } : {}), ...(o.event ? { event: o.event } : {}), ...(o.userId ? { userId: o.userId } : {}) }, orderBy: { createdAt: "desc" }, take: Math.min(300, o.limit ?? 100) });
  return rows.map((r) => ({ id: r.id, queue: r.queue, jobId: r.jobId, name: r.name, event: r.event, userId: r.userId, durationMs: r.durationMs, error: r.error, at: r.createdAt.toISOString() }));
}

/** An error from someone's browser, grouped with the same one seen before. */
export async function recordClientError(e: { message: string; stack?: string | null; url?: string | null; userAgent?: string | null; userId?: string | null }) {
  const firstLine = (e.stack || "").split("\n").find((l) => /at |@/.test(l))?.trim() ?? "";
  let path = ""; try { path = e.url ? new URL(e.url).pathname.replace(/\/c[a-z0-9]{20,}/g, "/<id>") : ""; } catch { /* not a URL */ }
  const fingerprint = createHash("sha1").update(`${normalizeError(e.message)}|${normalizeError(firstLine)}|${path}`).digest("hex");
  await prisma.clientError.upsert({
    where: { fingerprint },
    create: { fingerprint, message: e.message.slice(0, 500), stack: e.stack?.slice(0, 4000) ?? null, url: e.url?.slice(0, 500) ?? null, userAgent: e.userAgent?.slice(0, 300) ?? null, userId: e.userId ?? null },
    update: { count: { increment: 1 }, lastSeen: new Date(), resolved: false, ...(e.userId ? { userId: e.userId } : {}) },
  });
}
