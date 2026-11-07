// Payments with Stripe: the $5 Starter subscription (Checkout), the card and invoices page (Customer Portal), and the
// webhook that keeps each account's plan, period and invoices in step. Pay-as-you-go usage is added to the renewal
// invoice when Stripe drafts it (invoice.created waits about an hour before it is finalized), and to a last invoice
// when a plan ends. Without STRIPE_SECRET_KEY payments are off: the trial works, checkout says payments are coming.
import { AppError, env, periodUsage } from "@rendrr/core";
import { prisma, type User } from "@rendrr/db";
import { PLAN_INFO, statement } from "@rendrr/shared";
import Stripe from "stripe";

export const API_VERSION = "2025-02-24.acacia" as const;
export const STARTER_LOOKUP_KEY = "rendrr_starter_monthly";

let client: Stripe | null = null;
/** Tests hand in a stand-in. */
export function setStripeClient(c: Stripe | null) { client = c; starterPriceId = null; }
export function stripe(): Stripe {
  if (client) return client;
  const key = env().STRIPE_SECRET_KEY;
  if (!key) throw new AppError("Payments are being set up. Your free trial keeps working until then.", 503, "payments_off");
  client = new Stripe(key, { apiVersion: API_VERSION, appInfo: { name: "Rendrr" } });
  return client;
}
export const paymentsOn = () => !!client || !!env().STRIPE_SECRET_KEY;

const WEB = () => env().PUBLIC_WEB_URL.replace(/\/$/, "");

let starterPriceId: string | null = null;
/** The $5 a month price: STRIPE_PRICE_STARTER, else the price with our lookup key, made the first time if missing. */
export async function starterPrice(): Promise<string> {
  if (starterPriceId) return starterPriceId;
  if (process.env.STRIPE_PRICE_STARTER) return (starterPriceId = process.env.STRIPE_PRICE_STARTER);
  const s = stripe();
  const found = await s.prices.list({ lookup_keys: [STARTER_LOOKUP_KEY], active: true, limit: 1 });
  if (found.data[0]) return (starterPriceId = found.data[0].id);
  const product = await s.products.create({ name: "Rendrr Starter", description: PLAN_INFO.starter.blurb });
  const price = await s.prices.create({ product: product.id, currency: "usd", unit_amount: PLAN_INFO.starter.priceCents, recurring: { interval: "month" }, lookup_key: STARTER_LOOKUP_KEY, nickname: "Starter monthly" });
  return (starterPriceId = price.id);
}

export async function ensureCustomer(u: User): Promise<string> {
  if (u.stripeCustomerId) return u.stripeCustomerId;
  const c = await stripe().customers.create({ email: u.email || undefined, name: u.name || undefined, metadata: { userId: u.id } });
  await prisma.user.update({ where: { id: u.id }, data: { stripeCustomerId: c.id } });
  return c.id;
}

/** Where to go to start Starter (Checkout), or to manage it when it is already on (the Portal). */
export async function checkoutUrl(userId: string): Promise<string> {
  const u = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  if (u.plan === "comp") throw new AppError("Your account has no limits already. Nothing to pay.", 400, "comp");
  if (u.plan === "starter" && u.stripeSubscriptionId && ["active", "past_due"].includes(u.billingStatus)) return portalUrl(userId);
  const customer = await ensureCustomer(u);
  const session = await stripe().checkout.sessions.create({
    mode: "subscription", customer, client_reference_id: u.id,
    line_items: [{ price: await starterPrice(), quantity: 1 }],
    subscription_data: { metadata: { userId: u.id } },
    allow_promotion_codes: true,
    success_url: `${WEB()}/usage?paid=1`, cancel_url: `${WEB()}/usage?canceled=1`,
  });
  if (!session.url) throw new AppError("Stripe did not give a checkout page. Try again.", 502, "stripe");
  return session.url;
}

/** Stripe's own page for the card, the invoices and cancelling. */
export async function portalUrl(userId: string): Promise<string> {
  const u = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  if (!u.stripeCustomerId) throw new AppError("There is no card on this account yet. Start Starter first.", 400, "no_customer");
  const s = await stripe().billingPortal.sessions.create({ customer: u.stripeCustomerId, return_url: `${WEB()}/usage` });
  return s.url;
}

// ---------------- the webhook ----------------

export function verifyEvent(raw: string, signature: string | undefined): Stripe.Event {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) throw new AppError("The Stripe webhook secret is not set.", 503, "webhook_off");
  if (!signature) throw new AppError("Missing Stripe signature.", 400, "signature");
  try { return stripe().webhooks.constructEvent(raw, signature, secret); }
  catch { throw new AppError("Bad Stripe signature.", 400, "signature"); }
}

