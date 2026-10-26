import { AppError } from "@rendrr/core";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authenticate } from "../auth";
import { addFont, deleteFont, listFonts } from "../services/fonts";

// Fonts the user adds once and uses by name in graphics (Settings › Fonts; the connector's add_font).
export default async function fonts(app: FastifyInstance) {
  app.addHook("preHandler", authenticate);

  app.get("/fonts", async (req) => ({ fonts: await listFonts(req.user!.id) }));

  // The file as base64 (the browser reads it); checked for being a font before anything is kept.
  app.post("/fonts", { bodyLimit: 4 * 1024 * 1024, config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (req) => {
    const body = z.object({
      family: z.string().trim().min(1).max(60).regex(/^[A-Za-z0-9][A-Za-z0-9 _-]*$/),
      weight: z.number().int().min(100).max(900).default(400),
      style: z.enum(["normal", "italic"]).default("normal"),
      data: z.string().min(16).max(3_000_000),
    }).safeParse(req.body);
    if (!body.success) throw new AppError("Send the font's family name (letters, digits, spaces), weight, style and file.", 400);
    return addFont(req.user!.id, body.data, Buffer.from(body.data.data.replace(/^data:[^,]*,/, ""), "base64"));
  });

  app.delete("/fonts/:id", async (req) => {
    await deleteFont(req.user!.id, (req.params as { id: string }).id);
    return { ok: true };
  });
}
