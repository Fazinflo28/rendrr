import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import { ensureBucketCors, env, redis, safeEqual, toFriendly } from "@rendrr/core";
import { prisma } from "@rendrr/db";
import Fastify from "fastify";
import account from "./routes/account";
import explore from "./routes/explore";
import internal from "./routes/internal";
import library from "./routes/library";
import projects from "./routes/projects";
import render from "./routes/render";
import color from "./routes/color";
import lutUpload from "./routes/lutUpload";
import soundUpload from "./routes/soundUpload";
import fonts from "./routes/fonts";
import reviews from "./routes/reviews";
import { backfillOutputSeconds, refreshFillerFlags } from "./services/projects";
import { removeDemoFootage } from "./services/cleanup";
import { mergeDuplicateAccounts } from "./services/logins";
import { migrateToSequences } from "./services/sequence";

export async function buildServer() {
  const e = env();
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL || "info", redact: ["req.headers.authorization", "req.headers['x-internal-secret']", "req.headers['x-review-key']"] },
    bodyLimit: 8 * 1024 * 1024,
    // Client IPs come from Railway's X-Real-IP (see clientIp); X-Forwarded-For is never trusted, so nobody can pick their own IP.
    trustProxy: false,
  });

  // JSON bodies; an empty body with a JSON content type (curl, some clients on DELETE) counts as {} instead of a 400.
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => {
    const text = typeof body === "string" ? body : body.toString("utf8");
    if (!text.trim()) return done(null, {});
    try { done(null, JSON.parse(text)); } catch { done(Object.assign(new Error("Bad JSON"), { statusCode: 400 }), undefined); }
  });

  const origins = new Set([e.PUBLIC_WEB_URL, ...(e.WEB_ORIGINS || "").split(",")].map((s) => s.trim().replace(/\/$/, "")).filter(Boolean));
  await app.register(cors, {
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      const ok = origins.has(origin) || /^http:\/\/localhost:\d+$/.test(origin) || /^https:\/\/rendrr[a-z0-9-]*\.vercel\.app$/.test(origin);
      cb(null, ok);
    },
    methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["authorization", "content-type", "x-review-key"],
    maxAge: 600,
  });
  // Review pages are public, so they get a tighter limit. This hook must be added before the rate limit
  // plugin's own onRoute hook, which reads route.config when each route is registered.
  app.addHook("onRoute", (route) => {
    const cfg = (route.config || {}) as { rateLimit?: unknown };
    if (route.url.startsWith("/public/") && !cfg.rateLimit) route.config = { ...cfg, rateLimit: { max: 90, timeWindow: "1 minute" } } as never;
  });
  // Per IP. The MCP server (one IP for every AI user) is keyed per user, but only when its secret is valid.
  // On Railway the edge sets X-Real-IP to the caller's address; elsewhere the socket address is used.
  const onRailway = !!process.env.RAILWAY_ENVIRONMENT_ID;
  const clientIp = (req: { headers: Record<string, unknown>; ip: string }) => {
    const real = req.headers["x-real-ip"];
    return onRailway && typeof real === "string" && real ? real : req.ip;
  };
  const internalSecret = e.INTERNAL_API_SECRET;
  await app.register(rateLimit, {
    global: true, max: 600, timeWindow: "1 minute",
    keyGenerator: (req) => {
      const s = req.headers["x-internal-secret"];
      if (internalSecret && typeof s === "string" && safeEqual(s, internalSecret)) return "internal:" + String(req.headers["x-rendrr-clerk-id"] || "");
      return clientIp(req);
    },
    errorResponseBuilder: () => ({ statusCode: 429, error: { message: "Too many requests. Wait a minute and try again.", code: "rate-limit" } }),
  });

  app.setErrorHandler((err: Error & { statusCode?: number; friendly?: boolean }, req, reply) => {
    if (err.statusCode === 429) return reply.code(429).send({ error: { message: "Too many requests. Wait a minute and try again.", code: "rate-limit" } });
    if (!err.friendly && err.statusCode && err.statusCode < 500 && !(err as { issues?: unknown }).issues) {
      return reply.code(err.statusCode).send({ error: { message: "That request did not look right. Refresh the page and try again.", code: "bad-request" } });
    }
    const f = toFriendly(err);
    if (f.status >= 500) req.log.error({ msg: err.message, stack: err.stack }, "request failed");
    return reply.code(f.status).send({ error: { message: f.message, code: f.code, ...(f.meta || {}) } });
  });
  app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: { message: "That page does not exist.", code: "not-found" } }));

  app.get("/health", async () => {
    const [db, rd] = await Promise.all([
      prisma.$queryRaw`SELECT 1`.then(() => "ok").catch(() => "down"),
      redis().ping().then(() => "ok").catch(() => "down"),
    ]);
    return { ok: db === "ok" && rd === "ok", db, redis: rd, service: "rendrr-api", commit: process.env.RAILWAY_GIT_COMMIT_SHA?.slice(0, 7) || null, time: new Date().toISOString() };
  });
  app.get("/", async () => ({ service: "rendrr-api", health: "/health" }));

  // Storage must accept uploads from the web app (preview copies, originals for export). Best effort.
  const corsOrigins = Array.from(new Set([...origins, "http://localhost:3000"]));
  ensureBucketCors([...corsOrigins, "https://*.vercel.app", "http://localhost:*", "http://127.0.0.1:*"])
    .catch(() => ensureBucketCors(corsOrigins)) // some stores refuse wildcard origins
    .then(() => app.log.info({ origins: corsOrigins }, "bucket CORS set"), (e) => app.log.warn({ msg: (e as Error).message }, "could not set bucket CORS: browser uploads will fail"));

  backfillOutputSeconds().catch(() => {});
  refreshFillerFlags().then((n) => { if (n) app.log.info({ transcripts: n }, "filler marks refreshed"); }, () => {});
  migrateToSequences().then((r) => { if (r.converted || r.stayed.length) app.log.info({ converted: r.converted, stayed: r.stayed }, "timelines converted to sequences"); }, (e) => app.log.warn({ msg: (e as Error).message }, "sequence migration failed"));
  mergeDuplicateAccounts().then((r) => { if (r.merged.length || r.skipped.length) app.log.info(r, "duplicate accounts merged"); }, (e) => app.log.warn({ msg: (e as Error).message }, "duplicate account merge failed"));
  removeDemoFootage().then((r) => { if (r.removed || r.kept || r.fakeDriveConnections) app.log.info(r, "demo footage removed"); }, (e) => app.log.warn({ msg: (e as Error).message }, "demo footage cleanup failed"));

  await app.register(account);
  await app.register(explore);
  await app.register(library);
  await app.register(projects);
  await app.register(render);
  await app.register(color);
  await app.register(lutUpload);
  await app.register(soundUpload);
  await app.register(fonts);
  await app.register(reviews);
  await app.register(internal);
  return app;
}

if (process.argv[1]?.endsWith("server.ts") || process.argv[1]?.endsWith("server.js")) {
  const app = await buildServer();
  const port = Number(process.env.PORT || 4000);
  // Railway's private network is IPv6; fall back to IPv4 where IPv6 is missing.
  await app.listen({ port, host: process.env.HOST || "::" }).catch(async (err: { code?: string }) => {
    if (err.code !== "EAFNOSUPPORT") throw err;
    await app.listen({ port, host: "0.0.0.0" });
  });
  const stop = async () => { await app.close(); await prisma.$disconnect(); process.exit(0); };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}
