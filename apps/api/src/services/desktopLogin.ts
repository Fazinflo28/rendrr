import { createHash, randomBytes } from "node:crypto";
import { AppError, redis, safeEqual } from "@rendrr/core";

// Log the Mac app in through the browser, where Google sign-in works and the person is usually logged in already.
//  1. The app makes a secret (verifier) and opens /desktop-login?c=<sha256(verifier)> in the browser.
//  2. In the browser, logged in, the person clicks Allow: approve() keeps {challenge, login} for 5 minutes under a
//     random grant, and the page hands the grant to the app through the rendrr:// link (only that Mac gets it).
//  3. The app redeems grant + verifier: once only, and only with the secret that made the challenge, it gets a
//     2-minute sign-in for that login (a Clerk ticket, or a Supabase magic link's hashed token). A link someone else made and got approved is useless to them:
//     the grant goes to the approver's own Mac, and their verifier never matches it.

const GRANT_SECONDS = 300;
const key = (grant: string) => `desktop-login:${grant}`;
const B64URL = /^[A-Za-z0-9_-]+$/;

export const challengeOf = (verifier: string) => createHash("sha256").update(verifier).digest("base64url");

export async function approveDesktopLogin(clerkId: string, challenge: unknown) {
  if (typeof challenge !== "string" || challenge.length !== 43 || !B64URL.test(challenge)) throw new AppError("This login link is not right. Start again from the Rendrr app.", 400, "desktop-login");
  const grant = randomBytes(24).toString("base64url");
  await redis().set(key(grant), JSON.stringify({ c: challenge, clerkId }), "EX", GRANT_SECONDS);
  return { grant, expiresInMinutes: GRANT_SECONDS / 60 };
}

export async function redeemDesktopLogin<T extends object>(grant: unknown, verifier: unknown, makeTicket: (clerkId: string) => Promise<T>): Promise<T> {
  const gone = () => new AppError("This login has expired or was already used. Start again from the Rendrr app.", 400, "desktop-login");
  if (typeof grant !== "string" || grant.length !== 32 || !B64URL.test(grant)) throw gone();
  if (typeof verifier !== "string" || verifier.length < 43 || verifier.length > 128 || !B64URL.test(verifier)) throw gone();
  // Read and delete in one step: a grant works once, even if two requests race.
  const res = await redis().multi().get(key(grant)).del(key(grant)).exec();
  const raw = res?.[0]?.[1];
  if (typeof raw !== "string") throw gone();
  const saved = JSON.parse(raw) as { c: string; clerkId: string };
  if (!safeEqual(challengeOf(verifier), saved.c)) throw gone();
  return makeTicket(saved.clerkId);
}
