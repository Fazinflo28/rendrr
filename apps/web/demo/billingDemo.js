// Demo Usage & billing and admin data, built with the real shared billing code so the pages see the server's shapes.
// Tests pick the account: globalThis.__demoPlan = "trial" | "starter" | "comp" (default "starter"),
// __demoUsage = { exportMinutes, previewMinutes, footageMinutes, storageGBNow }, __demoAdmin = true for the admin menu.
import { DEFAULT_SPEND_LIMIT_CENTS, PAYG, PLAN_INFO, TRIAL_DAYS, COST_RATES, statement } from "../../../packages/shared/src/billing.ts";

const DAY = 86_400_000;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const r2 = (n) => Math.round(n * 100) / 100;
const iso = (t) => new Date(t).toISOString();
const state = { spendLimitCents: DEFAULT_SPEND_LIMIT_CENTS, users: null, actions: [], resolved: new Set() };

function usageNow() {
  const u = globalThis.__demoUsage || { exportMinutes: 31.5, previewMinutes: 48, footageMinutes: 72, storageGBNow: 6.4 };
  return { exportMinutes: u.exportMinutes ?? 0, previewMinutes: u.previewMinutes ?? 0, footageMinutes: u.footageMinutes ?? 0, storageGBNow: u.storageGBNow ?? 0, storageGbByDay: Array(12).fill(u.storageGBNow ?? 0) };
}

export function demoBillingOverview() {
  const plan = globalThis.__demoPlan || "starter";
  const info = PLAN_INFO[plan];
  const now = Date.now();
  const gone = plan === "trial" ? 3 : 11; // days into the period (a trial has 4 days left)
  const start = now - gone * DAY, end = plan === "trial" ? start + TRIAL_DAYS * DAY : start + 30 * DAY;
  const usage = usageNow();
  const st = statement(plan, usage, {});
  const days = [];
  const per = [0.5, 0, 2.5, 4, 0, 1.5, 6, 3, 0, 5, 4.5, 4.5].slice(-(gone + 1));
  for (let i = 0; i < per.length; i++) {
    const f = per[i] / per.reduce((s, x) => s + x, 0);
    days.push({ date: iso(start + i * DAY).slice(0, 10), export: r2(usage.exportMinutes * f), preview: r2(usage.previewMinutes * f), footage: r2(usage.footageMinutes * f) });
  }
  const total = end - start, past = Math.min(total, Math.max(DAY, now - start));
  const ended = plan === "trial" && globalThis.__demoTrialEnded;
  return {
    plan, planName: info.name, status: ended ? "expired" : plan === "trial" ? "trialing" : "active", blurb: info.blurb, priceCents: info.priceCents,
    period: { start: iso(start), end: iso(end), daysLeft: Math.max(0, Math.ceil((end - now) / DAY)) },
    trial: plan === "trial" ? { endsAt: iso(ended ? now - DAY : start + TRIAL_DAYS * DAY), daysLeft: ended ? 0 : Math.max(0, Math.ceil((start + TRIAL_DAYS * DAY - now) / DAY)), days: TRIAL_DAYS, ended: !!ended } : null,
    meters: st.meters, lines: st.lines, baseCents: st.baseCents, usageCents: st.usageCents, totalCents: st.totalCents,
    projectedCents: Math.round(st.baseCents + (st.usageCents * total) / past),
    spendLimitCents: state.spendLimitCents, defaultSpendLimitCents: DEFAULT_SPEND_LIMIT_CENTS,
    bonus: { exportMinutes: 0, footageMinutes: 0 },
    rates: { exportMinuteCents: PAYG.exportMinuteCents, footageHourCents: PAYG.footageHourCents, storageGbMonthCents: PAYG.storageGbMonthCents, fourKMultiplier: 2 },
    plans: ["trial", "starter"].map((id) => ({ id, name: PLAN_INFO[id].name, priceCents: PLAN_INFO[id].priceCents, allowance: PLAN_INFO[id].allowance, blurb: PLAN_INFO[id].blurb, payAsYouGo: PLAN_INFO[id].payAsYouGo, fourK: PLAN_INFO[id].fourK })),
    storage: { totalGB: usage.storageGBNow, byKind: { footage: r2(usage.storageGBNow * 0.55), previews: r2(usage.storageGBNow * 0.2), finals: r2(usage.storageGBNow * 0.15), originals: r2(usage.storageGBNow * 0.07), audio: r2(usage.storageGBNow * 0.02), other: r2(usage.storageGBNow * 0.01) } },
    days,
    byProject: [
      { id: "f1", name: "Fazinflo", exportMinutes: r2(usage.exportMinutes * 0.6), previewMinutes: r2(usage.previewMinutes * 0.5), edits: 6 },
      { id: "f2", name: "Podcast", exportMinutes: r2(usage.exportMinutes * 0.4), previewMinutes: r2(usage.previewMinutes * 0.5), edits: 3 },
    ],
    payments: { enabled: true, enforced: true, card: plan === "starter", customer: plan === "starter" },
    invoices: plan === "starter" ? [
      { id: "in1", number: "RENDRR-0002", periodStart: iso(start - 30 * DAY), periodEnd: iso(start), totalCents: 742, usageCents: 242, status: "paid", url: "#", pdf: "#", paidAt: iso(start) },
      { id: "in2", number: "RENDRR-0001", periodStart: iso(start - 60 * DAY), periodEnd: iso(start - 30 * DAY), totalCents: 500, usageCents: 0, status: "paid", url: "#", pdf: "#", paidAt: iso(start - 30 * DAY) },
    ] : [],
  };
}

