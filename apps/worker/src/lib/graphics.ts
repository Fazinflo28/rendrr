import { clearVariantError, downloadFile, getBytes, graphicVariant, headObject, queue, readGraphic, setVariantWarnings, signGet, uploadFile, type GraphicVariant } from "@rendrr/core";
import { prisma } from "@rendrr/db";
import { findTemplate, graphicDefaults, GRAPHIC_FONT_WATCH, PREFIX, templateHtml, templateSize, withClock, withEarly, withParams, wrapGraphicHtml, type V3Clip } from "@rendrr/shared";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { availableParallelism, totalmem } from "node:os";
import { join } from "node:path";
import { PNG } from "pngjs";
import puppeteer, { type Browser, type CDPSession, type Page } from "puppeteer-core";
import { cpuBudget, JobError, run } from "./ffmpeg";

/** Threads this container may start (cgroup pids.max; it counts threads). */
function threadBudget() {
  try { const v = readFileSync("/sys/fs/cgroup/pids.max", "utf8").trim(); if (v !== "max" && Number(v) > 0) return Number(v); } catch { /* no limit */ }
  return Infinity;
}
/**
 * The thread limit (1000 on Railway) is shared by every job. A recording browser costs about 100 threads with its
 * encoder (Chromium about 80: it sizes its pools by the host's CPUs, not the container's; the VP9 encoder about 10
 * at encodePiece's caps). 500 are kept for the rest of the worker: a render's FFmpeg starts hundreds.
 */
const THREADS_KEPT = 500, THREADS_PER_BROWSER = 100;
/** Browsers this worker runs at once, across every job (graphics, tests, a render's graphics, snapshots). */
export const BROWSER_SLOTS = Math.max(1, Math.floor(Number(process.env.BROWSER_SLOTS)) || Math.min(8, Math.floor((threadBudget() - THREADS_KEPT) / THREADS_PER_BROWSER)));
/**
 * Browsers recording one graphic at once: one CPU each, one CPU left for the rest of the worker, and one slot left
 * so a test or a snapshot is not held up by a long recording.
 */
export const GRAPHIC_WORKERS = Math.max(1, Math.min(6, Math.floor(Number(process.env.GRAPHIC_WORKERS)) || Math.min(cpuBudget() - 1, BROWSER_SLOTS - 1)));

let freeSlots = BROWSER_SLOTS;
/**
 * Takes up to `want` browser slots: waits for one, and up to 5 s for `want` (a test or a snapshot gives its slots
 * back in seconds), then takes what is free. A recording that takes fewer runs fewer browsers. giveBrowsers returns
 * them.
 */
async function takeBrowsers(want: number, signal?: AbortSignal): Promise<number> {
  want = Math.max(1, Math.min(want, BROWSER_SLOTS));
  const patient = Date.now() + 5_000;
  while (freeSlots < want && (freeSlots < 1 || Date.now() < patient)) {
    if (signal?.aborted) throw new JobError("Stopped.");
    // Kept browsers hold slots: when too few are free, one is closed for its slot (else it is reused: browserFor).
    if (idle.length && (await closeOneIdle())) continue;
    await new Promise((r) => setTimeout(r, 200));
  }
  const n = Math.min(want, freeSlots);
  freeSlots -= n;
  return n;
}
const giveBrowsers = (n: number) => { freeSlots += n; };

/**
 * Browsers kept for the next recording (starting Chromium takes a second, and starting many at once is what fails on
 * a busy worker): a browser a recording ended with cleanly, its pages closed, kept a minute. Each keeps a browser slot
 * while it waits; a recording that needs slots takes it (reused) or closes it (its slot freed).
 */
const idle: { b: Browser; uses: number; born: number; timer: NodeJS.Timeout }[] = [];
const IDLE_MS = 60_000, MAX_USES = 20, MAX_AGE_MS = 10 * 60_000;
const uses = new WeakMap<Browser, { uses: number; born: number }>();
/** A kept browser, its slot given to the recording that takes it (null: none kept). */
function reuseBrowser(): Browser | null {
  while (idle.length) {
    const x = idle.pop()!;
    clearTimeout(x.timer);
    freeSlots += 1; // its slot back: the recording's own slot covers it now
    if (x.b.connected) return x.b;
    killBrowser(x.b);
  }
  return null;
}
/** A browser a recording is done with: kept if it is healthy, young and a slot is free for it; else closed. */
async function keepOrClose(b: Browser) {
  const u = uses.get(b) ?? { uses: 0, born: Date.now() };
  if (!b.connected || u.uses >= MAX_USES || Date.now() - u.born > MAX_AGE_MS || freeSlots < 1 || idle.length >= GRAPHIC_WORKERS) return closeBrowser(b);
  try { for (const pg of await b.pages()) await pg.close().catch(() => {}); } catch { return closeBrowser(b); }
  freeSlots -= 1;
  const x = { b, uses: u.uses, born: u.born, timer: setTimeout(() => { const i = idle.indexOf(x); if (i >= 0) { idle.splice(i, 1); freeSlots += 1; void closeBrowser(b); } }, IDLE_MS) };
  x.timer.unref?.();
  idle.push(x);
}
/** A kept browser closed to free its slot for someone waiting. */
async function closeOneIdle() {
  const x = idle.shift();
  if (!x) return false;
  clearTimeout(x.timer);
  freeSlots += 1;
  await closeBrowser(x.b);
  return true;
}
/** A browser for a recording: a kept one, else a new one. */
async function browserFor(): Promise<Browser> {
  const b = reuseBrowser() ?? (await launchLocked());
  const u = uses.get(b) ?? { uses: 0, born: Date.now() };
  u.uses++;
  uses.set(b, u);
  return b;
}

/**
 * Recordings at once in this worker (graphics, placements a render records, tests): the rest wait their turn, in the
 * order they came. Each recording runs its own browsers (up to GRAPHIC_WORKERS) within the browser slots.
 */
