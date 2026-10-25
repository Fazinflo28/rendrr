import { downloadFile, headObject, signGet, uploadFile } from "@rendrr/core";
import { prisma } from "@rendrr/db";
import { GRAPHIC_TEMPLATES, PREFIX, templateHtml, templateSize, withClock, wrapGraphicHtml, type V3Clip } from "@rendrr/shared";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { availableParallelism } from "node:os";
import { join } from "node:path";
import { PNG } from "pngjs";
import puppeteer, { type Browser, type CDPSession, type Page } from "puppeteer-core";
import { JobError, run } from "./ffmpeg";

/** CPUs this container may use: its cgroup quota when there is one (the host can have many more than we get). */
function cpuBudget() {
  try {
    const [q, p] = readFileSync("/sys/fs/cgroup/cpu.max", "utf8").trim().split(/\s+/);
    if (q !== "max" && Number(q) > 0 && Number(p) > 0) return Math.max(1, Math.floor(Number(q) / Number(p)));
  } catch { /* no cgroup v2 quota */ }
  return availableParallelism();
}
/** Threads this container may start (cgroup pids.max; it counts threads). Chromium uses about 80 per browser. */
function threadBudget() {
  try { const v = readFileSync("/sys/fs/cgroup/pids.max", "utf8").trim(); if (v !== "max" && Number(v) > 0) return Number(v); } catch { /* no limit */ }
  return Infinity;
}
/**
 * Browsers recording one graphic at once: one CPU each, one CPU left for the rest of the worker, and room left
 * under the thread limit for a render running at the same time (500 threads) at about 100 per browser.
 */
export const GRAPHIC_WORKERS = Math.max(1, Math.min(6, Math.floor(Number(process.env.GRAPHIC_WORKERS)) || Math.min(cpuBudget() - 1, Math.floor((threadBudget() - 500) / 100))));

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

/** A headless Chromium with no network: every request but data: is blocked, WebRTC too, and memory is capped. */
function launchLocked() {
  return puppeteer.launch({
    executablePath: chromiumPath(), headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--mute-audio", "--no-first-run", "--disable-extensions", "--disable-background-networking",
      "--proxy-server=127.0.0.1:9", "--proxy-bypass-list=<-loopback>", "--host-resolver-rules=MAP * ~NOTFOUND",
      "--webrtc-ip-handling-policy=disable_non_proxied_udp", // WebRTC would otherwise send UDP around the proxy
      "--js-flags=--max-old-space-size=256", "--renderer-process-limit=1",
      // A long graphic is recorded with two pages; without these the one in the background stops drawing for seconds.
      "--disable-renderer-backgrounding", "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows",
      // Every capture shows the page as the clock left it: animations are not run on the compositor thread (whose
      // picture can lag the clock by a frame or two), and images are decoded before they are drawn.
      "--disable-threaded-animation", "--disable-threaded-scrolling", "--disable-checker-imaging"],
  });
}

/** The graphic loaded in a page at w x h with the virtual clock, fonts ready, transparent when asked. */
async function openGraphicPage(browser: Browser, html: string, w: number, h: number, transparent: boolean, errors: string[]) {
  const page = await browser.newPage();
  await page.setViewport({ width: w, height: h, deviceScaleFactor: 1 });
  await page.setRequestInterception(true);
  page.on("request", (req) => { const u = req.url(); if (u.startsWith("data:") || u === "about:blank") req.continue(); else req.abort("blockedbyclient"); });
  page.on("pageerror", (e) => errors.push(String((e as Error).message || e).slice(0, 300)));
  await page.setContent(withClock(wrapGraphicHtml(html, w, h)), { waitUntil: "load", timeout: 15_000 });
  await page.evaluate(() => (document as Document & { fonts?: { ready: Promise<unknown> } }).fonts?.ready);
  const cdp = await page.createCDPSession();
  if (transparent) await cdp.send("Emulation.setDefaultBackgroundColorOverride", { color: { r: 0, g: 0, b: 0, a: 0 } });
  return { page, cdp };
}
type GPage = Awaited<ReturnType<typeof openGraphicPage>>;