const idOf = (x: string | { id: string } | null | undefined) => (typeof x === "string" ? x : x?.id ?? null);
const toDate = (s?: number | null) => (s ? new Date(s * 1000) : null);

async function userFor(customer: string | null, metaUserId?: string | null): Promise<User | null> {
  if (customer) { const u = await prisma.user.findUnique({ where: { stripeCustomerId: customer } }); if (u) return u; }
  if (metaUserId) return prisma.user.findUnique({ where: { id: metaUserId } });
  return null;
}

/** A subscription's period (the top level before Stripe's 2025-03-31 API, its first item after). */
function periodOf(sub: Stripe.Subscription): { start: Date; end: Date } {
  const any = sub as unknown as { current_period_start?: number; current_period_end?: number; items?: { data?: { current_period_start?: number; current_period_end?: number }[] } };
  const it = any.items?.data?.[0];
  const start = toDate(any.current_period_start ?? it?.current_period_start) ?? new Date();
  const end = toDate(any.current_period_end ?? it?.current_period_end) ?? new Date(start.getTime() + 30 * 86_400_000);
  return { start, end };
}

/** The account's plan, status and period from its subscription. */
export async function applySubscription(sub: Stripe.Subscription) {
  const u = await userFor(idOf(sub.customer), sub.metadata?.userId);
  if (!u) return null;
  const status = sub.status === "active" || sub.status === "trialing" ? "active" : sub.status === "past_due" || sub.status === "unpaid" ? "past_due" : sub.status === "incomplete" ? u.billingStatus : "canceled";
  const ended = status === "canceled";
  const { start, end } = periodOf(sub);
  const newPeriod = u.periodStart.getTime() !== start.getTime();
  const updated = await prisma.user.update({ where: { id: u.id }, data: {
    plan: u.plan === "comp" ? "comp" : "starter", billingStatus: u.plan === "comp" ? u.billingStatus : status,
    stripeCustomerId: idOf(sub.customer) ?? u.stripeCustomerId, stripeSubscriptionId: ended ? null : sub.id,
    ...(ended ? {} : { periodStart: start, periodEnd: end, storageLimitGB: PLAN_INFO.starter.allowance!.storageGB }),
    ...(newPeriod && !ended ? { billingNotes: {} } : {}),
  } });
  // A plan that ended: what it used past the allowance in its last period goes on one last invoice.
  if (ended && u.plan === "starter" && u.stripeCustomerId) await finalUsageInvoice(updated).catch((e) => console.error("[stripe] last usage invoice:", (e as Error).message));
  return updated;
}

/** The pay-as-you-go lines for a user's usage between two dates (Starter's allowance taken off). */
export async function usageLines(userId: string, start: Date, end: Date) {
  const u = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  const usage = await periodUsage(userId, start, end, 0);
  return statement("starter", usage, { exportMinutes: u.bonusExportMinutes, footageMinutes: u.bonusFootageMinutes });
}

/** The renewal invoice Stripe just drafted: add last period's pay-as-you-go usage to it, once. */
export async function addUsageToInvoice(inv: Stripe.Invoice) {
  if (!inv.id || inv.status !== "draft") return;
  const reason = inv.billing_reason;
  if (reason !== "subscription_cycle" && reason !== "subscription_update") return;
  const u = await userFor(idOf(inv.customer), null);
  if (!u) return;
  const mirror = await prisma.billingInvoice.findUnique({ where: { stripeInvoiceId: inv.id } });
  if (mirror?.usageAdded) return;
  const start = toDate(inv.period_start)!, end = toDate(inv.period_end)!;
  const s = await usageLines(u.id, start, end);
  for (const l of s.lines) {
    if (l.amountCents <= 0) continue;
    await stripe().invoiceItems.create({ customer: idOf(inv.customer)!, invoice: inv.id, currency: "usd", amount: l.amountCents, description: `${l.label}: ${l.quantity} ${l.unit}` }, { idempotencyKey: `usage-${inv.id}-${l.metric}` });
  }
  await prisma.billingInvoice.upsert({
    where: { stripeInvoiceId: inv.id },
    create: { userId: u.id, stripeInvoiceId: inv.id, periodStart: start, periodEnd: end, baseCents: PLAN_INFO.starter.priceCents, usageCents: s.usageCents, totalCents: (inv.total ?? 0) + s.usageCents, status: "draft", usageAdded: true, lines: s.lines as object },
    update: { usageCents: s.usageCents, usageAdded: true, lines: s.lines as object },
  });
}

