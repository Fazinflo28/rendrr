import type { FastifyInstance } from "fastify";
import { LUT_MAX, lutsText, saveUpload } from "../services/luts";

// The one-time links add_lut upload gives: the AI's code workspace sends a .cube file here (no login: the link is the
// key). Any content type, as curl sends it; the file is checked and kept like one imported in the editor.
export default async function lutUpload(app: FastifyInstance) {
  app.removeAllContentTypeParsers();
  app.addContentTypeParser("*", { parseAs: "buffer", bodyLimit: LUT_MAX + 1024 }, (_req, body, done) => done(null, body));
  const handler = async (req: { params: unknown; query: unknown; body: unknown }) => {
    const { token } = req.params as { token: string };
    const name = typeof (req.query as { name?: unknown }).name === "string" ? ((req.query as { name: string }).name.slice(0, 120) || undefined) : undefined;
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.from(typeof req.body === "string" ? req.body : "");
    const l = await saveUpload(token, body, name);
    return { id: l.id, name: l.name, kind: l.kind, size: l.size, replaced: l.replaced,
      text: `${l.replaced ? "Replaced" : "Added"} LUT "${l.name}" ${l.id} (${l.kind.toUpperCase()}, ${l.size} points). Put it on the edit: apply_edits set_grade{all: true, lut: {id: "${l.id}", amount: 1}}. Your LUTs: ${await lutsText(l.userId)}.` };
  };
  const opts = { bodyLimit: LUT_MAX + 1024, config: { rateLimit: { max: 20, timeWindow: "1 minute" } } };
  app.put("/luts/upload/:token", opts, handler);
  app.post("/luts/upload/:token", opts, handler);
}
