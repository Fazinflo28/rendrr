// Renders on this computer (a Mac or a Windows PC). While the Rendrr app is open, Rendrr hands it the encode of each render: a task with the files
// to fetch (signed links, or small files inline), the FFmpeg runs to make (every path inside the task's own folder),
// and where to upload what they make. This file checks a task is safe to run, fetches its files (footage kept in a
// cache, so the next render of the same edit fetches nothing), runs FFmpeg in a fresh folder, reports how far it is,
// uploads the result and keeps a final in Downloads. Pure Node: the app's main process runs it, and so do the tests.
"use strict";
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const http = require("node:http");
const https = require("node:https");
const { spawn, execFile } = require("node:child_process");

const PROTOCOL = 1;
const IS_WIN = process.platform === "win32";
const MACHINE = IS_WIN ? "PC" : "Mac";
/** FFmpeg features a render may need (the same list as the worker's MAC_FEATURES). */
const FEATURES = ["ass", "lut3d", "zscale", "tonemap", "vidstabtransform", "minterpolate", "afir", "sendcmd", "libvpx-vp9", "libx264", "libx265", "prores_ks", "ffv1", "palettegen", "paletteuse", "alphamerge"];
const NAME_CHARS = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;
/** A name inside the render's folder: plain parts, none of them "." or "..". */
const NAME = { test: (n) => typeof n === "string" && NAME_CHARS.test(n) && !n.split("/").some((p) => p === "." || p === "..") };
const FILE = /^[^/\\:\0]{1,200}$/;

/** Which kind of thing each feature is, so FFmpeg can be asked about it by name (the same on every FFmpeg version). */
const KIND = { libx264: "encoder", libx265: "encoder", prores_ks: "encoder", ffv1: "encoder", "libvpx-vp9": "decoder" };

/** What this Mac's FFmpeg is: its version and which FEATURES it has (ok false: it does not run). */
async function probeFfmpeg(ffmpeg) {
  const out = (args) => new Promise((resolve) => execFile(ffmpeg, args, { maxBuffer: 8 << 20, timeout: 20000 }, (e, so, se) => resolve(e && !so && !se ? null : `${so || ""}\n${se || ""}`)));
  const v = await out(["-hide_banner", "-version"]);
  if (!v || !/ffmpeg version/.test(v)) return { ok: false, version: null, have: [], why: "FFmpeg is missing from this app" };
  // "-h filter=lut3d" answers "Filter lut3d ..." when it has it, "Unknown filter" when not.
  const have = [];
  await Promise.all(FEATURES.map(async (f) => {
    const kind = KIND[f] || "filter";
    const t = await out(["-hide_banner", "-h", `${kind}=${f}`]);
    if (t && new RegExp(`^${kind[0].toUpperCase()}${kind.slice(1)} ${f.replace(/-/g, "\\-")}\\b`, "m").test(t)) have.push(f);
  }));
  const version = (v.match(/ffmpeg version (\S+)/) || [])[1] || null;
  // The graphics chip's encoders that really work here (a tiny test encode each: built in is not enough, NVENC needs
  // an NVIDIA card). Rendrr encodes this computer's H.264 previews and finals with the first one (audit #11).
  const hw = [];
  for (const enc of HW_ENCODERS) if (await hwWorks(ffmpeg, enc)) hw.push(enc);
  return { ok: true, version, have: [...FEATURES.filter((f) => have.includes(f)), ...hw], why: null };
}

/** Hardware H.264 encoders to try on this kind of computer (the same names as the worker's MAC_FEATURES). */
const HW_ENCODERS = IS_WIN ? ["h264_nvenc", "h264_qsv", "h264_amf"] : process.platform === "darwin" ? ["h264_videotoolbox"] : [];
/** True when a quarter second of grey encodes with this encoder, within 15 s. */
function hwWorks(ffmpeg, enc) {
  const args = ["-hide_banner", "-loglevel", "error", "-nostdin", "-f", "lavfi", "-i", "color=c=gray:s=256x256:r=30:d=0.25", "-c:v", enc, "-b:v", "1M", "-pix_fmt", "yuv420p", "-f", "null", "-"];
  return new Promise((resolve) => execFile(ffmpeg, args, { timeout: 15000, maxBuffer: 1 << 20 }, (e) => resolve(!e)));
}

