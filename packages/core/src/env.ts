import { z } from "zod";

// Every setting the servers read. Optional keys switch features to their stub when missing.
const Env = z.object({
  NODE_ENV: z.string().default("development"),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1).default("redis://localhost:6379"),
  S3_ENDPOINT: z.string().url(),
  S3_BUCKET: z.string().min(1),
  S3_REGION: z.string().default("auto"),
  S3_ACCESS_KEY_ID: z.string().min(1),
  S3_SECRET_ACCESS_KEY: z.string().min(1),
  S3_FORCE_PATH_STYLE: z.string().optional(),
  CLERK_SECRET_KEY: z.string().optional(),
  CLERK_PUBLISHABLE_KEY: z.string().optional(),
  // Supabase Auth (replacing Clerk): the project URL (https://<ref>.supabase.co), its publishable (anon) key and, on the
  // API only, its secret (service role) key. AUTH_PROVIDER=supabase makes it the login (web build, MCP connector).
  SUPABASE_URL: z.string().optional(),
  SUPABASE_PUBLISHABLE_KEY: z.string().optional(),
  SUPABASE_SECRET_KEY: z.string().optional(),
  AUTH_PROVIDER: z.string().optional(),
  ASSEMBLYAI_API_KEY: z.string().optional(), // TODO(key): unset = sample transcript
  GOOGLE_CLIENT_ID: z.string().optional(), // TODO(key): unset = fake Drive with sample files
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  // Tests point these at a stand-in Google (the real ones by default).
  GOOGLE_API_URL: z.string().optional(),
  GOOGLE_TOKEN_URL: z.string().optional(),
  DRIVE_CHUNK_BYTES: z.string().optional(),
  STRIPE_SECRET_KEY: z.string().optional(), // TODO(key): billing is stubbed
  ENCRYPTION_KEY: z.string().optional(), // 32 bytes, base64. Required in production.
  INTERNAL_API_SECRET: z.string().optional(), // shared by the API and the MCP server
  PUBLIC_API_URL: z.string().default("http://localhost:4000"),
  PUBLIC_WEB_URL: z.string().default("http://localhost:3000"),
  PUBLIC_MCP_URL: z.string().default("http://localhost:4100"),
  WEB_ORIGINS: z.string().optional(),
  SIGNUP_ALLOWLIST: z.string().optional(),
});
export type EnvT = z.infer<typeof Env>;

let cached: EnvT | null = null;
export function env(): EnvT {
  if (cached) return cached;
  const r = Env.safeParse(process.env);
  if (!r.success) {
    const missing = r.error.issues.map((i) => i.path.join(".")).join(", ");
    throw new Error(`Missing or invalid settings: ${missing}`);
  }
  cached = r.data;
  return cached;
}
export const isProd = () => env().NODE_ENV === "production";
export const features = () => ({
  transcription: !!env().ASSEMBLYAI_API_KEY,
  drive: !!(env().GOOGLE_CLIENT_ID && env().GOOGLE_CLIENT_SECRET),
  billing: !!env().STRIPE_SECRET_KEY,
});
