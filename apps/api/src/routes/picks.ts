// The page the user opens from their AI's link (/add/<pick>): what the AI asked for, and the files that arrived.
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authenticate } from "../auth";
import { addToPick, finishPick, pickView } from "../services/picks";

const Items = z.object({ videoIds: z.array(z.string().min(1).max(80)).min(1).max(200) });

export default async function picks(app: FastifyInstance) {
  app.addHook("preHandler", authenticate);
  const idOf = (req: { params: unknown }) => (req.params as { id: string }).id;
  app.get("/picks/:id", async (req) => pickView(req.user!.id, idOf(req)));
  // Videos or pictures added on the page (from the computer, a Dropbox link): recorded for the AI, and put in its edit.
  app.post("/picks/:id/items", async (req) => {
    const { videoIds } = Items.parse(req.body);
    await addToPick(req.user!.id, idOf(req), videoIds);
    return pickView(req.user!.id, idOf(req));
  });
  app.post("/picks/:id/done", async (req) => { await finishPick(req.user!.id, idOf(req)); return pickView(req.user!.id, idOf(req)); });
}
