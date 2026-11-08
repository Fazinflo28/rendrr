// The database address the app connects with. Supabase's Transaction pooler (Supavisor, port 6543) hands each query to
// any free server connection, so Prisma must not keep prepared statements (pgbouncer=true), and each service keeps a
// small pool so all of them fit the pooler's client limit. A plain Postgres address is left as it is.
export function poolerUrl(raw: string | undefined, limit = process.env.DB_CONNECTION_LIMIT || "8"): string | undefined {
  if (!raw) return raw;
  let u: URL;
  try { u = new URL(raw); } catch { return raw; }
  const pooled = u.port === "6543" || u.searchParams.get("pgbouncer") === "true";
  if (!pooled) return raw;
  if (!u.searchParams.has("pgbouncer")) u.searchParams.set("pgbouncer", "true");
  if (!u.searchParams.has("connection_limit")) u.searchParams.set("connection_limit", limit);
  return u.toString();
}

/** Where the app's database is, for logs (never the user name or password). */
export function dbHost(raw: string | undefined): string {
  try { const u = new URL(raw || ""); return `${u.hostname}:${u.port || "5432"}`; } catch { return "unknown"; }
}