// ---- Admin ----
const NAMES = [["Ronnii K", "ronnii@fazinflo.com", "comp"], ["Maya Chen", "maya@studio.co", "starter"], ["Leo Park", "leo@clips.io", "starter"], ["Ana Ruiz", "ana@gmail.com", "trial"], ["Sam Ode", "sam@agency.net", "trial"], ["Iris Wolf", "iris@brand.com", "starter"]];
function users() {
  if (state.users) return state.users;
  const now = Date.now();
  state.users = NAMES.map(([name, email, plan], i) => ({
    id: "u" + (i + 1), name, email, plan, status: plan === "trial" ? (i === 4 ? "expired" : "trialing") : "active", role: i === 0 ? "admin" : "user",
    trialEndsAt: iso(now + (i === 4 ? -2 : 3) * DAY), createdAt: iso(now - (40 - i * 6) * DAY), lastActiveAt: iso(now - i * 3600_000),
    usage30: { exportMinutes: [12, 41.5, 18, 6, 10, 27][i], previewMinutes: [30, 80, 44, 20, 35, 52][i], footageMinutes: [40, 95, 60, 22, 30, 58][i] },
    cost30: [0.21, 0.74, 0.33, 0.09, 0.15, 0.48][i], revenueAll: [0, 12.42, 5, 0, 0, 10][i], marginAll: [null, 94.04, 93.4, null, null, 95.2][i],
    storageGB: [3.1, 8.6, 4.2, 1.1, 2.3, 6.9][i], videos: [14, 31, 12, 4, 6, 19][i], edits: [9, 22, 8, 3, 2, 12][i], hasCard: plan === "starter",
    bonus: { exportMinutes: 0, footageMinutes: 0 }, spendLimitCents: DEFAULT_SPEND_LIMIT_CENTS,
  }));
  return state.users;
}

function series(days) {
  const now = Date.now();
  return Array.from({ length: days }, (_, i) => {
    const w = 0.6 + ((i * 7) % 5) / 5;
    return { date: iso(now - (days - 1 - i) * DAY).slice(0, 10), compute: r2(0.08 * w), memory: r2(0.05 * w), transcription: r2(0.03 * w), egress: r2(0.004 * w), storage: 0.012, fixed: 0.5, revenue: i % 9 === 3 ? 5 : 0, exportMinutes: r2(4 * w), previewMinutes: r2(9 * w), footageMinutes: r2(11 * w), signups: i % 6 === 0 ? 1 : 0 };
  });
}