export const RECORD_SLOTS = Math.max(1, Math.floor(Number(process.env.RECORD_SLOTS)) || 2);
let recording = 0;
const recordQueue: (() => void)[] = [];
async function takeRecording(signal?: AbortSignal) {
  while (recording >= RECORD_SLOTS) {
    if (signal?.aborted) throw new JobError("Stopped.");
    await new Promise<void>((r) => { recordQueue.push(r); setTimeout(r, 1000); });
  }
  recording++;
}
const giveRecording = () => { recording--; recordQueue.shift()?.(); };
/** Recordings running now, and waiting (tests). */
export const recordingsNow = () => ({ running: recording, waiting: recordQueue.length });
/** Browser slots free now, kept browsers counted as free (tests). */
export const freeBrowserSlots = () => freeSlots + idle.length;
/** Every kept browser closed (shutdown, tests). */
export async function closeIdleBrowsers() { while (idle.length) await closeOneIdle(); }

/** The container could not start another process or thread. */
const threadsGone = (e: unknown) => /EAGAIN|Resource temporarily unavailable|pthread_create/.test(String((e as Error)?.message ?? e));
const busyError = () => new JobError("The server is too busy to record graphics right now (it ran out of threads). Try again in a minute.", "busy", true);

/** Kills a browser and every process it started (puppeteer starts each browser as its own process group). */
function killBrowser(b: Browser) {
  const p = b.process();
  if (!p?.pid || p.exitCode !== null || p.signalCode !== null) return;
  try { process.kill(-p.pid, "SIGKILL"); } catch { try { p.kill("SIGKILL"); } catch { /* gone */ } }
}
/** Closes a browser, and kills it if it has not closed within 5 s. */
async function closeBrowser(b: Browser) {
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([b.close(), new Promise((r) => { timer = setTimeout(r, 5_000); })]).catch(() => {});
  clearTimeout(timer);
  killBrowser(b);
}

/**
 * Up to `exactSeconds` a graphic is recorded on every frame; longer ones (up to 4 hours: a whole video) are sampled,
 * see recordHtml. Always 30 fps. maxMs caps the recording time of any one graphic.
 */
export const GRAPHIC_LIMITS = { maxSeconds: 4 * 3600, exactSeconds: 15, maxLong: 1920, maxShort: 1080, fps: 30, maxMs: 25 * 60_000 };
/** Measured per CPU: about 90 ms to draw and capture a 1080x1920 frame and 20 ms to encode it; smaller is cheaper. */
const frameCostMs = (w: number, h: number) => 40 + (130 * w * h) / (1080 * 1920);
/** The time limit for recording a graphic: enough for one that moves on every frame, spread over GRAPHIC_WORKERS. */
export const recordLimitMs = (seconds: number, w = 1080, h = 1920) =>
  Math.min(GRAPHIC_LIMITS.maxMs, 90_000 + Math.round((Math.max(0.5, seconds) * GRAPHIC_LIMITS.fps * frameCostMs(w, h)) / GRAPHIC_WORKERS));

function chromiumPath() {
  const c = [process.env.CHROMIUM_PATH, "/usr/bin/chromium", "/usr/bin/chromium-browser", "/opt/pw-browsers/chromium-1194/chrome-linux/chrome"].filter(Boolean) as string[];
  const p = c.find((x) => existsSync(x));
  if (!p) throw new JobError("The graphics renderer is not installed on this server.", "no-chromium", false);
  return p;
}

/**
 * A headless Chromium with no network: every request but data: is blocked, WebRTC too, and memory is capped. Out of
 * threads, it says the server is busy. Each one needs a browser slot (takeBrowsers).
 */
async function launchLocked() {
  // Waits longer than puppeteer's 30 s (a busy worker starts Chromium slowly) and lets one call take 5 min.
  return puppeteer.launch({
    executablePath: chromiumPath(), headless: true, timeout: 90_000, protocolTimeout: 300_000,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--mute-audio", "--no-first-run", "--disable-extensions", "--disable-background-networking",
      "--disable-crash-reporter", "--disable-breakpad", // no crash handler process (more threads, and its fork fails first when they run out)
      "--proxy-server=127.0.0.1:9", "--proxy-bypass-list=<-loopback>", "--host-resolver-rules=MAP * ~NOTFOUND",
      "--webrtc-ip-handling-policy=disable_non_proxied_udp", // WebRTC would otherwise send UDP around the proxy
      "--js-flags=--max-old-space-size=256", "--renderer-process-limit=1",
      // A long graphic is recorded with two pages; without these the one in the background stops drawing for seconds.
      "--disable-renderer-backgrounding", "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows",
      // Every capture shows the page as the clock left it: animations are not run on the compositor thread (whose
      // picture can lag the clock by a frame or two), and images are decoded before they are drawn.
      "--disable-threaded-animation", "--disable-threaded-scrolling", "--disable-checker-imaging"],
  }).catch((e) => { throw threadsGone(e) ? busyError() : e; });
}

/** The graphic loaded in a page at w x h with the virtual clock, fonts ready (every @font-face loaded before the first
 *  frame, so nothing draws with a fallback while a font loads), the font watch, transparent when asked. */