/** One last invoice for a plan that ended with usage past its allowance in its last period. */
async function finalUsageInvoice(u: User) {
  const notes = (u.billingNotes ?? {}) as { finalInvoiceFor?: string };
  const key = u.periodStart.toISOString();
  if (notes.finalInvoiceFor === key) return;
  const s = await usageLines(u.id, u.periodStart, new Date());
  if (s.usageCents < 50) return; // under Stripe's smallest charge: not worth a bill
  const customer = u.stripeCustomerId!;
  for (const l of s.lines) if (l.amountCents > 0) await stripe().invoiceItems.create({ customer, currency: "usd", amount: l.amountCents, description: `${l.label}: ${l.quantity} ${l.unit}` }, { idempotencyKey: `final-${u.id}-${key}-${l.metric}` });
  const inv = await stripe().invoices.create({ customer, collection_method: "charge_automatically", auto_advance: true, pending_invoice_items_behavior: "include", description: "Rendrr pay-as-you-go usage (last period)" }, { idempotencyKey: `final-inv-${u.id}-${key}` });
  await prisma.user.update({ where: { id: u.id }, data: { billingNotes: { ...notes, finalInvoiceFor: key } } });
  await mirrorInvoice(inv, { usageCents: s.usageCents, lines: s.lines });
}

/** Keeps our copy of a Stripe invoice: status, totals, link. */
export async function mirrorInvoice(inv: Stripe.Invoice, extra: { usageCents?: number; lines?: unknown } = {}) {
  if (!inv.id) return;
  const u = await userFor(idOf(inv.customer), null);
  if (!u) return;
  const status = inv.status === "paid" ? "paid" : inv.status === "open" ? "open" : inv.status === "void" ? "void" : inv.status === "uncollectible" ? "uncollectible" : "draft";
  const data = {
    number: inv.number ?? null, totalCents: inv.total ?? 0, status, hostedUrl: inv.hosted_invoice_url ?? null, pdfUrl: inv.invoice_pdf ?? null,
    paidAt: inv.status === "paid" ? toDate(inv.status_transitions?.paid_at) ?? new Date() : null,
    ...(extra.usageCents != null ? { usageCents: extra.usageCents } : {}), ...(extra.lines ? { lines: extra.lines as object } : {}),
  };
  await prisma.billingInvoice.upsert({
    where: { stripeInvoiceId: inv.id },
    create: { userId: u.id, stripeInvoiceId: inv.id, periodStart: toDate(inv.period_start) ?? new Date(), periodEnd: toDate(inv.period_end) ?? new Date(), baseCents: Math.max(0, (inv.total ?? 0) - (extra.usageCents ?? 0)), ...data },
    update: data,
  });
}

/** One webhook event, applied once (a resent event is skipped). */
export async function handleStripeEvent(event: Stripe.Event): Promise<{ handled: boolean; skipped?: boolean }> {
  try { await prisma.stripeEvent.create({ data: { id: event.id, type: event.type } }); }
  catch { return { handled: false, skipped: true }; }
  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const s = event.data.object as Stripe.Checkout.Session;
        const subId = idOf(s.subscription);
        const userId = s.client_reference_id;
        if (userId && idOf(s.customer)) await prisma.user.updateMany({ where: { id: userId, stripeCustomerId: null }, data: { stripeCustomerId: idOf(s.customer) } });
        if (subId) await applySubscription(await stripe().subscriptions.retrieve(subId));
        break;
      }
      case "customer.subscription.created":
      case "customer.subscription.updated":
      case "customer.subscription.deleted":
        await applySubscription(event.data.object as Stripe.Subscription);
        break;
      case "invoice.created":
        await addUsageToInvoice(event.data.object as Stripe.Invoice);
        break;
      case "invoice.finalized":
      case "invoice.paid":
      case "invoice.voided":
      case "invoice.marked_uncollectible":
        await mirrorInvoice(event.data.object as Stripe.Invoice);
        break;
      case "invoice.payment_failed": {
        const inv = event.data.object as Stripe.Invoice;
        await mirrorInvoice(inv);
        const u = await userFor(idOf(inv.customer), null);
        if (u && u.plan === "starter") await prisma.user.update({ where: { id: u.id }, data: { billingStatus: "past_due", billingNotes: { ...((u.billingNotes ?? {}) as object), lastPaymentError: inv.last_finalization_error?.message ?? "The card was declined." } } });
        break;
      }
      default:
        return { handled: false };
    }
    return { handled: true };
  } catch (e) {
    // Not applied: forget the event so Stripe's retry runs it again.
    await prisma.stripeEvent.delete({ where: { id: event.id } }).catch(() => {});
    throw e;
  }
}