function overview() {
  const list = users();
  const s = series(30);
  const sum = (k) => r2(s.reduce((t, d) => t + d[k], 0));
  const cost30 = r2(sum("compute") + sum("memory") + sum("transcription") + sum("egress") + sum("storage") + sum("fixed"));
  const revenue30 = sum("revenue");
  return {
    users: { total: list.length, new7d: 2, active7d: 5, trialing: list.filter((u) => u.status === "trialing").length, trialEnded: list.filter((u) => u.status === "expired").length, starter: list.filter((u) => u.plan === "starter").length, pastDue: 0, canceled: 0, comp: list.filter((u) => u.plan === "comp").length },
    money: { mrr: r2(list.filter((u) => u.plan === "starter").length * 5), revenue30, cost30, margin30: revenue30 > 0 ? r2(((revenue30 - cost30) / revenue30) * 100) : null, costParts30: { compute: sum("compute"), memory: sum("memory"), transcription: sum("transcription"), egress: sum("egress"), storage: sum("storage"), fixed: sum("fixed") }, costToday: 0.17, costPerExportMinute: r2((cost30 - sum("fixed")) / sum("exportMinutes")) },
    usage30: { export: { minutes: sum("exportMinutes"), count: 61 }, preview: { minutes: sum("previewMinutes"), count: 140 }, footage: { minutes: sum("footageMinutes"), count: 38 } },
    renders30: { done: 196, failed: 3, stopped: 2 },
    storage: { totalGB: r2(list.reduce((t, u) => t + u.storageGB, 0)), day: iso(Date.now()).slice(0, 10) },
    issues: { failedRenders24h: 1, failedJobs24h: 2, clientErrors24h: 1, aiToolErrors24h: 3, stuckRenders: 0 },
    product: { edits: 56, edits30: 31, videos: 86, folders: 9, reviews: 14, reviewComments: 47, gallery: 6, aiConnections: 5, aiUsed30: 4, finals30: 41, onComputers30: 63, styles: 12 },
    queues: { render: { waiting: 0, active: 1, failed: 2, delayed: 0 }, proxy: { waiting: 1, active: 0, failed: 0, delayed: 0 }, analyze: { waiting: 0, active: 0, failed: 1, delayed: 0 }, graphic: { waiting: 0, active: 0, failed: 0, delayed: 0 } },
    rates: { ...COST_RATES, fixedMonthly: 15 },
    series: s,
  };
}

function listUsers(o = {}) {
  let rows = users().slice();
  const q = (o.q || "").trim().toLowerCase();
  if (q) rows = rows.filter((u) => u.email.includes(q) || u.name.toLowerCase().includes(q) || u.id === q);
  if (o.plan) rows = rows.filter((u) => u.plan === o.plan);
  const key = { recent: (r) => r.lastActiveAt, cost: (r) => r.cost30, usage: (r) => r.usage30.exportMinutes + r.usage30.footageMinutes, storage: (r) => r.storageGB, revenue: (r) => r.revenueAll, name: (r) => r.name.toLowerCase() }[o.sort || "recent"] || ((r) => r.lastActiveAt);
  rows.sort((a, b) => (o.sort === "name" ? String(key(a)).localeCompare(String(key(b))) : key(a) < key(b) ? 1 : key(a) > key(b) ? -1 : 0));
  return { total: rows.length, offset: 0, users: rows.map(({ bonus, spendLimitCents, ...r }) => r) };
}