/** A new page: puppeteer waits 30 s for it (not settable); a busy worker can take longer, so up to three times. */
async function newPage(browser: Browser) {
  for (let i = 0; ; i++) {
    try { return await browser.newPage(); }
    catch (e) {
      if (i >= 2 || !/Timed out after waiting/i.test(String((e as Error)?.message)) || !browser.connected) throw e;
      console.warn(`[graphic] a new page took over 30 s; waiting for it again (${i + 1} of 2)`);
    }
  }
}
async function openGraphicPage(browser: Browser, html: string, w: number, h: number, transparent: boolean, errors: string[]) {
  const page = await newPage(browser);
  await page.setViewport({ width: w, height: h, deviceScaleFactor: 1 });
  await page.setRequestInterception(true);
  page.on("request", (req) => { const u = req.url(); if (u.startsWith("data:") || u === "about:blank") req.continue(); else req.abort("blockedbyclient"); });
  page.on("pageerror", (e) => errors.push(String((e as Error).message || e).slice(0, 300)));
  await page.setContent(withClock(wrapGraphicHtml(html, w, h), GRAPHIC_FONT_WATCH), { waitUntil: "load", timeout: 15_000 });
  await page.evaluate("Promise.all([...document.fonts].map((f) => f.load().catch(() => null))).then(() => document.fonts.ready)");
  const cdp = await page.createCDPSession();
  if (transparent) await cdp.send("Emulation.setDefaultBackgroundColorOverride", { color: { r: 0, g: 0, b: 0, a: 0 } });
  // The graphic says renderFrame(t) draws the whole frame from t alone: frames not captured can skip it.
  const pure = await page.evaluate(() => (window as unknown as { renderFramePure?: unknown }).renderFramePure === true);
  return { page, cdp, pure };
}
type GPage = Awaited<ReturnType<typeof openGraphicPage>>;

/**
 * Moves the page's clock through frames from..to (inclusive), one frame at a time, in one call. renderFrame runs on
 * each of them, unless the graphic declared it pure: then only on the last one when `drawLast` (it is captured next).
 */
async function stepTo(g: GPage, from: number, to: number, drawLast = true) {
  if (to < from) return;
  await g.page.evaluate((a, b, fps, pure, last) => {
    const adv = (window as unknown as { __rendrrAdvance: (t: number, draw?: boolean) => void }).__rendrrAdvance;
    for (let f = a; f <= b; f++) adv(f / fps, !pure || (last && f === b));
  }, from, to, GRAPHIC_LIMITS.fps, g.pure, drawLast);
}
/** The picture now, as PNG bytes; `scale` < 1 draws a smaller one (cheaper, for spotting changes). */
async function shoot(g: GPage, w: number, h: number, scale = 1): Promise<Buffer> {
  const shot = await g.cdp.send("Page.captureScreenshot", { format: "png", optimizeForSpeed: true, captureBeyondViewport: false, ...(scale < 1 ? { clip: { x: 0, y: 0, width: w, height: h, scale } } : {}) });
  return Buffer.from(shot.data, "base64");
}

/**
 * One picture of a page at a time (a library item's preview frame, a sheet of icons), drawn as the recorder draws:
 * the locked browser, the virtual clock stepped frame by frame to `at`. PNG bytes and any errors the page threw.
 */
export async function snapshotHtml(html: string, o: { width: number; height: number; at: number; transparent?: boolean }): Promise<{ png: Buffer; errors: string[] }> {
  await takeBrowsers(1);
  let browser: Browser | null = null;
  const errors: string[] = [];
  try {
    browser = await launchLocked();
    const g = await openGraphicPage(browser, html, o.width, o.height, !!o.transparent, errors);
    await stepTo(g, 0, Math.max(0, Math.round(o.at * GRAPHIC_LIMITS.fps)));
    return { png: await shoot(g, o.width, o.height), errors };
  } finally {
    if (browser) await closeBrowser(browser);
    giveBrowsers(1);
  }
}

/** How many pixels differ between two pictures of the same size (any channel by more than 2 levels). */
export function changedPixels(a: Buffer, b: Buffer): number {
  if (a.equals(b)) return 0;
  const x = PNG.sync.read(a).data, y = PNG.sync.read(b).data;
  return changedIn(x, y);
}
function changedIn(x: Uint8Array, y: Uint8Array) {
  if (x.length !== y.length) return Infinity;
  let n = 0;
  for (let i = 0; i < x.length; i += 4) {
    if (Math.abs(x[i] - y[i]) > 2 || Math.abs(x[i + 1] - y[i + 1]) > 2 || Math.abs(x[i + 2] - y[i + 2]) > 2 || Math.abs(x[i + 3] - y[i + 3]) > 2) n++;
  }
  return n;
}

type Piece = { file: string; start: number; end: number };
const CHUNK = 90; // pictures per encoded piece: encoding keeps pace with capturing, and few PNGs sit on disk
/** A recording chunk: at most 90 s of the graphic (Engine Part 5: long graphics in chunks of 60-90 s). */
const CHUNK_FRAMES = 90 * 30;
/** Memory this container may use (cgroup memory.max, else the machine's). */
function memoryBudget() {
  try { const v = readFileSync("/sys/fs/cgroup/memory.max", "utf8").trim(); if (v !== "max" && Number(v) > 0) return Number(v); } catch { /* no cgroup v2 limit */ }
  return totalmem();
}
/** Pieces that may encode at once: what memory allows after the browsers (about 0.5 GB each) and 1.5 GB for the rest
 *  of the worker (a render may run too), at about 0.9 GB per encoder at 1080x1920 (less when smaller); 1 to `workers`. */
function encodeSlots(w: number, h: number, workers: number) {
  const per = 0.25e9 + (0.65e9 * w * h) / (1080 * 1920);
  return Math.max(1, Math.min(workers, Math.floor((memoryBudget() - 1.5e9 - workers * 0.5e9) / per)));
}

/**
 * Records HTML into a transparent WebM in locked headless Chromiums: no network (every request except data: is
 * blocked), a memory cap, max 1080x1920 (or 1920x1080), 30 fps, and time limits that fail loudly.
 *
 * Up to 15 s every frame is captured. A longer graphic is first scanned (in parallel): a quarter-size picture every
 * 0.5 s says which half seconds change. No change: the frame is held. A small change (under 0.2% of the pixels): the
 * full picture from that moment. A bigger change: every frame of that half second. The scan gives the cost before any
 * recording: over the limit, it fails at once and says why. Then the frames to capture are split into lanes with
 * the same amount of work, one browser each, and each lane into chunks of at most 90 s, recorded in order (a chunk
 * that crashes is recorded again once on a fresh page). A lane's page steps its clock frame by frame from 0, so timers,
 * transitions and JS state arrive as if playing; renderFrame runs on every frame unless the graphic sets
 * window.renderFramePure = true (it draws the whole frame from t alone), then only on captured frames. Pictures are
 * encoded in pieces as they come (variable frame rate: each keeps its own time) and joined, so the file is exactly as
 * long as the graphic. Missed: something that appears and goes within one half second of an otherwise still graphic.
 */
