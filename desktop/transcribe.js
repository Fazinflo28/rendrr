// Transcripts made on this computer. When Rendrr hands the app a task with a transcribe step (render.js), the speech in
// the task's 16 kHz sound is written out as timed words by whisper.cpp, which ships inside the app (whisper-cli). Its
// speech model is not in the download: it is fetched once, the first time it is needed (a few hundred MB), checked
// against the size and SHA-256 its host gives, and kept in the app's folder. Nothing of the footage leaves the computer
// for this; only the words go back to Rendrr. Pure Node: the app's main process runs it, and so do the tests.
"use strict";
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn, execFile } = require("node:child_process");

/** The speech models: English footage gets the English-only model (more accurate for its size), anything else the
 *  multilingual one. Both "small", quantised (q5_1): close to a cloud service on clear speech, fast on a recent computer. */
const MODEL_HOST = process.env.RENDRR_WHISPER_MODELS || "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/";
const MODELS = { en: "ggml-small.en-q5_1.bin", any: "ggml-small-q5_1.bin" };
const modelName = (language) => (String(language || "en").toLowerCase() === "en" ? MODELS.en : MODELS.any);
/** A model smaller than this is not a model (an error page saved by mistake). */
const MODEL_MIN_BYTES = 20 << 20;

/** True when this whisper-cli runs here (its help answers within 20 s). */
function whisperWorks(bin) {
  if (!bin || !fs.existsSync(bin)) return Promise.resolve(false);
  return new Promise((resolve) => execFile(bin, ["--help"], { timeout: 20000, maxBuffer: 4 << 20 }, (e, so, se) => resolve(!e || /usage|options/i.test(`${so}${se}`))));
}

const sha256File = (file) => new Promise((resolve, reject) => {
  const h = crypto.createHash("sha256");
  fs.createReadStream(file).on("data", (c) => h.update(c)).on("error", reject).on("end", () => resolve(h.digest("hex")));
});

/**
 * The speech model for this language, fetched the first time (onPct: 0 to 100 while it downloads). The host's answer
 * gives the file's size and SHA-256 (Hugging Face: x-linked-size and x-linked-etag on the redirect); the file is kept
 * only when both match. download: render.js's download (ranged, retried). Returns the model's path.
 */
async function ensureModel(dir, language, { download, onPct, signal, host = MODEL_HOST } = {}) {
  await fsp.mkdir(dir, { recursive: true });
  const name = modelName(language);
  const file = path.join(dir, name), mark = `${file}.ok`;
  const st = await fsp.stat(file).catch(() => null);
  const ok = await fsp.readFile(mark, "utf8").then(JSON.parse).catch(() => null);
  if (st && ok && ok.size === st.size) return file;
  const url = host + name;
  // What the file should be: its size and SHA-256, from the host's redirect (read without following it).
  let size = 0, sha = "";
  try {
    const head = await fetch(url, { method: "HEAD", redirect: "manual", signal });
    size = Number(head.headers.get("x-linked-size") || head.headers.get("content-length") || 0);
    sha = String(head.headers.get("x-linked-etag") || "").replace(/"/g, "").toLowerCase();
  } catch (e) { if (signal && signal.aborted) throw e; }
  if (!/^[0-9a-f]{64}$/.test(sha)) sha = "";
  if (!(size >= MODEL_MIN_BYTES)) throw new Error("the speech model's host did not say how big it is; try again later");
  let got = 0;
  const part = `${file}.download`;
  await fsp.rm(part, { force: true });
  await download(url, part, { size, signal, onBytes: (n) => { got += n; if (onPct) onPct(Math.max(0, Math.min(100, (got / size) * 100))); } });
  if (sha && (await sha256File(part)) !== sha) { await fsp.rm(part, { force: true }); throw new Error("the speech model did not download whole (its check failed); it will be fetched again next time"); }
  await fsp.rename(part, file);
  await fsp.writeFile(mark, JSON.stringify({ size, sha256: sha || null, at: Date.now() }));
  return file;
}

/** Words whisper.cpp marks rather than says: "[BLANK_AUDIO]", "(music)", "*laughs*". */
const NOT_SPEECH = /^\s*(\[[^\]]*\]|\([^)]*\)|\*[^*]*\*|♪+)\s*$/;

/**
 * whisper-cli's JSON (-oj with -ml 1 -sow: one word a segment, offsets in milliseconds) as Rendrr's words: text,
 * start, end in seconds, in order. A word split in two by the model (" don" "'t") is joined back.
 */