function userDetail(id) {
  const u = users().find((x) => x.id === id);
  if (!u) throw Object.assign(new Error("No such user."), { status: 404 });
  const now = Date.now(), start = now - 11 * DAY;
  const usage = { exportMinutes: u.usage30.exportMinutes, previewMinutes: u.usage30.previewMinutes, footageMinutes: u.usage30.footageMinutes, storageGBNow: u.storageGB, storageGbByDay: Array(12).fill(u.storageGB) };
  return {
    user: { id: u.id, name: u.name, email: u.email, role: u.role, createdAt: u.createdAt, lastActiveAt: u.lastActiveAt, stripeCustomerId: u.hasCard ? "cus_demo" + u.id : null, stripeSubscriptionId: u.hasCard ? "sub_demo" + u.id : null },
    billing: { plan: u.plan, status: u.status, trialEndsAt: u.trialEndsAt, period: { start: iso(start), end: iso(u.plan === "trial" ? start + 7 * DAY : start + 30 * DAY) }, spendLimitCents: u.spendLimitCents, bonus: u.bonus, statement: statement(u.plan, usage, u.bonus), usage },
    costsByKind: [
      { kind: "render", jobs: 24, cost: r2(u.cost30 * 0.62), cpuSeconds: 4100, transcribeMinutes: 0, egressGB: 0.4 },
      { kind: "proxy", jobs: u.videos, cost: r2(u.cost30 * 0.18), cpuSeconds: 1200, transcribeMinutes: 0, egressGB: 0 },
      { kind: "analyze", jobs: u.videos, cost: r2(u.cost30 * 0.15), cpuSeconds: 160, transcribeMinutes: u.usage30.footageMinutes, egressGB: 0 },
      { kind: "graphic", jobs: 5, cost: r2(u.cost30 * 0.05), cpuSeconds: 300, transcribeMinutes: 0, egressGB: 0 },
    ],
    renders: [
      { id: "r1", project: "Founder story", kind: "final", status: "done", quality: "1080p", seconds: 92, sizeMB: 84.2, by: "claude", error: null, errorCode: null, createdAt: iso(now - 3600_000), tookSeconds: 71, cost: 0.012, cpuSeconds: 210 },
      { id: "r2", project: "Founder story", kind: "preview", status: "done", quality: "720p", seconds: 92, sizeMB: 22.5, by: "claude", error: null, errorCode: null, createdAt: iso(now - 2 * 3600_000), tookSeconds: 24, cost: 0.003, cpuSeconds: 48 },
      { id: "r3", project: "Office tour", kind: "final", status: "failed", quality: "4K", seconds: 60, sizeMB: 0, by: "web", error: "ffmpeg exited with code 1", errorCode: "render_failed", createdAt: iso(now - 5 * 3600_000), tookSeconds: 40, cost: 0.006, cpuSeconds: 95 },
    ],
    usageRecords: [
      { id: "ur1", metric: "export", quantity: 1.53, billable: 1.53, refId: "r1", meta: { projectId: "p1" }, createdAt: iso(now - 3600_000) },
      { id: "ur2", metric: "footage", quantity: 4.2, billable: 4.2, refId: "v1", meta: {}, createdAt: iso(now - 26 * 3600_000) },
    ],
    storage: { totalGB: u.storageGB, byKind: { footage: r2(u.storageGB * 0.6), previews: r2(u.storageGB * 0.2), finals: r2(u.storageGB * 0.2) }, videos: u.videos },
    failures: [{ queue: "render", jobId: "j-r3", error: "ffmpeg exited with code 1", at: iso(now - 5 * 3600_000) }],
    toolErrors: [{ tool: "apply_edits", error: "Unknown op: zoom_to", ai: "claude", at: iso(now - 7 * 3600_000) }],
    invoices: u.revenueAll ? [{ id: "in-" + u.id, number: "RENDRR-0001", totalCents: Math.round(u.revenueAll * 100), usageCents: Math.max(0, Math.round(u.revenueAll * 100) - 500), status: "paid", url: "#", periodStart: iso(start - 30 * DAY), periodEnd: iso(start) }] : [],
    actions: state.actions.filter((a) => a.targetId === u.id).map(({ targetId, ...a }) => a),
  };
}

function change(id, c) {
  const u = users().find((x) => x.id === id);
  if (!u) throw Object.assign(new Error("No such user."), { status: 404 });
  if (c.plan === "comp") Object.assign(u, { plan: "comp", status: "active" });
  if (c.plan === "trial") { if (u.plan === "starter" && u.hasCard) throw Object.assign(new Error("This account pays for Starter. Cancel it in Stripe first."), { friendly: true, status: 400 }); Object.assign(u, { plan: "trial", status: "trialing" }); }
  if (c.trialDays) { const base = Math.max(Date.now(), new Date(u.trialEndsAt).getTime()); u.trialEndsAt = iso(base + c.trialDays * DAY); if (u.plan === "trial") u.status = "trialing"; }
  if (c.bonusExportMinutes) u.bonus.exportMinutes = Math.max(0, u.bonus.exportMinutes + c.bonusExportMinutes);
  if (c.bonusFootageMinutes) u.bonus.footageMinutes = Math.max(0, u.bonus.footageMinutes + c.bonusFootageMinutes);
  if (c.spendLimitCents != null) u.spendLimitCents = Math.max(0, Math.round(c.spendLimitCents));
  if (c.role) u.role = c.role;
  const { reason, ...what } = c;
  state.actions.unshift({ targetId: id, action: Object.keys(what).join(","), meta: { ...what, ...(reason ? { reason } : {}) }, adminId: "u1", at: iso(Date.now()) });
  globalThis.__demoAdminChanges = [...(globalThis.__demoAdminChanges || []), { id, ...c }];
  return userDetail(id);
}

