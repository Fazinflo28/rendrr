// Plans, allowances, pay-as-you-go lines and the "may this happen" answer the API gives the web app and the AI.
import { describe, expect, it } from "vitest";
import { cardFeeCents, exportMultiplier, jobCost, mayUse, PLAN_INFO, statement, storageCost, type Account, type PeriodUsage } from "../src/billing";

const none: PeriodUsage = { exportMinutes: 0, previewMinutes: 0, footageMinutes: 0, storageGbByDay: [], storageGBNow: 0 };
const day = 86_400_000;
const trial = (over: Partial<Account> = {}): Account => ({ plan: "trial", status: "trialing", trialEndsAt: new Date(Date.now() + 3 * day), spendLimitCents: 2000, canPay: false, ...over });
const starter = (over: Partial<Account> = {}): Account => ({ plan: "starter", status: "active", trialEndsAt: new Date(0), spendLimitCents: 2000, canPay: true, ...over });

describe("plans", () => {
  it("the trial and Starter allowances are the numbers on the pricing page", () => {
    expect(PLAN_INFO.trial.allowance).toEqual({ exportMinutes: 10, previewMinutes: 60, footageMinutes: 30, storageGB: 5 });
    expect(PLAN_INFO.starter.allowance).toEqual({ exportMinutes: 25, previewMinutes: null, footageMinutes: 60, storageGB: 10 });
    expect(PLAN_INFO.starter.priceCents).toBe(500);
  });
  it("4K and heavy effects count double, not four times", () => {
    expect(exportMultiplier({})).toBe(1);
    expect(exportMultiplier({ fourK: true })).toBe(2);
    expect(exportMultiplier({ heavy: true })).toBe(2);
    expect(exportMultiplier({ fourK: true, heavy: true })).toBe(2);
  });
});

describe("statement", () => {
  it("inside the allowance: just the $5", () => {
    const s = statement("starter", { ...none, exportMinutes: 20, footageMinutes: 50, storageGbByDay: [4, 6], storageGBNow: 6 });
    expect(s.totalCents).toBe(500);
    expect(s.lines).toEqual([]);
    expect(s.meters.find((m) => m.metric === "export")).toMatchObject({ used: 20, included: 25, left: 5, over: 0 });
  });
  it("the 50-short-videos month from the plan: 75 export minutes, 2.5 hours of footage, 30 GB", () => {
    const s = statement("starter", { ...none, exportMinutes: 75, footageMinutes: 150, storageGbByDay: Array(30).fill(30), storageGBNow: 30 });
    expect(s.lines.map((l) => [l.metric, l.quantity, l.amountCents])).toEqual([["export", 50, 500], ["footage", 90, 150], ["storage", 600, 200]]);
    expect(s.totalCents).toBe(1350);
  });
  it("bonus minutes count before pay as you go", () => {
    const s = statement("starter", { ...none, exportMinutes: 30 }, { exportMinutes: 10 });
    expect(s.lines).toEqual([]);
    expect(s.bonusUsed.exportMinutes).toBe(5);
  });
  it("the trial and comp never charge", () => {
    expect(statement("trial", { ...none, exportMinutes: 99 }).totalCents).toBe(0);
    expect(statement("comp", { ...none, exportMinutes: 999 }).totalCents).toBe(0);
    expect(statement("comp", none).meters.every((m) => m.included === null)).toBe(true);
  });
});

