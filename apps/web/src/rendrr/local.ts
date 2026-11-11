/* eslint-disable @typescript-eslint/no-explicit-any */
// Footage from this computer: the raw file never leaves the browser until a full-quality export.
// The browser makes the light preview (720p proxy + 16 kHz mono audio) with ffmpeg.wasm and uploads only that.
import { enc, fail, post } from "./http";

const files = new Map<string, File>();            // videoId -> File held by this page
const handles = new Map<string, any>();           // videoId -> FileSystemFileHandle (survives reloads, Chrome/Edge)
const pendingHandles: Promise<any>[] = [];        // handles captured from the last drop, matched to files by name
const running = new Set<string>();
// Previews are made in this tab, two at a time: a whole folder of videos waits its turn instead of freezing the page.
const queue: string[] = [];
const AT_ONCE = 2;
function pump() { while (running.size < AT_ONCE && queue.length) { const id = queue.shift()!; if (files.has(id) && !running.has(id)) run(id); } }
const isBrowser = typeof window !== "undefined";

// ---------------- remembered file handles (IndexedDB) ----------------
function db(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      const r = indexedDB.open("rendrr-local", 1);
      r.onupgradeneeded = () => r.result.createObjectStore("handles");
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => resolve(null);
    } catch { resolve(null); }
  });
}
async function saveHandle(videoId: string, h: any) {
  handles.set(videoId, h);
  const d = await db(); if (!d) return;
  try { d.transaction("handles", "readwrite").objectStore("handles").put(h, videoId); } catch { /* not cloneable here */ }
}
async function loadHandles() {
  const d = await db(); if (!d) return;
  try {
    const tx = d.transaction("handles", "readonly").objectStore("handles");
    const keys: IDBValidKey[] = await new Promise((r) => { const q = tx.getAllKeys(); q.onsuccess = () => r(q.result); q.onerror = () => r([]); });
    for (const k of keys) {
      const h: any = await new Promise((r) => { const q = d.transaction("handles", "readonly").objectStore("handles").get(k); q.onsuccess = () => r(q.result); q.onerror = () => r(null); });
      if (h) handles.set(String(k), h);
    }
  } catch { /* ignore */ }
}
// Loaded once at startup so hasLocalFile() can answer synchronously.
export const handlesReady: Promise<void> = isBrowser ? loadHandles() : Promise.resolve();

// ---------------- ffmpeg.wasm (one instance, one job at a time) ----------------
const CORE = ["https://unpkg.com/@ffmpeg/core@0.12.10/dist/esm", "https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/esm"];
async function toBlobURL(url: string, type: string) {
  const r = await fetch(url);
  if (!r.ok) throw new Error("fetch " + url);
  return URL.createObjectURL(new Blob([await r.arrayBuffer()], { type }));
}
let ffP: Promise<any> | null = null;
function ffmpeg(): Promise<any> {
  if (!ffP) ffP = (async () => {
    // Served from our own origin (scripts/copy-ffmpeg.mjs) so its worker is same-origin.
    const mod = await import(/* webpackIgnore: true */ /* @vite-ignore */ ("/ffmpeg/index.js" as string));
    const ff = new mod.FFmpeg();
    let lastErr: unknown;
    for (const base of CORE) {
      try {
        await ff.load({ coreURL: await toBlobURL(`${base}/ffmpeg-core.js`, "text/javascript"), wasmURL: await toBlobURL(`${base}/ffmpeg-core.wasm`, "application/wasm") });
        return ff;
      } catch (e) { lastErr = e; }
    }
    throw lastErr;
  })().catch((e) => { ffP = null; throw e; });
  return ffP;
}
let lock: Promise<unknown> = Promise.resolve();
function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  const next = lock.then(fn, fn);
  lock = next.catch(() => {});
  return next;
}

type Info = { seconds: number; width: number; height: number; fps: number; hasAudio: boolean };
const hms = (s: string) => { const [h, m, sec] = s.split(":").map(Number); return h * 3600 + m * 60 + sec; };

