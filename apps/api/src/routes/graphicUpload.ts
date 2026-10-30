import type { FastifyInstance } from "fastify";
import { AppError } from "@rendrr/core";
import { graphicUploadFor, resolveGraphic, saveGraphic, usedGraphicUpload } from "../services/graphicCode";

// The one-time links create_graphic upload gives: the AI's code workspace sends the graphic's code here (no login: the
// link is the key), as curl -T sends it. The graphic is made with what create_graphic was sent with the link.
export default async function graphicUpload(app: FastifyInstance) {
  app.removeAllContentTypeParsers();
  app.addContentTypeParser("*", { parseAs: "buffer", bodyLimit: 1_000_000 + 1024 }, (_req, body, done) => done(null, body));
  const handler = async (req: { params: unknown; body: unknown }) => {
    const { token } = req.params as { token: string };
    const u = await graphicUploadFor(token);
    const code = (Buffer.isBuffer(req.body) ? req.body : Buffer.from(typeof req.body === "string" ? req.body : "")).toString("utf8");
    if (!code.trim()) throw new AppError("Nothing came with the upload. Send the file as the body: curl -T graphic.html '<link>'.", 400, "bad-graphic");
    const r = await resolveGraphic(u.userId, { ...u.i, code, codeFrom: undefined, code_from: undefined, replace: false });
    const g = await saveGraphic(u.userId, r);
    await usedGraphicUpload(token);
    return { graphicId: g.id, status: "queued", text: `Graphic ${g.id} is queued for recording. get_graphic {graphicId: "${g.id}", wait_seconds: 60} waits for it; apply_edits add_graphic can place it now.` };
  };
  const opts = { bodyLimit: 1_000_000 + 1024, config: { rateLimit: { max: 20, timeWindow: "1 minute" } } };
  app.put("/graphics/upload/:token", opts, handler);
  app.post("/graphics/upload/:token", opts, handler);
}