/**
 * What a video file on this Mac is, read with FFmpeg: its picture as shown (turned upright), frame rate, length, sound,
 * and HDR (pq, hlg). Null: not a video FFmpeg can read.
 */
async function probeFile(ffmpeg, file) {
  const text = await new Promise((resolve) => execFile(ffmpeg, ["-hide_banner", "-i", file], { maxBuffer: 4 << 20, timeout: 30000 }, (_e, so, se) => resolve(`${so || ""}\n${se || ""}`)));
  const video = text.split("\n").find((l) => /Stream #\S+.*: Video: /.test(l) && !/attached pic/.test(l));
  if (!video) return null;
  const dims = video.match(/, (\d{2,5})x(\d{2,5})[ ,]/);
  if (!dims) return null;
  let width = Number(dims[1]), height = Number(dims[2]);
  const rot = Number((text.match(/rotation of (-?[\d.]+) degrees/) || text.match(/rotate\s*:\s*(-?\d+)/) || [])[1] || 0);
  if (Math.abs(Math.round(rot)) % 180 === 90) [width, height] = [height, width];
  const fps = Number((video.match(/([\d.]+) fps/) || video.match(/([\d.]+) tbr/) || [])[1] || 0);
  const d = text.match(/Duration: (\d+):(\d+):([\d.]+)/);
  const seconds = d ? Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3]) : 0;
  const transfer = /smpte2084/.test(video) ? "pq" : /arib-std-b67/.test(video) ? "hlg" : null;
  return { width, height, fps: fps || 30, seconds, hasAudio: /Stream #\S+.*: Audio: /.test(text), transfer };
}

function bad(why) { const e = new Error(why); e.badTask = true; return e; }
const linkOk = (u, allowHttp) => { try { const x = new URL(u); return x.protocol === "https:" || (allowHttp && x.protocol === "http:"); } catch { return false; } };

/** Throws unless the task is one this app may run: names inside its folder, no path or protocol outside it, links over https. */
function checkTask(t, { allowHttp = false } = {}) {
  if (!t || t.v !== PROTOCOL || typeof t.id !== "string" || typeof t.token !== "string" || !linkOk(t.api, allowHttp)) throw bad("not a Rendrr render task");
  const names = new Set();
  for (const i of t.inputs || []) {
    if (!NAME.test(i.name) || i.name === "fonts" || i.name.startsWith("fonts/") || names.has(i.name)) throw bad(`bad input name ${i.name}`);
    names.add(i.name);
    if (i.data != null) { if (typeof i.data !== "string") throw bad("bad inline data"); continue; }
    // An original kept on this Mac: named by its video, never by a path (the app knows where it is).
    if (i.local != null) { if (!/^[A-Za-z0-9_-]{1,64}$/.test(String(i.local.videoId)) || !(Number(i.local.size) > 0)) throw bad("bad original"); continue; }
    if (!linkOk(i.url, allowHttp)) throw bad(`bad link for ${i.name}`);
    if (i.keep != null && (typeof i.keep !== "string" || i.keep.length > 300)) throw bad(`bad cache key for ${i.name}`);
    for (const h of Object.keys(i.headers || {})) if (h.toLowerCase() !== "authorization") throw bad("bad header");
  }
  for (const f of t.fonts || []) if (!/^[A-Za-z0-9._-]+$/.test(f.name) || !linkOk(f.url, allowHttp)) throw bad(`bad font ${f.name}`);
  if (!Array.isArray(t.commands) || !t.commands.length || t.commands.length > 200) throw bad("no runs");
  for (const c of t.commands) {
    if (!Array.isArray(c.args) || c.args.some((a) => typeof a !== "string")) throw bad("bad arguments");
    for (const a of c.args) {
      if (a.startsWith("/") || a.startsWith("\\") || a.startsWith("~") || a.includes("\0") || a.split(/[\\/]/).includes("..")) throw bad(`an argument names a path outside the render: ${a.slice(0, 60)}`);
      // A protocol (concat:, http:, file:...) could reach outside the render's folder; only FFmpeg's progress pipe.
      if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(a) && a !== "pipe:1" && a !== "pipe:2") throw bad(`an argument names a protocol: ${a.slice(0, 40)}`);
    }
    if (c.graph != null) {
      if (typeof c.graph !== "string" || c.graph.length > 16 << 20) throw bad("bad graph");
      // Also a Windows drive ("C:/", "C\\:\\") or network path ("\\\\server").
      if (/(^|[='":,\s])\/[A-Za-z]/.test(c.graph) || /(^|[='":,\s])[A-Za-z]\\*:[\\/]/.test(c.graph) || /(^|[='":,\s])\\{2,}[A-Za-z0-9]/.test(c.graph) || c.graph.includes("://") || c.graph.includes("..")) throw bad("the graph names a path outside the render");
    }
  }
  for (const o of t.outputs || []) {
    if (!NAME.test(o.name) || !linkOk(o.url, allowHttp) || typeof o.type !== "string") throw bad(`bad output ${o.name}`);
    if (o.save != null && !FILE.test(o.save)) throw bad("bad file name");
  }
  if (!(t.outputs || []).length) throw bad("nothing to make");
}

