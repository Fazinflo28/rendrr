// Usage & billing: the page's data, starting Starter (Stripe Checkout), managing the card (Stripe's portal), the
// spending limit, and Stripe's webhook (no login: Stripe signs it).
import { AppError } from "@rendrr/core";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authenticate } from "../auth";
import { billingOverview, setSpendLimit } from "../services/billing";
import { checkoutUrl, handleStripeEvent, portalUrl, verifyEvent } from "../services/stripe";

export default async function billing(app: FastifyInstance) {
  app.post("/billing/webhook", { config: { rateLimit: { max: 600, timeWindow: "1 minute" } } }, async (req, reply) => {
    const raw = (req as unknown as { rawBody?: string }).rawBody;
    if (typeof raw !== "string") throw new AppError("Send the event as JSON.", 400);
    const event = verifyEvent(raw, req.headers["stripe-signature"] as string | undefined);
    const r = await handleStripeEvent(event);
    return reply.send({ received: true, ...r });
  });

  app.register(async (a) => {
    a.addHook("preHandler", authenticate);
    a.get("/billing", async (req) => billingOverview(req.user!.id));
    a.get("/billing/overview", async (req) => billingOverview(req.user!.id));
    a.post("/billing/checkout", async (req) => ({ url: await checkoutUrl(req.user!.id) }));
    a.post("/billing/portal", async (req) => ({ url: await portalUrl(req.user!.id) }));
    a.post("/billing/limit", async (req) => {
      const { cents } = z.object({ cents: z.number().int().min(0).max(100_000) }).parse(req.body);
      return { spendLimitCents: await setSpendLimit(req.user!.id, cents) };
    });
  });
}