export async function recordHtml(html: string, o: { width: number; height: number; durationSec: number; transparent: boolean; dir: string; signal?: AbortSignal; onProgress?: (frac: number) => void; workers?: number; maxMs?: number }) {
  // One of RECORD_SLOTS recordings at once in this worker; the others wait their turn.
  await takeRecording(o.signal);
  try { return await recordNow(html, o); } finally { giveRecording(); }
}
async function recordNow(html: string, o: { width: number; height: number; durationSec: number; transparent: boolean; dir: string; signal?: AbortSignal; onProgress?: (frac: number) => void; workers?: number; maxMs?: number }) {
  const w = Math.round(o.width / 2) * 2, h = Math.round(o.height / 2) * 2;
  if (Math.max(w, h) > GRAPHIC_LIMITS.maxLong || Math.min(w, h) > GRAPHIC_LIMITS.maxShort) throw new JobError("Graphics can be 1080x1920 at most.", "too-big", false);
  const dur = Math.min(GRAPHIC_LIMITS.maxSeconds, Math.max(0.5, o.durationSec));
  const FPS = GRAPHIC_LIMITS.fps, STEP = 15, frames = Math.max(1, Math.round(dur * FPS));
  const sampled = dur > GRAPHIC_LIMITS.exactSeconds;
  // Browsers: as many as asked for (a lane is at least 2 s), as many as are free in the worker.
  const workers = await takeBrowsers(Math.min(GRAPHIC_WORKERS, o.workers ?? GRAPHIC_WORKERS, Math.max(1, Math.floor(frames / 60))), o.signal);
  const maxMs = Math.min(GRAPHIC_LIMITS.maxMs, o.maxMs ?? GRAPHIC_LIMITS.maxMs);
  const cost = frameCostMs(w, h);
  const t0 = Date.now();
  const root = join(o.dir, "graphic-" + Math.random().toString(36).slice(2, 7));
  const checkAt = [0, Math.floor(frames / 3), Math.floor((2 * frames) / 3), frames - 1];
  const checkFiles = checkAt.map((_, i) => join(root, "checks", `c${i}.png`));

  // Every browser this recording starts (a crashed one's stand-in too), all closed at the end; pooled[k] is pool
  // branch k's, kept from the scan to the recording. One kill switch with a deadline that moves: the scan's, then
  // the recording's. Once the recording is ending (stopped, timed out or failed), no browser starts: one started
  // then would never be closed.
  const browsers: Browser[] = [], pooled: Browser[] = [];
  let phase: "scan" | "record" = sampled ? "scan" : "record", timedOut: "scan" | "record" | null = null, stopped = false, failing = false;
  const killAll = () => { for (const b of browsers) killBrowser(b); };
  const ending = () => stopped || !!timedOut || failing;
  const launch = async () => {
    if (ending()) throw new Error("The recording is ending.");
    const b = await browserFor();
    browsers.push(b);
    if (ending()) killAll();
    return b;
  };
  let deadline = t0 + (sampled ? Math.min(maxMs, 60_000 + Math.round((frames * 10) / workers)) : Math.min(maxMs, 60_000 + Math.round((frames * cost) / workers)));
  const watch = setInterval(() => { if (Date.now() > deadline && !timedOut) { timedOut = phase; killAll(); } }, 250);
  const abort = () => { stopped = true; killAll(); };
  o.signal?.addEventListener("abort", abort, { once: true });
  const errors: string[] = [];
  const codeError = () => new JobError(`The graphic code threw an error: ${errors[0]}${/fetch|network|load/i.test(errors[0]) ? " (graphics have no internet access: inline images and fonts as data: URLs)" : ""}`, "code-error", false);
  const check = () => { if (stopped) throw new JobError("Stopped."); if (errors.length) throw codeError(); };
  let lastP = 0;
  const progress = (p: number) => { p = Math.min(0.99, p); if (p > lastP) { lastP = p; o.onProgress?.(p); } };
  // `jobs` jobs over up to n browsers. When one fails, the others are stopped (every browser killed) and the pool
  // returns only once all of them have ended, with the first error: nothing is left running when the browsers close.
  const pool = async (n: number, jobs: number, work: (browser: Browser, i: number) => Promise<void>) => {
    let next = 0, first: unknown = null;
    await Promise.all(Array.from({ length: Math.min(n, jobs) }, async (_, k) => {
      try {
        if (!pooled[k]?.connected) pooled[k] = await launch();
        while (next < jobs && !failing) await work(pooled[k], next++);
      } catch (e) { if (!failing) { failing = true; first = e; killAll(); } }
    }));
    if (failing) throw first;
  };

  // Which frames are captured: all of them up to 15 s; for longer graphics, what the scan finds.
  const capture = new Uint8Array(frames);
  let dense = 0, pictures = 0;
  const missingFonts = new Set<string>(); // fonts asked for that drew with a fallback (each range's page says)
  const pieces: Piece[] = [];
  let chunkCount = 0, retried = 0;
  try {
    await mkdir(join(root, "checks"), { recursive: true });
    if (!sampled) capture.fill(1);
    else {
      const samples: number[] = [];
      for (let k = 0; k < frames; k += STEP) samples.push(k);
      if (samples[samples.length - 1] !== frames - 1) samples.push(frames - 1);
      const level = new Uint8Array(samples.length); // 0 still, 1 a small change, 2 a real change since the sample before
      const parts = Math.max(1, Math.min(workers, Math.floor(samples.length / 8)));
      let scanned = 0;
      await pool(workers, parts, async (browser, pi) => {
        const i0 = Math.round((pi * samples.length) / parts), i1 = Math.round(((pi + 1) * samples.length) / parts);
        const g = await openGraphicPage(browser, html, w, h, o.transparent, errors);
        try {
          const base = i0 > 0 ? i0 - 1 : 0;
          await stepTo(g, 0, samples[base], true);
          let prev = PNG.sync.read(await shoot(g, w, h, 0.25)).data;
          const tiny = Math.max(16, Math.round((0.002 * prev.length) / 4));
          for (let i = Math.max(1, i0); i < i1; i++) {
            check();
            await stepTo(g, samples[i - 1] + 1, samples[i], true);
            const cur = PNG.sync.read(await shoot(g, w, h, 0.25)).data;
            const d = changedIn(prev, cur);
            level[i] = d > tiny ? 2 : d > 0 ? 1 : 0;
            prev = cur;
            progress((0.1 * ++scanned) / samples.length);
          }
        } finally { await g.page.close().catch(() => {}); }
      });
      check();
      capture[0] = 1;
      for (let i = 1; i < samples.length; i++) {
        if (level[i] === 2) for (let f = samples[i - 1] + 1; f <= samples[i]; f++) { capture[f] = 1; if (f < samples[i]) dense++; }
        else if (level[i] === 1) capture[samples[i]] = 1;
      }
    }
    // The cost, before recording: captures spread over the browsers, plus the time already spent.
    const captures = capture.reduce((x, y) => x + y, 0);
    const estimateMs = Math.round((captures * cost) / workers);
    if (Date.now() - t0 + estimateMs > maxMs) {
      throw new JobError(`This graphic would take about ${Math.ceil(estimateMs / 60_000)} min to record (the limit is ${Math.round(maxMs / 60_000)} min): it moves on ${Math.round((100 * captures) / frames)}% of its ${frames} frames at ${w}x${h}. Make less of it move at once, draw it smaller, or split it into graphics placed where they are needed.`, "graphic-slow", false);
    }
    phase = "record";
    deadline = Math.min(t0 + maxMs, Date.now() + 60_000 + Math.round(estimateMs * 2.5));

    // Lanes, one per browser, with the same number of captures (each starts with a capture), at least 2 s long. Each
    // lane is cut into chunks of at most 90 s, recorded in order on one page (so its clock never steps back to 0). A
    // chunk whose page or browser crashes is recorded once more on a fresh page; the pieces of the failed try are
    // dropped.
    const nRanges = Math.max(1, Math.min(workers, Math.floor(frames / 60), captures));
    const lanes: { a: number; b: number }[] = [];
    let acc = 0, a = 0;
    for (let f = 0; f < frames; f++) {
      acc += capture[f];
      if (lanes.length < nRanges - 1 && acc >= ((lanes.length + 1) * captures) / nRanges && f + 1 - a >= 60 && frames - (f + 1) >= 60) { lanes.push({ a, b: f + 1 }); a = f + 1; }
    }
    lanes.push({ a, b: frames });
    const chunksOf = (l: { a: number; b: number }) => {
      const n = Math.max(1, Math.ceil((l.b - l.a) / CHUNK_FRAMES)), out: { a: number; b: number }[] = [];
      for (let k = 0; k < n; k++) out.push({ a: l.a + Math.round(((l.b - l.a) * k) / n), b: l.a + Math.round(((l.b - l.a) * (k + 1)) / n) });
      return out;
    };
    const laneChunks = lanes.map(chunksOf);
    chunkCount = laneChunks.reduce((x, c) => x + c.length, 0);
    for (const c of laneChunks.flat()) capture[c.a] = 1;
    const total = capture.reduce((x, y) => x + y, 0);
    let captured = 0;

    // At most `slots` pieces encode at once (a VP9 encoder holds about 0.8 GB at 1080x1920): capturing waits for a
    // free one, so a busy graphic cannot start encoders faster than they finish and run the container out of memory.
    const slots = encodeSlots(w, h, workers);
    let active = 0;
    const waiting: (() => void)[] = [];
    const acquire = async () => { while (active >= slots) await new Promise<void>((r) => waiting.push(r)); active++; };
    const release = () => { active--; waiting.shift()?.(); };

    await pool(workers, lanes.length, async (browser0, li) => {
      let browser = browser0, g: GPage | null = null, at = -1; // the page and the last frame its clock stepped to
      const fresh = async () => {
        if (g) await g.page.close().catch(() => {});
        if (!browser.connected) { killBrowser(browser); browser = await launch(); }
        g = await openGraphicPage(browser, html, w, h, o.transparent, errors);
        at = -1;
      };
      try {
        for (const [ci, ch] of laneChunks[li].entries()) {
          for (let attempt = 0; ; attempt++) {
            const mine: Piece[] = [], tries: Promise<unknown>[] = [];
            let failed: unknown = null, done = 0;
            try {
              if (!g || attempt > 0) await fresh();
              const rdir = join(root, `r${li}-${ci}-${attempt}`);
              await mkdir(rdir, { recursive: true });
              let list: { frame: number; file: string }[] = [], last: Buffer | null = null, lastFile = "", lastFrame = ch.a, n = 0;
              const flush = async (end: number) => {
                if (!list.length) return;
                const l = list, piece = join(root, `p${li}-${ci}-${attempt}-${mine.length}.webm`);
                list = [];
                mine.push({ file: piece, start: l[0].frame, end });
                await acquire();
                tries.push(encodePiece(l, end, piece, o.transparent, ch.b === frames && end === frames, o.signal).catch((e) => { failed ??= e; }).finally(release));
              };
              // The picture showing at a check frame is the last one kept at or before it.
              const checks = async (upTo: number) => { for (const [i, c] of checkAt.entries()) if (c >= lastFrame && c < upTo && c >= ch.a && c < ch.b && lastFile) await copyFile(lastFile, checkFiles[i]); };
              const keep = async (frame: number, png: Buffer) => {
                if (last && last.equals(png)) return;
                await checks(frame);
                if (list.length >= CHUNK) await flush(frame);
                const file = join(rdir, `k${String(n++).padStart(6, "0")}.png`);
                await writeFile(file, png);
                list.push({ frame, file });
                last = png; lastFile = file; lastFrame = frame;
                done++;
              };
              await stepTo(g!, at + 1, ch.a - 1, false);
              for (let f = ch.a; f < ch.b; ) {
                check();
                if (failed) throw failed;
                if (!capture[f]) { let e = f; while (e < ch.b && !capture[e]) e++; await stepTo(g!, f, e - 1, false); f = e; continue; }
                await stepTo(g!, f, f, true);
                await keep(f, await shoot(g!, w, h));
                progress(0.1 + (0.9 * ++captured) / total);
                f++;
              }
              at = ch.b - 1;
              await checks(ch.b);
              await flush(ch.b);
              await Promise.all(tries);
              if (failed) throw failed;
              pieces.push(...mine);
              pictures += done;
              break;
            } catch (e) {
              await Promise.allSettled(tries);
              for (const p of mine) await rm(p.file, { force: true }).catch(() => {});
              captured -= done;
              // Only a crash is tried again, up to 3 times after a pause that grows (2, 5, 10 s): not the graphic's own
              // errors, a time limit, a stop or another lane's failure.
              if (attempt >= 3 || e instanceof JobError || ending() || errors.length) throw e;
              retried++;
              console.warn(`[graphic] chunk ${ci + 1} of lane ${li + 1} (frames ${ch.a}-${ch.b}) failed, recording it again in ${[2, 5, 10][attempt]} s: ${(e as Error).message.slice(0, 200)}`);
              await new Promise((r) => setTimeout(r, [2000, 5000, 10000][attempt]));
            }
          }
        }
        if (g) for (const f of (await (g as GPage).page.evaluate("window.__rendrrMissingFonts ? window.__rendrrMissingFonts() : []")) as string[]) missingFonts.add(f);
      } finally { if (g) await (g as GPage).page.close().catch(() => {}); }
    });
    check();
  } catch (e) {
    if (stopped || o.signal?.aborted) throw new JobError("Stopped.");
    if (timedOut === "scan") throw new JobError(`The graphic took too long to step through (${Math.round((lastP / 0.1) * 100)}% scanned in ${Math.round((Date.now() - t0) / 1000)} s): its code is slow to run on every frame. If renderFrame(t) draws the whole frame from t alone, set window.renderFramePure = true so frames that are not recorded skip it.`, "graphic-slow", false);
    if (timedOut === "record") throw new JobError(`The graphic did not finish recording in time (${Math.round(lastP * 100)}% done after ${Math.round((Date.now() - t0) / 1000)} s; ${dense} frames move one by one). Make less of it move at once, draw it smaller, or split it into graphics placed where they are needed.`, "graphic-slow", false);
    if (e instanceof JobError) throw e;
    if (threadsGone(e)) throw busyError();
    throw new JobError(`The graphic crashed while recording: ${(e as Error).message.slice(0, 200)}`, "graphic", true);
  } finally {
    clearInterval(watch);
    o.signal?.removeEventListener("abort", abort);
    // A recording that ended cleanly keeps its browsers for the next one; one that failed or was stopped closes them.
    const clean = !failing && !stopped && !timedOut;
    giveBrowsers(workers);
    await Promise.all(browsers.map((b) => (clean ? keepOrClose(b) : closeBrowser(b))));
  }
  // The pieces, in time order, joined without re-encoding; each lasts exactly until the next one starts.
  const all = [...pieces].sort((x, y) => x.start - y.start);
  const out = join(o.dir, `g-${Math.random().toString(36).slice(2, 7)}.webm`);
  if (all.length === 1) await rename(all[0].file, out);
  else {
    const list = join(root, "pieces.txt");
    await writeFile(list, all.map((p) => `file '${p.file}'\nduration ${((p.end - p.start) / FPS).toFixed(6)}`).join("\n") + "\n");
    await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-f", "concat", "-safe", "0", "-i", list, "-c", "copy", out], { signal: o.signal })
      .catch((e) => { throw threadsGone(e) ? busyError() : e; });
  }
  o.onProgress?.(1);
  return { path: out, checkFrames: checkFiles, seconds: frames / FPS, width: w, height: h, pictures, dense, missingFonts: Array.from(missingFonts).sort(), chunks: chunkCount, retried };
}

