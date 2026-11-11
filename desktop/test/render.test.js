// Renders on this Mac (render.js), against a stand-in Rendrr: a task is refused when it names anything outside its own
// folder; a real one fetches its footage (once: the second render takes it from the cache), its captions and fonts,
// runs FFmpeg, uploads the result where it is told, keeps a final in "Downloads" and says it is done; Rendrr saying
// stop stops it without a word more; a run that fails is reported. RENDRR_FFMPEG: the FFmpeg to test (the app's own on
// the Mac build), else the one on the PATH.
"use strict";
const assert = require("node:assert/strict");
const { test, before, after } = require("node:test");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { checkTask, probeFfmpeg, runTask } = require("../render");

const FFMPEG = process.env.RENDRR_FFMPEG || "ffmpeg";
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rendrr-render-test-"));
const fontDir = path.join(__dirname, "..", "..", "apps", "web", "public", "fonts");
const font = fs.existsSync(fontDir) ? fs.readdirSync(fontDir).find((f) => f.endsWith(".ttf")) : null;
let server, base = "";
const got = { puts: {}, reports: [], gets: {} };
let stopAfter = null; // stop the task at its first render report

before(async () => {
  // A 3 s clip with sound, as storage would hold a preview copy.
  execFileSync(FFMPEG, ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=640x360:r=30:d=3", "-f", "lavfi", "-i", "sine=f=440:d=3", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", path.join(tmp, "clip.mp4")]);
  server = http.createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    if (req.method === "GET" && u.pathname.startsWith("/files/")) {
      const f = u.pathname === "/files/font.ttf" ? path.join(fontDir, font) : path.join(tmp, path.basename(u.pathname));
      got.gets[u.pathname] = (got.gets[u.pathname] || 0) + 1;
      return fs.createReadStream(f).pipe(res);
    }
    if (req.method === "PUT" && u.pathname.startsWith("/up/")) {
      const chunks = []; req.on("data", (c) => chunks.push(c));
      req.on("end", () => { got.puts[u.pathname] = { body: Buffer.concat(chunks), type: req.headers["content-type"], length: Number(req.headers["content-length"]) }; res.end(); });
      return;
    }
    if (req.method === "POST" && u.pathname.startsWith("/desktop/tasks/")) {
      let b = ""; req.on("data", (c) => (b += c));
      req.on("end", () => {
        const what = u.pathname.split("/").pop(), body = JSON.parse(b || "{}");
        got.reports.push({ what, body, token: req.headers["x-rendrr-task-token"] });
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(what === "progress" ? { stop: stopAfter && body.phase === "render" ? stopAfter : null } : { ok: true }));
      });
      return;
    }
    res.statusCode = 404; res.end();
  }).listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

