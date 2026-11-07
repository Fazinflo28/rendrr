// Plans, prices, what each plan includes, pay-as-you-go rates, and what things cost Rendrr. Pure: the API, the worker
// and the web app all read the same numbers. Money is in cents (what users pay) or dollars (what Rendrr pays).
//
// Plans:
//   trial    7 days free, no card. A small allowance to make a few real videos.
//   starter  $5 a month. An allowance, then pay as you go up to the user's spending limit.
//   comp     Granted by an admin (Rendrr's own accounts, partners): no limits, no charge.
//
// Units:
//   export minutes   minutes of finished video exported (render_final), by the second. 4K and heavy effects count 2x.
//   preview minutes  minutes of preview rendered (free on Starter, limited in the trial).
//   footage minutes  minutes of footage uploaded and processed (transcribed and measured), once per video.
//   storage          GB kept (originals, previews, finals, graphics), measured once a day.

export type PlanId = "trial" | "starter" | "comp";
export type BillingStatus = "trialing" | "active" | "past_due" | "canceled" | "expired";
export type Metric = "export" | "preview" | "footage" | "storage";

export type Allowance = { exportMinutes: number; previewMinutes: number | null; footageMinutes: number; storageGB: number };

export const PLAN_INFO: Record<PlanId, { name: string; priceCents: number; allowance: Allowance | null; payAsYouGo: boolean; fourK: boolean; blurb: string }> = {
  trial: {
    name: "Free trial", priceCents: 0, payAsYouGo: false, fourK: false,
    allowance: { exportMinutes: 10, previewMinutes: 60, footageMinutes: 30, storageGB: 5 },
    blurb: "7 days free. About 10 short videos of a minute, or one 10-minute video.",
  },
  starter: {
    name: "Starter", priceCents: 500, payAsYouGo: true, fourK: true,
    allowance: { exportMinutes: 25, previewMinutes: null, footageMinutes: 60, storageGB: 10 },
    blurb: "$5 a month. 25 export minutes, 1 hour of footage and 10 GB, then pay as you go.",
  },
  comp: { name: "Complimentary", priceCents: 0, payAsYouGo: false, fourK: true, allowance: null, blurb: "No limits." },
};

export const TRIAL_DAYS = 7;
/** A fresh account's spending limit for pay as you go (cents). */
export const DEFAULT_SPEND_LIMIT_CENTS = 2000;
/** A last render may run this many minutes past an allowance that has room left (so a 10.5-minute video is not refused for 30 seconds). */
export const ALLOWANCE_GRACE_MINUTES = 1;

/** Pay-as-you-go prices once the allowance is used (cents). */
export const PAYG = {
  exportMinuteCents: 10, // $0.10 a minute; 4K and heavy effects count 2 minutes
  footageHourCents: 100, // $1.00 an hour of footage processed
  storageGbMonthCents: 10, // $0.10 a GB a month over the allowance, by the day
} as const;

/** What counts double: a 4K export, and renders with heavy effects (subject mask, stabilizing, optical-flow slow motion, morph cut, tracking). */
export const MULTIPLIER = { fourK: 2, heavy: 2 } as const;
export function exportMultiplier(o: { fourK?: boolean; heavy?: boolean }): number {
  return o.fourK || o.heavy ? Math.max(o.fourK ? MULTIPLIER.fourK : 1, o.heavy ? MULTIPLIER.heavy : 1) : 1;
}

/**
 * What things cost Rendrr (US dollars). Railway bills CPU and memory by the minute of actual use, buckets by the GB
 * stored (downloads free), and data sent out of a service by the GB; AssemblyAI bills audio by the second.
 * Sources: docs.railway.com (pricing, storage buckets billing), assemblyai.com/pricing (Universal-2).
 */