async function makePreview(file: File, onPct: (p: number) => void): Promise<{ proxy: Blob; audio: Blob; info: Info }> {
  return exclusive(async () => {
    const ff = await ffmpeg();
    const dir = "/in" + Math.random().toString(36).slice(2, 7);
    await ff.createDir(dir);
    await ff.mount("WORKERFS", { files: [file] }, dir);
    const input = `${dir}/${file.name}`;
    const log: string[] = [];
    let passStart = 0, passWeight = 0, duration = 0;
    const onLog = ({ message }: { message: string }) => {
      log.push(message); if (log.length > 400) log.shift();
      const t = /time=(\d+:\d+:\d+(?:\.\d+)?)/.exec(message);
      if (t && duration > 0) onPct(Math.min(99, passStart + (hms(t[1]) / duration) * passWeight));
    };
    ff.on("log", onLog);
    try {
      // 1. Read the file's length, size and frame rate from FFmpeg's own report.
      await ff.exec(["-hide_banner", "-i", input]).catch(() => {});
      const all = log.join("\n");
      const d = /Duration: (\d+:\d+:\d+(?:\.\d+)?)/.exec(all);
      duration = d ? hms(d[1]) : 0;
      const vs = /Stream #\d+:\d+.*Video:.*?(\d{2,5})x(\d{2,5})/.exec(all);
      const fpsM = /(\d+(?:\.\d+)?) fps/.exec(all);
      const rot = /rotation of (-?\d+(?:\.\d+)?)|rotate\s*:\s*(-?\d+)/.exec(all);
      let width = vs ? Number(vs[1]) : 0, height = vs ? Number(vs[2]) : 0;
      if (rot && Math.abs(Number(rot[1] ?? rot[2])) % 180 === 90) [width, height] = [height, width];
      const hasAudio = /Stream #\d+:\d+.*Audio:/.test(all);
      if (!duration || !width) throw fail("We could not read this file. Check it plays on your computer, then add it again.");

      // 2. The 720p proxy: H.264 ~2 Mbps, keyframe every 0.5 s, constant 30 fps, SDR, AAC.
      passStart = 0; passWeight = 85;
      const scale = "scale='if(gte(iw,ih),-2,720)':'if(gte(iw,ih),720,-2)',fps=30,format=yuv420p";
      const audioIn = hasAudio ? [] : ["-f", "lavfi", "-t", String(duration), "-i", "anullsrc=r=48000:cl=stereo"];
      const code = await ff.exec(["-hide_banner", "-i", input, ...audioIn, "-map", "0:v:0", "-map", hasAudio ? "0:a:0" : "1:a:0",
        "-vf", scale, "-c:v", "libx264", "-preset", "ultrafast", "-b:v", "2000k", "-maxrate", "2500k", "-bufsize", "4000k",
        "-g", "15", "-keyint_min", "15", "-sc_threshold", "0", "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709",
        "-c:a", "aac", "-b:a", "128k", "-ac", "2", "-ar", "48000", "-shortest", "-movflags", "+faststart", "proxy.mp4"]);
      if (code !== 0) throw fail("We could not make a preview of this file. Try exporting it again as MP4, then add it.");

      // 3. 16 kHz mono audio for transcription.
      passStart = 85; passWeight = 15;
      const code2 = hasAudio
        ? await ff.exec(["-hide_banner", "-i", input, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "aac", "-b:a", "48k", "audio.m4a"])
        : await ff.exec(["-hide_banner", "-f", "lavfi", "-t", String(duration), "-i", "anullsrc=r=16000:cl=mono", "-c:a", "aac", "-b:a", "32k", "audio.m4a"]);
      if (code2 !== 0) throw fail("We could not read the sound in this file.");
      const proxy = new Blob([await ff.readFile("proxy.mp4")], { type: "video/mp4" });
      const audio = new Blob([await ff.readFile("audio.m4a")], { type: "audio/mp4" });
      return { proxy, audio, info: { seconds: duration, width, height, fps: fpsM ? Number(fpsM[1]) : 30, hasAudio } };
    } finally {
      ff.off("log", onLog);
      for (const f of ["proxy.mp4", "audio.m4a"]) await ff.deleteFile(f).catch(() => {});
      await ff.unmount(dir).catch(() => {});
      await ff.deleteDir(dir).catch(() => {});
    }
  });
}

// The length of a video file: the browser's own reading of it (only its header), else FFmpeg's report. Null if neither can.
function browserLength(file: File): Promise<number | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const v = document.createElement("video");
    const done = (d: number | null) => { clearTimeout(t); v.removeAttribute("src"); v.load(); URL.revokeObjectURL(url); resolve(d); };
    const t = setTimeout(() => done(null), 15000);
    v.preload = "metadata"; v.muted = true;
    v.onloadedmetadata = () => done(Number.isFinite(v.duration) && v.duration > 0 ? v.duration : null);
    v.onerror = () => done(null);
    v.src = url;
  });
}
function ffmpegLength(file: File): Promise<number | null> {
  return exclusive(async () => {
    const ff = await ffmpeg();
    const dir = "/len" + Math.random().toString(36).slice(2, 7);
    const log: string[] = [];
    const onLog = ({ message }: { message: string }) => { log.push(message); };
    await ff.createDir(dir);
    await ff.mount("WORKERFS", { files: [file] }, dir);
    ff.on("log", onLog);
    try {
      await ff.exec(["-hide_banner", "-i", `${dir}/${file.name}`]).catch(() => {});
      const d = /Duration: (\d+:\d+:\d+(?:\.\d+)?)/.exec(log.join("\n"));
      return d ? hms(d[1]) : null;
    } finally {
      ff.off("log", onLog);
      await ff.unmount(dir).catch(() => {});
      await ff.deleteDir(dir).catch(() => {});
    }
  }).catch(() => null);
}
export async function fileLength(file: File): Promise<number | null> {
  return (await browserLength(file)) ?? (await ffmpegLength(file));
}