function wordsFromWhisper(json) {
  const segs = Array.isArray(json && json.transcription) ? json.transcription : [];
  const out = [];
  for (const s of segs) {
    const raw = String((s && s.text) || "");
    const text = raw.trim();
    const a = Number(s && s.offsets && s.offsets.from), b = Number(s && s.offsets && s.offsets.to);
    if (!text || NOT_SPEECH.test(text) || !Number.isFinite(a) || !Number.isFinite(b)) continue;
    const prev = out[out.length - 1];
    // No space before it: the rest of the word before ("'t", ",").
    if (prev && !/^\s/.test(raw) && b / 1000 - prev.end < 0.5) { prev.text += text; prev.end = Math.max(prev.end, b / 1000); continue; }
    out.push({ text, start: a / 1000, end: Math.max(a, b) / 1000 });
  }
  return out;
}

/** A short spoken-style prompt so the model keeps "um" and "uh" (Rendrr's filler removal needs them). */
const FILLER_PROMPT = "Um, so, uh, I was, like, thinking about it. Hmm, you know, it's, um, really simple.";

/**
 * The speech in a 16 kHz WAV written to outJson as { words: [{ text, start, end }] }. onFrac: 0 to 1 as it goes.
 * Stopped when it goes stallSec with no progress, or runs longer than four times the sound (at least ten minutes), so it
 * never runs forever; signal stops it at once.
 */
function transcribe(bin, model, wav, outJson, { language = "en", seconds = 0, threads = 4, onFrac, signal, stallSec = 300 } = {}) {
  return new Promise((resolve, reject) => {
    const base = outJson.replace(/\.json$/i, "") + "-whisper";
    const lang = /^[a-z]{2,3}$/.test(String(language)) ? String(language) : "en";
    const args = ["-m", model, "-f", wav, "-l", lang, "-t", String(Math.max(1, Math.min(16, threads | 0))), "-ml", "1", "-sow", "-oj", "-of", base, "-pp", "-nt"];
    if (lang === "en") args.push("--prompt", FILLER_PROMPT);
    const p = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let err = "", moved = Date.now(), pct = -1, why = null;
    const kill = (w) => { why = why || w; try { p.kill("SIGKILL"); } catch { /* gone */ } };
    const onAbort = () => kill("stopped");
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
    const capMs = Math.max(600, seconds * 4) * 1000, t0 = Date.now();
    const watch = setInterval(() => {
      if (Date.now() - moved > stallSec * 1000) kill(`the speech model stopped moving at ${Math.max(0, pct)}%`);
      else if (Date.now() - t0 > capMs) kill("the speech model took far too long");
    }, 5000);
    const read = (d) => {
      const s = String(d);
      if (err.length < 60000) err += s;
      for (const m of s.matchAll(/progress\s*=\s*(\d+)%/g)) { const v = Number(m[1]); if (v > pct) { pct = v; moved = Date.now(); if (onFrac) onFrac(Math.min(1, v / 100)); } }
    };
    p.stdout.on("data", read);
    p.stderr.on("data", read);
    p.on("error", (e) => { clearInterval(watch); reject(e); });
    p.on("close", async (code, sig) => {
      clearInterval(watch);
      if (signal) signal.removeEventListener("abort", onAbort);
      if (why === "stopped" || (signal && signal.aborted)) return reject(Object.assign(new Error("stopped"), { stopped: true }));
      if (why) return reject(new Error(why));
      if (code !== 0) return reject(new Error(code == null ? `the speech model was stopped by the system (${sig || "a signal"}), most likely out of memory` : `the speech model failed (${code}): ${err.slice(-600).trim()}`));
      try {
        const json = JSON.parse(await fsp.readFile(`${base}.json`, "utf8"));
        const words = wordsFromWhisper(json);
        await fsp.writeFile(outJson, JSON.stringify({ words, by: "whisper.cpp", model: path.basename(model) }));
        await fsp.rm(`${base}.json`, { force: true });
        if (onFrac) onFrac(1);
        resolve({ words: words.length });
      } catch (e) { reject(new Error(`the speech model's words could not be read: ${String((e && e.message) || e).slice(0, 200)}`)); }
    });
  });
}

module.exports = { MODELS, modelName, ensureModel, wordsFromWhisper, transcribe, whisperWorks, FILLER_PROMPT };
