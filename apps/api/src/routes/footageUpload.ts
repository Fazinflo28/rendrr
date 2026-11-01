import type { FastifyInstance } from "fastify";
import { createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import type { Readable } from "node:stream";
import { AppError } from "@rendrr/core";
import { FOOTAGE_UPLOAD_MAX_BYTES } from "@rendrr/shared";
import { footageText, footageUploadFor, keepFootage, usedFootageUpload, waitForFootage } from "../services/footage";

// The one-time links add_footage upload gives: the AI's code workspace sends a video or a picture here (no login: the
// link is the key), as curl -T sends it. The body goes to disk as it comes (up to 2 GB), then it is kept as the user's
// footage; the reply waits a little for a picture or a short clip to be ready.
export default async function footageUpload(app: FastifyInstance) {
  app.removeAllContentTypeParsers();
  app.addContentTypeParser("*", { bodyLimit: FOOTAGE_UPLOAD_MAX_BYTES + 1024 }, (_req, payload, done) => done(null, payload));
  const handler = async (req: { params: unknown; query: unknown; body: unknown }) => {
    const { token } = req.params as { token: string };
    const u = await footageUploadFor(token);
    const q = req.query as { name?: unknown; filename?: unknown };
    const asked = (typeof q.name === "string" && q.name.slice(0, 200)) || u.name || "";
    const file = (typeof q.filename === "string" && q.filename.slice(0, 300)) || asked || "upload";
    const dir = await mkdtemp(join(tmpdir(), "footage-up-"));
    try {
      const path = join(dir, "src");
      let n = 0;
      const body = req.body as Readable | undefined;
      if (!body || typeof body.pipe !== "function") throw new AppError("Send the file itself as the body: curl -T file.mp4 '<link>'.", 400, "bad-footage");
      body.on("data", (c: Buffer) => { n += c.length; });
      await pipeline(body, createWriteStream(path));
      if (!n) throw new AppError("Nothing came with the upload. Send the file as the body: curl -T file.mp4 '<link>'.", 400, "bad-footage");
      const v = await keepFootage(u.userId, path, file, { ...u, name: asked || null });
      await usedFootageUpload(token);
      const now = await waitForFootage(v.id, 45_000);
      return { videoId: now.id, name: now.name, status: now.status, still: now.still, text: footageText(now, { projectId: u.projectId }) };
    } finally { await rm(dir, { recursive: true, force: true }).catch(() => {}); }
  };
  const opts = { bodyLimit: FOOTAGE_UPLOAD_MAX_BYTES + 1024, config: { rateLimit: { max: 20, timeWindow: "1 minute" } } };
  app.put("/footage/upload/:token", opts, handler);
  app.post("/footage/upload/:token", opts, handler);
}
