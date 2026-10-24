import { downloadFile, headObject, signGet, uploadFile } from "@rendrr/core";
import { prisma } from "@rendrr/db";
import { GRAPHIC_TEMPLATES, PREFIX, templateHtml, templateSize, withClock, wrapGraphicHtml, type V3Clip } from "@rendrr/shared";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PNG } from "pngjs";
import puppeteer, { type Browser, type CDPSession, type Page } from "puppeteer-core";
import { JobError, run } from "./ffmpeg";

/**
 * Up to `exactSeconds` a graphic is recorded frame by frame (as before Phase 7). Longer ones (up to 4 hours: a whole
 * video) are sampled; see recordLong. Their time limit grows with the length.
 */
export const GRAPHIC_LIMITS = { maxSeconds: 4 * 3600, exactSeconds: 15, maxLong: 1920, maxShort: 1080, killMs: 60_000, fps: 30 };
export const recordLimitMs = (seconds: number) => (seconds > GRAPHIC_LIMITS.exactSeconds ? GRAPHIC_LIMITS.killMs + Math.round(seconds * 500) : GRAPHIC_LIMITS.killMs);

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
      "--disable-renderer-backgrounding", "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows"],
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

/** The picture at time t (seconds on the virtual clock), as PNG bytes. */
async function shootAt(page: Page, cdp: CDPSession, t: number): Promise<Buffer> {
  await page.evaluate((x) => (window as unknown as { __rendrrAdvance: (t: number) => void }).__rendrrAdvance(x), t);
  const shot = await cdp.send("Page.captureScreenshot", { format: "png", optimizeForSpeed: true, captureBeyondViewport: false });
  return Buffer.from(shot.data, "base64");
}

/** How many pixels differ between two pictures of the same size (any channel by more than 2 levels). */
export function changedPixels(a: Buffer, b: Buffer): number {
  if (a.equals(b)) return 0;
  const x = PNG.sync.read(a).data, y = PNG.sync.read(b).data;
  if (x.length !== y.length) return Infinity;
  let n = 0;
  for (let i = 0; i < x.length; i += 4) {
    if (Math.abs(x[i] - y[i]) > 2 || Math.abs(x[i + 1] - y[i + 1]) > 2 || Math.abs(x[i + 2] - y[i + 2]) > 2 || Math.abs(x[i + 3] - y[i + 3]) > 2) n++;
  }
  return n;
}

/**
 * A graphic over 15 s (up to a whole video), recorded on the 30 fps grid without capturing every frame. A scout page
 * looks every 0.5 s. The same picture: the frame is held. A small change (under 0.2% of the pixels, like a progress
 * bar's edge moving a pixel): the new picture is shown from that moment. A bigger change: a second page, which follows
 * behind, records that half second frame by frame. Both clocks only move forward, so JS graphics see time as they
 * would playing. The WebM keeps each picture's own time (variable frame rate); the render and the player hold it.
 * Missed: something that appears and goes within one half second of an otherwise still graphic.
 */
async function recordLong(html: string, o: { width: number; height: number; durationSec: number; transparent: boolean; dir: string; signal?: AbortSignal; onProgress?: (frac: number) => void }) {
  const { width: w, height: h } = o;
  const FPS = GRAPHIC_LIMITS.fps, STEP = 15, frames = Math.max(1, Math.round(o.durationSec * FPS));
  const small = Math.max(64, Math.round(0.002 * w * h));
  const limit = recordLimitMs(o.durationSec);
  const fdir = join(o.dir, "frames-" + Math.random().toString(36).slice(2, 7));
  await mkdir(fdir, { recursive: true });
  const browser = await launchLocked();
  let timedOut = false;
  const kill = setTimeout(() => { timedOut = true; browser.process()?.kill("SIGKILL"); }, limit);
  const abort = () => browser.process()?.kill("SIGKILL");
  o.signal?.addEventListener("abort", abort, { once: true });
  const errors: string[] = [];
  // The pictures kept, each from its frame on (frame numbers on the 30 fps grid), and how many were recorded densely.
  const kept: { frame: number; file: string }[] = [];
  let last: Buffer | null = null, dense = 0;
  const keep = async (frame: number, png: Buffer) => {
    if (last && last.equals(png)) return;
    const file = join(fdir, `k${String(kept.length).padStart(6, "0")}.png`);
    await writeFile(file, png);
    kept.push({ frame, file });
    last = png;
  };
  try {
    const scout = await openGraphicPage(browser, html, w, h, o.transparent, errors);
    const rec = await openGraphicPage(browser, html, w, h, o.transparent, errors);
    await scout.page.bringToFront(); // the page opened last is in front; the scout draws first
    let prev = await shootAt(scout.page, scout.cdp, 0);
    await keep(0, prev);
    for (let at = STEP; ; at += STEP) {
      const k = Math.min(at, frames - 1);
      if (o.signal?.aborted) throw new JobError("Stopped.");
      const cur = await shootAt(scout.page, scout.cdp, k / FPS);
      const n = changedPixels(prev, cur);
      if (n > small) {
        // A real change inside this half second: record it frame by frame (the recorder page is behind, at or before k - STEP).
        // The page drawn from goes to the front: a background page stops drawing for seconds, flags or not.
        await rec.page.bringToFront();
        for (let f = Math.max(1, k - STEP + 1); f < k; f++) { await keep(f, await shootAt(rec.page, rec.cdp, f / FPS)); dense++; }
      }
      if (n > small) await scout.page.bringToFront();
      await keep(k, cur);
      prev = cur;
      o.onProgress?.(k / Math.max(1, frames - 1));
      if (k >= frames - 1) break;
    }
    if (errors.length) throw new JobError(`The graphic code threw an error: ${errors[0]}${/fetch|network|load/i.test(errors[0]) ? " (graphics have no internet access: inline images and fonts as data: URLs)" : ""}`, "code-error", false);
  } catch (e) {
    if (e instanceof JobError) throw e;
    if (o.signal?.aborted) throw new JobError("Stopped.");
    if (timedOut) throw new JobError(`The graphic did not finish recording within ${Math.round(limit / 1000)} s: it changes on ${dense} of the ${frames} frames recorded so far. A long graphic must stay still most of the time (a bar, a logo, a title that comes and goes); make it change less often or shorten it.`, "graphic-slow", false);
    throw new JobError(`The graphic crashed while recording: ${(e as Error).message.slice(0, 200)}`, "graphic", true);
  } finally {
    clearTimeout(kill);
    o.signal?.removeEventListener("abort", abort);
    await browser.close().catch(() => browser.process()?.kill("SIGKILL"));
  }
  // Each picture lasts until the next one; the list ends on the last frame so the file is exactly as long as the graphic.
  const list = kept.map((x, i) => `file '${x.file}'\nduration ${(((kept[i + 1]?.frame ?? frames) - x.frame) / FPS).toFixed(6)}`).join("\n") + `\nfile '${kept[kept.length - 1].file}'\n`;
  const listPath = join(fdir, "list.txt");
  await writeFile(listPath, list);
  const out = join(o.dir, `g-${Math.random().toString(36).slice(2, 7)}.webm`);
  await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-f", "concat", "-safe", "0", "-i", listPath, "-fps_mode", "vfr",
    "-c:v", "libvpx-vp9", "-pix_fmt", o.transparent ? "yuva420p" : "yuv420p", "-b:v", "0", "-crf", "20", "-deadline", "realtime", "-cpu-used", "8", "-row-mt", "1", "-auto-alt-ref", "0", out], { signal: o.signal });
  const at = (f: number) => kept.reduce((best, x) => (x.frame <= f ? x : best), kept[0]).file;
  const pick = [0, Math.floor(frames / 3), Math.floor((2 * frames) / 3), frames - 1].map(at);
  return { path: out, checkFrames: pick, seconds: frames / FPS, width: w, height: h, pictures: kept.length, dense };
}