export const COST_RATES = {
  cpuPerVcpuSecond: 20 / (30 * 24 * 3600), // $20 a vCPU-month
  memPerGbSecond: 10 / (30 * 24 * 3600), // $10 a GB-month of memory
  transcribePerSecond: 0.15 / 3600, // $0.15 an hour of audio (Universal-2)
  egressPerGB: 0.05, // data sent out of a Railway service (Drive saves); bucket downloads are free
  storagePerGBMonth: 0.015, // Railway bucket
  cardPercent: 0.029, // Stripe: 2.9% + 30 cents a charge
  cardFixedCents: 30,
} as const;
export type CostRates = typeof COST_RATES;

const GB = 1024 ** 3;
export const bytesToGB = (b: number | bigint) => Number(b) / GB;

/** One job's cost in dollars from what was measured. */
export function jobCost(m: { cpuSeconds: number; memGbSeconds: number; transcribeSeconds?: number; egressBytes?: number }, r: CostRates = COST_RATES) {
  const costCompute = m.cpuSeconds * r.cpuPerVcpuSecond;
  const costMemory = m.memGbSeconds * r.memPerGbSecond;
  const costTranscribe = (m.transcribeSeconds ?? 0) * r.transcribePerSecond;
  const costEgress = bytesToGB(m.egressBytes ?? 0) * r.egressPerGB;
  return { costCompute, costMemory, costTranscribe, costEgress, costTotal: costCompute + costMemory + costTranscribe + costEgress };
}

/** Storage cost for some GB kept some days (dollars). */
export const storageCost = (gbDays: number, r: CostRates = COST_RATES) => (gbDays / 30) * r.storagePerGBMonth;
/** The card fee on one charge (cents). */
export const cardFeeCents = (amountCents: number, r: CostRates = COST_RATES) => (amountCents > 0 ? Math.round(amountCents * r.cardPercent + r.cardFixedCents) : 0);

// ---------------- a period's bill ----------------

/** What a user used in a period: billable minutes per metric, and storage as GB per day (one value a day so far). */
export type PeriodUsage = { exportMinutes: number; previewMinutes: number; footageMinutes: number; storageGbByDay: number[]; storageGBNow: number };
export type BillLine = { metric: Metric; label: string; quantity: number; unit: string; unitCents: number; amountCents: number };
export type Meter = { metric: Metric; label: string; used: number; included: number | null; unit: string; left: number | null; over: number };

export type Statement = {
  plan: PlanId;
  baseCents: number;
  meters: Meter[];
  lines: BillLine[];
  usageCents: number;
  totalCents: number;
  /** Bonus minutes granted by an admin that this period's usage drew on. */
  bonusUsed: { exportMinutes: number; footageMinutes: number };
};

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * A period's bill: the plan's price, how much of each allowance is used, and the pay-as-you-go lines for what went
 * past it (Starter only; the trial and comp never charge). Bonus minutes count before pay as you go.
 */