/** POST to Rendrr with the task's token; the answer's JSON (null on failure). */
async function report(t, what, body) {
  try {
    const r = await fetch(`${t.api}/desktop/tasks/${encodeURIComponent(t.id)}/${what}`, { method: "POST", headers: { "content-type": "application/json", "x-rendrr-task-token": t.token }, body: JSON.stringify(body || {}), signal: AbortSignal.timeout(20000) });
    return r.ok ? await r.json().catch(() => ({})) : null;
  } catch { return null; }
}

/** Big files come in several ranged requests at once (one connection to a far-away server is slow; a few fill the line). */
const PAR = { min: 64 << 20, chunk: 16 << 20, streams: 6 };
/** How many of a render's files are fetched at once. */
const FETCH_AT_ONCE = 4;
const refused = (status) => status === 401 || status === 403;

/**
 * Downloads a link to a file (via a .part file, size checked). onBytes: each chunk's length (a part that is fetched
 * again gives its bytes back first, as a negative count). relink(): a fresh link and headers, when the server says the
 * one in hand is no longer good (a Google Drive sign-in lasts an hour; a big original can take longer).
 */
async function download(url, dest, { headers, size, onBytes, signal, relink, par = PAR } = {}) {
  const link = { url, headers: headers || {} };
  let renewing = null, renewals = 0;
  // One fresh link for every request that was refused at the same time (three at most: a link refused again and again
  // is not a stale sign-in).
  const renew = async (was) => {
    if (!relink) return false;
    if (link.url !== was.url || link.headers !== was.headers) return true;
    if (!renewing && renewals >= 3) return false;
    if (!renewing) renewals++;
    renewing = renewing || Promise.resolve(relink()).then((l) => { if (l && l.url) { link.url = l.url; link.headers = l.headers || {}; return true; } return false; }, () => false).finally(() => { renewing = null; });
    return renewing;
  };
  if (size && size >= par.min) {
    const got = await inRanges(link, dest, { size, onBytes, signal, renew, par });
    if (got != null) return got;
  }
  let last;
  for (let attempt = 0; attempt < 4; attempt++) {
    const part = `${dest}.${process.pid}.${Date.now()}.part`;
    const was = { ...link };
    let got = 0;
    try {
      const r = await fetch(was.url, { headers: was.headers, signal });
      if (!r.ok || !r.body) { if (refused(r.status) && (await renew(was))) { attempt--; throw new Error(`download refused (${r.status})`); } throw new Error(`download failed (${r.status})`); }
      const out = fs.createWriteStream(part);
      for await (const chunk of r.body) {
        got += chunk.length; if (onBytes) onBytes(chunk.length);
        if (!out.write(chunk)) await new Promise((res) => out.once("drain", res));
      }
      await new Promise((res, rej) => out.end((e) => (e ? rej(e) : res())));
      if (size && got !== size) throw new Error(`download incomplete (${got} of ${size} bytes)`);
      await fsp.rename(part, dest);
      return got;
    } catch (e) {
      last = e;
      if (got && onBytes) onBytes(-got);
      await fsp.rm(part, { force: true });
      if (signal && signal.aborted) throw e;
      await new Promise((res) => setTimeout(res, 1000 * (attempt + 1)));
    }
  }
  throw last;
}

/**
 * The file in ranges, par.streams at a time, each written where it goes. Null: the server does not send ranges (the
 * caller fetches it in one piece). Each range is tried four times; a link refused is renewed once per refusal.
 */
