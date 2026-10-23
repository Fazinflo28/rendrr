import { downloadFile, headObject, signGet, uploadFile } from "@rendrr/core";
import { prisma } from "@rendrr/db";
import { GRAPHIC_TEMPLATES, PREFIX, templateHtml, templateSize, withClock, wrapGraphicHtml, type V3Clip } from "@rendrr/shared";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import puppeteer from "puppeteer-core";
import { JobError, run } from "./ffmpeg";

export const GRAPHIC_LIMITS = { maxSeconds: 15, maxLong: 1920, maxShort: 1080, killMs: 60_000, fps: 30 };

function chromiumPath() {
  const c = [process.env.CHROMIUM_PATH, "/usr/bin/chromium", "/usr/bin/chromium-browser", "/opt/pw-browsers/chromium-1194/chrome-linux/chrome"].filter(Boolean) as string[];
  const p = c.find((x) => existsSync(x));
  if (!p) throw new JobError("The graphics renderer is not installed on this server.", "no-chromium", false);
  return p;
}

/**
 * Records HTML into a transparent WebM in a locked headless Chromium: no network (every request except
 * data: is blocked), a memory cap, max 15 s at max 1080x1920, and a 60 s kill switch.
 * Returns the paths of four check frames too.
 */
export async function recordHtml(html: string, o: { width: number; height: number; durationSec: number; transparent: boolean; dir: string; signal?: AbortSignal }) {
  const w = Math.round(o.width / 2) * 2, h = Math.round(o.height / 2) * 2;
  if (Math.max(w, h) > GRAPHIC_LIMITS.maxLong || Math.min(w, h) > GRAPHIC_LIMITS.maxShort) throw new JobError("Graphics can be 1080x1920 at most.", "too-big", false);
  const dur = Math.min(GRAPHIC_LIMITS.maxSeconds, Math.max(0.5, o.durationSec));
  // Big, long graphics are captured at fewer frames per second (played back at 30) to stay inside the 60 s limit.
  const px = w * h;
  const fps = px > 1.2e6 ? (dur > 6 ? 12 : 20) : px > 5e5 ? (dur > 8 ? 20 : 30) : 30;
  const frames = Math.max(1, Math.round(dur * fps));
  const fdir = join(o.dir, "frames-" + Math.random().toString(36).slice(2, 7));
  await mkdir(fdir, { recursive: true });
  const browser = await puppeteer.launch({
    executablePath: chromiumPath(), headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--mute-audio", "--no-first-run", "--disable-extensions", "--disable-background-networking",
      "--proxy-server=127.0.0.1:9", "--proxy-bypass-list=<-loopback>", "--host-resolver-rules=MAP * ~NOTFOUND",
      "--webrtc-ip-handling-policy=disable_non_proxied_udp", // WebRTC would otherwise send UDP around the proxy
      "--js-flags=--max-old-space-size=256", "--renderer-process-limit=1"],
  });
  const kill = setTimeout(() => { browser.process()?.kill("SIGKILL"); }, GRAPHIC_LIMITS.killMs);
  const abort = () => browser.process()?.kill("SIGKILL");
  o.signal?.addEventListener("abort", abort, { once: true });
  const errors: string[] = [];
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: w, height: h, deviceScaleFactor: 1 });
    await page.setRequestInterception(true);
    page.on("request", (req) => { const u = req.url(); if (u.startsWith("data:") || u === "about:blank") req.continue(); else req.abort("blockedbyclient"); });
    page.on("pageerror", (e) => errors.push(String((e as Error).message || e).slice(0, 300)));
    await page.setContent(withClock(wrapGraphicHtml(html, w, h)), { waitUntil: "load", timeout: 15_000 });
    await page.evaluate(() => (document as Document & { fonts?: { ready: Promise<unknown> } }).fonts?.ready);
    const cdp = await page.createCDPSession();
    if (o.transparent) await cdp.send("Emulation.setDefaultBackgroundColorOverride", { color: { r: 0, g: 0, b: 0, a: 0 } });
    for (let i = 0; i < frames; i++) {
      if (o.signal?.aborted) throw new JobError("Stopped.");
      await page.evaluate((t) => (window as unknown as { __rendrrAdvance: (t: number) => void }).__rendrrAdvance(t), i / fps);
      const shot = await cdp.send("Page.captureScreenshot", { format: "png", optimizeForSpeed: true, captureBeyondViewport: false });
      await writeFile(join(fdir, `f${String(i).padStart(5, "0")}.png`), Buffer.from(shot.data, "base64"));
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
  await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-framerate", String(fps), "-i", join(fdir, "f%05d.png"), "-r", String(GRAPHIC_LIMITS.fps),
    "-c:v", "libvpx-vp9", "-pix_fmt", o.transparent ? "yuva420p" : "yuv420p", "-b:v", "0", "-crf", "32", "-deadline", "realtime", "-cpu-used", "8", "-row-mt", "1", "-auto-alt-ref", "0", out], { signal: o.signal });
  const pick = [0, Math.floor(frames / 3), Math.floor((2 * frames) / 3), frames - 1].map((i) => join(fdir, `f${String(Math.min(frames - 1, i)).padStart(5, "0")}.png`));
  return { path: out, checkFrames: pick, seconds: frames / fps, width: w, height: h };
}

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
export async function renderGraphicClip(clip: V3Clip, o: { width: number; height: number; dir: string; userId: string; signal?: AbortSignal; durationSec?: number }): Promise<string | null> {
  const id = clip.graphicId!;
  // Drawn for as long as it is on screen in the edit (cut words inside the clip make that shorter), so its
  // ending animation is never cut off.
  const dur = Math.min(GRAPHIC_LIMITS.maxSeconds, Math.max(0.5, o.durationSec ?? clip.end - clip.start));
  const local = join(o.dir, `graphic-${clip.id}.webm`);
  const tpl = GRAPHIC_TEMPLATES.find((t) => t.id === id);
  if (tpl) {
    // Drawn at up to 720p (short side), keeping the output's shape; the overlay scales it to the output size.
    const { width: w, height: h } = templateSize(o.width, o.height);
    const logo = id === "gt_logo_reveal" ? await brandLogoDataUrl(o.userId) : null;
    const html = templateHtml(id, clip.params || {}, w, h, dur, logo);
    const hash = createHash("sha256").update(JSON.stringify([id, html, w, h, dur])).digest("hex").slice(0, 24);
    const key = `${PREFIX.graphics}${o.userId}/tpl-${hash}.webm`;
    if (await headObject(key)) { await downloadFile(key, local); return local; }
    const r = await recordHtml(html, { width: w, height: h, durationSec: dur, transparent: true, dir: o.dir, signal: o.signal });
    await uploadFile(key, r.path, "video/webm");
    return r.path;
  }
  const g = await prisma.graphic.findUnique({ where: { id } });
  if (!g || (g.ownerId && g.ownerId !== o.userId) || g.status !== "ready" || !g.renderedKey) return null;
  await downloadFile(g.renderedKey, local);
  return local;
}

export async function readCheckFrame(path: string) { return readFile(path); }
