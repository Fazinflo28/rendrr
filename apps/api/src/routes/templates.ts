// Motion templates: Rendrr's own (anyone can look) and the user's; Recreate makes an edit from one with new words,
// pictures, colours and videos (services/motionTemplates.ts).
import { unauthorized } from "@rendrr/core";
import { z } from "zod";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { authenticate } from "../auth";
import { getMotionTemplate, listMotionTemplates, recreateMotionTemplate, templateOut } from "../services/motionTemplates";

async function optionalAuth(req: FastifyRequest, reply: FastifyReply) {
  if (!req.headers.authorization && !req.headers["x-internal-secret"]) return;
  try { await authenticate(req, reply); } catch { req.user = undefined; }
}

const RecreateBody = z.object({
  slots: z.record(z.string().max(2_100_000).nullable()).default({}),
  name: z.string().max(200).optional(),
  folderId: z.string().max(80).nullable().optional(),
});

export default async function templates(app: FastifyInstance) {
  app.addHook("preHandler", optionalAuth);
  app.get("/templates", async (req) => (await listMotionTemplates(req.user?.id)).map(templateOut));
  app.get("/templates/:id", async (req) => templateOut(await getMotionTemplate(req.user?.id, (req.params as { id: string }).id)));
  app.post("/templates/:id/recreate", async (req) => {
    if (!req.user) throw unauthorized("Please log in to continue.");
    const b = RecreateBody.parse(req.body ?? {});
    return recreateMotionTemplate(req.user.id, (req.params as { id: string }).id, b.slots, { name: b.name, folderId: b.folderId ?? null, actorKind: "user" });
  });
}
