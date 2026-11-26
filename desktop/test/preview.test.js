// The preview copy made on this computer (audit #14): the same files the page made with ffmpeg.wasm (a 720p proxy at
// 30 fps with sound, and 16 kHz mono sound for the transcript), what the file is, and progress up to the end. A file
// with no sound gets silence; a graphics chip that fails falls back to the processor.
"use strict";
const assert = require("node:assert/strict");
const { test, after } = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { makePreview } = require("../render");

const FFMPEG = process.env.RENDRR_FFMPEG || "ffmpeg";
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rendrr-preview-test-"));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const probe = (f) => { try { execFileSync(FFMPEG, ["-hide_banner", "-i", f], { stdio: ["ignore", "ignore", "pipe"] }); } catch (e) { return String(e.stderr); } return ""; };

test("a vertical clip with sound: a 720 wide proxy at 30 fps with sound, the transcript's sound, and what it is", async () => {
  const src = path.join(tmp, "in.mov");
  execFileSync(FFMPEG, ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=1080x1920:r=60:d=3", "-f", "lavfi", "-i", "sine=f=330:d=3", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", src]);
  const dir = fs.mkdtempSync(path.join(tmp, "a-"));
  const seen = [];
  const r = await makePreview(FFMPEG, src, dir, { onPct: (p) => seen.push(p) });
  assert.equal(r.info.width, 1080); assert.equal(r.info.height, 1920); assert.equal(r.info.hasAudio, true);
  assert.ok(Math.abs(r.info.seconds - 3) < 0.1);
  const p = probe(r.proxy);
  assert.match(p, /Video: h264.*720x1280/);
  assert.match(p, /30 fps/);
  assert.match(p, /Audio: aac.*48000 Hz, stereo/);
  assert.match(probe(r.audio), /Audio: aac.*16000 Hz, mono/);
  assert.equal(r.proxySize, fs.statSync(r.proxy).size);
  assert.ok(seen.length && seen.every((x) => x >= 0 && x <= 99), "progress stays between 0 and 99");
});

test("a clip with no sound gets silence; an encoder that fails is replaced by the processor's", async () => {
  const src = path.join(tmp, "mute.mp4");
  execFileSync(FFMPEG, ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=1280x720:r=25:d=2", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", src]);
  const dir = fs.mkdtempSync(path.join(tmp, "b-"));
  const r = await makePreview(FFMPEG, src, dir, { hw: "no_such_encoder" });
  assert.equal(r.info.hasAudio, false);
  const p = probe(r.proxy);
  assert.match(p, /Video: h264.*1280x720/);
  assert.match(p, /Audio: aac/);
  assert.match(probe(r.audio), /Audio: aac.*16000 Hz, mono/);
});

test("not a video: refused", async () => {
  const f = path.join(tmp, "note.txt");
  fs.writeFileSync(f, "hello");
  await assert.rejects(makePreview(FFMPEG, f, fs.mkdtempSync(path.join(tmp, "c-"))), /not a video/);
});