export function statement(plan: PlanId, u: PeriodUsage, bonus: { exportMinutes?: number; footageMinutes?: number } = {}): Statement {
  const info = PLAN_INFO[plan];
  const a = info.allowance;
  const be = Math.max(0, bonus.exportMinutes ?? 0), bf = Math.max(0, bonus.footageMinutes ?? 0);
  const inc = (n: number | null | undefined, extra = 0) => (n == null ? null : n + extra);
  const exportInc = a ? inc(a.exportMinutes, be) : null;
  const footageInc = a ? inc(a.footageMinutes, bf) : null;
  const previewInc = a ? a.previewMinutes : null;
  const storageInc = a ? a.storageGB : null;
  const meter = (metric: Metric, label: string, used: number, included: number | null, unit: string): Meter => ({
    metric, label, used: round2(used), included, unit,
    left: included == null ? null : round2(Math.max(0, included - used)),
    over: included == null ? 0 : round2(Math.max(0, used - included)),
  });
  const meters = [
    meter("export", "Export minutes", u.exportMinutes, exportInc, "min"),
    meter("footage", "Footage minutes", u.footageMinutes, footageInc, "min"),
    meter("preview", "Preview minutes", u.previewMinutes, previewInc, "min"),
    meter("storage", "Storage", u.storageGBNow, storageInc, "GB"),
  ];
  const lines: BillLine[] = [];
  if (plan === "starter" && a) {
    const exOver = Math.max(0, u.exportMinutes - a.exportMinutes - be);
    if (exOver > 0) lines.push({ metric: "export", label: "Extra export minutes", quantity: round2(exOver), unit: "min", unitCents: PAYG.exportMinuteCents, amountCents: Math.round(exOver * PAYG.exportMinuteCents) });
    const ftOver = Math.max(0, u.footageMinutes - a.footageMinutes - bf);
    if (ftOver > 0) lines.push({ metric: "footage", label: "Extra footage", quantity: round2(ftOver), unit: "min", unitCents: PAYG.footageHourCents / 60, amountCents: Math.round((ftOver / 60) * PAYG.footageHourCents) });
    // Storage past the allowance, day by day: each GB-day over costs a 30th of the monthly price.
    const overGbDays = u.storageGbByDay.reduce((s, gb) => s + Math.max(0, gb - a.storageGB), 0);
    if (overGbDays > 0) lines.push({ metric: "storage", label: "Extra storage", quantity: round2(overGbDays), unit: "GB-day", unitCents: PAYG.storageGbMonthCents / 30, amountCents: Math.round((overGbDays / 30) * PAYG.storageGbMonthCents) });
  }
  const usageCents = lines.reduce((s, l) => s + l.amountCents, 0);
  return {
    plan, baseCents: info.priceCents, meters, lines, usageCents, totalCents: info.priceCents + usageCents,
    bonusUsed: { exportMinutes: round2(Math.min(be, Math.max(0, u.exportMinutes - (a?.exportMinutes ?? 0)))), footageMinutes: round2(Math.min(bf, Math.max(0, u.footageMinutes - (a?.footageMinutes ?? 0)))) },
  };
}

// ---------------- may this happen? ----------------

export type Account = {
  plan: PlanId;
  status: BillingStatus;
  trialEndsAt: Date | string;
  spendLimitCents: number;
  /** A card is on file (a Stripe subscription that pays). */
  canPay: boolean;
  bonusExportMinutes?: number;
  bonusFootageMinutes?: number;
};
export type Ask = { metric: "export" | "preview" | "footage"; minutes: number; fourK?: boolean; heavy?: boolean; storageGBAfter?: number };
export type Verdict = { ok: true; payAsYouGo?: boolean } | { ok: false; code: string; message: string };

const URL_HINT = "Open Usage & billing in Rendrr (app.rendrr.live/usage)";

/**
 * May the user do this (export, preview, or add footage) now? The answer the API gives the web app and the AI: a
 * clear sentence saying what ran out and what to do. `u` is the period's usage so far.
 */
