import { createCipheriv, createDecipheriv, createHmac, randomBytes, scryptSync, timingSafeEqual, createHash } from "node:crypto";
import { env, isProd } from "./env";

function key(): Buffer {
  const k = env().ENCRYPTION_KEY;
  if (!k) {
    if (isProd()) throw new Error("ENCRYPTION_KEY is not set");
    return createHash("sha256").update("rendrr-dev-only-key").digest();
  }
  const b = Buffer.from(k, "base64");
  if (b.length !== 32) throw new Error("ENCRYPTION_KEY must be 32 bytes, base64");
  return b;
}

/** AES-256-GCM. Output: base64(iv | tag | ciphertext). */
export function encrypt(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key(), iv);
  const enc = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), enc]).toString("base64");
}
export function decrypt(blob: string): string {
  const b = Buffer.from(blob, "base64");
  const d = createDecipheriv("aes-256-gcm", key(), b.subarray(0, 12));
  d.setAuthTag(b.subarray(12, 28));
  return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString("utf8");
}

export function hashPassword(pw: string): string {
  const salt = randomBytes(16);
  const h = scryptSync(pw, salt, 32);
  return `scrypt$${salt.toString("base64")}$${h.toString("base64")}`;
}
export function checkPassword(pw: string, stored: string): boolean {
  const [, s, h] = stored.split("$");
  if (!s || !h) return false;
  const got = scryptSync(pw, Buffer.from(s, "base64"), 32);
  const want = Buffer.from(h, "base64");
  return got.length === want.length && timingSafeEqual(got, want);
}

const ALPHA = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
/** Random token from an unambiguous alphabet. 10 chars ≈ 57 bits. */
export function token(len = 10): string {
  const b = randomBytes(len);
  let s = "";
  for (let i = 0; i < len; i++) s += ALPHA[b[i] % ALPHA.length];
  return s;
}
export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * The secret the MCP server sends the API with each tool call (x-internal-secret). INTERNAL_API_SECRET when it is set;
 * else one worked out from the Clerk secret key, which both services already hold, so no other secret has to be copied
 * between them. apps/mcp/src/secret.ts works it out the same way (a test keeps the two equal).
 */
export const internalSecretFromClerk = (clerkSecret: string) => createHmac("sha256", clerkSecret).update("rendrr-internal-api-v1").digest("hex");
/** Every secret the API accepts from the MCP server: the one set, and the one from the Clerk key. */
export function internalSecrets(): string[] {
  const e = env();
  return [e.INTERNAL_API_SECRET, e.CLERK_SECRET_KEY ? internalSecretFromClerk(e.CLERK_SECRET_KEY) : ""].filter((x): x is string => !!x);
}