function costs(days = 30) {
  const o = overview();
  return {
    days, total: o.money.cost30, jobs: r2(o.money.costParts30.compute + o.money.costParts30.memory + o.money.costParts30.transcription + o.money.costParts30.egress), storage: o.money.costParts30.storage, fixed: o.money.costParts30.fixed,
    perExportMinute: o.money.costPerExportMinute,
    byKind: [
      { kind: "render", jobs: 201, cost: 2.31, perJob: 0.0115, parts: { compute: 1.4, memory: 0.91, transcription: 0, egress: 0 }, cpuSecondsPerJob: 180, avgSeconds: 52, egressGB: 0 },
      { kind: "analyze", jobs: 38, cost: 0.96, perJob: 0.0253, parts: { compute: 0.06, memory: 0.04, transcription: 0.86, egress: 0 }, cpuSecondsPerJob: 12, avgSeconds: 95, egressGB: 0 },
      { kind: "proxy", jobs: 38, cost: 0.55, perJob: 0.0145, parts: { compute: 0.33, memory: 0.22, transcription: 0, egress: 0 }, cpuSecondsPerJob: 70, avgSeconds: 40, egressGB: 0 },
      { kind: "idle", jobs: 720, cost: 0.4, perJob: 0.0006, parts: { compute: 0.1, memory: 0.3, transcription: 0, egress: 0 }, cpuSecondsPerJob: 1, avgSeconds: 3600, egressGB: 0 },
      { kind: "drive", jobs: 9, cost: 0.05, perJob: 0.0056, parts: { compute: 0.01, memory: 0.01, transcription: 0, egress: 0.03 }, cpuSecondsPerJob: 3, avgSeconds: 18, egressGB: 0.6 },
    ],
    topUsers: users().slice().sort((a, b) => b.cost30 - a.cost30).map((u) => ({ id: u.id, name: u.name, email: u.email, plan: u.plan, cost: u.cost30 })),
    series: series(Math.min(days, 90)),
  };
}

function storageReport() {
  const list = users();
  const total = r2(list.reduce((t, u) => t + u.storageGB, 0));
  return {
    totalGB: total, byKindGB: { footage: r2(total * 0.55), previews: r2(total * 0.2), finals: r2(total * 0.15), originals: r2(total * 0.07), audio: r2(total * 0.02), other: r2(total * 0.01) },
    monthlyCost: r2(total * COST_RATES.storagePerGBMonth),
    top: list.slice().sort((a, b) => b.storageGB - a.storageGB).map((u) => ({ id: u.id, name: u.name, email: u.email, plan: u.plan, gb: u.storageGB, day: iso(Date.now()) })),
    series: Array.from({ length: 30 }, (_, i) => ({ day: iso(Date.now() - (29 - i) * DAY).slice(0, 10), gb: r2(total * (0.6 + (0.4 * i) / 29)) })),
  };
}

function issues(days = 7) {
  const now = Date.now();
  return {
    days,
    failedJobs: [{ key: "a1", where: "render", error: "ffmpeg exited with code #", count: 2, users: 1, last: iso(now - 5 * 3600_000), sample: "j-r3", final: 1 }, { key: "a2", where: "analyze", error: "AssemblyAI: audio too short", count: 1, users: 1, last: iso(now - 30 * 3600_000), sample: "j-a9", final: 0 }],
    failedRenders: [{ key: "b1", where: "render final (render_failed)", error: "ffmpeg exited with code #", count: 1, users: 1, last: iso(now - 5 * 3600_000), sample: "r3" }],
    aiToolErrors: [{ key: "c1", where: "tool apply_edits", error: "Unknown op: zoom_to", count: 3, users: 2, last: iso(now - 7 * 3600_000), sample: "claude" }],
    stuck: [],
    clientErrors: state.resolved.has("ce1") ? [] : [{ id: "ce1", message: "TypeError: Cannot read properties of undefined (reading 'clips')", url: "https://app.rendrr.live/editor/p5", count: 4, userId: "u3", firstSeen: iso(now - 2 * DAY), lastSeen: iso(now - 3600_000), stack: "at Timeline (editor.js:812)\nat renderWithHooks" }],
    queueTimes: [{ queue: "render", jobs: 196, avgSeconds: 52, maxSeconds: 610 }, { queue: "analyze", jobs: 38, avgSeconds: 95, maxSeconds: 400 }, { queue: "proxy", jobs: 38, avgSeconds: 40, maxSeconds: 180 }],
  };
}

