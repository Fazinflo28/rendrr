// Logs in to the MCP server the way Claude does (dynamic client registration, PKCE, Clerk sign-in, consent)
// and saves the access token to .mcp-token. Needs the test user (see SMOKE_TEST.md) and playwright-core.
//   node scripts/mcp-oauth-login.mjs https://mcp-production-7fa0.up.railway.app/mcp
// Full MCP OAuth round trip, like Claude does it: DCR -> authorize (sign in + consent) -> token -> MCP calls.
import { chromium } from "playwright-core";
import crypto from "node:crypto";
import fs from "node:fs";
const FAPI = (process.env.CLERK_FAPI || "https://mature-joey-7879.clerk.accounts.dev").replace(/\/$/, "");
const MCP = process.argv[2] || process.env.MCP_URL || "http://localhost:4100/mcp";
const REDIRECT = "http://localhost:9999/callback";
const b64u = (b) => b.toString("base64url");
const reg = await (await fetch(FAPI + "/oauth/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "Claude", redirect_uris: [REDIRECT], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], scope: "openid profile email" }) })).json();
console.log("DCR client:", reg.client_id ? "ok " + reg.client_id.slice(0, 8) + "…" : JSON.stringify(reg).slice(0, 300));
const verifier = b64u(crypto.randomBytes(32)), challenge = b64u(crypto.createHash("sha256").update(verifier).digest());
const auth = `${FAPI}/oauth/authorize?` + new URLSearchParams({ response_type: "code", client_id: reg.client_id, redirect_uri: REDIRECT, scope: "openid profile email", state: "s1", code_challenge: challenge, code_challenge_method: "S256", resource: MCP });
const exe = fs.existsSync("/opt/pw-browsers/chromium-1194/chrome-linux/chrome") ? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" : undefined;
const browser = await chromium.launch({ executablePath: exe, proxy: process.env.HTTPS_PROXY ? { server: process.env.HTTPS_PROXY, bypass: "localhost,127.0.0.1" } : undefined });
const page = await browser.newPage({ ignoreHTTPSErrors: true });
let code = null;
page.on("request", (r) => { if (r.url().startsWith(REDIRECT)) code = new URL(r.url()).searchParams.get("code"); });
await page.goto(auth, { waitUntil: "domcontentloaded" }).catch(() => {});
const shot = async (n) => page.screenshot({ path: `/tmp/rendrr-oauth-step-${n}.png` }).catch(() => {});
for (let i = 0; i < 25 && !code; i++) {
  await page.waitForTimeout(1500);
  const url = page.url();
  if (code) break;
  const email = page.locator('input[name="identifier"], input[type="email"]');
  const pw = page.locator('input[type="password"]');
  const otp = page.locator('input[autocomplete="one-time-code"], input[name="code"]');
  if (await email.count() && await email.first().isVisible().catch(() => false) && !(await email.first().inputValue())) { await email.first().fill((process.env.SMOKE_EMAIL || "smoke+clerk_test@rendrr.dev")); await page.keyboard.press("Enter"); await shot(i + "-email"); continue; }
  if (await pw.count() && await pw.first().isVisible().catch(() => false)) { await pw.first().fill((process.env.SMOKE_PASSWORD || "Rendrr-Smoke-Test-2026!")); await page.keyboard.press("Enter"); await shot(i + "-pw"); continue; }
  if (await otp.count() && await otp.first().isVisible().catch(() => false)) { await otp.first().fill("424242"); await shot(i + "-otp"); continue; }
  const allow = page.getByRole("button", { name: /allow|authorize|continue|accept/i });
  if (await allow.count()) { await shot(i + "-consent"); await allow.first().click().catch(() => {}); continue; }
  console.log("waiting at", url.slice(0, 100));
}
await shot("final");
await browser.close();
if (!code) { console.log("NO CODE"); process.exit(1); }
console.log("authorization code: ok");
const tok = await (await fetch(FAPI + "/oauth/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id: reg.client_id, code_verifier: verifier }) })).json();
console.log("token:", tok.access_token ? "ok (" + tok.token_type + ", scope " + tok.scope + ")" : JSON.stringify(tok).slice(0, 300));
fs.writeFileSync(".mcp-token", tok.access_token || "");


