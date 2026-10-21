// The API as one Vercel Function (Node.js request/response). Railway runs src/server.ts instead.
// The Fastify app is built once per instance and reused across requests.
import type { IncomingMessage, ServerResponse } from "node:http";
import { buildServer } from "./server";

const ready = buildServer().then(async (app) => { await app.ready(); return app; });

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  const app = await ready;
  app.server.emit("request", req, res);
}
