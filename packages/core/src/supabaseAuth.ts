// Supabase Auth (replacing Clerk): checks a Supabase access token (the web app's session, the AI connector's OAuth
// token) and looks users up with the project's secret key. A Supabase login is stored as "sb:<user id>" where Clerk
// logins were stored (User.clerkId, UserLogin.clerkId), so both kinds of login open the same Rendrr account.
import { createClient, type SupabaseClient, type User as SupabaseUser } from "@supabase/supabase-js";
import { createHash } from "node:crypto";
import { createRemoteJWKSet, decodeJwt, decodeProtectedHeader, jwtVerify } from "jose";
import { env } from "./env";

export const SB_PREFIX = "sb:";
export const isSupabaseLogin = (loginId: string) => loginId.startsWith(SB_PREFIX);
export const supabaseLoginId = (userId: string) => SB_PREFIX + userId;
export const supabaseUserId = (loginId: string) => loginId.slice(SB_PREFIX.length);

/** Supabase Auth is set up on this server (its URL is known). */
export const supabaseConfigured = () => !!env().SUPABASE_URL;
/** Supabase is the login the web app and the AI connector use (Clerk otherwise). */
export const supabaseIsLogin = () => supabaseConfigured() && (env().AUTH_PROVIDER || "").toLowerCase() === "supabase";
/** The project's address alone: anything pasted after it (".../rest/v1/", a trailing slash) is dropped. */
export const supabaseOrigin = (raw: string) => { const t = (raw || "").trim(); if (!t) return ""; try { return new URL(t).origin; } catch { return t.replace(/\/+$/, ""); } };
const base = () => supabaseOrigin(env().SUPABASE_URL || "");
/** The issuer Supabase writes in its tokens, and the OAuth authorization server's id. */
export const supabaseIssuer = () => `${base()}/auth/v1`;

/** What a checked token says about who is calling. */
export type SupabaseLogin = { userId: string; loginId: string; email: string | null; emailVerified: boolean; name: string | null; clientId: string | null };

/** The token's issuer is this project's Supabase Auth (read without checking: the check comes next). */
export function isSupabaseToken(token: string): boolean {
  if (!supabaseConfigured()) return false;
  try { return decodeJwt(token).iss === supabaseIssuer(); } catch { return false; }
}

let jwks: ReturnType<typeof createRemoteJWKSet> | null = null, jwksFor = "";
const checked = new Map<string, { at: number; login: SupabaseLogin | null }>();
const hash = (t: string) => createHash("sha256").update(t).digest("base64url");

function fromClaims(p: Record<string, unknown>): SupabaseLogin | null {
  const sub = typeof p.sub === "string" ? p.sub : "";
  if (!sub || p.role === "anon") return null;
  const meta = (p.user_metadata || {}) as Record<string, unknown>;
  const app = (p.app_metadata || {}) as Record<string, unknown>;
  const email = typeof p.email === "string" && p.email ? p.email.trim().toLowerCase() : null;
  // Signed in with Google (or another provider that checks emails), or a confirmed email/password account.
  const provider = typeof app.provider === "string" ? app.provider : "";
  // (The API checks again with the secret key, which knows when the email was confirmed.)
  const emailVerified = !!email && (meta.email_verified === true || (provider !== "" && provider !== "email"));
  const name = (typeof meta.full_name === "string" && meta.full_name) || (typeof meta.name === "string" && meta.name) || null;
  return { userId: sub, loginId: supabaseLoginId(sub), email, emailVerified, name, clientId: typeof p.client_id === "string" ? p.client_id : null };
}

/**
 * Checks a Supabase access token: by the project's public keys (asymmetric signing keys) when it has them, else by
 * asking Supabase Auth who it is (the older shared-secret tokens). Null: not valid. Results kept for a minute.
 */