// ---------------- uploads ----------------
function put(url: string, body: Blob, contentType: string | null, onLoaded: (n: number) => void): Promise<XMLHttpRequest> {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open("PUT", url);
    if (contentType) x.setRequestHeader("content-type", contentType);
    x.upload.onprogress = (e) => onLoaded(e.loaded);
    x.onload = () => (x.status >= 200 && x.status < 300 ? resolve(x) : reject(fail("The upload did not finish. Check your connection and try again.", "upload")));
    x.onerror = () => reject(fail("The upload did not finish. Check your connection and try again.", "upload"));
    x.send(body);
  });
}

// At most one progress report per interval, and progress within a stage never goes backwards.
function throttle(fn: (status: string, pct: number) => Promise<unknown>, ms = 1200) {
  let last = 0, stage = "", best = 0;
  return (status: string, pct: number, force = false) => {
    if (status !== stage) { stage = status; best = 0; }
    best = Math.max(best, Math.round(pct));
    const now = Date.now();
    if (!force && now - last < ms) return;
    last = now;
    fn(status, best).catch(() => {});
  };
}

async function run(videoId: string) {
  const file = files.get(videoId);
  if (!file || running.has(videoId)) return;
  running.add(videoId);
  const report = throttle((status, progress) => post(`/videos/${enc(videoId)}/local/progress`, { status, progress }));
  try {
    report("previewing", 1, true);
    const { proxy, audio, info } = await makePreview(file, (p) => report("previewing", p));
    report("previewing", 100, true);
    const urls = await post(`/videos/${enc(videoId)}/local/upload-urls`);
    const total = proxy.size + audio.size;
    let a = 0, b = 0;
    const tick = () => report("uploading", ((a + b) / total) * 100);
    await Promise.all([
      put(urls.proxy.url, proxy, urls.proxy.contentType, (n) => { a = n; tick(); }),
      put(urls.audio.url, audio, urls.audio.contentType, (n) => { b = n; tick(); }),
    ]);
    await post(`/videos/${enc(videoId)}/local/complete`, { seconds: info.seconds, width: info.width, height: info.height, fps: info.fps, proxySize: proxy.size, audioSize: audio.size });
  } catch (e: any) {
    const msg = e?.friendly ? e.message : "We could not read this file. Check it plays on your computer, then add it again.";
    await post(`/videos/${enc(videoId)}/local/progress`, { status: "failed", error: msg }).catch(() => {});
  } finally {
    running.delete(videoId);
    window.dispatchEvent(new Event("rendrr:library"));
    pump();
  }
}

// The plain file input works in every browser. (Dropped files still give us a handle that survives reloads.)
function pickFile(): Promise<{ file: File; handle?: any }> {
  return new Promise((resolve, reject) => {
    const i = document.createElement("input");
    i.type = "file"; i.accept = "video/*"; i.style.display = "none";
    const done = (f?: File) => { i.remove(); f ? resolve({ file: f }) : reject(fail("Pick the original file to continue.", "need-original")); };
    i.onchange = () => done(i.files?.[0]);
    i.addEventListener("cancel", () => done());
    document.body.appendChild(i);
    i.click();
  });
}

// ---------- a whole folder from the computer ----------
export { isVideoFile, folderOfFile } from "./localPick";
/** Files from a drop, folders included (walked all the way down). Call it inside the drop event: the browser only
 *  lets the folder be read from there; the reading itself finishes afterwards. Plain files come back as they are. */
export function filesFromDrop(dt: DataTransfer | null | undefined): Promise<File[]> {
  const entries = Array.from(dt?.items || []).map((it) => (it.kind === "file" ? (it as any).webkitGetAsEntry?.() : null)).filter(Boolean);
  if (!entries.some((e: any) => e.isDirectory)) return Promise.resolve(Array.from(dt?.files || []));
  const out: File[] = [];
  const readAll = (dir: any): Promise<any[]> => new Promise((resolve) => {
    const r = dir.createReader(), all: any[] = [];
    const next = () => r.readEntries((batch: any[]) => { if (!batch.length) resolve(all); else { all.push(...batch); next(); } }, () => resolve(all));
    next();
  });
  const walk = async (e: any, path: string): Promise<void> => {
    if (e.isFile) { const f: File = await new Promise((res, rej) => e.file(res, rej)); (f as any).rendrrFolder = path; out.push(f); return; }
    if (e.isDirectory) { const p = path ? `${path}/${e.name}` : e.name; for (const c of await readAll(e)) await walk(c, p); }
  };
  return Promise.all(entries.map((e: any) => walk(e, ""))).then(() => out);
}