/**
 * Kept pictures as one WebM piece, each shown until the next one (variable frame rate), the last until `end` (a
 * frame number). The graphic's final piece repeats its last picture at `end` so the file is exactly as long as the
 * graphic; the PNGs are deleted once encoded.
 */
async function encodePiece(list: { frame: number; file: string }[], end: number, out: string, transparent: boolean, final: boolean, signal?: AbortSignal) {
  const FPS = GRAPHIC_LIMITS.fps;
  const txt = out.replace(/\.webm$/, ".txt");
  await writeFile(txt, list.map((x, i) => `file '${x.file}'\nduration ${(((list[i + 1]?.frame ?? end) - x.frame) / FPS).toFixed(6)}`).join("\n") + "\n" + (final ? `file '${list[list.length - 1].file}'\n` : ""));
  // The encoder's clock is the 30 fps grid every picture sits on (its default, 25 fps, moved pictures by up to 20 ms).
  // One thread to decode the pictures and one for the filters: FFmpeg would start one per CPU of the host (48 on
  // Railway) for each, about 70 threads per piece against the container's limit, for no speed (measured).
  await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-filter_threads", "1", "-threads", "1", "-f", "concat", "-safe", "0", "-i", txt, "-fps_mode", "vfr", "-enc_time_base", `1/${FPS}`,
    "-c:v", "libvpx-vp9", "-pix_fmt", transparent ? "yuva420p" : "yuv420p", "-b:v", "0", "-crf", "20", "-deadline", "realtime", "-cpu-used", "8", "-row-mt", "1", "-auto-alt-ref", "0",
    "-threads", "2", out], { signal }); // several pieces encode at once; more threads did not make one faster
  await Promise.all(list.map((x) => rm(x.file, { force: true })));
}