export async function verifySupabaseToken(token: string): Promise<SupabaseLogin | null> {
  if (!supabaseConfigured()) return null;
  const key = hash(token), hit = checked.get(key);
  if (hit && Date.now() - hit.at < 60_000) return hit.login;
  let login: SupabaseLogin | null = null;
  try {
    const alg = decodeProtectedHeader(token).alg || "";
    if (alg.startsWith("HS")) login = await viaUserEndpoint(token);
    else {
      if (!jwks || jwksFor !== base()) { jwks = createRemoteJWKSet(new URL(`${supabaseIssuer()}/.well-known/jwks.json`), { cooldownDuration: 30_000 }); jwksFor = base(); }
      const { payload } = await jwtVerify(token, jwks, { issuer: supabaseIssuer() });
      login = fromClaims(payload as Record<string, unknown>);
    }
  } catch { login = null; }
  checked.set(key, { at: Date.now(), login });
  if (checked.size > 5000) for (const [k, v] of checked) if (Date.now() - v.at > 60_000) checked.delete(k);
  return login;
}

async function viaUserEndpoint(token: string): Promise<SupabaseLogin | null> {
  const r = await fetch(`${supabaseIssuer()}/user`, { headers: { apikey: env().SUPABASE_PUBLISHABLE_KEY || env().SUPABASE_SECRET_KEY || "", authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(8000) }).catch(() => null);
  if (!r?.ok) return null;
  const u = (await r.json().catch(() => null)) as SupabaseUser | null;
  if (!u?.id) return null;
  const claims = decodeJwt(token) as Record<string, unknown>;
  return { ...userLogin(u), clientId: typeof claims.client_id === "string" ? claims.client_id : null };
}

let admin: SupabaseClient | null = null;
/** The project's admin client (the secret key; the API only). Null when the key is not set. */
export function supabaseAdmin(): SupabaseClient | null {
  if (!supabaseConfigured() || !env().SUPABASE_SECRET_KEY) return null;
  admin ||= createClient(base(), env().SUPABASE_SECRET_KEY!, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
  return admin;
}

/** A Supabase user as a login: its email counts as verified once confirmed (or from a provider like Google). */
export function userLogin(u: SupabaseUser): SupabaseLogin {
  const meta = (u.user_metadata || {}) as Record<string, unknown>;
  const email = u.email ? u.email.trim().toLowerCase() : null;
  return { userId: u.id, loginId: supabaseLoginId(u.id), email, emailVerified: !!email && !!(u.email_confirmed_at || meta.email_verified === true),
    name: (typeof meta.full_name === "string" && meta.full_name) || (typeof meta.name === "string" && meta.name) || null, clientId: null };
}

/** A login looked up by its id with the secret key. Null without the key, or when it is gone. */
export async function supabaseLoginById(loginId: string): Promise<SupabaseLogin | null> {
  const a = supabaseAdmin();
  if (!a || !isSupabaseLogin(loginId)) return null;
  const { data, error } = await a.auth.admin.getUserById(supabaseUserId(loginId));
  return error || !data?.user ? null : userLogin(data.user);
}

const clients = new Map<string, { at: number; name: string | null }>();
/** The name an OAuth client registered with (the AI connector: "Claude", "ChatGPT"...), kept 10 minutes. */
export async function supabaseClientName(clientId: string): Promise<string | null> {
  const hit = clients.get(clientId);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.name;
  const a = supabaseAdmin();
  let name: string | null = null;
  if (a) {
    const r = await (a.auth.admin as unknown as { oauth?: { getClient(id: string): Promise<{ data: { client_name?: string } | null }> } }).oauth?.getClient(clientId).catch(() => null);
    name = r?.data?.client_name || null;
  }
  clients.set(clientId, { at: Date.now(), name });
  return name;
}

/**
 * A one-time sign-in for a user (the Mac app logging in through the browser): a magic link's hashed token, which the
 * app trades for a session (verifyOtp type "magiclink"). Nothing is emailed.
 */
export async function supabaseSignInToken(loginId: string): Promise<{ tokenHash: string; email: string }> {
  const a = supabaseAdmin();
  if (!a) throw new Error("Supabase secret key is not set");
  const u = await supabaseLoginById(loginId);
  if (!u?.email) throw new Error("That login has no email");
  const { data, error } = await a.auth.admin.generateLink({ type: "magiclink", email: u.email });
  if (error || !data?.properties?.hashed_token) throw new Error(error?.message || "No sign-in link");
  return { tokenHash: data.properties.hashed_token, email: u.email };
}