export function mayUse(acct: Account, u: PeriodUsage, ask: Ask, now = new Date()): Verdict {
  const plan = acct.plan;
  if (plan === "comp") return { ok: true };
  const minutes = Math.max(0, ask.minutes) * (ask.metric === "export" ? exportMultiplier(ask) : 1);
  if (plan === "trial") {
    if (new Date(acct.trialEndsAt).getTime() <= now.getTime() || acct.status === "expired") {
      return { ok: false, code: "trial_ended", message: `Your 7-day free trial has ended. Start the $5 Starter plan to keep exporting: ${URL_HINT}.` };
    }
    const a = PLAN_INFO.trial.allowance!;
    if (ask.metric === "export" && ask.fourK) return { ok: false, code: "trial_4k", message: `4K exports come with the $5 Starter plan. Export in 1080p during the trial, or start Starter: ${URL_HINT}.` };
    const check = (used: number, included: number, what: string): Verdict =>
      used >= included || used + minutes > included + ALLOWANCE_GRACE_MINUTES
        ? { ok: false, code: "trial_limit", message: `This needs ${round2(minutes)} ${what} and your free trial has ${round2(Math.max(0, included - used))} left. Start the $5 Starter plan for more: ${URL_HINT}.` }
        : { ok: true };
    if (ask.metric === "export") return check(u.exportMinutes, a.exportMinutes + (acct.bonusExportMinutes ?? 0), "export minutes");
    if (ask.metric === "preview") return check(u.previewMinutes, a.previewMinutes!, "preview minutes");
    if (ask.metric === "footage") {
      if ((ask.storageGBAfter ?? u.storageGBNow) > a.storageGB) return { ok: false, code: "trial_storage", message: `Your free trial's ${a.storageGB} GB of storage is full. Delete videos you no longer need, or start the $5 Starter plan: ${URL_HINT}.` };
      return check(u.footageMinutes, a.footageMinutes + (acct.bonusFootageMinutes ?? 0), "footage minutes");
    }
    return { ok: true };
  }
  // Starter
  if (acct.status === "past_due") return { ok: false, code: "past_due", message: `Your last payment did not go through. Update your card to keep exporting: ${URL_HINT}.` };
  if (acct.status !== "active") return { ok: false, code: "no_plan", message: `Your Starter plan is not active. Start it again to keep exporting: ${URL_HINT}.` };
  if (ask.metric === "preview") return { ok: true };
  const a = PLAN_INFO.starter.allowance!;
  const s = statement("starter", u, { exportMinutes: acct.bonusExportMinutes, footageMinutes: acct.bonusFootageMinutes });
  const included = ask.metric === "export" ? a.exportMinutes + (acct.bonusExportMinutes ?? 0) : a.footageMinutes + (acct.bonusFootageMinutes ?? 0);
  const used = ask.metric === "export" ? u.exportMinutes : u.footageMinutes;
  const overAfter = Math.max(0, used + minutes - included) - Math.max(0, used - included);
  if (overAfter <= 0) return { ok: true };
  if (!acct.canPay) return { ok: false, code: "no_card", message: `Your plan's ${ask.metric === "export" ? "export" : "footage"} minutes are used up. Add a card to keep going (pay as you go): ${URL_HINT}.` };
  const addCents = ask.metric === "export" ? overAfter * PAYG.exportMinuteCents : (overAfter / 60) * PAYG.footageHourCents;
  if (s.usageCents + addCents > acct.spendLimitCents) {
    return { ok: false, code: "spend_limit", message: `This would pass your $${(acct.spendLimitCents / 100).toFixed(2)} spending limit for pay as you go (used so far: $${(s.usageCents / 100).toFixed(2)}). Raise the limit to keep going: ${URL_HINT}.` };
  }
  return { ok: true, payAsYouGo: true };
}

/** The billing period's days (1-based) between two dates, at least 1. */
export const periodDays = (start: Date | string, end: Date | string) => Math.max(1, Math.round((new Date(end).getTime() - new Date(start).getTime()) / 86_400_000));
export const fmtCents = (c: number) => `$${(c / 100).toFixed(2)}`;

/**
 * A render with heavy effects (counts double): a subject mask, stabilizing, a morph cut, or optical-flow slow motion.
 * Read from the render plan the worker made.
 */
export function isHeavyPlan(plan: unknown): boolean {
  if (!plan || typeof plan !== "object") return false;
  const p = plan as { mattes?: object; stabilize?: object; stabilized?: object; transitions?: { type?: string }[] };
  const some = (o?: object) => !!o && Object.keys(o).length > 0;
  if (some(p.mattes) || some(p.stabilize) || some(p.stabilized)) return true;
  if ((p.transitions ?? []).some((t) => t?.type === "morph")) return true;
  return JSON.stringify(plan).includes('"interp":"flow"');
}
/** A 4K render, from its quality label ("4K", "4K HEVC HDR best"). */
export const isFourKQuality = (quality?: string | null) => /\b4K\b/i.test(quality || "");
