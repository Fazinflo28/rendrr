// The connector's login through Supabase Auth: the protected resource metadata names Supabase as the authorization
// server (for the URL asked about), and tokens Supabase signs are taken (as "sb:<user>"), others refused.
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { after, describe, it } from "node:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";

describe("connector login through Supabase", async () => {
  const keys = await generateKeyPair("ES256"), other = await generateKeyPair("ES256");
  const jwk = { ...(await exportJWK(keys.publicKey)), kid: "k1", alg: "ES256", use: "sig" };
  let stub!: Server;
  await new Promise<void>((ok) => { stub = createServer((req, res) => {
    if (req.url === "/auth/v1/.well-known/jwks.json") { res.end(JSON.stringify({ keys: [jwk] })); return; }
    if (req.url === "/.well-known/oauth-authorization-server/auth/v1") { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ issuer: base + "/auth/v1", registration_endpoint: base + "/auth/v1/oauth/clients/register" })); return; }
    res.statusCode = 404; res.end();
  }).listen(0, () => ok()); });
  const base = `http://127.0.0.1:${(stub.address() as { port: number }).port}`;
  process.env.SUPABASE_URL = base; process.env.AUTH_PROVIDER = "supabase";
  const { authServerMetadata, issuer, protectedResource, supabaseLogin, verifySupabase } = await import("../src/supabase");
  after(() => stub.close());
  const sign = (c: Record<string, unknown>, key = keys.privateKey, iss = `${base}/auth/v1`) => new SignJWT({ role: "authenticated", ...c }).setProtectedHeader({ alg: "ES256", kid: "k1" }).setIssuer(iss).setIssuedAt().setExpirationTime("1h").sign(key);
  const fakeRes = () => { const r: { body?: unknown; code?: number; headers: Record<string, string> } = { headers: {} }; const res = { set(h: Record<string, string>) { Object.assign(r.headers, h); return res; }, json(b: unknown) { r.body = b; return res; }, status(c: number) { r.code = c; return res; } }; return { r, res: res as never }; };

  it("is on with AUTH_PROVIDER=supabase and a project URL", () => { assert.equal(supabaseLogin(), true); assert.equal(issuer(), `${base}/auth/v1`); });

  it("keeps only the project address when more was pasted after it", () => {
    process.env.SUPABASE_URL = `${base}/rest/v1/`;
    try { assert.equal(issuer(), `${base}/auth/v1`); } finally { process.env.SUPABASE_URL = base; }
  });

  it("publishes Supabase as the authorization server for the URL asked about", () => {
    const { r, res } = fakeRes();
    protectedResource({ protocol: "https", get: () => "mcp.rendrr.live", originalUrl: "/.well-known/oauth-protected-resource/mcp" } as never, res);
    assert.deepEqual((r.body as { resource: string; authorization_servers: string[] }).resource, "https://mcp.rendrr.live/mcp");
    assert.deepEqual((r.body as { authorization_servers: string[] }).authorization_servers, [`${base}/auth/v1`]);
  });

  it("serves Supabase's authorization server metadata on its own host too", async () => {
    const { r, res } = fakeRes();
    await authServerMetadata({} as never, res);
    assert.equal((r.body as { issuer: string }).issuer, `${base}/auth/v1`);
  });

  it("takes Supabase's tokens as sb:<user>, with the OAuth client; refuses others", async () => {
    const info = await verifySupabase(await sign({ sub: "11111111-2222-3333-4444-555555555555", client_id: "claude-client", scope: "openid email" }));
    assert.equal((info?.extra as { userId: string }).userId, "sb:11111111-2222-3333-4444-555555555555");
    assert.equal(info?.clientId, "claude-client"); assert.deepEqual(info?.scopes, ["openid", "email"]);
    assert.equal(await verifySupabase(await sign({ sub: "x" }, other.privateKey)), null, "signed by someone else");
    assert.equal(await verifySupabase(await sign({ sub: "x" }, keys.privateKey, "https://evil.example/auth/v1")), null, "another issuer");
    assert.equal(await verifySupabase(await sign({ sub: "x", role: "anon" })), null, "the anonymous key");
    assert.equal(await verifySupabase("not-a-token"), null);
  });
});
