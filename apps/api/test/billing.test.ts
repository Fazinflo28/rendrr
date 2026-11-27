// Billing end to end on the API: the 7-day trial's limits (renders and footage stopped with a clear reason for the web
// app and the AI), the Usage & billing page's data, Stripe (checkout, the webhook moving the account to Starter, pay as
// you go added to the renewal invoice, a failed payment, a cancelled plan's last invoice), and the admin panel (team
// only; users, costs, storage, issues, changes recorded). Stripe is a stand-in here; its webhook signatures are real.
// Needs a database, Redis and storage (as in .env).
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import Stripe from "stripe";

process.env.INTERNAL_API_SECRET ||= "test-internal-secret";
process.env.LOG_LEVEL = process.env.TEST_LOG || "silent";
process.env.BILLING_ENFORCE = "on";
process.env.STRIPE_WEBHOOK_SECRET = "whsec_test_rendrr";
const ready = !!process.env.DATABASE_URL && !!process.env.REDIS_URL && !!process.env.S3_BUCKET;
const run = Math.random().toString(36).slice(2, 8);
const DAY = 86_400_000;

describe("billing: trial, Starter with Stripe, pay as you go, admin panel", { skip: !ready && "needs DATABASE_URL, REDIS_URL and storage" }, async () => {
  const { prisma } = await import("@rendrr/db");
  const { recordUsage, snapshotStorage, redis } = await import("@rendrr/core");
  const { assertMay, billingOverview } = await import("../src/services/billing");
  const { setStripeClient } = await import("../src/services/stripe");
  const { buildServer } = await import("../src/server");
  let app: Awaited<ReturnType<typeof buildServer>>;
  let userId = "", adminId = "";
  const clerk = `bill_${run}`, adminClerk = `billadm_${run}`;
  const as = (c: string) => ({ "x-internal-secret": process.env.INTERNAL_API_SECRET!, "x-rendrr-clerk-id": c });

  // ---- a stand-in Stripe that remembers what it was asked ----
  const calls: { what: string; args: unknown }[] = [];
  const real = new Stripe("sk_test_dummy", { apiVersion: "2025-02-24.acacia" });
  let sub: Record<string, unknown> = {};
  const fake = {
    webhooks: real.webhooks,
    customers: { create: async (a: unknown) => { calls.push({ what: "customer", args: a }); return { id: `cus_${run}` }; } },
    prices: { list: async () => ({ data: [] }), create: async (a: unknown) => { calls.push({ what: "price", args: a }); return { id: "price_starter" }; } },
    products: { create: async (a: unknown) => { calls.push({ what: "product", args: a }); return { id: "prod_starter" }; } },
    checkout: { sessions: { create: async (a: unknown) => { calls.push({ what: "checkout", args: a }); return { id: "cs_1", url: "https://checkout.stripe.test/cs_1" }; } } },
    billingPortal: { sessions: { create: async (a: unknown) => { calls.push({ what: "portal", args: a }); return { url: "https://billing.stripe.test/p_1" }; } } },
    subscriptions: { retrieve: async () => sub },
    invoiceItems: { create: async (a: unknown) => { calls.push({ what: "invoiceItem", args: a }); return { id: `ii_${calls.length}` }; } },
    invoices: { create: async (a: unknown) => { calls.push({ what: "invoice", args: a }); return { id: `in_final_${run}`, customer: `cus_${run}`, status: "open", total: 0, period_start: 0, period_end: 0 }; } },
  } as unknown as Stripe;
  const signed = (event: object) => {
    const payload = JSON.stringify(event);
    return { payload, headers: { "content-type": "application/json", "stripe-signature": real.webhooks.generateTestHeaderString({ payload, secret: process.env.STRIPE_WEBHOOK_SECRET! }) } };
  };
  const send = async (type: string, object: object, id = `evt_${type}_${Math.random().toString(36).slice(2)}`) => {
    const s = signed({ id, object: "event", type, data: { object }, api_version: "2025-02-24.acacia", created: Math.floor(Date.now() / 1000) });
    return app.inject({ method: "POST", url: "/billing/webhook", headers: s.headers, payload: s.payload });
  };

  before(async () => {
    setStripeClient(fake);
    app = await buildServer();
    const now = new Date();
    userId = (await prisma.user.create({ data: { clerkId: clerk, email: `bill-${run}@test.rendrr.dev`, name: "Bill", plan: "trial", billingStatus: "trialing", trialEndsAt: new Date(now.getTime() + 7 * DAY), periodStart: now, periodEnd: new Date(now.getTime() + 7 * DAY) } })).id;
    adminId = (await prisma.user.create({ data: { clerkId: adminClerk, email: `billadm-${run}@test.rendrr.dev`, name: "Admin", role: "admin", plan: "comp", billingStatus: "active" } })).id;
    await prisma.folder.create({ data: { userId, name: "Client A", workspace: "W" } });
  });
  after(async () => {
    setStripeClient(null);
    await prisma.stripeEvent.deleteMany({ where: { id: { contains: "evt_" } } }).catch(() => {});
    await prisma.adminAction.deleteMany({ where: { OR: [{ adminId }, { targetId: userId }] } });
    await prisma.clientError.deleteMany({ where: { message: { contains: run } } });
    await prisma.storageSnapshot.deleteMany({ where: { userId: { in: [userId, adminId] } } });
    await prisma.jobCost.deleteMany({ where: { userId } });
    await prisma.folder.deleteMany({ where: { userId } });
    await prisma.user.deleteMany({ where: { id: { in: [userId, adminId] } } });
    await app.close();
    await redis().quit().catch(() => {});
  });

  it("trial: renders and footage are stopped with the reason and what to do (402), within the limit they go", async () => {
    await assertMay(userId, { metric: "export", minutes: 3 });
    await recordUsage({ userId, metric: "export", quantity: 9.5, refId: `r1_${run}` });
    await recordUsage({ userId, metric: "export", quantity: 9.5, refId: `r1_${run}` }); // a retried job: counted once
    await assert.rejects(assertMay(userId, { metric: "export", minutes: 3 }), (e: Error & { status?: number; code?: string }) => {
      assert.equal(e.status, 402); assert.equal(e.code, "billing_trial_limit");
      assert.match(e.message, /needs 3 export minutes and your free trial has 0\.5 left\. Start the \$5 Editor Pro plan for more: Open Usage & billing/);
      return true;
    });
    await assert.rejects(assertMay(userId, { metric: "export", minutes: 1, fourK: true }), /4K exports come with the \$5 Editor Pro plan/);
    await assertMay(userId, { metric: "footage", minutes: 20 });
    await recordUsage({ userId, metric: "footage", quantity: 29, refId: `v1_${run}` });
    await assert.rejects(assertMay(userId, { metric: "footage", minutes: 5 }), /free trial has 1 left/);
  });

  it("the Usage & billing page: plan, trial days, meters, the day-by-day chart, by project", async () => {
    const b = await billingOverview(userId);
    assert.equal(b.plan, "trial");
    assert.equal(b.trial?.daysLeft, 7);
    assert.deepEqual(b.meters.find((m) => m.metric === "export"), { metric: "export", label: "Export minutes", used: 9.5, included: 10, unit: "min", left: 0.5, over: 0 });
    assert.equal(b.totalCents, 0);
    assert.ok(b.days.length >= 1 && b.days.at(-1)!.export === 9.5);
    assert.equal(b.plans.find((p) => p.id === "starter")?.priceCents, 500);
    const r = await app.inject({ method: "GET", url: "/billing", headers: as(clerk) });
    assert.equal(r.statusCode, 200);
    assert.equal(r.json().planName, "Free trial");
  });

  it("a trial that ended stops exports until Starter starts", async () => {
    await prisma.user.update({ where: { id: userId }, data: { trialEndsAt: new Date(Date.now() - 1000) } });
    await assert.rejects(assertMay(userId, { metric: "preview", minutes: 1 }), /Your 7-day free trial has ended/);
    await prisma.user.update({ where: { id: userId }, data: { trialEndsAt: new Date(Date.now() + 7 * DAY) } });
  });

  it("Start Starter: a Stripe checkout for the $5 price (made once by its lookup key), then the webhook moves the account", async () => {
    const r = await app.inject({ method: "POST", url: "/billing/checkout", headers: as(clerk) });
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(r.json().url, "https://checkout.stripe.test/cs_1");
    const price = calls.find((c) => c.what === "price")!.args as { unit_amount: number; recurring: { interval: string }; lookup_key: string };
    assert.deepEqual([price.unit_amount, price.recurring.interval, price.lookup_key], [500, "month", "rendrr_starter_monthly"]);
    const co = calls.find((c) => c.what === "checkout")!.args as { mode: string; client_reference_id: string; line_items: { price: string }[] };
    assert.deepEqual([co.mode, co.client_reference_id, co.line_items[0].price], ["subscription", userId, "price_starter"]);
    assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: userId } })).stripeCustomerId, `cus_${run}`);

    // The trial's usage was before the plan started (a real upgrade comes after it): it does not count in Starter.
    await prisma.usageRecord.updateMany({ where: { userId }, data: { createdAt: new Date(Date.now() - 3600_000) } });
    const start = Math.floor(Date.now() / 1000) - 60, end = start + 30 * 86400;
    sub = { id: `sub_${run}`, object: "subscription", customer: `cus_${run}`, status: "active", metadata: { userId }, current_period_start: start, current_period_end: end, items: { data: [] } };
    const w = await send("checkout.session.completed", { id: "cs_1", object: "checkout.session", customer: `cus_${run}`, subscription: `sub_${run}`, client_reference_id: userId });
    assert.equal(w.statusCode, 200, w.body);
    const u = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    assert.deepEqual([u.plan, u.billingStatus, u.stripeSubscriptionId, u.periodStart.getTime() / 1000], ["starter", "active", `sub_${run}`, start]);
    // A bad signature is refused.
    const bad = await app.inject({ method: "POST", url: "/billing/webhook", headers: { "content-type": "application/json", "stripe-signature": "t=1,v1=nope" }, payload: "{}" });
    assert.equal(bad.statusCode, 400);
  });

  it("Starter: the allowance, then pay as you go (a card is on file) up to the spending limit", async () => {
    await recordUsage({ userId, metric: "export", quantity: 30, billable: 30, refId: `r2_${run}` });
    await assertMay(userId, { metric: "export", minutes: 5 }); // 30 used of 25: pay as you go
    const b = await billingOverview(userId);
    assert.deepEqual(b.lines.map((l) => [l.metric, l.quantity, l.amountCents]), [["export", 5, 50]]);
    assert.equal(b.totalCents, 550);
    const lim = await app.inject({ method: "POST", url: "/billing/limit", headers: as(clerk), payload: { cents: 60 } });
    assert.equal(lim.json().spendLimitCents, 60);
    await assert.rejects(assertMay(userId, { metric: "export", minutes: 5 }), /pass your \$0\.60 spending limit/);
    await app.inject({ method: "POST", url: "/billing/limit", headers: as(clerk), payload: { cents: 2000 } });
  });

  it("the renewal invoice gets last period's pay-as-you-go lines, once; paid and failed payments are mirrored", async () => {
    const u = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    const inv = { id: `in_${run}`, object: "invoice", customer: `cus_${run}`, status: "draft", billing_reason: "subscription_cycle", total: 500, period_start: Math.floor(u.periodStart.getTime() / 1000), period_end: Math.floor(Date.now() / 1000) + 60 };
    const before = calls.filter((c) => c.what === "invoiceItem").length;
    assert.equal((await send("invoice.created", inv, `evt_inv_${run}`)).statusCode, 200);
    assert.equal((await send("invoice.created", inv, `evt_inv_${run}`)).json().skipped, true); // resent: skipped
    const items = calls.filter((c) => c.what === "invoiceItem").slice(before).map((c) => c.args as { amount: number; invoice: string; description: string });
    assert.deepEqual(items.map((i) => [i.amount, i.invoice]), [[50, `in_${run}`]]);
    assert.match(items[0].description, /Extra export minutes: 5 min/);
    let m = await prisma.billingInvoice.findUniqueOrThrow({ where: { stripeInvoiceId: `in_${run}` } });
    assert.deepEqual([m.usageAdded, m.usageCents], [true, 50]);

    await send("invoice.paid", { ...inv, status: "paid", total: 550, number: "R-0001", hosted_invoice_url: "https://inv.stripe.test/1", status_transitions: { paid_at: Math.floor(Date.now() / 1000) } });
    m = await prisma.billingInvoice.findUniqueOrThrow({ where: { stripeInvoiceId: `in_${run}` } });
    assert.deepEqual([m.status, m.totalCents, m.number], ["paid", 550, "R-0001"]);

    await send("invoice.payment_failed", { ...inv, id: `in2_${run}`, status: "open", billing_reason: "subscription_cycle" });
    assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: userId } })).billingStatus, "past_due");
    await assert.rejects(assertMay(userId, { metric: "export", minutes: 1 }), /Your last payment did not go through/);
    sub = { ...sub, status: "active" };
    await send("customer.subscription.updated", sub);
    assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: userId } })).billingStatus, "active");
  });

  it("a cancelled plan: exports stop, and its last period's pay-as-you-go usage gets one last invoice", async () => {
    await recordUsage({ userId, metric: "export", quantity: 10, billable: 10, refId: `r3_${run}` }); // now 15 extra minutes: $1.50
    const before = calls.filter((c) => c.what === "invoice").length;
    await send("customer.subscription.deleted", { ...sub, status: "canceled" });
    const u = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    assert.deepEqual([u.plan, u.billingStatus, u.stripeSubscriptionId], ["starter", "canceled", null]);
    assert.equal(calls.filter((c) => c.what === "invoice").length, before + 1);
    await assert.rejects(assertMay(userId, { metric: "export", minutes: 1 }), /Your Editor Pro plan is not active/);
  });

  it("storage is measured once a day per user (the storage bill and the admin panel)", async () => {
    await snapshotStorage();
    const s = await prisma.storageSnapshot.findFirst({ where: { userId } });
    assert.ok(s && s.day === new Date().toISOString().slice(0, 10));
    assert.ok(await prisma.usageRecord.findUnique({ where: { metric_refId: { metric: "storage", refId: `${userId}:${s!.day}` } } }));
  });

  it("the admin panel: team only; overview, users, a user, costs, storage, issues; changes are recorded", async () => {
    assert.equal((await app.inject({ method: "GET", url: "/admin/overview", headers: as(clerk) })).statusCode, 403);
    await prisma.jobCost.create({ data: { userId, queue: "render", jobId: "j1", kind: "render_final", refId: `r2_${run}`, cpuSeconds: 1254, memGbSeconds: 627, costCompute: 0.0097, costMemory: 0.0024, costTotal: 0.0121 } });
    const o = await app.inject({ method: "GET", url: "/admin/overview", headers: as(adminClerk) });
    assert.equal(o.statusCode, 200, o.body);
    const ov = o.json();
    assert.ok(ov.users.total >= 2 && ov.money.costParts30.compute >= 0.0097 && ov.series.length === 30 && ov.queues.render);
    const list = (await app.inject({ method: "GET", url: `/admin/users?q=bill-${run}`, headers: as(adminClerk) })).json();
    assert.equal(list.users.length, 1);
    assert.equal(list.users[0].cost30 > 0.012, true);
    assert.equal(list.users[0].usage30.exportMinutes, 49.5); // 9.5 in the trial, 40 on Starter
    const d = (await app.inject({ method: "GET", url: `/admin/users/${userId}`, headers: as(adminClerk) })).json();
    assert.equal(d.costsByKind[0].kind, "render_final");
    assert.equal(d.invoices.length >= 2, true);
    // Changes: comp, back to trial with 3 more days, bonus minutes; each one recorded.
    let ch = await app.inject({ method: "POST", url: `/admin/users/${userId}`, headers: as(adminClerk), payload: { plan: "comp" } });
    assert.equal(ch.json().billing.plan, "comp");
    ch = await app.inject({ method: "POST", url: `/admin/users/${userId}`, headers: as(adminClerk), payload: { plan: "trial", trialDays: 3, bonusExportMinutes: 15 } });
    assert.equal(ch.statusCode, 200, ch.body);
    assert.equal(ch.json().billing.plan, "trial");
    assert.equal(ch.json().billing.bonus.exportMinutes, 15);
    assert.equal((await prisma.adminAction.count({ where: { targetId: userId } })), 2);
    for (const url of ["/admin/costs?days=7", "/admin/storage", "/admin/issues", "/admin/jobs?limit=5"]) {
      const r = await app.inject({ method: "GET", url, headers: as(adminClerk) });
      assert.equal(r.statusCode, 200, `${url}: ${r.body}`);
    }
    const costs = (await app.inject({ method: "GET", url: "/admin/costs?days=7", headers: as(adminClerk) })).json();
    assert.ok(costs.byKind.find((k: { kind: string }) => k.kind === "render_final"));
  });

  it("browser errors are grouped by what broke and where", async () => {
    for (let i = 0; i < 2; i++) {
      const r = await app.inject({ method: "POST", url: "/telemetry/client-error", payload: { message: `TypeError: x is undefined ${run}`, stack: "TypeError\n    at render (app.js:10:5)", url: "https://app.rendrr.live/editor/cmabcdefghijklmnopqrstuvwx" } });
      assert.equal(r.statusCode, 200);
    }
    const e = await prisma.clientError.findFirstOrThrow({ where: { message: { contains: run } } });
    assert.equal(e.count, 2);
    const iss = (await app.inject({ method: "GET", url: "/admin/issues", headers: as(adminClerk) })).json();
    assert.ok(iss.clientErrors.some((c: { message: string }) => c.message.includes(run)));
  });
});
