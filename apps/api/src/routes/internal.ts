import type { FastifyInstance } from "fastify";
import { authenticate } from "../auth";

// MCP tool calls arrive here from the MCP server (shared secret). Filled in by tools.ts.
export default async function internal(app: FastifyInstance) {
  app.addHook("preHandler", authenticate);
  app.get("/internal/whoami", async (req) => ({ userId: req.user!.id, email: req.user!.email, name: req.user!.name, ai: req.ai }));
}