async function inRanges(link, dest, { size, onBytes, signal, renew, par }) {
  const part = `${dest}.${process.pid}.${Date.now()}.part`;
  const fh = await fsp.open(part, "w");
  const ranges = [];
  for (let a = 0; a < size; a += par.chunk) ranges.push([a, Math.min(size, a + par.chunk) - 1]);
  let ok = false;
  const one = async ([a, b], first) => {
    let last;
    for (let attempt = 0; attempt < 4; attempt++) {
      const was = { ...link };
      let pos = a;
      try {
        const r = await fetch(was.url, { headers: { ...was.headers, range: `bytes=${a}-${b}` }, signal });
        // No ranges (200), or anything odd on the first: fetched in one piece instead.
        if (first && r.status !== 206 && !refused(r.status)) { await r.body?.cancel().catch(() => {}); return false; }
        if (r.status !== 206 || !r.body) {
          await r.body?.cancel().catch(() => {});
          if (refused(r.status) && (await renew(was))) { attempt--; throw new Error(`download refused (${r.status})`); }
          throw new Error(`download failed (${r.status})`);
        }
        const cr = /bytes (\d+)-(\d+)\/(\d+|\*)/.exec(r.headers.get("content-range") || "");
        if (!cr || Number(cr[1]) !== a || Number(cr[2]) !== b || (cr[3] !== "*" && Number(cr[3]) !== size)) {
          await r.body.cancel().catch(() => {});
          if (first) return false; // not the file it said it was, or not the range asked: fetched in one piece
          throw new Error("download range mismatch");
        }
        for await (const c of r.body) {
          if (pos + c.length > b + 1) throw new Error("download range overran");
          await fh.write(c, 0, c.length, pos);
          pos += c.length; if (onBytes) onBytes(c.length);
        }
        if (pos !== b + 1) throw new Error(`download incomplete (${pos - a} of ${b + 1 - a} bytes)`);
        return true;
      } catch (e) {
        last = e;
        if (pos > a && onBytes) onBytes(-(pos - a));
        if (signal && signal.aborted) throw e;
        await new Promise((res) => setTimeout(res, 1000 * (attempt + 1)));
      }
    }
    throw last;
  };
  try {
    // The first range alone: it says whether the server sends ranges at all.
    if (!(await one(ranges[0], true))) return null;
    let next = 1, failed = null;
    const worker = async () => { while (!failed && next < ranges.length) { const r = ranges[next++]; try { await one(r, false); } catch (e) { failed = failed || e; } } };
    await Promise.all(Array.from({ length: Math.min(par.streams, ranges.length - 1) }, worker));
    if (failed) throw failed;
    await fh.close();
    if ((await fsp.stat(part)).size !== size) throw new Error("download incomplete");
    await fsp.rename(part, dest);
    ok = true;
    return size;
  } finally {
    if (!ok) { await fh.close().catch(() => {}); await fsp.rm(part, { force: true }); }
  }
}

/** Uploads a file to a signed link with a PUT (its length set: storage refuses a stream without one). */
function putOnce(url, file, type, onBytes, signal) {
  return new Promise((resolve, reject) => {
    const size = fs.statSync(file).size;
    const u = new URL(url);
    const req = (u.protocol === "http:" ? http : https).request(u, { method: "PUT", headers: { "content-type": type, "content-length": size }, signal }, (res) => {
      let text = ""; res.on("data", (c) => { if (text.length < 2000) text += c; });
      res.on("end", () => (res.statusCode >= 200 && res.statusCode < 300 ? resolve(size) : reject(Object.assign(new Error(`upload failed (${res.statusCode}): ${text.slice(0, 300)}`), { status: res.statusCode }))));
    });
    req.on("error", reject);
    const rs = fs.createReadStream(file);
    rs.on("data", (c) => onBytes && onBytes(c.length));
    rs.on("error", reject);
    rs.pipe(req);
  });
}
async function upload(url, file, type, onBytes, signal) {
  for (let attempt = 0; ; attempt++) {
    try { return await putOnce(url, file, type, onBytes, signal); }
    catch (e) { if ((signal && signal.aborted) || attempt >= 2 || (e.status && e.status < 500)) throw e; await new Promise((r) => setTimeout(r, 1500 * (attempt + 1))); }
  }
}

