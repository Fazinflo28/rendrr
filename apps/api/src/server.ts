import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import { ensureBucketCors, env, internalSecrets, maintenanceOn, redis, safeEqual, setupLineText, supabaseConfigured, supabaseSetupCheck, toFriendly } from "@rendrr/core";
import { isWebOrigin, webOrigins } from "./origins";
import { DRIVE_SWEEP_AGE_MS, syncStaleDriveFolders } from "./services/driveLibrary";
import { dbHost, prisma } from "@rendrr/db";
import { buildMaintenanceServer } from "./maintenance";
import Fastify from "fastify";
import account from "./routes/account";
import billing from "./routes/billing";
import admin from "./routes/admin";
import { ensureAdmins } from "./services/billing";
import explore from "./routes/explore";
import internal from "./routes/internal";
import library from "./routes/library";
import assets from "./routes/assets";
import { importUsersToSupabase } from "./services/supabaseImport";
import projects from "./routes/projects";
import render from "./routes/render";
import color from "./routes/color";
import lutUpload from "./routes/lutUpload";
import soundUpload from "./routes/soundUpload";
import footageUpload from "./routes/footageUpload";
import graphicUpload from "./routes/graphicUpload";
import fonts from "./routes/fonts";
import reviews from "./routes/reviews";
import downloads from "./routes/downloads";
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
    // Kept as sent: Stripe's webhook signature is checked against the exact bytes.
    (_req as unknown as { rawBody?: string }).rawBody = text;
    if (!text.trim()) return done(null, {});
    try { done(null, JSON.parse(text)); } catch { done(Object.assign(new Error("Bad JSON"), { statusCode: 400 }), undefined); }
  });

  const origins = webOrigins();
  await app.register(cors, {
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      cb(null, isWebOrigin(origin, origins));
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
  const internalKeys = internalSecrets();
  await app.register(rateLimit, {
    global: true, max: 600, timeWindow: "1 minute",
    keyGenerator: (req) => {
      const s = req.headers["x-internal-secret"];
      if (typeof s === "string" && internalKeys.some((x) => safeEqual(s, x))) return "internal:" + String(req.headers["x-rendrr-clerk-id"] || "");
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
  // Supabase Auth is the login: every account gets a Supabase login with its email (once).
  // What is set up in Supabase Auth (Google, redirect URLs, signing keys, OAuth server): one log line each, no values.
  if (supabaseConfigured()) supabaseSetupCheck([...origins]).then((lines) => { for (const l of lines) (l.ok === false ? app.log.warn.bind(app.log) : app.log.info.bind(app.log))(`Supabase setup: ${setupLineText(l)}`); }, (e) => app.log.warn({ msg: (e as Error).message }, "Supabase setup check failed"));
  importUsersToSupabase().then((r) => { if (r.created || r.failed) app.log.info(r, "accounts given a Supabase login"); }, (e) => app.log.warn({ msg: (e as Error).message }, "Supabase login import failed"));
  removeDemoFootage().then((r) => { if (r.removed || r.kept || r.fakeDriveConnections) app.log.info(r, "demo footage removed"); }, (e) => app.log.warn({ msg: (e as Error).message }, "demo footage cleanup failed"));

  ensureAdmins().then((n) => { if (n) app.log.info({ admins: n }, "admin accounts set"); }, (e) => app.log.warn({ msg: (e as Error).message }, "admin accounts not set"));

  await app.register(account);
  await app.register(billing);
  await app.register(admin);
  await app.register(explore);
  await app.register(library);
  await app.register(assets);
  await app.register(projects);
  await app.register(render);
  await app.register(color);
  await app.register(lutUpload);
  await app.register(soundUpload);
  await app.register(footageUpload);
  await app.register(graphicUpload);
  await app.register(fonts);
  await app.register(reviews);
  await app.register(downloads);
  await app.register(internal);
  return app;
}

if (process.argv[1]?.endsWith("server.ts") || process.argv[1]?.endsWith("server.js")) {
  const down = maintenanceOn();
  const app = down ? await buildMaintenanceServer() : await buildServer();
  if (!down) app.log.info({ db: dbHost(process.env.DATABASE_URL) }, "database");
  // One stray rejected promise (a background refresh, a closed stream) is logged, never a crash for every user.
  process.on("unhandledRejection", (e) => app.log.error({ msg: (e as Error)?.message || String(e), stack: (e as Error)?.stack }, "unhandled rejection"));
  const port = Number(process.env.PORT || 4000);
  // Railway's private network is IPv6; fall back to IPv4 where IPv6 is missing.
  await app.listen({ port, host: process.env.HOST || "::" }).catch(async (err: { code?: string }) => {
    if (err.code !== "EAFNOSUPPORT") throw err;
    await app.listen({ port, host: "0.0.0.0" });
  });
  // Folders imported from Google Drive: videos put in the Drive folder later come in by themselves. Every few minutes
  // one API instance (a Redis lock) looks at the folders not synced for DRIVE_SWEEP_AGE_MS.
  const sweep = setInterval(() => {
    if (down) return;
    void (async () => {
      if (!(await redis().set("drive-sweep", "1", "PX", 4 * 60_000, "NX").catch(() => null))) return;
      const r = await syncStaleDriveFolders({ age: DRIVE_SWEEP_AGE_MS, limit: 50 });
      const added = r.reduce((a, x) => a + x.added, 0);
      if (added || r.some((x) => x.error)) app.log.info({ folders: r.length, added, errors: r.filter((x) => x.error).length }, "drive folders synced");
    })().catch((e) => app.log.warn({ msg: (e as Error).message }, "drive sweep failed"));
  }, 5 * 60_000);
  sweep.unref();
  const stop = async () => { clearInterval(sweep); await app.close(); await prisma.$disconnect(); process.exit(0); };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}
