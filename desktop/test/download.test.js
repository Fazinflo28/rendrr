// The Mac app's downloads (render.js download), against a stand-in storage server: a big file comes in several ranged
// requests at once, each part written where it goes, and is the same file byte for byte; a server that does not send
// ranges gives it in one piece; a part cut off mid-way is fetched again (its bytes given back to the progress first); a
// link that is refused (a Google Drive sign-in that ran out) is renewed once and the download carries on.
"use strict";
const assert = require("node:assert/strict");
const { test, before, after } = require("node:test");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { download } = require("../render");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rendrr-download-test-"));
const body = crypto.randomBytes(1_000_000 + 333); // not a whole number of parts
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
let server, base = "";
const seen = []; // { path, range, auth }
let cutOnce = true; // the first ranged request for bytes 300000- is cut off mid-way

before(async () => {
  server = http.createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    seen.push({ path: u.pathname, range: req.headers.range || null, auth: req.headers.authorization || null });
    // /signed/: needs "Bearer fresh" (the stale one is refused).
    if (u.pathname.startsWith("/signed/") && req.headers.authorization !== "Bearer fresh") { res.statusCode = 401; return res.end("expired"); }
    const ranged = !u.pathname.startsWith("/plain/");
    const m = ranged && /^bytes=(\d+)-(\d+)$/.exec(req.headers.range || "");
    if (!m) { res.setHeader("content-length", body.length); return res.end(body); }
    const a = Number(m[1]), b = Math.min(body.length - 1, Number(m[2]));
    res.statusCode = 206;
    res.setHeader("content-range", `bytes ${a}-${b}/${body.length}`);
    res.setHeader("content-length", b - a + 1);
    if (u.pathname.startsWith("/cut/") && a === 300_000 && cutOnce) { cutOnce = false; res.write(body.subarray(a, a + 1000)); return setTimeout(() => res.destroy(), 20); }
    res.end(body.subarray(a, b + 1));
  }).listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

const par = { min: 1, chunk: 100_000, streams: 3 };
const from = (p) => seen.filter((s) => s.path === p);

test("a big file comes in several ranges at once, each part where it goes: the same file", async () => {
  let bytes = 0;
  const dest = path.join(tmp, "a.bin");
  const got = await download(`${base}/files/a.bin`, dest, { size: body.length, par, onBytes: (n) => (bytes += n) });
  assert.equal(got, body.length);
  assert.equal(sha(fs.readFileSync(dest)), sha(body), "byte for byte");
  assert.equal(bytes, body.length, "the progress counts every byte once");
  const reqs = from("/files/a.bin");
  assert.equal(reqs.length, 11, "eleven parts of 100,000 bytes");
  assert.ok(reqs.every((r) => /^bytes=\d+-\d+$/.test(r.range)), "each asked for its range");
  assert.ok(!fs.readdirSync(tmp).some((f) => f.endsWith(".part")), "no part file left");
});

test("a server that does not send ranges gives it in one piece", async () => {
  const dest = path.join(tmp, "b.bin");
  await download(`${base}/plain/b.bin`, dest, { size: body.length, par });
  assert.equal(sha(fs.readFileSync(dest)), sha(body));
  const reqs = from("/plain/b.bin");
  assert.equal(reqs.length, 2, "the first range (answered with the whole file, not read), then the file");
  assert.equal(reqs[1].range, null);
});

test("a part cut off mid-way is fetched again, its bytes given back to the progress first", async () => {
  let bytes = 0, low = 0;
  const dest = path.join(tmp, "c.bin");
  await download(`${base}/cut/c.bin`, dest, { size: body.length, par, onBytes: (n) => { bytes += n; low = Math.min(low, n); } });
  assert.equal(sha(fs.readFileSync(dest)), sha(body));
  assert.equal(from("/cut/c.bin").filter((r) => r.range === "bytes=300000-399999").length, 2, "that part twice");
  assert.ok(low < 0, "its first bytes given back");
  assert.equal(bytes, body.length, "the progress ends at the file's size");
});

test("a refused link is renewed once, and the download carries on with the fresh one", async () => {
  let asked = 0;
  const dest = path.join(tmp, "d.bin");
  const relink = async () => { asked++; return { url: `${base}/signed/d.bin`, headers: { authorization: "Bearer fresh" } }; };
  await download(`${base}/signed/d.bin`, dest, { size: body.length, par, headers: { authorization: "Bearer stale" }, relink });
  assert.equal(sha(fs.readFileSync(dest)), sha(body));
  assert.equal(asked, 1, "one fresh link for all the parts");
  assert.ok(from("/signed/d.bin").filter((r) => r.auth === "Bearer fresh").length >= 11);
  // In one piece too (a small file): refused, renewed, fetched.
  const small = path.join(tmp, "e.bin");
  await download(`${base}/signed/e.bin`, small, { size: body.length, headers: { authorization: "Bearer stale" }, relink: async () => ({ url: `${base}/signed/e.bin`, headers: { authorization: "Bearer fresh" } }) });
  assert.equal(sha(fs.readFileSync(small)), sha(body));
});

test("a link refused again and again fails (it is not a stale sign-in), with no part file left", async () => {
  let asked = 0;
  const dest = path.join(tmp, "f.bin");
  await assert.rejects(download(`${base}/signed/f.bin`, dest, { size: body.length, par, headers: { authorization: "Bearer stale" }, relink: async () => { asked++; return { url: `${base}/signed/f.bin`, headers: { authorization: "Bearer stale" } }; } }), /refused|failed/);
  assert.ok(asked <= 3, `renewed at most three times (${asked})`);
  assert.ok(!fs.existsSync(dest) && !fs.readdirSync(tmp).some((f) => f.startsWith("f.bin")), "nothing left");
});