/**
 * A file in the cache by its key (cache: the storage key and version; keep: an original in the user's Google Drive, by
 * its file, size and when it last changed): fetched once, then linked into each render.
 */
async function cached(cacheDir, input, onBytes, signal) {
  const dir = path.join(cacheDir, "media");
  await fsp.mkdir(dir, { recursive: true });
  const file = path.join(dir, crypto.createHash("sha256").update(String(input.cache || input.keep)).digest("hex"));
  const st = await fsp.stat(file).catch(() => null);
  if (st && (!input.size || st.size === input.size)) { const now = new Date(); await fsp.utimes(file, now, now).catch(() => {}); onBytes && onBytes(input.size || st.size); return file; }
  await download(input.url, file, { headers: input.headers, size: input.size, onBytes, signal, relink: input.relink });
  return file;
}

/** The cache kept under capBytes: the least recently used footage goes first. */
async function trimCache(cacheDir, capBytes) {
  const dir = path.join(cacheDir, "media");
  const names = await fsp.readdir(dir).catch(() => []);
  const files = (await Promise.all(names.filter((n) => !n.endsWith(".part")).map(async (n) => { const p = path.join(dir, n); const s = await fsp.stat(p).catch(() => null); return s && { p, size: s.size, at: s.mtimeMs }; }))).filter(Boolean);
  let total = files.reduce((a, f) => a + f.size, 0);
  for (const f of files.sort((a, b) => a.at - b.at)) { if (total <= capBytes) break; await fsp.rm(f.p, { force: true }); total -= f.size; }
}

/** One FFmpeg run in the render's folder; onSeconds: its output time (from -progress). Frozen too long: stopped. */
function runFfmpeg(ffmpeg, args, { cwd, onSeconds, signal, stallSec = 120 }) {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpeg, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let err = "", moved = Date.now(), at = -1, froze = false;
    const kill = () => { try { p.kill("SIGKILL"); } catch { /* gone */ } };
    if (signal) signal.addEventListener("abort", kill, { once: true });
    const watches = args.includes("-progress");
    const watch = watches ? setInterval(() => { if (Date.now() - moved > stallSec * 1000) { froze = true; kill(); } }, 5000) : null;
    p.stdout.on("data", (d) => { for (const m of String(d).matchAll(/out_time_(?:us|ms)=(\d+)/g)) { const s = Number(m[1]) / 1e6; if (s > at) { at = s; moved = Date.now(); } if (onSeconds) onSeconds(s); } });
    p.stderr.on("data", (d) => { if (err.length < 60000) err += d; });
    p.on("error", (e) => { if (watch) clearInterval(watch); reject(e); });
    p.on("close", (code, sig) => {
      if (watch) clearInterval(watch);
      if (signal) signal.removeEventListener("abort", kill);
      if (signal && signal.aborted) return reject(Object.assign(new Error("stopped"), { stopped: true }));
      if (froze) return reject(new Error(`FFmpeg froze at ${Math.max(0, at).toFixed(1)} s`));
      if (code === 0) return resolve();
      // Ended by a signal it was not sent here: the system stopped it (macOS and Windows end the biggest program when
      // memory runs out). It said "FFmpeg failed (null)" before.
      if (code == null) return reject(Object.assign(new Error(`FFmpeg was stopped by the system (${sig || "a signal"}) at ${Math.max(0, at).toFixed(1)} s, most likely out of memory`), { killed: true }));
      reject(new Error(`FFmpeg failed (${code}): ${err.length > 1500 ? `${err.slice(0, 900)} … ${err.slice(-600)}` : err}`.trim()));
    });
  });
}

/** The FFmpeg's major version (7, 9...), read once per binary. */
const majors = new Map();
function ffmpegMajor(ffmpeg) {
  if (!majors.has(ffmpeg)) majors.set(ffmpeg, new Promise((resolve) => execFile(ffmpeg, ["-hide_banner", "-version"], { timeout: 15000 }, (_e, so) => resolve(Number((String(so || "").match(/ffmpeg version n?(\d+)/) || [])[1] || 0)))));
  return majors.get(ffmpeg);
}

/**
 * Rendrr's runs written for the cloud's FFmpeg, said the way this Mac's FFmpeg reads them: since FFmpeg 7 a graph comes
 * from a file with "-/filter_complex" (FFmpeg 9 no longer has "-filter_complex_script").
 */