function jobs(o = {}) {
  const now = Date.now();
  const rows = [
    { id: 1, queue: "render", jobId: "j-r1", name: "final", event: "finish", userId: "u2", durationMs: 71000, error: null, at: iso(now - 3600_000) },
    { id: 2, queue: "render", jobId: "j-r3", name: "final", event: "fail", userId: "u3", durationMs: 40000, error: "ffmpeg exited with code 1", at: iso(now - 5 * 3600_000) },
    { id: 3, queue: "analyze", jobId: "j-a7", name: "analyze", event: "finish", userId: "u2", durationMs: 95000, error: null, at: iso(now - 6 * 3600_000) },
    { id: 4, queue: "proxy", jobId: "j-p7", name: "proxy", event: "start", userId: "u4", durationMs: null, error: null, at: iso(now - 600_000) },
  ];
  return rows.filter((r) => (!o.queue || r.queue === o.queue) && (!o.event || r.event === o.event));
}

// ---- The admin sections modelled on Dragly's panel ----
const person = (id) => { const u = users().find((x) => x.id === id); return u ? { id: u.id, name: u.name, email: u.email, plan: u.plan } : { id, name: "", email: "", plan: "" }; };
function folders(o = {}) {
  const now = Date.now();
  const all = [["Fazinflo", "Ronnii's studio", "u1"], ["Engine Room PT", "Ronnii's studio", "u1"], ["Movemend PT", "Ronnii's studio", "u1"], ["Podcast clips", "Maya Chen", "u2"], ["Brand ads", "Maya Chen", "u2"], ["Shorts", "Leo Park", "u3"], ["Wedding", "Ana Ruiz", "u4"], ["Agency reels", "Sam Ode", "u5"], ["Launch video", "Jo Lee", "u6"]]
    .map(([name, workspace, uid], i) => ({ id: "fd" + (i + 1), name, workspace, members: 1, hasFootage: i % 3 !== 2, owner: person(uid), edits: [9, 14, 6, 11, 5, 8, 3, 2, 6][i], edits30: [5, 9, 6, 4, 1, 6, 1, 0, 3][i], finals30: [6, 12, 8, 4, 0, 7, 1, 0, 3][i], reviews: [2, 4, 3, 1, 0, 2, 1, 0, 1][i], reviewViews: [11, 37, 18, 6, 0, 9, 4, 0, 2][i], createdAt: iso(now - (60 - i * 5) * DAY), lastActive: iso(now - i * 5 * 3600_000) }));
  const q = (o.q || "").toLowerCase();
  const list = q ? all.filter((f) => [f.name, f.workspace, f.owner.email].some((x) => x.toLowerCase().includes(q))) : all;
  return { total: list.length, all: all.length, offset: o.offset || 0, folders: list.slice(o.offset || 0, (o.offset || 0) + 50) };
}
function billingAdmin(o = {}) {
  const now = Date.now();
  const inv = [["u2", "RENDRR-0006", "paid", 500, 742], ["u3", "RENDRR-0005", "paid", 500, 0], ["u6", "RENDRR-0004", "failed", 500, 318], ["u2", "RENDRR-0003", "paid", 500, 410], ["u6", "RENDRR-0002", "paid", 500, 0], ["u3", "RENDRR-0001", "open", 500, 120]]
    .map(([uid, number, status, base, usage], i) => ({ id: "bi" + i, user: person(uid), number, status, base: base / 100, usage: usage / 100, total: (base + usage) / 100, url: "#", periodStart: iso(now - (30 + i * 6) * DAY), periodEnd: iso(now - i * 6 * DAY), paidAt: status === "paid" ? iso(now - i * 6 * DAY) : null, createdAt: iso(now - i * 6 * DAY) }));
  const list = o.status ? inv.filter((i) => i.status === o.status) : inv;
  return {
    payments: globalThis.__demoPaymentsOn !== false, revenueAll: 46.7, paidInvoices: 4, revenue30: 27.42, payments30: 3, base30: 15, usage30: 12.42, failed30: 1, openCount: 1, openAmount: 6.2, mrr: 15,
    plans: [{ plan: "starter", label: "Starter", users: 3, pastDue: 1, canceled: 0, mrr: 15 }, { plan: "trial", label: "Trial", users: 1, ended: 1, mrr: 0 }, { plan: "comp", label: "Complimentary", users: 1, mrr: 0 }],
    given30: { exportMinutes: 30, footageMinutes: 0 }, total: list.length, offset: 0, invoices: list,
  };
}
function renders(days = 7) {
  const now = Date.now();
  const perDay = Array.from({ length: days }, (_, i) => ({ day: iso(now - (days - 1 - i) * DAY).slice(0, 10), renders: 8 + ((i * 5) % 7), failed: i % 4 === 1 ? 1 : 0, computer: 4 + (i % 3) }));
  return {
    days, since: iso(now - days * DAY), total: 74, done: 70, failed: 3, successRate: 95.89, onComputers: 38, medianSeconds: 48,
    groups: [
      { key: "preview:computer", label: "Previews on people's computers", total: 30, done: 30, failed: 0, running: 0, minutes: 41.5, successRate: 100, medianSeconds: 14, lastOk: iso(now - 600_000), lastFail: null, reasons: [] },
      { key: "preview:cloud", label: "Previews on the cloud", total: 18, done: 17, failed: 1, running: 0, minutes: 22, successRate: 94.44, medianSeconds: 36, lastOk: iso(now - 3600_000), lastFail: { at: iso(now - 8 * 3600_000), error: "Clip missing" }, reasons: [{ reason: "clip_missing", n: 1 }] },
      { key: "final:computer", label: "Finals on people's computers", total: 8, done: 8, failed: 0, running: 0, minutes: 9.1, successRate: 100, medianSeconds: 58, lastOk: iso(now - 2 * 3600_000), lastFail: null, reasons: [] },
      { key: "final:cloud", label: "Finals on the cloud", total: 18, done: 15, failed: 2, running: 1, minutes: 19.4, successRate: 88.24, medianSeconds: 96, lastOk: iso(now - 3 * 3600_000), lastFail: { at: iso(now - 5 * 3600_000), error: "ffmpeg exited with code 1" }, reasons: [{ reason: "render_failed", n: 2 }] },
    ],
    byWho: { user: 41, claude: 30, chatgpt: 3 }, perDay,
    recentFailures: [{ id: "r3", at: iso(now - 5 * 3600_000), kind: "final", place: "cloud", project: "Ad v12", error: "ffmpeg exited with code 1", errorCode: "render_failed", by: "claude", user: person("u3") }, { id: "r9", at: iso(now - 8 * 3600_000), kind: "preview", place: "cloud", project: "Lifter v14", error: "Clip missing", errorCode: "clip_missing", by: "user", user: person("u2") }],
  };
}
function audit(o = {}) {
  const now = Date.now();
  const seed = [{ id: "a1", at: iso(now - 26 * 3600_000), admin: person("u1"), target: person("u5"), action: "trialDays", change: { trialDays: 7 }, reason: "Asked for more time to test" }, { id: "a2", at: iso(now - 3 * DAY), admin: person("u1"), target: person("u2"), action: "bonusExportMinutes", change: { bonusExportMinutes: 30 }, reason: "Render failed twice on our side" }];
  const live = state.actions.map((a, i) => { const { reason, ...change } = a.meta || {}; return { id: "live" + i, at: a.at, admin: person(a.adminId), target: person(a.targetId), action: a.action, change, reason: reason || null }; });
  const q = (o.q || "").toLowerCase();
  const rows = [...live, ...seed].filter((r) => !q || [r.admin.email, r.target.email, r.target.name, r.action, r.reason || ""].some((x) => x.toLowerCase().includes(q)));
  return { total: rows.length, offset: 0, rows };
}
function connectionsDemo() {
  const now = Date.now();
  const ai = [["u1", "claude", "Claude"], ["u2", "claude", "Claude"], ["u3", "chatgpt", "ChatGPT"], ["u6", "claude", "Claude"]].map(([uid, client, clientName], i) => ({ id: "ai" + i, user: person(uid), client, clientName, lastSeenAt: iso(now - i * 9 * 3600_000), revoked: false, createdAt: iso(now - (20 + i) * DAY) }));
  const computers = [{ userId: "u1", id: "m1", name: "Ronnii's MacBook Pro", platform: "mac", version: "0.1.20", at: iso(now - 20_000), online: true, canRender: true, user: person("u1") }, { userId: "u2", id: "w1", name: "MAYA-PC", platform: "windows", version: "0.1.10", at: iso(now - 4 * 3600_000), online: false, canRender: true, user: person("u2") }];
  return { ai, aiSummary: { claude: 3, chatgpt: 1, other: 0, used7d: 3 }, computers, versions: [{ version: "mac 0.1.20", n: 1 }, { version: "windows 0.1.10", n: 1 }] };
}
function galleryDemo() {
  const now = Date.now();
  const items = [["The Lifter", "u1", "Bold captions", "9:16", 31, 140, 12, 3], ["Just Stop", "u1", "Clean", "9:16", 24, 96, 7, 1], ["Podcast hook", "u2", "Podcast", "16:9", 58, 51, 4, 2]].map(([title, uid, style, ori, seconds, views, likes, recreates], i) => ({ id: "g" + i, title, author: person(uid).name, user: person(uid), style, shape: ori, platforms: ["Instagram", "TikTok"], likes, views, recreates, allowRecreate: i !== 2, seconds, hasVideo: true, createdAt: iso(now - (i + 2) * DAY) }));
  return { total: items.length, views: 287, likes: 23, recreates: 6, items };
}
function healthDemo() {
  const now = Date.now();
  return {
    checkedAt: iso(now), live: { db: { ok: true, ms: 12 }, redis: { ok: true, ms: 3 }, worker: { lastSeen: iso(now - 240_000), lastJob: { at: iso(now - 240_000), queue: "preview", event: "finish" } } },
    jobs: { finished1h: 14, failed1h: 0, failed24h: 2, browserErrors24h: 1 },
    keys: { storage: true, signIn: true, transcription: true, google: true, payments: false, webhook: false, encryption: true },
    switches: { maintenance: false, billingEnforce: "auto", localRendersFree: false, macRender: "default" },
    deploy: { commit: "c6f14f7", environment: "production", node: "v22.20.0", upSeconds: 5400 },
    migrations: [{ name: "20261126120000_folder_footage", ok: true, at: iso(now - DAY) }, { name: "20261124090000_render_made", ok: true, at: iso(now - 3 * DAY) }],
    queues: overview().queues,
  };
}

