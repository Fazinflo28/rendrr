// Which address each AI chat connects through (once an hour per user and address). Claude takes a connector's icon
// from its address (Google's favicon for the last two parts of the host), so the log shows who is on an old one.
const seen = new Map<string, number>();

export function hostLine(host: string, clerkId: string, client: string, now = Date.now()): string | null {
  const key = `${clerkId}|${host}`;
  if (now - (seen.get(key) ?? 0) < 3600_000) return null;
  seen.set(key, now);
  for (const [k, t] of seen) if (now - t > 3600_000) seen.delete(k);
  return `[mcp] ${client} connects through ${host} (${clerkId || "?"})`;
}