/** Moves the page's clock through frames from..to (inclusive) one frame at a time, in one call; nothing is drawn. */
async function stepTo(g: GPage, from: number, to: number) {
  if (to < from) return;
  await g.page.evaluate((a, b, fps) => { const adv = (window as unknown as { __rendrrAdvance: (t: number) => void }).__rendrrAdvance; for (let f = a; f <= b; f++) adv(f / fps); }, from, to, GRAPHIC_LIMITS.fps);
}
/** The picture now, as PNG bytes; `scale` < 1 draws a smaller one (cheaper, for spotting changes). */
async function shoot(g: GPage, w: number, h: number, scale = 1): Promise<Buffer> {
  const shot = await g.cdp.send("Page.captureScreenshot", { format: "png", optimizeForSpeed: true, captureBeyondViewport: false, ...(scale < 1 ? { clip: { x: 0, y: 0, width: w, height: h, scale } } : {}) });
  return Buffer.from(shot.data, "base64");
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
const CHUNK = 240; // pictures per encoded piece: keeps the PNGs on disk at any time small

/**
 * Records HTML into a transparent WebM in locked headless Chromiums: no network (every request except data: is
 * blocked), a memory cap, max 1080x1920, 30 fps, and a time limit (recordLimitMs) that fails loudly.
 *
 * The graphic's time is split into ranges recorded at once by GRAPHIC_WORKERS browsers. A range's pages first step
 * their clock frame by frame from 0 to the range's start without drawing, so the graphic sees time exactly as it
 * would playing (timers, transitions started mid-way and JS state all arrive where they should).
 * Up to 15 s every frame is captured. Longer graphics are sampled: a scout page draws a quarter-size picture every
 * 0.5 s; no change: the frame is held; a small change (under 0.2% of the pixels): the full picture from that moment;
 * a bigger change: a second page, following behind, captures that half second frame by frame. Missed: something
 * that appears and goes within one half second of an otherwise still graphic. Pictures are encoded in pieces as they
 * come (variable frame rate: each picture keeps its own time) and the pieces joined, so the file is exactly as long
 * as the graphic. Returns the paths of four check frames too.
 */
export async function recordHtml(html: string, o: { width: number; height: number; durationSec: number; transparent: boolean; dir: string; signal?: AbortSignal; onProgress?: (frac: number) => void; workers?: number }) {
  const w = Math.round(o.width / 2) * 2, h = Math.round(o.height / 2) * 2;
  if (Math.max(w, h) > GRAPHIC_LIMITS.maxLong || Math.min(w, h) > GRAPHIC_LIMITS.maxShort) throw new JobError("Graphics can be 1080x1920 at most.", "too-big", false);
  const dur = Math.min(GRAPHIC_LIMITS.maxSeconds, Math.max(0.5, o.durationSec));
  const FPS = GRAPHIC_LIMITS.fps, STEP = 15, frames = Math.max(1, Math.round(dur * FPS));
  const sampled = dur > GRAPHIC_LIMITS.exactSeconds;
  const workers = Math.max(1, Math.min(GRAPHIC_WORKERS, o.workers ?? GRAPHIC_WORKERS));
  const limit = Math.min(GRAPHIC_LIMITS.maxMs, recordLimitMs(dur, w, h) * Math.max(1, GRAPHIC_WORKERS / workers));
  // Ranges: a couple per browser for long graphics (so one busy stretch does not hold up the rest), at least 2 s each.
  const nRanges = Math.max(1, Math.min(sampled ? workers * 2 : workers, Math.floor(frames / 60)));
  const ranges = Array.from({ length: nRanges }, (_, i) => ({ a: Math.round((i * frames) / nRanges), b: Math.round(((i + 1) * frames) / nRanges) }));
  const root = join(o.dir, "graphic-" + Math.random().toString(36).slice(2, 7));
  await mkdir(join(root, "checks"), { recursive: true });
  const checkAt = [0, Math.floor(frames / 3), Math.floor((2 * frames) / 3), frames - 1];
  const checkFiles = checkAt.map((_, i) => join(root, "checks", `c${i}.png`));

  const browsers: Browser[] = [];
  let timedOut = false, stopped = false;
  const killAll = () => { for (const b of browsers) b.process()?.kill("SIGKILL"); };
  const kill = setTimeout(() => { timedOut = true; killAll(); }, limit);
  const abort = () => { stopped = true; killAll(); };
  o.signal?.addEventListener("abort", abort, { once: true });
  const errors: string[] = [];
  const codeError = () => new JobError(`The graphic code threw an error: ${errors[0]}${/fetch|network|load/i.test(errors[0]) ? " (graphics have no internet access: inline images and fonts as data: URLs)" : ""}`, "code-error", false);
  const done = ranges.map(() => 0);
  let lastP = 0, dense = 0, pictures = 0;
  const progress = () => { const p = Math.min(0.99, done.reduce((x, y) => x + y, 0) / frames); if (p > lastP) { lastP = p; o.onProgress?.(p); } };
  const pieces: Piece[][] = ranges.map(() => []);
  const encodes: Promise<void>[] = [];

  async function recordRange(browser: Browser, ri: number) {
    const { a, b } = ranges[ri];
    const rdir = join(root, `r${ri}`);
    await mkdir(rdir, { recursive: true });
    let chunk: { frame: number; file: string }[] = [], last: Buffer | null = null, lastFile = "", lastFrame = a, n = 0;
    const flush = (end: number) => {
      if (!chunk.length) return;
      const list = chunk, piece = join(root, `p${ri}-${pieces[ri].length}.webm`);
      pieces[ri].push({ file: piece, start: list[0].frame, end });
      chunk = [];
      encodes.push(encodePiece(list, end, piece, o.transparent, ri === ranges.length - 1 && end === frames, o.signal));
    };
    // The picture showing at a check frame is the last one kept at or before it.
    const checks = async (upTo: number) => { for (const [i, c] of checkAt.entries()) if (c >= lastFrame && c < upTo && c >= a && c < b && lastFile) await copyFile(lastFile, checkFiles[i]); };
    const keep = async (frame: number, png: Buffer) => {
      if (last && last.equals(png)) return;
      await checks(frame);
      if (chunk.length >= CHUNK) flush(frame);
      const file = join(rdir, `k${String(n++).padStart(6, "0")}.png`);
      await writeFile(file, png);
      chunk.push({ frame, file });
      last = png; lastFile = file; lastFrame = frame; pictures++;
    };
    const scout = await openGraphicPage(browser, html, w, h, o.transparent, errors);
    const rec = sampled ? await openGraphicPage(browser, html, w, h, o.transparent, errors) : null;
    let front: GPage = rec ?? scout; // the page opened last is in front
    const use = async (g: GPage) => { if (front !== g) { await g.page.bringToFront(); front = g; } return g; };
    try {
      await stepTo(scout, 0, a - 1);
      if (!sampled) {
        for (let f = a; f < b; f++) {
          if (stopped) throw new JobError("Stopped.");
          if (errors.length) throw codeError();
          if (failed) return;
          await stepTo(scout, f, f);
          await keep(f, await shoot(scout, w, h));
          done[ri] = f + 1 - a; progress();
        }
      } else {
        await stepTo(rec!, 0, a - 1);
        let recAt = a - 1; // the last frame the follower page's clock has reached
        await stepTo(scout, a, a);
        await use(scout);
        await keep(a, await shoot(scout, w, h));
        let small = PNG.sync.read(await shoot(scout, w, h, 0.25)).data;
        const tiny = Math.max(16, Math.round(0.002 * small.length / 4));
        for (let prev = a; prev < b - 1; ) {
          if (stopped) throw new JobError("Stopped.");
          if (errors.length) throw codeError();
          if (failed) return;
          const k = Math.min(prev + STEP, b - 1);
          await stepTo(scout, prev + 1, k);
          await use(scout);
          const cur = PNG.sync.read(await shoot(scout, w, h, 0.25)).data;
          const diff = changedIn(small, cur);
          if (diff > tiny) {
            // A real change in this half second: the follower draws every frame of it.
            await stepTo(rec!, recAt + 1, prev);
            await use(rec!);
            for (let f = prev + 1; f < k; f++) { await stepTo(rec!, f, f); await keep(f, await shoot(rec!, w, h)); dense++; }
            recAt = k - 1;
            await use(scout);
          }
          if (diff > 0) await keep(k, await shoot(scout, w, h));
          small = cur; prev = k;
          done[ri] = k + 1 - a; progress();
        }
      }
      await checks(b);
      flush(b);
    } finally {
      await scout.page.close().catch(() => {});
      await rec?.page.close().catch(() => {});
    }
  }

  let failed = false;
  try {
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(workers, ranges.length) }, async () => {
      const browser = await launchLocked();
      browsers.push(browser);
      if (stopped || timedOut) killAll();
      try { while (next < ranges.length && !failed) await recordRange(browser, next++); }
      catch (e) { failed = true; throw e; }
      finally { await browser.close().catch(() => browser.process()?.kill("SIGKILL")); }
    }));
    await Promise.all(encodes);
    if (errors.length) throw codeError();
  } catch (e) {
    await Promise.allSettled(encodes);
    if (stopped || o.signal?.aborted) throw new JobError("Stopped.");
    if (timedOut) {
      const at = done.reduce((x, y) => x + y, 0);
      throw new JobError(`The graphic did not finish recording within ${Math.round(limit / 1000)} s (${Math.round((100 * at) / frames)}% done): it moved on ${dense} of the ${at} frames recorded so far. Recording costs about ${(frameCostMs(w, h) / workers / 1000 * FPS).toFixed(1)} s per second of motion at ${w}x${h}; make it move less of the time, draw it smaller, or split it into shorter graphics placed where they are needed.`, "graphic-slow", false);
    }
    if (e instanceof JobError) throw e;
    throw new JobError(`The graphic crashed while recording: ${(e as Error).message.slice(0, 200)}`, "graphic", true);
  } finally {
    clearTimeout(kill);
    o.signal?.removeEventListener("abort", abort);
    killAll();
  }
  // The pieces, in time order, joined without re-encoding; each lasts exactly until the next one starts.
  const all = pieces.flat().sort((x, y) => x.start - y.start);
  const out = join(o.dir, `g-${Math.random().toString(36).slice(2, 7)}.webm`);
  if (all.length === 1) await rename(all[0].file, out);
  else {
    const list = join(root, "pieces.txt");
    await writeFile(list, all.map((p) => `file '${p.file}'\nduration ${((p.end - p.start) / FPS).toFixed(6)}`).join("\n") + "\n");
    await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-f", "concat", "-safe", "0", "-i", list, "-c", "copy", out], { signal: o.signal });
  }
  o.onProgress?.(1);
  return { path: out, checkFrames: checkFiles, seconds: frames / FPS, width: w, height: h, pictures, dense };
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
  await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-f", "concat", "-safe", "0", "-i", txt, "-fps_mode", "vfr", "-enc_time_base", `1/${FPS}`,
    "-c:v", "libvpx-vp9", "-pix_fmt", transparent ? "yuva420p" : "yuv420p", "-b:v", "0", "-crf", "20", "-deadline", "realtime", "-cpu-used", "8", "-row-mt", "1", "-auto-alt-ref", "0",
    "-threads", "2", out], { signal }); // several pieces encode at once; more threads did not make one faster
  await Promise.all(list.map((x) => rm(x.file, { force: true })));
}

