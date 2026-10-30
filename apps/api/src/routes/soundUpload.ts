import type { FastifyInstance } from "fastify";
import { createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import type { Readable } from "node:stream";
import { AppError } from "@rendrr/core";
import { SOUND_MAX_BYTES } from "@rendrr/shared";
import { keepSound, soundOut, uploadFor, usedUpload } from "../services/sounds";

// The one-time links add_audio upload gives: the AI's code workspace sends an audio file here (no login: the link is
// the key), as curl -T sends it. The body goes to disk as it comes (up to 500 MB), then it is kept like any audio file.
export default async function soundUpload(app: FastifyInstance) {
  app.removeAllContentTypeParsers();
  app.addContentTypeParser("*", { bodyLimit: SOUND_MAX_BYTES + 1024 }, (_req, payload, done) => done(null, payload));
  const handler = async (req: { params: unknown; query: unknown; body: unknown; headers: Record<string, unknown> }) => {
    const { token } = req.params as { token: string };
    const u = await uploadFor(token);
    const q = (req.query as { name?: unknown }).name;
    const name = (typeof q === "string" && q.slice(0, 120)) || u.name || "Audio";
    const dir = await mkdtemp(join(tmpdir(), "sound-up-"));
    try {
      const path = join(dir, "src");
      let n = 0;
      const body = req.body as Readable | undefined;
      if (!body || typeof (body as Readable).pipe !== "function") throw new AppError("Send the audio file itself as the body: curl -T file.mp3 '<link>'.", 400, "bad-audio");
      body.on("data", (c: Buffer) => { n += c.length; });
      await pipeline(body, createWriteStream(path));
      if (!n) throw new AppError("Nothing came with the upload. Send the file as the body: curl -T file.mp3 '<link>'.", 400, "bad-audio");
      const s = await keepSound(u.userId, path, name);
      await usedUpload(token);
      return { id: s.id, name: s.name, seconds: s.seconds, status: s.status, text: soundOut(s) };
    } finally { await rm(dir, { recursive: true, force: true }).catch(() => {}); }
  };
  const opts = { bodyLimit: SOUND_MAX_BYTES + 1024, config: { rateLimit: { max: 20, timeWindow: "1 minute" } } };
  app.put("/audio/upload/:token", opts, handler);
  app.post("/audio/upload/:token", opts, handler);
}