/**
 * Records HTML into a transparent WebM in a locked headless Chromium: no network (every request except
 * data: is blocked), a memory cap, max 1080x1920, and a kill switch (60 s; longer for long graphics).
 * Returns the paths of four check frames too. Over 15 s the graphic is sampled (recordLong).
 */
export async function recordHtml(html: string, o: { width: number; height: number; durationSec: number; transparent: boolean; dir: string; signal?: AbortSignal; onProgress?: (frac: number) => void }) {
  const w = Math.round(o.width / 2) * 2, h = Math.round(o.height / 2) * 2;
  if (Math.max(w, h) > GRAPHIC_LIMITS.maxLong || Math.min(w, h) > GRAPHIC_LIMITS.maxShort) throw new JobError("Graphics can be 1080x1920 at most.", "too-big", false);
  const dur = Math.min(GRAPHIC_LIMITS.maxSeconds, Math.max(0.5, o.durationSec));
  if (dur > GRAPHIC_LIMITS.exactSeconds) return recordLong(html, { ...o, width: w, height: h, durationSec: dur });
  // Big, long graphics are captured at fewer frames per second (played back at 30) to stay inside the 60 s limit.
  const px = w * h;
  const fps = px > 1.2e6 ? (dur > 6 ? 12 : 20) : px > 5e5 ? (dur > 8 ? 20 : 30) : 30;
  const frames = Math.max(1, Math.round(dur * fps));
  const fdir = join(o.dir, "frames-" + Math.random().toString(36).slice(2, 7));
  await mkdir(fdir, { recursive: true });
  const browser = await launchLocked();
  const kill = setTimeout(() => { browser.process()?.kill("SIGKILL"); }, GRAPHIC_LIMITS.killMs);
  const abort = () => browser.process()?.kill("SIGKILL");
  o.signal?.addEventListener("abort", abort, { once: true });
  const errors: string[] = [];
  try {
    const { page, cdp } = await openGraphicPage(browser, html, w, h, o.transparent, errors);
    for (let i = 0; i < frames; i++) {
      if (o.signal?.aborted) throw new JobError("Stopped.");
      await writeFile(join(fdir, `f${String(i).padStart(5, "0")}.png`), await shootAt(page, cdp, i / fps));
    }
    if (errors.length) throw new JobError(`The graphic code threw an error: ${errors[0]}${/fetch|network|load/i.test(errors[0]) ? " (graphics have no internet access: inline images and fonts as data: URLs)" : ""}`, "code-error", false);
  } catch (e) {
    if (e instanceof JobError) throw e;
    if (o.signal?.aborted) throw new JobError("Stopped.");
    throw new JobError(`The graphic did not render in time (60 second limit) or crashed: ${(e as Error).message.slice(0, 200)}`, "graphic", true);
  } finally {
    clearTimeout(kill);
    o.signal?.removeEventListener("abort", abort);
    await browser.close().catch(() => browser.process()?.kill("SIGKILL"));
  }
  const out = join(o.dir, `g-${Math.random().toString(36).slice(2, 7)}.webm`);
  await encodeFrames(fdir, fps, out, o.transparent, o.signal);
  const pick = [0, Math.floor(frames / 3), Math.floor((2 * frames) / 3), frames - 1].map((i) => join(fdir, `f${String(Math.min(frames - 1, i)).padStart(5, "0")}.png`));
  return { path: out, checkFrames: pick, seconds: frames / fps, width: w, height: h };
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
    const r = await recordHtml(html, { width: w, height: h, durationSec: dur, transparent: true, dir: o.dir, signal: o.signal, onProgress: o.onProgress });
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