function adaptArgs(args, major) {
  if (major < 7) return args;
  return args.map((a) => (a === "-filter_complex_script" ? "-/filter_complex" : a === "-filter_script" ? "-/filter" : a));
}

/**
 * A file put in the render's folder under its name without copying it: a symbolic link; on Windows (where those need
 * Developer Mode) a hard link, or, for a file on another drive, a copy. direct: return false instead of copying (the
 * caller then names the file by its path).
 */
async function linkInto(src, dest, { direct = false } = {}) {
  try { await fsp.symlink(src, dest, "file"); return true; } catch (e) { if (!IS_WIN) throw e; }
  try { await fsp.link(src, dest); return true; } catch { /* another drive */ }
  if (direct) return false;
  await fsp.copyFile(src, dest);
  return true;
}

/** A free name in a folder: "name.mp4", then "name (2).mp4"... */
function freeName(dir, name) {
  const ext = path.extname(name), stem = name.slice(0, name.length - ext.length);
  for (let n = 1; ; n++) { const p = path.join(dir, n === 1 ? name : `${stem} (${n})${ext}`); if (!fs.existsSync(p)) return p; }
}

/**
 * Runs a task to the end and tells Rendrr how it went. o: ffmpeg (its path), cacheDir, workDir (the render's folder
 * goes in it), saveDir (where a final is kept: Downloads), allowHttp (tests), cacheBytes, onState ({phase, frac}),
 * localFile(videoId, size): where this Mac keeps that video's original (null when it no longer has that file).
 * Rendrr may answer a report with stop (the user stopped it, or the cloud took over): it stops at once and says nothing more.
 */