/**
 * Recorded frames (f00000.png…) as a WebM at 30 fps, transparent when asked. crf 20: at crf 32 the realtime encoder
 * left ghosts of earlier frames wherever the picture stopped changing (a card's old rows showed through the next).
 */
export async function encodeFrames(fdir: string, fps: number, out: string, transparent: boolean, signal?: AbortSignal) {
  await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-filter_threads", "1", "-threads", "1", "-framerate", String(fps), "-i", join(fdir, "f%05d.png"), "-r", String(GRAPHIC_LIMITS.fps),
    "-c:v", "libvpx-vp9", "-pix_fmt", transparent ? "yuva420p" : "yuv420p", "-b:v", "0", "-crf", "20", "-deadline", "realtime", "-cpu-used", "8", "-row-mt", "1", "-auto-alt-ref", "0",
    "-threads", String(Math.min(4, cpuBudget())), out], { signal });
}
/** Changes when the encoding does, so cached template files are recorded again. */
export const GRAPHIC_ENCODER = "vp9-crf20";

export async function brandLogoDataUrl(userId: string): Promise<string | null> {
  const u = await prisma.user.findUnique({ where: { id: userId } });
  if (!u?.logoKey) return null;
  const r = await fetch(await signGet(u.logoKey, 300)).catch(() => null);
  if (!r?.ok) return null;
  const type = r.headers.get("content-type") || "image/png";
  return `data:${type};base64,${Buffer.from(await r.arrayBuffer()).toString("base64")}`;
}