/**
 * Recorded frames (f00000.png…) as a WebM at 30 fps, transparent when asked. crf 20: at crf 32 the realtime encoder
 * left ghosts of earlier frames wherever the picture stopped changing (a card's old rows showed through the next).
 */
export async function encodeFrames(fdir: string, fps: number, out: string, transparent: boolean, signal?: AbortSignal) {
  await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-framerate", String(fps), "-i", join(fdir, "f%05d.png"), "-r", String(GRAPHIC_LIMITS.fps),
    "-c:v", "libvpx-vp9", "-pix_fmt", transparent ? "yuva420p" : "yuv420p", "-b:v", "0", "-crf", "20", "-deadline", "realtime", "-cpu-used", "8", "-row-mt", "1", "-auto-alt-ref", "0", out], { signal });
}
/** Changes when the encoding does, so cached template files are recorded again. */
export const GRAPHIC_ENCODER = "vp9-crf20";

async function brandLogoDataUrl(userId: string): Promise<string | null> {
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
  const tpl = GRAPHIC_TEMPLATES.find((t) => t.id === id);
  if (tpl) {
    // Drawn at up to 720p (short side), keeping the output's shape; the overlay scales it to the output size.
    const { width: w, height: h } = templateSize(o.width, o.height);
    const logo = id === "gt_logo_reveal" ? await brandLogoDataUrl(o.userId) : null;
    const html = templateHtml(id, clip.params || {}, w, h, dur, logo);
    const hash = createHash("sha256").update(JSON.stringify([id, html, w, h, dur, GRAPHIC_ENCODER])).digest("hex").slice(0, 24);
    const key = `${PREFIX.graphics}${o.userId}/tpl-${hash}.webm`;
    if (await headObject(key)) { await downloadFile(key, local); return { path: local, seconds: dur }; }
    // Inside a render: two browsers, so the render's own encoding keeps its CPUs.
    const r = await recordHtml(html, { width: w, height: h, durationSec: dur, transparent: true, dir: o.dir, signal: o.signal, onProgress: o.onProgress, workers: 2 });
    await uploadFile(key, r.path, "video/webm");
    return { path: r.path, seconds: r.seconds };
  }
  const g = await prisma.graphic.findUnique({ where: { id } });
  if (!g || (g.ownerId && g.ownerId !== o.userId) || g.status !== "ready" || !g.renderedKey) return null;
  await downloadFile(g.renderedKey, local);
  // A custom graphic plays as recorded; a clip longer than that holds its last frame (as the player does).
  return { path: local, seconds: g.durationSec };
}

export async function readCheckFrame(path: string) { return readFile(path); }