describe("mayUse", () => {
  it("trial: exports up to its 10 minutes (with a minute of grace for the last one), then the plan", () => {
    expect(mayUse(trial(), { ...none, exportMinutes: 9 }, { metric: "export", minutes: 1.8 }).ok).toBe(true);
    const no = mayUse(trial(), { ...none, exportMinutes: 9 }, { metric: "export", minutes: 3 });
    expect(no).toMatchObject({ ok: false, code: "trial_limit" });
    expect((no as { message: string }).message).toMatch(/needs 3 export minutes and your free trial has 1 left\. Start the \$5 Starter plan/);
    expect(mayUse(trial(), { ...none, exportMinutes: 10 }, { metric: "export", minutes: 0.2 }).ok).toBe(false);
  });
  it("trial: no 4K, previews and footage have their own limits, storage 5 GB, ends after 7 days", () => {
    expect(mayUse(trial(), none, { metric: "export", minutes: 1, fourK: true })).toMatchObject({ ok: false, code: "trial_4k" });
    expect(mayUse(trial(), { ...none, previewMinutes: 60 }, { metric: "preview", minutes: 1 })).toMatchObject({ ok: false, code: "trial_limit" });
    expect(mayUse(trial(), { ...none, footageMinutes: 25 }, { metric: "footage", minutes: 4 }).ok).toBe(true);
    expect(mayUse(trial(), { ...none, storageGBNow: 4.8 }, { metric: "footage", minutes: 2, storageGBAfter: 5.3 })).toMatchObject({ ok: false, code: "trial_storage" });
    expect(mayUse(trial({ trialEndsAt: new Date(Date.now() - 1000) }), none, { metric: "export", minutes: 1 })).toMatchObject({ ok: false, code: "trial_ended" });
  });
  it("starter: inside the allowance always; past it pay as you go with a card, up to the spending limit", () => {
    expect(mayUse(starter({ canPay: false }), { ...none, exportMinutes: 10 }, { metric: "export", minutes: 10 })).toEqual({ ok: true });
    expect(mayUse(starter({ canPay: false }), { ...none, exportMinutes: 24 }, { metric: "export", minutes: 3 })).toMatchObject({ ok: false, code: "no_card" });
    expect(mayUse(starter(), { ...none, exportMinutes: 24 }, { metric: "export", minutes: 3 })).toEqual({ ok: true, payAsYouGo: true });
    // $20 limit: 25 included + 200 extra minutes = $20 exactly; one more 4K minute (2 billable) passes it.
    expect(mayUse(starter(), { ...none, exportMinutes: 225 }, { metric: "export", minutes: 1, fourK: true })).toMatchObject({ ok: false, code: "spend_limit" });
    expect(mayUse(starter({ spendLimitCents: 0 }), { ...none, exportMinutes: 25 }, { metric: "export", minutes: 1 })).toMatchObject({ ok: false, code: "spend_limit" });
  });
  it("starter: previews are free; a failed payment or a cancelled plan stops exports", () => {
    expect(mayUse(starter(), { ...none, previewMinutes: 9999 }, { metric: "preview", minutes: 30 }).ok).toBe(true);
    expect(mayUse(starter({ status: "past_due" }), none, { metric: "export", minutes: 1 })).toMatchObject({ ok: false, code: "past_due" });
    expect(mayUse(starter({ status: "canceled" }), none, { metric: "export", minutes: 1 })).toMatchObject({ ok: false, code: "no_plan" });
  });
  it("comp: anything", () => {
    expect(mayUse({ ...starter(), plan: "comp", status: "active" }, { ...none, exportMinutes: 1e6 }, { metric: "export", minutes: 600, fourK: true }).ok).toBe(true);
  });
});

describe("costs", () => {
  it("a job's dollars from what was measured, at Railway and AssemblyAI rates", () => {
    // A 20-minute 1080p final: 209 s at about 6 vCPU and 3 GB.
    const c = jobCost({ cpuSeconds: 209 * 6, memGbSeconds: 209 * 3 });
    expect(c.costTotal).toBeCloseTo(0.0121, 3);
    // An hour transcribed: $0.15. 1 GB sent to Drive: $0.05.
    expect(jobCost({ cpuSeconds: 0, memGbSeconds: 0, transcribeSeconds: 3600 }).costTranscribe).toBeCloseTo(0.15, 5);
    expect(jobCost({ cpuSeconds: 0, memGbSeconds: 0, egressBytes: 1024 ** 3 }).costEgress).toBeCloseTo(0.05, 5);
  });
  it("storage by GB-days, card fee per charge", () => {
    expect(storageCost(300)).toBeCloseTo(0.15, 5); // 10 GB for 30 days
    expect(cardFeeCents(500)).toBe(45);
    expect(cardFeeCents(0)).toBe(0);
  });
});
