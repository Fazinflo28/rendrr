// The Mac app logs in through the browser (services/desktopLogin.ts): Allow in the browser makes a 5-minute grant;
// the app trades it, once, with the secret that made the challenge, for a sign-in ticket of that same login.
// Needs Redis (REDIS_URL, as in .env). Run: pnpm --filter @rendrr/api test
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { after, describe, it } from "node:test";

const ready = !!process.env.REDIS_URL;

describe("Mac app login through the browser", { skip: !ready && "needs REDIS_URL" }, async () => {
  const { approveDesktopLogin, redeemDesktopLogin, challengeOf } = await import("../src/services/desktopLogin");
  const { redis } = await import("@rendrr/core");
  after(() => redis().disconnect());

  const newVerifier = () => randomBytes(32).toString("base64url");
  const tickets: string[] = [];
  const makeTicket = async (clerkId: string) => { tickets.push(clerkId); return "ticket-for-" + clerkId; };

  it("the challenge is the browser-standard S256 of the secret", () => {
    const v = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"; // RFC 7636 example
    assert.equal(challengeOf(v), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
    assert.equal(challengeOf(v), createHash("sha256").update(v).digest("base64url"));
  });

  it("Allow then redeem gives a ticket for the login that clicked Allow, once", async () => {
    const v = newVerifier();
    const { grant, expiresInMinutes } = await approveDesktopLogin("user_browser", challengeOf(v));
    assert.equal(grant.length, 32);
    assert.equal(expiresInMinutes, 5);
    const ttl = await redis().ttl(`desktop-login:${grant}`);
    assert.ok(ttl > 290 && ttl <= 300, `expires in 5 minutes (${ttl}s)`);
    assert.deepEqual(await redeemDesktopLogin(grant, v, makeTicket), { ticket: "ticket-for-user_browser" });
    await assert.rejects(redeemDesktopLogin(grant, v, makeTicket), /expired or was already used/);
  });

  it("someone else's secret gets nothing, and burns the grant", async () => {
    const mine = newVerifier();
    const { grant } = await approveDesktopLogin("user_victim", challengeOf(mine));
    const before = tickets.length;
    await assert.rejects(redeemDesktopLogin(grant, newVerifier(), makeTicket), /expired or was already used/);
    await assert.rejects(redeemDesktopLogin(grant, mine, makeTicket), /expired or was already used/);
    assert.equal(tickets.length, before, "no ticket was made");
  });

  it("an expired grant gets nothing", async () => {
    const v = newVerifier();
    const { grant } = await approveDesktopLogin("user_late", challengeOf(v));
    await redis().pexpire(`desktop-login:${grant}`, 1);
    await new Promise((r) => setTimeout(r, 20));
    await assert.rejects(redeemDesktopLogin(grant, v, makeTicket), /expired/);
  });

  it("bad input is refused before Redis is read", async () => {
    await assert.rejects(approveDesktopLogin("user_x", "short"), /not right/);
    await assert.rejects(approveDesktopLogin("user_x", "a".repeat(42) + "!"), /not right/);
    await assert.rejects(redeemDesktopLogin("../../etc", newVerifier(), makeTicket), /expired/);
    await assert.rejects(redeemDesktopLogin("a".repeat(32), "tiny", makeTicket), /expired/);
    await assert.rejects(redeemDesktopLogin(undefined, undefined, makeTicket), /expired/);
  });
});