/**
 * The transparent WebM for one V3 graphic clip. Templates are drawn at the output size with the clip's params
 * (cached in storage by a hash of everything that changes the picture). Custom graphics use their stored render.
 */
export async function renderGraphicClip(clip: V3Clip, o: { width: number; height: number; dir: string; userId: string; signal?: AbortSignal; durationSec?: number; onProgress?: (frac: number) => void }): Promise<{ path: string; seconds: number } | null> {
  const id = clip.graphicId!;
  // Drawn for as long as it is on screen in the edit (cut words inside the clip make that shorter), so its
  // ending animation is never cut off. Phase 7: however long that is (over 15 s it is sampled, see recordLong).
  const dur = Math.min(GRAPHIC_LIMITS.maxSeconds, Math.max(0.5, o.durationSec ?? clip.end - clip.start));
  const local = join(o.dir, `graphic-${clip.id}.webm`);
  const tpl = findTemplate(id);
  if (tpl) {
    // Drawn at up to 720p (short side), keeping the output's shape; the overlay scales it to the output size.
    const { width: w, height: h } = templateSize(o.width, o.height);
    const logo = id === "gt_logo_reveal" ? await brandLogoDataUrl(o.userId) : null;
    // A library graphic may name a font the user added (add_font): its file goes in the page.
    const html = withEarly(templateHtml(id, clip.params || {}, w, h, dur, logo), id.startsWith("lib_") ? await userFontsTag(o.userId, JSON.stringify(clip.params || {})) : "");
    const hash = createHash("sha256").update(JSON.stringify([id, html, w, h, dur, GRAPHIC_ENCODER])).digest("hex").slice(0, 24);
    const key = `${PREFIX.graphics}${o.userId}/tpl-${hash}.webm`;
    if (await headObject(key)) { await downloadFile(key, local); return { path: local, seconds: dur }; }
    // Inside a render: two browsers, so the render's own encoding keeps its CPUs.
    const r = await recordHtml(html, { width: w, height: h, durationSec: dur, transparent: true, dir: o.dir, signal: o.signal, onProgress: o.onProgress, workers: 2 });
    await uploadFile(key, r.path, "video/webm");
    return { path: r.path, seconds: r.seconds };
  }
  let g = await prisma.graphic.findUnique({ where: { id }, select: GRAPHIC_FIELDS });
  if (!g || (g.ownerId && g.ownerId !== o.userId)) return null;
  const limit = recordLimitMs(g.durationSec, g.width, g.height);
  const params = clip.params && Object.keys(clip.params).length ? clip.params : null;
  /** Nothing to play for this placement: the render stops and says which one, with its params. */
  const fail = (why: string) => new JobError(`Graphic placement ${clip.id} (${g!.id}${params ? `, params ${JSON.stringify(params).slice(0, 300)}` : ""}) could not be recorded: ${why.replace(/\.$/, "")}. Nothing was lost: retry_graphic records it again, or fix its code (create_graphic codeFrom + edits, replace: true) and render again.`, "graphic-placement", false);
  // The graphic's own recording: wait while the queue records it; if it failed or is missing, record it here.
  if (g.status === "queued" || g.status === "rendering") {
    g = await waitForGraphic(g.id, limit, o.signal, o.onProgress) ?? g;
  }
  if (g.status !== "ready" || !g.renderedKey || !(await headObject(g.renderedKey))) {
    if (!g.code) throw fail("it has no code");
    const r = await withRetries(async () => recordHtml(await customGraphicHtml(g!.code!, graphicDefaults(g!.paramsSchema), g!.ownerId), { width: g!.width, height: g!.height, durationSec: g!.durationSec, transparent: g!.transparent, dir: o.dir, signal: o.signal, onProgress: o.onProgress, workers: 2 }), o.signal).catch((e) => { throw fail((e as Error).message); });
    const key = `${PREFIX.graphics}${g.ownerId}/${g.id}.webm`;
    await uploadFile(key, r.path, "video/webm");
    // Kept for the graphic itself (the next render and the editor have it), unless its code changed meanwhile.
    await prisma.graphic.updateMany({ where: { id: g.id, code: g.code }, data: { status: "ready", renderedKey: key, error: null, durationSec: r.seconds } });
    g = { ...g, status: "ready", renderedKey: key };
    if (!(g.code && graphicVariant(g, clip.params))) return { path: r.path, seconds: r.seconds };
  }
  // A placement with its own params plays its own recording: from storage, from the job recording it now, or
  // recorded here (then kept, so the next render and the editor have it). A job still waiting is taken over.
  const v = g.code ? graphicVariant(g, clip.params) : null;
  if (v && !(await headObject(v.key))) {
    await waitForVariant(v, limit, o.signal, o.onProgress);
    if (!(await headObject(v.key))) {
      const r = await withRetries(async () => recordHtml(await customGraphicHtml(g!.code!, v.params, g!.ownerId), { width: g!.width, height: g!.height, durationSec: g!.durationSec, transparent: g!.transparent, dir: o.dir, signal: o.signal, onProgress: o.onProgress, workers: 2 }), o.signal).catch((e) => { throw fail((e as Error).message); });
      await uploadFile(v.key, r.path, "video/webm");
      await setVariantWarnings(v.progressId, fontWarning(r.missingFonts)).catch(() => {});
      await clearVariantError(v.progressId).catch(() => {});
      return { path: r.path, seconds: r.seconds };
    }
  }
  await downloadFile(v ? v.key : g.renderedKey!, local);
  // A custom graphic plays as recorded; a clip longer than that holds its last frame (as the player does).
  return { path: local, seconds: g.durationSec };
}

