// Upload links take the body as a stream, which Fastify's bodyLimit does not cover: saveBody counts the bytes and stops
// a body over the cap with a 413, and refuses a Content-Length over it before reading. Under the cap the file is whole.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { after, describe, it } from "node:test";
import Fastify from "fastify";
import { saveBody } from "../src/services/uploadBody";

const dir = mkdtempSync(join(tmpdir(), "upload-body-"));
after(() => rmSync(dir, { recursive: true, force: true }));
const chunks = (n: number, size: number) => Readable.from(Array.from({ length: n }, (_, i) => Buffer.alloc(size, i)));

describe("saveBody", () => {
  it("writes a body under the cap whole", async () => {
    const path = join(dir, "ok");
    const n = await saveBody(chunks(4, 1000), path, 5000, { tooBig: "too big", code: "too-big" });
    assert.equal(n, 4000);
    assert.equal(statSync(path).size, 4000);
    assert.equal(readFileSync(path)[3999], 3);
  });
  it("stops a body over the cap with a 413", async () => {
    const path = join(dir, "big");
    await assert.rejects(saveBody(chunks(10, 1000), path, 5000, { tooBig: "too big", code: "too-big" }), (e: { status?: number; code?: string }) => e.status === 413 && e.code === "too-big");
    assert.ok(statSync(path).size <= 5000, "nothing past the cap is written");
  });
  it("refuses a Content-Length over the cap before reading", async () => {
    let read = false;
    const body = new Readable({ read() { read = true; this.push(null); } });
    await assert.rejects(saveBody(body, join(dir, "len"), 100, { length: "101", tooBig: "too big", code: "too-big" }), (e: { status?: number }) => e.status === 413);
    assert.equal(read, false);
  });
  it("a streamed request over the cap gets a 413 reply, not a dropped connection", async () => {
    const app = Fastify();
    app.removeAllContentTypeParsers();
    app.addContentTypeParser("*", (_req, payload, done) => done(null, payload));
    app.setErrorHandler((err: Error & { status?: number }, _req, reply) => reply.code(err.status || 500).send({ message: err.message }));
    app.put("/up", async (req) => ({ n: await saveBody(req.body as Readable, join(dir, "route"), 1000, { length: req.headers["content-length"], tooBig: "too big", code: "too-big" }) }));
    await app.listen({ port: 0, host: "127.0.0.1" });
    try {
      const port = (app.server.address() as { port: number }).port;
      const { request } = await import("node:http");
      const status = await new Promise<number>((res, rej) => {
        const q = request({ host: "127.0.0.1", port, method: "PUT", path: "/up", headers: { "transfer-encoding": "chunked", "content-type": "application/octet-stream" } }, (s) => { s.resume(); res(s.statusCode || 0); });
        q.on("error", rej);
        q.write(Buffer.alloc(800)); setTimeout(() => { q.write(Buffer.alloc(800)); q.end(); }, 50);
      });
      assert.equal(status, 413);
      const ok = await app.inject({ method: "PUT", url: "/up", payload: Buffer.alloc(900), headers: { "content-type": "application/octet-stream" } });
      assert.equal(ok.json().n, 900);
    } finally { await app.close(); }
  });
});
