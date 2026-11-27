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
  const rows = await prisma.usageRecord.findMany({ where: { userId, createdAt: { gte: start, lt: end }, metric: { in: ["export", "preview", "footage"] } }, select: { metric: true, quantity: true, billable: true, createdAt: true, meta: true, refId: true } });
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
    renders: await whereRendersRan(rows),
    footage: await footageBySource(rows),
    byProject: Array.from(byFolder.values()).map((f) => ({ id: f.id, name: f.name, exportMinutes: r2(f.export), previewMinutes: r2(f.preview), edits: f.edits.size })).sort((a, b) => b.exportMinutes - a.exportMinutes),
    payments: { enabled: features().billing, enforced: billingEnforced(), card: !!user.stripeSubscriptionId && account.canPay, customer: !!user.stripeCustomerId },
    invoices: invoices.map((i) => ({ id: i.id, number: i.number, periodStart: i.periodStart.toISOString(), periodEnd: i.periodEnd.toISOString(), totalCents: i.totalCents, usageCents: i.usageCents, status: i.status, url: i.hostedUrl, pdf: i.pdfUrl, paidAt: i.paidAt?.toISOString() ?? null })),
  };
}

type UsageRow = { metric: string; quantity: number; billable: number; createdAt: Date; meta: unknown; refId: string };
type Made = { on?: string; device?: string | null; why?: string | null; platform?: string } | null;
type Split = { computer: number; cloud: number };

/**
 * Where this period's renders ran, so the user sees exactly what they used: minutes on their own computer (the Rendrr
 * app) and minutes on Rendrr's cloud, previews and exports apart, and each render under its video with its length,
 * quality and the minutes it counted toward the plan. From the same usage rows the bill is made from, so the two never
 * disagree. Where a row does not say where it ran (rows from before that was kept), the render's own record does;
 * with neither, it was the cloud (renders before the Mac app existed).
 */
