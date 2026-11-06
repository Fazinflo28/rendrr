import { env } from "@rendrr/core";

/** The web app's own addresses: PUBLIC_WEB_URL and WEB_ORIGINS (comma-separated), without a trailing slash. */
export function webOrigins(): Set<string> {
  const e = env();
  return new Set([e.PUBLIC_WEB_URL, ...(e.WEB_ORIGINS || "").split(",")].map((s) => String(s || "").trim().replace(/\/$/, "")).filter(Boolean));
}

/** An address the web app runs on (CORS, and where a Google consent may send its code back). */
export function isWebOrigin(origin: string, list = webOrigins()): boolean {
  return list.has(origin) || /^http:\/\/localhost:\d+$/.test(origin) || /^https:\/\/rendrr[a-z0-9-]*\.vercel\.app$/.test(origin);
}
