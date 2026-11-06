// The Mac app (desktop/) logs in through the browser, because Google refuses to sign in inside apps.
// The app keeps a secret (verifier) here and opens /desktop-login?c=<S256 of it> in the browser; Allow there sends a
// grant back through rendrr://; the app trades grant + verifier for a sign-in ticket (apps/api/src/services/desktopLogin.ts).
export const DESKTOP_KEY = "rendrr:desktop-login";
const MAX_AGE_MS = 15 * 60_000;

export const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
export const s256 = async (v: string) => b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(v))));

/** The Mac app's bridge (desktop/preload.js), or null in a browser. openInBrowser is there from app 0.1.2 on. */
export const desktopApp = (): any => (typeof window !== "undefined" ? (window as any).rendrrDesktop || null : null);

/** A new secret, kept in this app's storage; returns its challenge for the browser. */
export async function newChallenge(now = Date.now()): Promise<string> {
  const v = b64url(crypto.getRandomValues(new Uint8Array(32)));
  localStorage.setItem(DESKTOP_KEY, JSON.stringify({ v, at: now }));
  return s256(v);
}

/** The secret, if this app started a login in the last 15 minutes. */
export function savedVerifier(now = Date.now()): string | null {
  try {
    const s = JSON.parse(localStorage.getItem(DESKTOP_KEY) || "{}");
    return typeof s.v === "string" && typeof s.at === "number" && now - s.at <= MAX_AGE_MS ? s.v : null;
  } catch { return null; }
}

export function forgetVerifier() { try { localStorage.removeItem(DESKTOP_KEY); } catch { /* fine */ } }

export const isChallenge = (c: string) => /^[A-Za-z0-9_-]{43}$/.test(c);
export const appLink = (grant: string) => "rendrr://auth?grant=" + encodeURIComponent(grant);