export async function whereRendersRan(rows: UsageRow[], limit = 500) {
  const zero = (): Split => ({ computer: 0, cloud: 0 });
  const rr = rows.filter((r) => r.metric === "export" || r.metric === "preview").sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  const renders = rr.length ? await prisma.render.findMany({
    where: { id: { in: rr.slice(0, limit).map((r) => r.refId) } },
    select: { id: true, kind: true, version: true, quality: true, made: true, startedAt: true, finishedAt: true, project: { select: { id: true, name: true, folder: { select: { name: true } } } } },
  }) : [];
  const byId = new Map(renders.map((x) => [x.id, x]));
  // Real meters: what each render's job used on Rendrr's servers, measured by the worker (the container's CPU and
  // memory counters, shared among the jobs running at the time). A render made on the user's computer still has a
  // small job here (planning it, handing it over); the encode itself used the computer's own chip. Never costs.
  const jobs = rr.length ? await prisma.jobCost.groupBy({ by: ["refId"], where: { refId: { in: rr.map((r) => r.refId) }, kind: { startsWith: "render_" } }, _sum: { cpuSeconds: true, memGbSeconds: true, wallMs: true } }) : [];
  const jobOf = new Map(jobs.map((j) => [j.refId!, { cpu: j._sum.cpuSeconds ?? 0, memGbS: j._sum.memGbSeconds ?? 0, wallS: (j._sum.wallMs ?? 0) / 1000 }]));
  const compute = { cpuSeconds: 0, memGbSeconds: 0, jobSeconds: 0, runSeconds: zero(), measured: 0 };
  const minutes = zero(), counted = zero(), count = zero();
  const preview = zero(), exportMin = zero();
  const videos = new Map<string, { id: string; name: string; folder: string | null; minutes: number; counted: number; computer: number; cloud: number; last: string; renders: unknown[] }>();
  rr.forEach((r, i) => {
    const meta = (r.meta || {}) as { on?: string; projectId?: string; quality?: string | null; fourK?: boolean; heavy?: boolean; samples?: boolean };
    const x = byId.get(r.refId);
    const made = (x?.made ?? null) as Made;
    const where: keyof Split = (meta.on ?? made?.on) === "mac" ? "computer" : "cloud";
    minutes[where] += r.quantity; counted[where] += r.billable; count[where] += 1;
    (r.metric === "export" ? exportMin : preview)[where] += r.quantity;
    const job = jobOf.get(r.refId);
    if (job) { compute.cpuSeconds += job.cpu; compute.memGbSeconds += job.memGbS; compute.jobSeconds += job.wallS; compute.measured++; }
    const runS = x?.startedAt && x.finishedAt ? Math.max(0, (x.finishedAt.getTime() - x.startedAt.getTime()) / 1000) : null;
    if (runS != null) compute.runSeconds[where] += runS;
    if (i >= limit) return;
    const pid = x?.project.id ?? meta.projectId ?? "gone";
    const v = videos.get(pid) ?? { id: pid, name: x?.project.name ?? "A deleted edit", folder: x?.project.folder?.name ?? null, minutes: 0, counted: 0, computer: 0, cloud: 0, last: r.createdAt.toISOString(), renders: [] };
    v.minutes += r.quantity; v.counted += r.billable; v[where] += r.quantity;
    v.renders.push({
      id: r.refId, at: r.createdAt.toISOString(), kind: r.metric === "export" ? "export" : "preview", version: x?.version ?? null, samples: !!meta.samples,
      minutes: r2(r.quantity), counted: r2(r.billable), where, platform: where === "computer" ? (made?.platform === "windows" ? "windows" : "mac") : null,
      device: where === "computer" ? made?.device ?? null : null, why: where === "cloud" ? made?.why ?? null : null,
      quality: x?.quality ?? meta.quality ?? null, fourK: !!meta.fourK, heavy: !!meta.heavy,
      runSeconds: runS == null ? null : Math.round(runS),
      server: job ? { cpuSeconds: Math.round(job.cpu * 10) / 10, avgMemoryGB: job.wallS > 0 ? r2(job.memGbS / job.wallS) : null, seconds: Math.round(job.wallS) } : null,
    });
    videos.set(pid, v);
  });
  const sp = (s: Split) => ({ computer: r2(s.computer), cloud: r2(s.cloud) });
  return {
    total: { minutes: r2(minutes.computer + minutes.cloud), counted: r2(counted.computer + counted.cloud), renders: rr.length },
    minutes: sp(minutes), counted: sp(counted), count, preview: sp(preview), export: sp(exportMin),
    // What was really used: time each render took where it ran, and the servers' measured CPU and memory. Rendrr's
    // cloud renders on CPUs (no GPU), so there is no GPU meter.
    compute: {
      runMinutes: sp({ computer: compute.runSeconds.computer / 60, cloud: compute.runSeconds.cloud / 60 }),
      serverCpuMinutes: r2(compute.cpuSeconds / 60), serverMemoryGbMinutes: r2(compute.memGbSeconds / 60),
      avgMemoryGB: compute.jobSeconds > 0 ? r2(compute.memGbSeconds / compute.jobSeconds) : null,
      measuredRenders: compute.measured, gpu: false,
    },
    videos: Array.from(videos.values()).map((v) => ({ ...v, minutes: r2(v.minutes), counted: r2(v.counted), computer: r2(v.computer), cloud: r2(v.cloud) })),
    more: Math.max(0, rr.length - limit),
  };
}

/**
 * Footage added this period, by where it came from: the user's own computer (an upload from the browser, or the Rendrr
 * app's own copy) or cloud storage (Google Drive and other linked storage). Minutes are the footage's length; counted
 * is what the plan counted, from the same rows the bill uses.
 */
export async function footageBySource(rows: UsageRow[], limit = 200) {
  const fr = rows.filter((r) => r.metric === "footage").sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  const vids = fr.length ? await prisma.video.findMany({ where: { id: { in: fr.map((r) => r.refId) } }, select: { id: true, name: true, source: true } }) : [];
  const byId = new Map(vids.map((v) => [v.id, v]));
  const fromOf = (src?: string | null): "computer" | "cloud" | "rendrr" => (src === "upload" || src === "local" ? "computer" : src === "canvas" || src === "placeholder" ? "rendrr" : "cloud");
  const minutes = { computer: 0, cloud: 0, rendrr: 0 }, counted = { computer: 0, cloud: 0, rendrr: 0 };
  const list = fr.map((r) => {
    const v = byId.get(r.refId), from = fromOf(v?.source ?? (r.meta as { source?: string })?.source);
    minutes[from] += r.quantity; counted[from] += r.billable;
    return { id: r.refId, name: v?.name ?? (r.meta as { name?: string })?.name ?? "Deleted footage", at: r.createdAt.toISOString(), from, source: v?.source ?? null, minutes: r2(r.quantity), counted: r2(r.billable) };
  });
  const k = (o: typeof minutes) => ({ computer: r2(o.computer), cloud: r2(o.cloud), rendrr: r2(o.rendrr) });
  return { minutes: k(minutes), counted: k(counted), total: r2(minutes.computer + minutes.cloud + minutes.rendrr), videos: list.slice(0, limit), more: Math.max(0, list.length - limit) };
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
