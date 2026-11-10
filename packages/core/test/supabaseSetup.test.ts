// The Supabase setup check (the API logs it at start-up): against a stand-in Supabase and a stand-in Google it says what
// is on and what is missing (Google, confirm email, keys, signing key, OAuth server, Site URL, each redirect address,
// whether Google takes Supabase's callback), and prints no key.
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.S3_BUCKET ||= "test-bucket"; process.env.S3_REGION ||= "auto"; process.env.S3_ENDPOINT ||= "https://storage.example.com";
process.env.S3_ACCESS_KEY_ID ||= "test-key"; process.env.S3_SECRET_ACCESS_KEY ||= "test-secret";
process.env.DATABASE_URL ||= "postgres://test@localhost:5432/test"; process.env.REDIS_URL ||= "redis://localhost:6379";

const SITE = "https://app.example.com";
// What the stand-in has switched on (the tests flip these).
const on = { google: true, confirm: true, oauth: true, registration: true, asym: true, googleTakesCallback: true };
const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");

describe("Supabase setup check", () => {
  let stub: Server, base = "";
  beforeAll(async () => {
    await new Promise<void>((ok) => {
      stub = createServer((req, res) => {
        const u = new URL(req.url || "/", base);
        const send = (code: number, body: unknown, headers: Record<string, string> = {}) => { res.writeHead(code, { "content-type": "application/json", ...headers }); res.end(JSON.stringify(body)); };
        if (u.pathname === "/auth/v1/settings") return req.headers.apikey === "pk_test" ? send(200, { external: { google: on.google, email: true }, mailer_autoconfirm: !on.confirm }) : send(401, { message: "Invalid API key" });
        if (u.pathname === "/auth/v1/admin/users") return req.headers.authorization === "Bearer sk_test" ? send(200, { users: [], aud: "authenticated" }) : send(401, { msg: "Invalid API key" });
        if (u.pathname === "/auth/v1/.well-known/jwks.json") return send(200, { keys: on.asym ? [{ kty: "EC", alg: "ES256", kid: "k1" }] : [] });
        if (u.pathname === "/.well-known/oauth-authorization-server/auth/v1") return on.oauth ? send(200, { issuer: `${base}/auth/v1`, authorization_endpoint: `${base}/auth/v1/oauth/authorize`, ...(on.registration ? { registration_endpoint: `${base}/auth/v1/oauth/clients/register` } : {}) }) : send(404, {});
        if (u.pathname === "/auth/v1/authorize") {
          if (!on.google) return send(400, { msg: "Unsupported provider: provider is not enabled" });
          const to = u.searchParams.get("redirect_to") || "";
          const state = `${b64({ alg: "HS256" })}.${b64({ site_url: SITE, referrer: to.startsWith(`${SITE}/`) ? to : SITE, provider: "google" })}.sig`;
          return send(302, {}, { location: `${base}/google/auth?client_id=c1&redirect_uri=${encodeURIComponent(`${base}/auth/v1/callback`)}&state=${state}` });
        }
        if (u.pathname === "/google/auth") return on.googleTakesCallback ? send(302, {}, { location: "https://accounts.google.com/v3/signin/identifier?x=1" })
          : send(302, {}, { location: `https://accounts.google.com/signin/oauth/error/v2?authError=${Buffer.from("Error 400: redirect_uri_mismatch").toString("base64")}&client_id=c1` });
        send(404, {});
      }).listen(0, () => ok());
    });
    base = `http://127.0.0.1:${(stub.address() as { port: number }).port}`;
    process.env.SUPABASE_URL = base; process.env.SUPABASE_PUBLISHABLE_KEY = "pk_test"; process.env.SUPABASE_SECRET_KEY = "sk_test";
    await import("../src/supabaseSetup"); // loads supabase-js once (slow the first time)
  }, 60_000);
  afterAll(() => { stub.close(); });

  it("all set: every line is ok, and an address not on the redirect list is named", async () => {
    const { supabaseSetupCheck, setupLineText } = await import("../src/supabaseSetup");
    const lines = await supabaseSetupCheck([SITE, "https://other.example.com/"]);
    const by = Object.fromEntries(lines.map((l) => [l.item, l]));
    for (const k of ["publishable key", "secret key", "Google sign-in", "Email sign-in", "JWT signing key", "OAuth server", "Site URL", `redirect ${SITE}/auth/callback`, "Google client"]) expect(by[k]?.ok, `${k}: ${by[k]?.note}`).toBe(true);
    expect(by["redirect https://other.example.com/auth/callback"].ok).toBe(false);
    expect(by["redirect https://other.example.com/auth/callback"].note).toContain("https://other.example.com/**");
    const text = lines.map(setupLineText).join("\n");
    expect(text).not.toMatch(/pk_test|sk_test|c1/);
    expect(text).toContain("ok Google client");
  });

  it("a URL pasted with more after it still works, and the line says what was ignored; the dashboard address is named", async () => {
    const { supabaseSetupCheck, supabaseUrlNote } = await import("../src/supabaseSetup");
    const { env } = await import("../src/env");
    (env() as { SUPABASE_URL?: string }).SUPABASE_URL = `${base}/rest/v1/`;
    try {
      const by = Object.fromEntries((await supabaseSetupCheck([SITE])).map((l) => [l.item, l]));
      expect(by["Supabase URL"].note).toContain('"/rest/v1/" after it is ignored');
      for (const k of ["publishable key", "secret key", "OAuth server", "JWT signing key", `redirect ${SITE}/auth/callback`]) expect(by[k]?.ok, `${k}: ${by[k]?.note}`).toBe(true);
    } finally { (env() as { SUPABASE_URL?: string }).SUPABASE_URL = base; }
    expect(supabaseUrlNote("https://abcdefghijklmnopqrst.supabase.co")).toEqual({ ok: true, note: "a Supabase project address" });
    expect(supabaseUrlNote("https://supabase.com/dashboard/project/abcdefghijklmnopqrst").ok).toBe(false);
    expect(supabaseUrlNote("abcd").ok).toBe(false);
  });

  it("names what is missing: Google's redirect URI, the signing key, the OAuth server's registration, confirm email, a wrong key", async () => {
    const { supabaseSetupCheck } = await import("../src/supabaseSetup");
    const { env } = await import("../src/env");
    Object.assign(on, { confirm: false, asym: false, registration: false, googleTakesCallback: false });
    let by = Object.fromEntries((await supabaseSetupCheck([SITE])).map((l) => [l.item, l]));
    expect(by["Email sign-in"]).toMatchObject({ ok: false, note: "on, but Confirm email is off" });
    expect(by["JWT signing key"].ok).toBe(false); expect(by["JWT signing key"].note).toContain("Migrate, then Rotate");
    expect(by["OAuth server"]).toMatchObject({ ok: false, note: "on, but Allow dynamic client registration is off" });
    expect(by["Google client"].ok).toBe(false); expect(by["Google client"].note).toContain(`${base}/auth/v1/callback`);
    Object.assign(on, { google: false, oauth: false });
    (env() as { SUPABASE_PUBLISHABLE_KEY?: string }).SUPABASE_PUBLISHABLE_KEY = "wrong";
    by = Object.fromEntries((await supabaseSetupCheck([SITE])).map((l) => [l.item, l]));
    expect(by["publishable key"].ok).toBe(false);
    expect(by["OAuth server"].ok).toBe(false); expect(by["OAuth server"].note).toContain("/oauth/consent");
    (env() as { SUPABASE_PUBLISHABLE_KEY?: string }).SUPABASE_PUBLISHABLE_KEY = "pk_test";
    by = Object.fromEntries((await supabaseSetupCheck([SITE])).map((l) => [l.item, l]));
    expect(by["Google sign-in"].ok).toBe(false);
    expect(by["redirect URLs"].note).toContain("Google sign-in is off");
  });
});
