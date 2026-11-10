// Login through Supabase Auth (replacing Clerk). A stand-in Supabase publishes its public key (JWKS) like the real one;
// tokens it signs open Rendrr: a known email opens the account that already has it (verified only), a new email gets
// a new account unless sign ups are invite only, a token signed by anyone else or for another project is refused, and
// the AI connector's calls (the MCP server's "sb:" login) reach the same account. Needs a database and Redis.
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { after, before, describe, it } from "node:test";
import { exportJWK, generateKeyPair, SignJWT, type JWK } from "jose";

process.env.INTERNAL_API_SECRET ||= "test-internal-secret";
process.env.LOG_LEVEL = process.env.TEST_LOG || "silent";
const ready = !!process.env.DATABASE_URL && !!process.env.REDIS_URL && !!process.env.S3_BUCKET;
const run = Math.random().toString(36).slice(2, 8);

describe("login through Supabase Auth", { skip: !ready && "needs DATABASE_URL, REDIS_URL and storage" }, async () => {
  const keys = await generateKeyPair("ES256");
  const other = await generateKeyPair("ES256");
  const jwk: JWK = { ...(await exportJWK(keys.publicKey)), kid: "k1", alg: "ES256", use: "sig" };
  let stub: Server; let base = "";
  // The stand-in Supabase: its JWKS, and nothing else is needed (no secret key: the token's own claims are used).
  await new Promise<void>((ok) => {
    stub = createServer((req, res) => {
      if (req.url === "/auth/v1/.well-known/jwks.json") { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ keys: [jwk] })); return; }
      res.statusCode = 404; res.end("{}");
    }).listen(0, () => ok());
  });
  base = `http://127.0.0.1:${(stub!.address() as { port: number }).port}`;
  process.env.SUPABASE_URL = base;
  delete process.env.SUPABASE_SECRET_KEY;

  const { prisma } = await import("@rendrr/db");
  const { redis, env } = await import("@rendrr/core");
  const { buildServer } = await import("../src/server");
  let app: Awaited<ReturnType<typeof buildServer>>;
  const sign = (claims: Record<string, unknown>, o: { key?: CryptoKey; iss?: string; exp?: string } = {}) =>
    new SignJWT({ role: "authenticated", aud: "authenticated", ...claims }).setProtectedHeader({ alg: "ES256", kid: "k1" }).setIssuer(o.iss ?? `${base}/auth/v1`).setIssuedAt().setExpirationTime(o.exp ?? "1h").sign(o.key ?? keys.privateKey);
  const me = (tok: string) => app.inject({ method: "GET", url: "/account/profile", headers: { authorization: `Bearer ${tok}` } });
  const email = `owner-${run}@test.rendrr.dev`;
  let ownerId = "";
  const sub1 = crypto.randomUUID(), sub2 = crypto.randomUUID(), sub3 = crypto.randomUUID(), sub4 = crypto.randomUUID();

  before(async () => {
    assert.equal(env().SUPABASE_URL, base, "the server reads the stand-in's URL");
    app = await buildServer();
    // An account made through Clerk, with an edit in it.
    const u = await prisma.user.create({ data: { clerkId: `user_clerk_${run}`, email, name: "Owner" } });
    ownerId = u.id;
    const folder = await prisma.folder.create({ data: { userId: u.id, name: "Edits", workspace: "Personal" } });
    const v = await prisma.video.create({ data: { userId: u.id, name: "Talk", seconds: 10, source: "drive", status: "ready" } });
    await prisma.project.create({ data: { userId: u.id, folderId: folder.id, videoId: v.id, name: `Promo ${run}`, timeline: {} as never } });
  });
  after(async () => {
    const ids = [sub1, sub2, sub3, sub4].map((s) => `sb:${s}`);
    const made = await prisma.user.findMany({ where: { OR: [{ id: ownerId }, { clerkId: { in: ids } }] }, select: { id: true } });
    await prisma.userLogin.deleteMany({ where: { clerkId: { in: ids } } });
    await prisma.project.deleteMany({ where: { userId: { in: made.map((m) => m.id) } } });
    await prisma.video.deleteMany({ where: { userId: { in: made.map((m) => m.id) } } });
    await prisma.folder.deleteMany({ where: { userId: { in: made.map((m) => m.id) } } });
    await prisma.user.deleteMany({ where: { id: { in: made.map((m) => m.id) } } });
    delete process.env.SIGNUP_ALLOWLIST;
    await app.close(); await redis().quit().catch(() => {}); stub.close();
  });

  it("a verified email (Google) opens the account it already has, edits and all", async () => {
    const tok = await sign({ sub: sub1, email, app_metadata: { provider: "google" }, user_metadata: { full_name: "Owner G", email_verified: true } });
    const r = await me(tok);
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(r.json().email, email);
    const link = await prisma.userLogin.findUnique({ where: { clerkId: `sb:${sub1}` } });
    assert.equal(link?.userId, ownerId, "the Supabase login is linked to the Clerk-made account");
    const ps = await app.inject({ method: "GET", url: "/projects", headers: { authorization: `Bearer ${tok}` } });
    assert.ok(JSON.stringify(ps.json()).includes(`Promo ${run}`), "its edits are there");
  });

  it("an unverified email does not open someone's account: it gets its own", async () => {
    const tok = await sign({ sub: sub2, email, app_metadata: { provider: "email" }, user_metadata: {} });
    const r = await me(tok);
    assert.equal(r.statusCode, 200, r.body);
    const u = await prisma.user.findUnique({ where: { clerkId: `sb:${sub2}` } });
    assert.ok(u && u.id !== ownerId, "a separate, new account");
  });

  it("invite only: a new email is refused while the list is set; one on the list gets in", async () => {
    process.env.SIGNUP_ALLOWLIST = `vip-${run}@test.rendrr.dev`;
    (env() as { SIGNUP_ALLOWLIST?: string }).SIGNUP_ALLOWLIST = process.env.SIGNUP_ALLOWLIST;
    const no = await me(await sign({ sub: sub3, email: `stranger-${run}@test.rendrr.dev`, app_metadata: { provider: "google" }, user_metadata: { email_verified: true } }));
    assert.equal(no.statusCode, 403); assert.equal(no.json().error.code, "invite-only");
    const chk = await app.inject({ method: "POST", url: "/auth/signup-check", payload: { email: `stranger-${run}@test.rendrr.dev` } });
    assert.equal(chk.statusCode, 403);
    const okChk = await app.inject({ method: "POST", url: "/auth/signup-check", payload: { email: `vip-${run}@test.rendrr.dev` } });
    assert.equal(okChk.statusCode, 200);
    const yes = await me(await sign({ sub: sub4, email: `vip-${run}@test.rendrr.dev`, app_metadata: { provider: "google" }, user_metadata: { email_verified: true } }));
    assert.equal(yes.statusCode, 200, yes.body);
    delete process.env.SIGNUP_ALLOWLIST; (env() as { SIGNUP_ALLOWLIST?: string }).SIGNUP_ALLOWLIST = undefined;
  });

  it("refuses tokens signed by anyone else, for another project, or expired", async () => {
    const forged = await sign({ sub: sub1, email }, { key: other.privateKey });
    assert.equal((await me(forged)).statusCode, 401);
    const elsewhere = await sign({ sub: sub1, email }, { iss: "https://someone-else.supabase.co/auth/v1" });
    assert.equal((await me(elsewhere)).statusCode, 401, "another issuer is not taken as Supabase, nor as Clerk");
    const old = await sign({ sub: sub1, email }, { exp: "-1m" });
    assert.equal((await me(old)).statusCode, 401);
    const anon = await sign({ sub: sub1, role: "anon" });
    assert.equal((await me(anon)).statusCode, 401, "the anonymous key's token is not a login");
  });

  it("the AI connector's calls with the Supabase login reach the same account", async () => {
    const r = await app.inject({ method: "POST", url: "/internal/tools/list_projects", headers: { "x-internal-secret": process.env.INTERNAL_API_SECRET!, "x-rendrr-clerk-id": `sb:${sub1}`, "x-rendrr-ai": "claude" }, payload: {} });
    assert.equal(r.statusCode, 200, r.body);
    assert.ok(r.json().text.includes(`Promo ${run}`));
  });
});
