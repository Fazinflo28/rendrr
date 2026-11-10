// What is set up in Supabase Auth, read the way a browser would (its public endpoints) and with the secret key, so the
// API's log says what is still missing before (and after) the switch to Supabase logins. Prints no key, token or client
// id: only on/off, the Site URL and the redirect addresses tried.
import { decodeJwt } from "jose";
import { env } from "./env";
import { supabaseAdmin, supabaseConfigured, supabaseIssuer } from "./supabaseAuth";

/** One thing checked. ok null: could not tell. */
export type SetupLine = { item: string; ok: boolean | null; note: string };

const get = (url: string, init: RequestInit = {}) => fetch(url, { redirect: "manual", signal: AbortSignal.timeout(8000), ...init });
const json = async (r: Response) => (await r.json().catch(() => ({}))) as Record<string, any>;
const googleRefusal = (s: string) => (/redirect_uri_mismatch/.test(s) ? "redirect_uri_mismatch" : /(invalid|deleted|disabled)_client/.exec(s)?.[0] || "");

/** Checks Supabase Auth. `webUrls`: the web app's addresses (people come back to <address>/auth/callback). */
export async function supabaseSetupCheck(webUrls: string[]): Promise<SetupLine[]> {
  const out: SetupLine[] = [];
  const add = (item: string, ok: boolean | null, note: string) => out.push({ item, ok, note });
  if (!supabaseConfigured()) { add("Supabase URL", false, "SUPABASE_URL is not set"); return out; }
  const iss = supabaseIssuer(), base = iss.replace(/\/auth\/v1$/, "");

  // The publishable key, and which sign-ins are on.
  const pk = env().SUPABASE_PUBLISHABLE_KEY;
  let google: boolean | null = null;
  if (!pk) add("publishable key", false, "SUPABASE_PUBLISHABLE_KEY is not set");
  else {
    const r = await get(`${iss}/settings`, { headers: { apikey: pk } }).catch(() => null);
    if (!r?.ok) add("publishable key", false, r ? `refused (${r.status}): copy it again from Project Settings > API Keys` : "Supabase did not answer");
    else {
      const s = await json(r), ext = (s.external || {}) as Record<string, boolean>;
      add("publishable key", true, "works");
      google = !!ext.google;
      add("Google sign-in", google, google ? "on" : "off (Authentication > Sign In / Providers > Google)");
      add("Email sign-in", !!ext.email && s.mailer_autoconfirm === false, !ext.email ? "off" : s.mailer_autoconfirm ? "on, but Confirm email is off" : "on, Confirm email on");
    }
  }

  // The secret key (the API looks people up and gives every account a login with it).
  const a = supabaseAdmin();
  if (!a) add("secret key", false, "SUPABASE_SECRET_KEY is not set");
  else {
    const { error } = await a.auth.admin.listUsers({ page: 1, perPage: 1 }).catch((e: Error) => ({ error: e }));
    add("secret key", !error, error ? `refused (${error.message}): copy it again from Project Settings > API Keys` : "works");
  }

  // Signing keys: the connector's login needs an asymmetric one (ES256/RS256).
  {
    const r = await get(`${iss}/.well-known/jwks.json`).catch(() => null);
    const keys = (r?.ok ? ((await json(r)).keys as { alg?: string; kty?: string }[]) : null) || [];
    const asym = keys.filter((k) => (k.alg ? !k.alg.startsWith("HS") : k.kty === "EC" || k.kty === "RSA"));
    add("JWT signing key", r ? asym.length > 0 : null, !r ? "Supabase did not answer"
      : asym.length ? `${[...new Set(asym.map((k) => k.alg || k.kty))].join(", ")} published (make sure Rotate made it the current key)`
      : "still the legacy shared secret (Project Settings > JWT Keys: Migrate, then Rotate)");
  }

  // The OAuth 2.1 server Claude and ChatGPT log in through.
  {
    const r = await get(`${base}/.well-known/oauth-authorization-server/auth/v1`).catch(() => null);
    const m = r?.ok ? await json(r) : null;
    if (!r) add("OAuth server", null, "Supabase did not answer");
    else if (!m?.authorization_endpoint) add("OAuth server", false, "off (Authentication > OAuth Server: on, path /oauth/consent)");
    else add("OAuth server", !!m.registration_endpoint, m.registration_endpoint ? "on, dynamic client registration on" : "on, but Allow dynamic client registration is off");
  }

  // Where people land after Google: the Site URL, each web address's /auth/callback, and whether Google takes the client.
  const urls = [...new Set(webUrls.map((u) => u.replace(/\/$/, "")).filter((u) => /^https:\/\//.test(u)))].slice(0, 3);
  if (google === false) add("redirect URLs", null, "not checked: Google sign-in is off");
  let siteSaid = false, googleSaid = false;
  for (const u of google === false ? [] : urls) {
    const to = `${u}/auth/callback`;
    const r = await get(`${iss}/authorize?provider=google&redirect_to=${encodeURIComponent(to)}`).catch(() => null);
    const loc = r && r.status >= 300 && r.status < 400 ? r.headers.get("location") || "" : "";
    if (!loc) { add(`redirect ${to}`, null, r ? `not checked (Supabase answered ${r.status})` : "Supabase did not answer"); continue; }
    let claims: Record<string, unknown> = {};
    try { claims = decodeJwt(new URL(loc).searchParams.get("state") || "") as Record<string, unknown>; } catch { /* state not readable */ }
    const ref = typeof claims.referrer === "string" ? claims.referrer : null, site = typeof claims.site_url === "string" ? claims.site_url : null;
    if (site && !siteSaid) {
      siteSaid = true;
      const want = urls[0];
      add("Site URL", site.replace(/\/$/, "") === want, site.replace(/\/$/, "") === want ? site : `${site} (set it to ${want} under Authentication > URL Configuration)`);
    }
    add(`redirect ${to}`, ref === null ? null : ref === to, ref === null ? "not checked (state not readable)"
      : ref === to ? "allowed" : `not allowed: people would land on ${ref} (add ${u}/** under Authentication > URL Configuration > Redirect URLs)`);
    if (!googleSaid) {
      googleSaid = true;
      const g = await get(loc).catch(() => null);
      const next = g?.headers.get("location") || "";
      let why = "";
      if (!g) why = "Google did not answer";
      else if (/authError=/.test(next)) why = googleRefusal(Buffer.from(new URL(next, "https://accounts.google.com").searchParams.get("authError") || "", "base64").toString("latin1")) || "refused";
      else if (g.status >= 400 || g.status === 200) why = googleRefusal(await g.text().catch(() => "")) || (g.status >= 400 ? `refused (${g.status})` : "");
      add("Google client", !why, !why ? "takes Supabase's callback (the secret is checked at the first real login)"
        : why === "redirect_uri_mismatch" ? `refuses Supabase's callback: add ${iss}/callback to the Google client's Authorized redirect URIs`
        : `${why}: check the Client ID in Supabase's Google settings`);
    }
  }
  return out;
}

/** One log line per item: "ok", "MISSING" or "?", then what it is. */
export const setupLineText = (l: SetupLine) => `${l.ok ? "ok" : l.ok === false ? "MISSING" : "?"} ${l.item}: ${l.note}`;