/**
 * A recording tried up to 3 times when it fails on the server's side (a crash, the server busy), after 5 then 15 s.
 * The graphic's own errors (its code threw, too slow) fail at once.
 */
async function withRetries<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  for (let i = 0; ; i++) {
    try { return await work(); }
    catch (e) {
      const again = !(e instanceof JobError) || (e as JobError).retry !== false;
      if (i >= 2 || !again || signal?.aborted) throw e;
      console.warn(`[graphic] a placement's recording failed, trying again in ${[5, 15][i]} s: ${(e as Error).message.slice(0, 200)}`);
      await new Promise((r) => setTimeout(r, [5000, 15000][i]));
    }
  }
}

/** While the graphic queue records the graphic itself, wait for it (up to its time limit). Its row once it ends. */
async function waitForGraphic(id: string, limitMs: number, signal?: AbortSignal, onProgress?: (frac: number) => void) {
  const end = Date.now() + limitMs;
  while (Date.now() < end && !signal?.aborted) {
    const g = await prisma.graphic.findUnique({ where: { id }, select: GRAPHIC_FIELDS });
    if (!g || (g.status !== "queued" && g.status !== "rendering")) return g;
    const p = await readGraphic(id);
    if (p) onProgress?.(p.percent / 100);
    await new Promise((r) => setTimeout(r, 2000));
  }
  return null;
}

/**
 * The graphic's columns the worker reads, named: a deploy can run the new worker before the API has added a column,
 * and reading every column would fail until it has.
 */
export const GRAPHIC_FIELDS = { id: true, ownerId: true, kind: true, code: true, paramsSchema: true, width: true, height: true, durationSec: true, transparent: true, status: true, renderedKey: true } as const;

/** A custom graphic's page: its code with window.params set first and the user's fonts it names. */
export async function customGraphicHtml(code: string, params: Record<string, unknown>, ownerId: string | null) {
  return withEarly(withParams(code, params), await userFontsTag(ownerId, code + JSON.stringify(params)));
}

/** The user's fonts (add_font) that a graphic's code or params name, as @font-face rules with the file inside. */
export async function userFontsTag(userId: string | null, text: string): Promise<string> {
  if (!userId) return "";
  // No table yet while a deploy is running the migration: no user fonts for that moment.
  const fs = await prisma.font.findMany({ where: { userId }, select: { family: true, weight: true, style: true, format: true, key: true } }).catch(() => []);
  const low = text.toLowerCase();
  const named = fs.filter((f) => low.includes(f.family.toLowerCase()));
  if (!named.length) return "";
  const fmt: Record<string, string> = { ttf: "truetype", otf: "opentype", woff: "woff", woff2: "woff2" };
  const faces = await Promise.all(named.map(async (f) => `@font-face{font-family:${JSON.stringify(f.family)};src:url(data:font/${f.format};base64,${(await getBytes(f.key)).toString("base64")}) format("${fmt[f.format] ?? f.format}");font-weight:${f.weight};font-style:${f.style};font-display:block}`));
  return `<style>${faces.join("")}</style>`;
}

/** What the AI is told when fonts drew with a fallback. */
export const fontWarning = (missing: string[]) => (missing.length ? [`Fonts not installed, drawn with a fallback: ${missing.join(", ")}. Use an installed font (create_graphic lists them) or add the file with add_font.`] : []);

/**
 * While the graphic queue is recording this variant (prewarmed by the edit), wait for it rather than record it twice;
 * one still waiting in the queue is taken off it (the render records it now, in its turn).
 */
async function waitForVariant(v: GraphicVariant, limitMs: number, signal?: AbortSignal, onProgress?: (frac: number) => void) {
  const end = Date.now() + limitMs;
  while (Date.now() < end && !signal?.aborted) {
    const job = await queue("graphic").getJob(v.jobId).catch(() => null);
    const state = job ? await job.getState().catch(() => "unknown") : null;
    if (job && (state === "waiting" || state === "delayed" || state === "prioritized")) { await job.remove().catch(() => {}); return; }
    if (!job || state !== "active" || (await headObject(v.key))) return;
    const p = await readGraphic(v.progressId);
    if (p) onProgress?.(p.percent / 100);
    await new Promise((r) => setTimeout(r, 2000));
  }
}

export async function readCheckFrame(path: string) { return readFile(path); }
