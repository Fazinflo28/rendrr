// The API in maintenance mode (MAINTENANCE=1): /health stays up so Railway keeps the deployment, every other request gets
// a 503 with a plain message the web app and the AI show as they are. No database, no background work.
import cors from "@fastify/cors";
import { MAINTENANCE_MESSAGE } from "@rendrr/core";
import Fastify from "fastify";
import { isWebOrigin, webOrigins } from "./origins";

export async function buildMaintenanceServer() {
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL || "info" } });
  const origins = webOrigins();
  await app.register(cors, { origin: (origin, cb) => cb(null, !origin || isWebOrigin(origin, origins)), methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"], allowedHeaders: ["authorization", "content-type", "x-review-key"], maxAge: 600 });
  app.get("/health", async () => ({ ok: true, maintenance: true, service: "rendrr-api", commit: process.env.RAILWAY_GIT_COMMIT_SHA?.slice(0, 7) || null, time: new Date().toISOString() }));
  app.setNotFoundHandler((_req, reply) => reply.code(503).header("retry-after", "120").send({ error: { message: MAINTENANCE_MESSAGE, code: "maintenance" } }));
  app.log.info("maintenance mode: every request but /health gets 503, nothing touches the database");
  return app;
}