async function runTask(t, o) {
  checkTask(t, { allowHttp: !!o.allowHttp });
  const ac = new AbortController();
  let stop = null, state = { phase: "download", frac: 0, cmd: 0, seconds: 0 }, sent = 0, pending = null;
  const say = (force) => {
    if (o.onState) o.onState(state);
    if (!force && Date.now() - sent < 1000) return;
    sent = Date.now();
    pending = report(t, "progress", state).then((r) => { if (r && r.stop && !stop) { stop = r.stop; ac.abort(); } });
  };
  const beat = setInterval(() => say(true), 10000); // a long step still says it is alive
  const job = await fsp.mkdtemp(path.join(o.workDir || os.tmpdir(), "rendrr-render-"));
  try {
    say(true);
    // ---- The files ----
    const total = (t.inputs || []).reduce((a, i) => a + (i.data == null ? i.size || 0 : 0), 0) + (t.fonts || []).reduce((a, f) => a + (f.size || 0), 0);
    let got = 0;
    const onBytes = (n) => { got += n; state = { ...state, phase: "download", frac: total ? Math.min(1, got / total) : 0 }; say(); };
    const direct = {}; // an original on another drive of a Windows PC: FFmpeg reads it by its path (the app knows it)
    const inflight = new Map(); // one fetch per cached file, though two inputs name it
    const fetchOne = async (i) => {
      const dest = path.join(job, i.name);
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      if (i.data != null) await fsp.writeFile(dest, Buffer.from(i.data, "base64"));
      // The original kept on this computer, read where it is (it must still be the same file).
      else if (i.local != null) {
        const file = o.localFile ? await o.localFile(String(i.local.videoId), Number(i.local.size)) : null;
        if (!file) throw new Error(`the original of this video is no longer where it was on this ${MACHINE} (moved, renamed or changed)`);
        const asArg = t.commands.some((c) => c.args.includes(i.name));
        if (!(await linkInto(file, dest, { direct: asArg }))) direct[i.name] = file;
      }
      else {
        // A link that stops working mid-way (a Google Drive sign-in lasts an hour): Rendrr gives a fresh one.
        const relink = async () => { const r = await report(t, "link", { name: i.name }); return r && linkOk(r.url, !!o.allowHttp) ? { url: r.url, headers: r.headers && r.headers.authorization ? { authorization: String(r.headers.authorization) } : {} } : null; };
        if (i.cache || (i.keep && i.size)) {
          const k = String(i.cache || i.keep);
          if (!inflight.has(k)) inflight.set(k, cached(o.cacheDir, { ...i, relink }, onBytes, ac.signal));
          await linkInto(await inflight.get(k), dest);
        }
        else await download(i.url, dest, { headers: i.headers, size: i.size, onBytes, signal: ac.signal, relink });
      }
    };
    // A few files at a time: one at a time, an edit with many clips spent most of its render waiting on each link
    // (from far away, every file costs a round trip or two before its first byte). The first failure stops the rest.
    const list = t.inputs || [];
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(FETCH_AT_ONCE, list.length) }, async () => {
      while (next < list.length) {
        if (ac.signal.aborted) throw Object.assign(new Error("stopped"), { stopped: true });
        const i = list[next++];
        try { await fetchOne(i); } catch (e) { ac.abort(); throw e; }
      }
    }));
    if ((t.fonts || []).length) {
      const fonts = path.join(o.cacheDir, "fonts");
      await fsp.mkdir(fonts, { recursive: true });
      for (const f of t.fonts) {
        const p = path.join(fonts, f.name);
        const st = await fsp.stat(p).catch(() => null);
        if (st && st.size === f.size) { onBytes(f.size); continue; }
        await download(f.url, p, { size: f.size, onBytes, signal: ac.signal });
      }
      // A Mac links the fonts folder in; Windows gets its own copy of the (small) font files.
      if (!IS_WIN) await fsp.symlink(fonts, path.join(job, "fonts"));
      else { await fsp.mkdir(path.join(job, "fonts")); for (const f of t.fonts) await fsp.copyFile(path.join(fonts, f.name), path.join(job, "fonts", f.name)); }
    }
    // ---- The runs ----
    const major = await ffmpegMajor(o.ffmpeg);
    for (const [k, c] of t.commands.entries()) {
      if (stop) break;
      let args = c.args;
      if (c.graph != null) { const g = `graph-${k}.txt`; await fsp.writeFile(path.join(job, g), c.graph); args = args.map((a) => (a === "__FILTER_SCRIPT__" ? g : a)); }
      args = adaptArgs(args, major).map((a) => direct[a] || a);
      state = { phase: "render", frac: 0, cmd: k, seconds: 0 }; say(true);
      await runFfmpeg(o.ffmpeg, args, { cwd: job, signal: ac.signal, stallSec: t.stallSec || 120, onSeconds: (s) => { state = { ...state, seconds: s, frac: c.seconds ? Math.min(1, s / c.seconds) : 0 }; say(); } });
    }
    if (stop) throw Object.assign(new Error("stopped"), { stopped: true });
    // ---- What they made ----
    const outputs = {}, upTotal = t.outputs.reduce((a, x) => a + (fs.statSync(path.join(job, x.name), { throwIfNoEntry: false })?.size || 0), 0);
    let up = 0;
    state = { phase: "upload", frac: 0, cmd: t.commands.length - 1, seconds: state.seconds }; say(true);
    let savedPath = null;
    for (const x of t.outputs) {
      const file = path.join(job, x.name);
      if (!fs.existsSync(file)) throw new Error(`FFmpeg made no ${x.name}`);
      outputs[x.name] = await upload(x.url, file, x.type, (n) => { up += n; state = { ...state, frac: upTotal ? up / upTotal : 1 }; say(); }, ac.signal);
      // A final is kept on this computer: in Downloads, under its name.
      if (x.save && o.saveDir) { savedPath = freeName(o.saveDir, x.save); await fsp.copyFile(file, savedPath); }
    }
    await pending;
    if (stop) throw Object.assign(new Error("stopped"), { stopped: true });
    const ok = await report(t, "done", { outputs, saved: savedPath ? path.basename(savedPath) : null });
    if (!ok) throw new Error("Rendrr did not take the finished render");
    return { ok: true, outputs, savedPath };
  } catch (e) {
    if (stop || e.stopped) return { ok: false, stopped: stop || "stopped" };
    const error = String((e && e.message) || e).slice(0, 480);
    await report(t, "failed", { error: `the ${MACHINE} could not render it: ${error}` });
    return { ok: false, error };
  } finally {
    clearInterval(beat);
    await fsp.rm(job, { recursive: true, force: true }).catch(() => {});
    if (o.cacheDir) await trimCache(o.cacheDir, o.cacheBytes || 20e9).catch(() => {});
  }
}

module.exports = { PROTOCOL, FEATURES, HW_ENCODERS, probeFfmpeg, probeFile, checkTask, runTask, trimCache, adaptArgs, linkInto, download };
