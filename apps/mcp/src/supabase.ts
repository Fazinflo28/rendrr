// The AI connector's login through Supabase Auth (replacing Clerk) once AUTH_PROVIDER=supabase: Supabase's OAuth 2.1
// server registers Claude and ChatGPT (dynamic client registration), shows the consent page on the Rendrr web app
// (/oauth/consent) and issues the token; this server only publishes where to log in and checks the token.
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { Request, Response } from "express";
import { createRemoteJWKSet, decodeJwt, decodeProtectedHeader, jwtVerify } from "jose";

const base = () => (process.env.SUPABASE_URL || "").replace(/\/$/, "");
/** Supabase is the connector's login. */
export const supabaseLogin = () => !!base() && (process.env.AUTH_PROVIDER || "").toLowerCase() === "supabase";
/** Supabase Auth's issuer: the authorization server the connector logs in with. */
export const issuer = () => `${base()}/auth/v1`;

/** RFC 9728: this resource (the URL asked about, without the well-known part) and its authorization server. */
export function protectedResource(req: Request, res: Response) {
  const url = new URL(`${req.protocol}://${req.get("host")}${req.originalUrl}`);
  url.pathname = url.pathname.replace(/\.well-known\/oauth-protected-resource\/?/, "");
  url.search = "";
  res.set("Access-Control-Allow-Origin", "*").json({
    resource: url.toString(), authorization_servers: [issuer()], resource_name: "Rendrr",
    scopes_supported: ["openid", "profile", "email"], bearer_methods_supported: ["header"],
  });
}

let meta: { at: number; body: unknown } | null = null;
/** Supabase's authorization server metadata, also served here for clients that look on the resource's own host. */
export async function authServerMetadata(_req: Request, res: Response) {
  try {
    if (!meta || Date.now() - meta.at > 10 * 60_000) {
      const r = await fetch(`${base()}/.well-known/oauth-authorization-server/auth/v1`, { signal: AbortSignal.timeout(8000) });
      if (!r.ok) throw new Error(`Supabase answered ${r.status}`);
      meta = { at: Date.now(), body: await r.json() };
    }
    res.set("Access-Control-Allow-Origin", "*").json(meta.body);
  } catch (e) {
    res.status(502).json({ error: "authorization server metadata unavailable", detail: (e as Error).message });
  }
}

let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;
const seen = new Map<string, { at: number; info: AuthInfo | null }>();

/** A Supabase access token checked (its signature by the project's public keys, else by Supabase Auth itself). */
export async function verifySupabase(token: string): Promise<AuthInfo | null> {
  const hit = seen.get(token);
  if (hit && Date.now() - hit.at < 60_000) return hit.info;
  let info: AuthInfo | null = null;
  try {
    let claims: Record<string, unknown>;
    if ((decodeProtectedHeader(token).alg || "").startsWith("HS")) {
      const r = await fetch(`${issuer()}/user`, { headers: { apikey: process.env.SUPABASE_PUBLISHABLE_KEY || "", authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(8000) });
      if (!r.ok) throw new Error("rejected");
      claims = decodeJwt(token) as Record<string, unknown>;
    } else {
      jwks ||= createRemoteJWKSet(new URL(`${issuer()}/.well-known/jwks.json`), { cooldownDuration: 30_000 });
      claims = (await jwtVerify(token, jwks, { issuer: issuer() })).payload as Record<string, unknown>;
    }
    const sub = typeof claims.sub === "string" ? claims.sub : "";
    if (sub && claims.role !== "anon") info = {
      token, clientId: typeof claims.client_id === "string" ? claims.client_id : "supabase",
      scopes: typeof claims.scope === "string" ? claims.scope.split(" ").filter(Boolean) : [],
      expiresAt: typeof claims.exp === "number" ? claims.exp : undefined,
      extra: { userId: `sb:${sub}` },
    };
  } catch { info = null; }
  seen.set(token, { at: Date.now(), info });
  if (seen.size > 5000) for (const [k, v] of seen) if (Date.now() - v.at > 60_000) seen.delete(k);
  return info;
}