/**
 * In the Rendrr Mac app: the original stays on this Mac. The app remembers where the file is and reads what it is;
 * Rendrr is told (its size, picture and sound), so a final made on this Mac reads it there and it is never uploaded.
 */
function keepOnMac(videoId: string, file: File) {
  const d = isBrowser ? (window as any).rendrrDesktop : null;
  if (!d?.keepOriginal) return;
  d.keepOriginal(videoId, file)
    .then((info: any) => (info ? post(`/videos/${enc(videoId)}/mac-original`, { device: d.device || "", ...info }) : null))
    .catch(() => { /* an older server or a file the app cannot read: the original is asked for once, as before */ });
}

export const localJobs = {
  /** Call synchronously inside a drop event: remembers file handles where the browser offers them. */
  capture(dt: DataTransfer | null | undefined) {
    pendingHandles.length = 0;
    if (!dt?.items) return;
    for (const it of Array.from(dt.items)) {
      const get = (it as any).getAsFileSystemHandle;
      if (it.kind === "file" && typeof get === "function") pendingHandles.push(get.call(it).catch(() => null));
    }
  },
  hold(videoId: string, file: File) {
    files.set(videoId, file);
    keepOnMac(videoId, file);
    Promise.all(pendingHandles).then((hs) => { const h = hs.find((x) => x && x.name === file.name); if (h) saveHandle(videoId, h); });
  },
  has: (videoId: string) => files.has(videoId) || handles.has(videoId),
  file: (videoId: string) => files.get(videoId) || null,
  /** A video file's length in seconds (null when it can't be read). */
  length: (file: File) => fileLength(file),
  running: () => Array.from(running),
  start(videoId: string) { if (files.has(videoId) && !running.has(videoId) && !queue.includes(videoId)) { queue.push(videoId); pump(); } },
  waiting: (videoId: string) => queue.includes(videoId),
  /** Makes sure this page holds the file: remembered handle (asks permission) or a picker. Call from a click. */
  async ensureFile(videoId: string, expectedName?: string) {
    if (files.has(videoId)) return files.get(videoId)!;
    const h = handles.get(videoId);
    if (h) {
      try {
        let perm = await h.queryPermission?.({ mode: "read" });
        if (perm !== "granted") perm = await h.requestPermission?.({ mode: "read" });
        if (perm === "granted") { const f = await h.getFile(); files.set(videoId, f); return f; }
      } catch { /* fall through to the picker */ }
    }
    const { file, handle } = await pickFile();
    if (expectedName && file.name !== expectedName) throw fail(`That is not the same file. We need '${expectedName}'.`);
    files.set(videoId, file);
    keepOnMac(videoId, file);
    if (handle) saveHandle(videoId, handle);
    return file;
  },
  /** Multipart upload of an original, 3 parts at a time, with retries. Returns the parts for the complete call. */
  async uploadParts(file: File, urls: string[], partSize: number, onPct: (pct: number) => void, signal?: AbortSignal) {
    const loaded = new Array(urls.length).fill(0);
    const parts: { PartNumber: number; ETag: string }[] = [];
    let next = 0;
    const report = () => onPct((loaded.reduce((a, b) => a + b, 0) / file.size) * 100);
    const worker = async () => {
      while (next < urls.length) {
        if (signal?.aborted) throw fail("You stopped this export.", "stopped"); // no new part after Stop
        const i = next++;
        const blob = file.slice(i * partSize, Math.min(file.size, (i + 1) * partSize));
        let lastErr: unknown;
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            const x = await put(urls[i], blob, null, (n) => { loaded[i] = n; report(); });
            const etag = x.getResponseHeader("ETag") || x.getResponseHeader("etag");
            if (!etag) throw fail("The storage did not confirm the upload. Try again.", "upload");
            parts.push({ PartNumber: i + 1, ETag: etag.replace(/^"?/, '"').replace(/"?$/, '"') });
            lastErr = null;
            break;
          } catch (e) { lastErr = e; loaded[i] = 0; }
        }
        if (lastErr) throw lastErr;
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    return parts.sort((a, b) => a.PartNumber - b.PartNumber);
  },
};
