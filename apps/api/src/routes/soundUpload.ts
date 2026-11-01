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
import { footageText, keepFootage, sniff, waitForFootage } from "../services/footage";
import { open } from "node:fs/promises";

const VIDEO_NAME = /\.(mp4|mov|m4v|webm|mkv|avi|mts|m2ts|3gp|wmv|mpg|mpeg|png|jpe?g|webp|gif)$/i;

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
      // A video or a picture sent to an audio link (an AI whose tool list is older than add_footage, given a file in the
      // chat): it goes into the library as footage. ?kind=footage says so; a picture, or a video file's name, is enough.
      const fh = await open(path, "r"); const head = Buffer.alloc(16);
      try { await fh.read(head, 0, 16, 0); } finally { await fh.close(); }
      const fname = typeof (req.query as { filename?: unknown }).filename === "string" ? String((req.query as { filename: string }).filename).slice(0, 300) : "";
      const kindQ = (req.query as { kind?: unknown }).kind;
      if (kindQ === "footage" || kindQ === "video" || kindQ === "picture" || (() => { try { return sniff(head).image; } catch { return true; } })() || VIDEO_NAME.test(fname)) {
        const v = await keepFootage(u.userId, path, fname || name, { name: typeof q === "string" ? name : null });
        await usedUpload(token);
        const now = await waitForFootage(v.id, 45_000);
        return { videoId: now.id, name: now.name, status: now.status, still: now.still, text: footageText(now) };
      }
      const s = await keepSound(u.userId, path, name);
      await usedUpload(token);
      return { id: s.id, name: s.name, seconds: s.seconds, status: s.status, text: soundOut(s) };
    } finally { await rm(dir, { recursive: true, force: true }).catch(() => {}); }
  };
  const opts = { bodyLimit: SOUND_MAX_BYTES + 1024, config: { rateLimit: { max: 20, timeWindow: "1 minute" } } };
  app.put("/audio/upload/:token", opts, handler);
  app.post("/audio/upload/:token", opts, handler);
}
