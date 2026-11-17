// The page the user opens from their AI's link (/add/<pick>): what the AI asked for, and the files that arrived.
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authenticate } from "../auth";
import { addToPick, checkPhotos, createPick, finishPick, importLinks, pickView, startPhotos, PICK_SOURCES } from "../services/picks";

const Items = z.object({ videoIds: z.array(z.string().min(1).max(80)).min(1).max(200) });
const Links = z.object({ urls: z.array(z.string().min(1).max(2000)).min(1).max(50) });
const New = z.object({ source: z.enum(PICK_SOURCES), projectId: z.string().min(1).max(80).nullish(), kind: z.enum(["footage", "reference"]).nullish() });

export default async function picks(app: FastifyInstance) {
  app.addHook("preHandler", authenticate);
  const idOf = (req: { params: unknown }) => (req.params as { id: string }).id;
  // Looking at a Google Photos pick also asks Google (no more often than it says) whether the user has chosen.
  app.get("/picks/:id", async (req) => { await checkPhotos(req.user!.id, idOf(req)).catch(() => {}); return pickView(req.user!.id, idOf(req)); });
  // A Google Photos choice to send the user to (409 photos-connect: Google Photos must be connected first).
  app.post("/picks/:id/photos", async (req) => { await startPhotos(req.user!.id, idOf(req)); return pickView(req.user!.id, idOf(req)); });
  // The Library's and the editor's Dropbox and Google Photos tabs track their files the same way.
  app.post("/picks", async (req) => { const b = New.parse(req.body); const p = await createPick(req.user!.id, b.source, { projectId: b.projectId, kind: b.kind }); return pickView(req.user!.id, p.id); });
  // Share links (a Dropbox link, or files chosen in Dropbox) brought in in the background; the page polls for them.
  app.post("/picks/:id/links", async (req) => { const { urls } = Links.parse(req.body); await importLinks(req.user!.id, idOf(req), urls); return pickView(req.user!.id, idOf(req)); });
  // Videos or pictures added on the page (from the computer, a Dropbox link): recorded for the AI, and put in its edit.
  app.post("/picks/:id/items", async (req) => {
    const { videoIds } = Items.parse(req.body);
    await addToPick(req.user!.id, idOf(req), videoIds);
    return pickView(req.user!.id, idOf(req));
  });
  app.post("/picks/:id/done", async (req) => { await finishPick(req.user!.id, idOf(req)); return pickView(req.user!.id, idOf(req)); });
}
