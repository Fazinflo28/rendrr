// Transcripts made on this computer (transcribe.js, render.js): whisper.cpp's words read the way Rendrr keeps them; the
// speech model fetched once and checked against the size and SHA-256 its host gives (a bad copy is never kept); a
// stand-in whisper-cli run to the end, stopped when it freezes; and a task with a transcribe step run end to end
// against a stand-in Rendrr, the words uploaded with the rest. RENDRR_FFMPEG: the FFmpeg to test.
"use strict";
const assert = require("node:assert/strict");
const { test, before, after } = require("node:test");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { checkTask, runTask, download } = require("../render");
const { ensureModel, wordsFromWhisper, transcribe, whisperWorks, modelName } = require("../transcribe");

const FFMPEG = process.env.RENDRR_FFMPEG || "ffmpeg";
const IS_WIN = process.platform === "win32";
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rendrr-transcribe-test-"));
const MODEL = crypto.randomBytes(21 << 20); // a stand-in "model", over the 20 MB a real one must be
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
let server, base = "", modelGets = 0, badModel = false;
const got = { puts: {}, reports: [] };

before(async () => {
  execFileSync(FFMPEG, ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "sine=f=300:d=2", "-ac", "1", "-ar", "16000", "-c:a", "aac", path.join(tmp, "audio.m4a")]);
  server = http.createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    if (u.pathname.startsWith("/models/")) {
      // The model's host: a redirect that says the file's size and SHA-256, then the file (with ranges).
      res.statusCode = 302; res.setHeader("location", `${base}/cdn${u.pathname}`); res.setHeader("x-linked-size", String(MODEL.length)); res.setHeader("x-linked-etag", `"${sha(MODEL)}"`); return res.end();
    }
    if (u.pathname.startsWith("/cdn/models/")) {
      modelGets++;
      const body = badModel ? Buffer.concat([MODEL.subarray(0, MODEL.length - 1), Buffer.from([MODEL[MODEL.length - 1] ^ 1])]) : MODEL;
      const m = /bytes=(\d+)-(\d+)/.exec(req.headers.range || "");
      if (m) { const a = Number(m[1]), b = Number(m[2]); res.statusCode = 206; res.setHeader("content-range", `bytes ${a}-${b}/${body.length}`); return res.end(body.subarray(a, b + 1)); }
      return res.end(body);
    }
    if (req.method === "GET" && u.pathname.startsWith("/files/")) return fs.createReadStream(path.join(tmp, path.basename(u.pathname))).pipe(res);
    if (req.method === "PUT" && u.pathname.startsWith("/up/")) {
      const chunks = []; req.on("data", (c) => chunks.push(c));
      req.on("end", () => { got.puts[u.pathname] = Buffer.concat(chunks); res.end(); });
      return;
    }
    if (req.method === "POST" && u.pathname.startsWith("/desktop/tasks/")) {
      let b = ""; req.on("data", (c) => (b += c));
      req.on("end", () => { got.reports.push({ what: u.pathname.split("/").pop(), body: JSON.parse(b || "{}") }); res.setHeader("content-type", "application/json"); res.end(JSON.stringify(u.pathname.endsWith("/progress") ? { stop: null } : { ok: true })); });
      return;
    }
    res.statusCode = 404; res.end();
  }).listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

test("whisper.cpp's words, one a segment, read as Rendrr's: seconds, in order, marks dropped, split words joined", () => {
  const words = wordsFromWhisper({ transcription: [
    { offsets: { from: 0, to: 0 }, text: "" },
    { offsets: { from: 120, to: 400 }, text: " Um," },
    { offsets: { from: 400, to: 700 }, text: " I" },
    { offsets: { from: 700, to: 900 }, text: " don" },
    { offsets: { from: 900, to: 1010 }, text: "'t" },
    { offsets: { from: 1100, to: 1500 }, text: " know." },
    { offsets: { from: 1500, to: 3000 }, text: " [BLANK_AUDIO]" },
    { offsets: { from: 3000, to: 3400 }, text: " (music)" },
  ] });
  assert.deepEqual(words, [
    { text: "Um,", start: 0.12, end: 0.4 }, { text: "I", start: 0.4, end: 0.7 }, { text: "don't", start: 0.7, end: 1.01 }, { text: "know.", start: 1.1, end: 1.5 },
  ]);
  assert.deepEqual(wordsFromWhisper({}), []);
  assert.equal(modelName("en"), "ggml-small.en-q5_1.bin");
  assert.equal(modelName("fr"), "ggml-small-q5_1.bin");
});

test("the speech model: fetched once with progress, checked, kept; a copy that fails its check is not kept", async () => {
  const dir = path.join(tmp, "speech");
  const seen = [];
  const f = await ensureModel(dir, "en", { download, host: `${base}/models/`, onPct: (p) => seen.push(p) });
  assert.equal(path.basename(f), "ggml-small.en-q5_1.bin");
  assert.equal(sha(fs.readFileSync(f)), sha(MODEL));
  assert.ok(seen.length && seen.at(-1) === 100, "progress up to 100");
  const before = modelGets;
  await ensureModel(dir, "en", { download, host: `${base}/models/` });
  assert.equal(modelGets, before, "the second time it is already here");
  badModel = true;
  await assert.rejects(ensureModel(path.join(tmp, "speech2"), "en", { download, host: `${base}/models/` }), /check failed/);
  assert.ok(!fs.existsSync(path.join(tmp, "speech2", "ggml-small.en-q5_1.bin")), "not kept");
  badModel = false;
});

