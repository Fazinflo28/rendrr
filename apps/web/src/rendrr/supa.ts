// Supabase Auth in the browser (replacing Clerk once NEXT_PUBLIC_AUTH_PROVIDER=supabase): email and password, Google,
// password reset, the Mac app's one-time sign-in and the AI connector's consent page. The session lives in this
// browser (localStorage) and refreshes itself; its access token goes to the API on every request.
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const URL_ = process.env.NEXT_PUBLIC_SUPABASE_URL || "";
const KEY = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || "";
export const SUPABASE_AUTH = (process.env.NEXT_PUBLIC_AUTH_PROVIDER || "").toLowerCase() === "supabase" && !!URL_ && !!KEY;

let client: SupabaseClient | null = null;
export function supa(): SupabaseClient {
  client ||= createClient(URL_, KEY, { auth: { flowType: "pkce", persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, storageKey: "rendrr-auth" } });
  return client;
}

let last: string | null = null;
/** The current access token (refreshed when due), or null when logged out. */
export async function supaToken(): Promise<string | null> {
  const { data } = await supa().auth.getSession();
  last = data.session?.access_token ?? null;
  return last;
}
/** The last token seen, for a request that cannot wait (a keepalive as the page closes). */
export const lastSupaToken = () => last;

/** Supabase's error, said for people. */
export function supaMessage(e: unknown, fallback: string): string {
  const m = String((e as { message?: string })?.message || "");
  if (/invalid login credentials/i.test(m)) return "That email or password is not right. Used Rendrr before the new login? Click Forgot password to set one, or continue with Google.";
  if (/email not confirmed/i.test(m)) return "Confirm your email first: open the link we sent you.";
  if (/user already registered/i.test(m)) return "An account with that email already exists. Log in instead.";
  if (/password should be at least|weak password/i.test(m)) return "Pick a stronger password (at least 8 characters).";
  if (/rate limit|too many/i.test(m)) return "Too many tries. Wait a minute and try again.";
  if (/token has expired|otp.*expired|invalid.*token/i.test(m)) return "That code has expired or is not right. Ask for a new one.";
  return m || fallback;
}