const size = (f) => fs.statSync(path.join(tmp, f)).size;
const ass = `[Script Info]\nScriptType: v4.00+\nPlayResX: 320\nPlayResY: 180\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, BackColour, Bold, Alignment\nStyle: Default,Inter,24,&H00FFFFFF,&H00000000,1,2\n\n[Events]\nFormat: Layer, Start, End, Style, Text\nDialogue: 0,0:00:00.00,0:00:03.00,Default,Made on this Mac\n`;
const task = (over = {}) => ({
  v: 1, id: "11111111-2222-3333-4444-555555555555", token: "tok", api: base, renderId: "r1", kind: "final", label: "Final v1 of Test",
  inputs: [
    { name: "source", url: `${base}/files/clip.mp4`, size: size("clip.mp4"), cache: "proxies/u/v.mp4#etag1" },
    { name: "captions.ass", data: Buffer.from(ass).toString("base64") },
  ],
  fonts: font ? [{ name: font, url: `${base}/files/font.ttf`, size: fs.statSync(path.join(fontDir, font)).size }] : [],
  commands: [{
    args: ["-hide_banner", "-nostdin", "-y", "-loglevel", "error", "-i", "source", "-filter_complex_script", "__FILTER_SCRIPT__", "-map", "[vout]", "-map", "0:a", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-t", "3", "-movflags", "+faststart", "-progress", "pipe:1", "-nostats", "out.mp4"],
    graph: `[0:v]scale=320:180,ass=filename='captions.ass'${font ? ":fontsdir='fonts'" : ""}[vout]`, seconds: 3,
  }],
  outputs: [{ name: "out.mp4", url: `${base}/up/finals/u/p/r1.mp4`, type: "video/mp4", save: "Test final v1.mp4" }],
  stallSec: 60,
  ...over,
});
const opts = () => ({ ffmpeg: FFMPEG, cacheDir: path.join(tmp, "cache"), workDir: tmp, saveDir: fs.mkdtempSync(path.join(tmp, "downloads-")), allowHttp: true });

test("a task naming anything outside its own folder (a Mac's or a Windows PC's), a protocol, or a plain-http link is refused", () => {
  assert.doesNotThrow(() => checkTask(task(), { allowHttp: true }));
  assert.throws(() => checkTask(task()), /not a Rendrr render task|bad link/, "http only in tests");
  const withArg = (a) => task({ commands: [{ args: ["-i", a, "out.mp4"] }] });
  for (const a of ["/etc/passwd", "~/x", "../x", "a/../../b", "concat:a|b", "http://evil/x", "file:x", "C:\\Windows\\x", "\\\\server\\share\\x", "a\\..\\..\\b"]) assert.throws(() => checkTask(withArg(a), { allowHttp: true }), /path|protocol/, a);
  for (const g of ["movie=/etc/passwd[v]", "ass=filename='/Users/x/a.ass'", "amovie=http://x/y", "lut3d=file=../x", "movie=C\\:/Windows/x[v]", "lut3d=file='D:\\\\looks\\\\a.cube'", "movie=\\\\\\\\server\\\\x[v]"]) assert.throws(() => checkTask(task({ commands: [{ args: ["-i", "source", "out.mp4"], graph: g }] }), { allowHttp: true }), /graph/, g);
  assert.throws(() => checkTask(task({ inputs: [{ name: "../x", data: "" }] }), { allowHttp: true }), /input name/);
  assert.throws(() => checkTask(task({ inputs: [{ name: "fonts/x.ttf", data: "" }] }), { allowHttp: true }), /input name/);
  assert.throws(() => checkTask(task({ outputs: [{ name: "out.mp4", url: `${base}/up/x`, type: "video/mp4", save: "../../evil" }] }), { allowHttp: true }), /file name/);
  // Division and colons in a real graph are fine.
  assert.doesNotThrow(() => checkTask(task({ commands: [{ args: ["-i", "source", "out.mp4"], graph: "[0:v]scale=iw/2:-2,overlay=x='(W-w)/2':y=H/2[v]" }] }), { allowHttp: true }));
});

test("the cloud's runs are said the way this Mac's FFmpeg reads them (FFmpeg 7 and later: -/filter_complex)", () => {
  const { adaptArgs } = require("../render");
  const a = ["-i", "source", "-filter_complex_script", "graph-0.txt", "out.mp4"];
  assert.deepEqual(adaptArgs(a, 6), a);
  assert.deepEqual(adaptArgs(a, 9), ["-i", "source", "-/filter_complex", "graph-0.txt", "out.mp4"]);
});

test("this Mac's FFmpeg says its version and what it can do", async () => {
  const p = await probeFfmpeg(FFMPEG);
  assert.equal(p.ok, true);
  assert.ok(p.version);
  for (const f of ["libx264", "ass", "lut3d", "sendcmd"]) assert.ok(p.have.includes(f), `has ${f} (${p.have.join(", ")})`);
  const none = await probeFfmpeg(path.join(tmp, "no-ffmpeg"));
  assert.equal(none.ok, false);
});

test("a render: fetched, made with captions in its fonts, uploaded, kept in Downloads, reported done; the second takes the footage from the cache", async () => {
  const o = opts();
  const r = await runTask(task(), o);
  assert.equal(r.ok, true, r.error);
  const put = got.puts["/up/finals/u/p/r1.mp4"];
  assert.ok(put && put.body.length > 1000 && put.length === put.body.length && put.type === "video/mp4", "uploaded with its length and type");
  fs.writeFileSync(path.join(tmp, "got.mp4"), put.body);
  const info = execFileSync(FFMPEG, ["-hide_banner", "-i", path.join(tmp, "got.mp4"), "-f", "null", "-"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) + "";
  assert.ok(typeof info === "string");
  const probe = (() => { try { execFileSync(FFMPEG, ["-hide_banner", "-i", path.join(tmp, "got.mp4")], { stdio: "pipe" }); } catch (e) { return String(e.stderr); } return ""; })();
  assert.match(probe, /320x180/, "the picture the run made");
  assert.match(probe, /Audio: aac/);
  assert.equal(fs.readFileSync(r.savedPath).length, put.body.length, "the same file kept in Downloads");
  assert.equal(path.basename(r.savedPath), "Test final v1.mp4");
  const done = got.reports.filter((x) => x.what === "done").at(-1);
  assert.deepEqual(done.body, { outputs: { "out.mp4": put.body.length }, saved: "Test final v1.mp4" });
  assert.ok(got.reports.every((x) => x.token === "tok"), "every report carries the task's token");
  assert.ok(got.reports.some((x) => x.what === "progress" && x.body.phase === "render"), "it said how far it was");
  assert.ok(!fs.readdirSync(tmp).some((f) => f.startsWith("rendrr-render-")), "its folder is gone");
  // Again: the footage is not fetched a second time; a second final with the same name gets a new one.
  const before = got.gets["/files/clip.mp4"];
  const r2 = await runTask(task(), { ...o });
  assert.equal(r2.ok, true, r2.error);
  assert.equal(got.gets["/files/clip.mp4"], before, "from the cache");
  assert.equal(path.basename(r2.savedPath), "Test final v1 (2).mp4");
});

test("Rendrr says stop (the user stopped it, or the cloud took over): it stops and says nothing more", async () => {
  stopAfter = "stopped";
  const reports = got.reports.length;
  const slow = task({ commands: [{ args: ["-hide_banner", "-nostdin", "-y", "-re", "-stream_loop", "-1", "-i", "source", "-c:v", "libx264", "-preset", "ultrafast", "-t", "60", "-progress", "pipe:1", "-nostats", "out.mp4"], seconds: 60 }] });
  const r = await runTask(slow, opts());
  stopAfter = null;
  assert.equal(r.ok, false);
  assert.equal(r.stopped, "stopped");
  assert.ok(!got.reports.slice(reports).some((x) => x.what === "failed" || x.what === "done"), "no failure or done reported");
});

test("a run that fails is reported, with FFmpeg's reason", async () => {
  const r = await runTask(task({ commands: [{ args: ["-hide_banner", "-nostdin", "-y", "-i", "source", "-filter_complex_script", "__FILTER_SCRIPT__", "-map", "[vout]", "out.mp4"], graph: "[0:v]nosuchfilter[vout]" }] }), opts());
  assert.equal(r.ok, false);
  const failed = got.reports.filter((x) => x.what === "failed").at(-1);
  assert.match(failed.body.error, /^the Mac could not render it: FFmpeg failed/);
});
