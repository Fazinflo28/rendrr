import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import { ensureBucketCors, env, redis, toFriendly } from "@rendrr/core";
import { prisma } from "@rendrr/db";
import Fastify from "fastify";
import account from "./routes/account";
import internal from "./routes/internal";
import library from "./routes/library";
import projects from "./routes/projects";
import render from "./routes/render";
import reviews from "./routes/reviews";

export async function buildServer() {
  const e = env();
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL || "info", redact: ["req.headers.authorization", "req.headers['x-internal-secret']", "req.headers['x-review-key']"] },
    bodyLimit: 6 * 1024 * 1024,
    trustProxy: true,
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
  // Per IP. Review pages and login are public, so they get their own tighter limits.
  await app.register(rateLimit, {
    global: true, max: 600, timeWindow: "1 minute",
    keyGenerator: (req) => (req.headers["x-internal-secret"] ? "internal:" + String(req.headers["x-rendrr-clerk-id"] || "") : req.ip),
    errorResponseBuilder: () => ({ statusCode: 429, error: { message: "Too many requests. Wait a minute and try again.", code: "rate-limit" } }),
  });
  app.addHook("onRoute", (route) => {
    if (route.url.startsWith("/public/")) route.config = { ...(route.config as object), rateLimit: { max: 90, timeWindow: "1 minute" } } as never;
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
  ensureBucketCors([...origins, "https://*.vercel.app", "http://localhost:3000"]).then(() => app.log.info("bucket CORS set"), (e) => app.log.warn({ msg: (e as Error).message }, "could not set bucket CORS"));

  await app.register(account);
  await app.register(library);
  await app.register(projects);
  await app.register(render);
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