export const demoBillingApi = {
  getBillingOverview: async () => { await wait(120); return demoBillingOverview(); },
  startCheckout: async () => { await wait(100); globalThis.__demoCheckout = (globalThis.__demoCheckout || 0) + 1; return { url: "/usage?paid=1" }; },
  openBillingPortal: async () => { await wait(100); globalThis.__demoPortal = (globalThis.__demoPortal || 0) + 1; return { url: "/billing" }; },
  setSpendLimit: async (cents) => { await wait(100); state.spendLimitCents = Math.max(0, Math.min(100_000, Math.round(cents))); return { spendLimitCents: state.spendLimitCents }; },
  adminMe: async () => { if (!globalThis.__demoAdmin) throw Object.assign(new Error("Admins only."), { status: 403 }); return { admin: true }; },
  adminOverview: async () => { await wait(120); return overview(); },
  adminUsers: async (o) => { await wait(80); return listUsers(o); },
  adminUser: async (id) => { await wait(80); return userDetail(id); },
  adminChangeUser: async (id, c) => { await wait(100); return change(id, c); },
  adminCosts: async (days) => { await wait(80); return costs(days); },
  adminStorage: async () => { await wait(80); return storageReport(); },
  adminIssues: async (days) => { await wait(80); return issues(days); },
  adminResolveClientError: async (id) => { await wait(60); state.resolved.add(id); return { ok: true }; },
  adminJobs: async (o) => { await wait(60); return jobs(o); },
  adminFolders: async (o) => { await wait(70); return folders(o); },
  adminBilling: async (o) => { await wait(70); return billingAdmin(o); },
  adminRenders: async (days) => { await wait(70); return renders(days); },
  adminAudit: async (o) => { await wait(60); return audit(o); },
  adminConnections: async () => { await wait(60); return connectionsDemo(); },
  adminHealth: async () => { await wait(60); return healthDemo(); },
  adminGallery: async () => { await wait(60); return galleryDemo(); },
  reportClientError: async () => ({ ok: true }),
};