// A stand-in whisper-cli: a script that prints progress and writes the JSON whisper.cpp writes (-oj -of base). Not on
// Windows, where a script cannot be run as a program without a shell.
const fakeWhisper = (body) => {
  const f = path.join(tmp, `whisper-${crypto.randomBytes(4).toString("hex")}`);
  fs.writeFileSync(f, `#!${process.execPath}\n${body}`);
  fs.chmodSync(f, 0o755);
  return f;
};
const WRITES = `const a = process.argv.slice(2), of = a[a.indexOf("-of") + 1];
if (a.includes("--help")) { console.log("usage: whisper-cli [options] file0.wav"); process.exit(0); }
for (const p of [10, 50, 100]) process.stderr.write("whisper_print_progress_callback: progress = " + p + "%\\n");
require("fs").writeFileSync(of + ".json", JSON.stringify({ transcription: [{ offsets: { from: 0, to: 500 }, text: " Hello" }, { offsets: { from: 500, to: 900 }, text: " there." }] }));`;

test("a transcript with whisper-cli: progress to the end, the words written; one that freezes is stopped", { skip: IS_WIN }, async () => {
  const bin = fakeWhisper(WRITES);
  assert.equal(await whisperWorks(bin), true);
  assert.equal(await whisperWorks(path.join(tmp, "nothing-here")), false);
  const out = path.join(tmp, "words.json"), fr = [];
  const r = await transcribe(bin, "model.bin", "speech.wav", out, { seconds: 1, onFrac: (f) => fr.push(f) });
  assert.equal(r.words, 2);
  assert.deepEqual(JSON.parse(fs.readFileSync(out, "utf8")).words, [{ text: "Hello", start: 0, end: 0.5 }, { text: "there.", start: 0.5, end: 0.9 }]);
  assert.equal(fr.at(-1), 1);
  const frozen = fakeWhisper(`setTimeout(() => {}, 60000);`);
  const t0 = Date.now();
  await assert.rejects(transcribe(frozen, "m", "s.wav", path.join(tmp, "w2.json"), { stallSec: 1 }), /stopped moving/);
  assert.ok(Date.now() - t0 < 15000, "stopped soon after it froze");
  const ac = new AbortController();
  const p = transcribe(frozen, "m", "s.wav", path.join(tmp, "w3.json"), { signal: ac.signal });
  setTimeout(() => ac.abort(), 300);
  await assert.rejects(p, /stopped/);
});

const task = (over = {}) => ({
  v: 1, id: "99999999-2222-3333-4444-555555555555", token: "tok", api: base, renderId: "heard-v1", kind: "footage_transcript", label: "a transcript",
  inputs: [{ name: "audio.m4a", url: `${base}/files/audio.m4a`, size: fs.statSync(path.join(tmp, "audio.m4a")).size }],
  commands: [{ args: ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-i", "audio.m4a", "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", "speech.wav"] }],
  outputs: [{ name: "words.json", url: `${base}/up/mac/heard/v1.json`, type: "application/json" }],
  transcribe: { input: "speech.wav", output: "words.json", language: "en", seconds: 2 },
  ...over,
});

test("a transcribe step: checked like the rest of a task", () => {
  assert.doesNotThrow(() => checkTask(task(), { allowHttp: true }));
  assert.throws(() => checkTask(task({ transcribe: { input: "../x.wav", output: "words.json" } }), { allowHttp: true }), /transcript step/);
  assert.throws(() => checkTask(task({ transcribe: { input: "speech.wav", output: "other.json" } }), { allowHttp: true }), /not sent back/);
  assert.throws(() => checkTask(task({ transcribe: { input: "speech.wav", output: "words.json", language: "en; rm" } }), { allowHttp: true }), /language/);
});

test("a task with a transcribe step: the sound made into a WAV, the words written by the app's speech model and uploaded", async () => {
  const seen = [];
  const r = await runTask(task(), {
    ffmpeg: FFMPEG, cacheDir: path.join(tmp, "cache"), workDir: tmp, allowHttp: true,
    transcribe: async ({ input, output, language, seconds, onModel, onFrac }) => {
      seen.push({ wav: fs.existsSync(input) && fs.statSync(input).size > 1000, language, seconds });
      onModel(50); onFrac(0.5);
      fs.writeFileSync(output, JSON.stringify({ words: [{ text: "Hi", start: 0.1, end: 0.4 }] }));
    },
  });
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(seen, [{ wav: true, language: "en", seconds: 2 }]);
  assert.deepEqual(JSON.parse(got.puts["/up/mac/heard/v1.json"].toString()).words, [{ text: "Hi", start: 0.1, end: 0.4 }]);
  assert.ok(got.reports.some((x) => x.what === "progress" && x.body.phase === "render" && x.body.cmd === 1), "the transcript's progress is the run after the last");
  // An app with no speech model: the task fails and says why (the cloud makes the transcript).
  const r2 = await runTask(task({ id: "99999999-2222-3333-4444-555555555556" }), { ffmpeg: FFMPEG, cacheDir: path.join(tmp, "cache"), workDir: tmp, allowHttp: true });
  assert.equal(r2.ok, false);
  assert.match(r2.error, /cannot make transcripts/);
});
