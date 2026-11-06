import { createWriteStream } from "node:fs";
import { Transform, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { AppError } from "@rendrr/core";

// Fastify does not apply bodyLimit to a body handed over as a stream, so the upload links count the bytes themselves:
// a body over `max` stops at the limit with a 413 (and a Content-Length over it is refused before anything is read).
// The request itself is left out of the pipeline so a stop does not destroy its socket before the 413 is sent.
export async function saveBody(body: Readable, path: string, max: number, opts: { length?: unknown; tooBig: string; code: string }): Promise<number> {
  const len = Number(opts.length);
  if (Number.isFinite(len) && len > max) throw new AppError(opts.tooBig, 413, opts.code);
  let n = 0;
  const count = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      n += chunk.length;
      if (n > max) return cb(new AppError(opts.tooBig, 413, opts.code));
      cb(null, chunk);
    },
  });
  body.on("error", (e) => count.destroy(e));
  body.pipe(count);
  try {
    await pipeline(count, createWriteStream(path));
  } finally {
    body.unpipe(count);
  }
  return n;
}
