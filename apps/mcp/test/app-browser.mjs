// The Rendrr app as Claude shows it: the page from the connector, in a sandboxed frame with the content security policy
// a host builds from its declared domains, talking MCP Apps (JSON-RPC over postMessage) to a stand-in host whose tools
// answer like Rendrr's. Checks: the projects grid; opening an edit plays its preview (from the storage origin only);
// a shimmer while the preview loads; comments at the player's moment, markers, jump, resolve; Send to Claude; a render's
// progress, then the new preview, which waits for play (nothing plays on its own); typing survives the polls; search;
// the web app's look; size. Real Chromium (Playwright), real video files.
//   node test/app-browser.mjs   (from apps/mcp; needs ffmpeg)
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, statSync, createReadStream } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
const require = createRequire(import.meta.url);
const { chromium } = require(require.resolve("playwright-core", { paths: [join(root, "apps/web"), root, ...(process.env.NODE_PATH || "").split(":").filter(Boolean)] }));
const APP = readFileSync(join(here, "../src/app/projects.html"), "utf8");
const fails = [];
const check = (ok, what) => { console.log(`${ok ? "ok  " : "FAIL"} ${what}`); if (!ok) fails.push(what); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Two previews and a thumbnail (WebM: this Chromium has no H.264; the app does not care what it plays).
const dir = mkdtempSync(join(tmpdir(), "rendrr-app-"));
const ff = (...a) => execFileSync("ffmpeg", ["-v", "error", "-y", ...a]);
ff("-f", "lavfi", "-i", "testsrc2=s=320x568:r=25:d=8", "-f", "lavfi", "-i", "sine=f=440:d=8", "-c:v", "libvpx-vp9", "-b:v", "300k", "-c:a", "libopus", "-shortest", join(dir, "v1.webm"));
ff("-f", "lavfi", "-i", "smptebars=s=320x568:r=25:d=6", "-f", "lavfi", "-i", "sine=f=660:d=6", "-c:v", "libvpx-vp9", "-b:v", "300k", "-c:a", "libopus", "-shortest", join(dir, "v2.webm"));
ff("-f", "lavfi", "-i", "testsrc2=s=320x180", "-frames:v", "1", join(dir, "thumb.jpg"));

// The storage: files with ranges, like signed links. A link changed on the way (its %2F turned into %252F) fails its
// signature, as on the real storage. slow=ms holds the first bytes back that long (a big preview on a slow line).
const media = createServer(async (req, res) => {
  const slow = Number(new URL(req.url, "http://x").searchParams.get("slow") || 0);
  if (slow && /^bytes=0-/.test(req.headers.range || "bytes=0-")) await sleep(slow);
  if (/%25/.test(req.url) || (req.url.includes("X-Amz-Credential") && !req.url.includes("X-Amz-Credential=tid%2F20261029%2Fiad"))) { res.statusCode = 403; return res.end(); }
  const f = join(dir, new URL(req.url, "http://x").pathname.slice(1));
  let size; try { size = statSync(f).size; } catch { res.statusCode = 404; return res.end(); }
  const type = f.endsWith(".jpg") ? "image/jpeg" : "video/webm";
  const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || "");
  if (m) { const a = +m[1], b = m[2] ? +m[2] : size - 1; res.writeHead(206, { "content-type": type, "content-range": `bytes ${a}-${b}/${size}`, "accept-ranges": "bytes", "content-length": b - a + 1 }); createReadStream(f, { start: a, end: b }).pipe(res); }
  else { res.writeHead(200, { "content-type": type, "content-length": size, "accept-ranges": "bytes" }); createReadStream(f).pipe(res); }
}).listen(0, "127.0.0.1");
await new Promise((r) => media.on("listening", r));
const M = `http://127.0.0.1:${media.address().port}`;

// Rendrr behind the host: two projects (one with two edits, one empty), comments, a render that moves on with each look.
const now = Date.now();
const db = {
  folders: [
    { id: "f1", name: "Spine clinic", edits: 2, updated: now - 3600e3, thumb: `${M}/thumb.jpg?X-Amz-Credential=tid%2F20261029%2Fiad&X-Amz-Signature=a`, aspect: "9:16", openComments: 1, rendering: false },
    { id: "f2", name: "New client", edits: 0, updated: now - 86400e3 * 5, thumb: null, aspect: null, openComments: 0, rendering: false },
  ],
  projects: [
    { id: "p1", name: "Knee pain reel", folder: "Spine clinic", folderId: "f1", aspect: "9:16", status: "In review", version: 2, updated: now - 3600e3, seconds: 8, thumb: `${M}/thumb.jpg?X-Amz-Credential=tid%2F20261029%2Fiad&X-Amz-Signature=a`, previewVersion: 1, rendering: false, openComments: 1 },
    { id: "p2", name: "Founder story", folder: "Spine clinic", folderId: "f1", aspect: "16:9", status: "Draft", version: 1, updated: now - 86400e3 * 2, seconds: null, thumb: null, previewVersion: null, rendering: false, openComments: 0 },
  ],
  comments: { p1: [{ id: "c0", time: 1.2, text: "The client wants the logo smaller", author: "Dana", mine: false, resolved: false, at: now - 7200e3 }], p2: [] },
  preview: { p1: { renderId: "r1", version: 1, url: `${M}/v1.webm?X-Amz-Signature=b&slow=1500`, seconds: 8, quality: "540p", at: now - 3600e3 }, p2: null },
  rendering: { p1: null, p2: null },
  older: { p1: [], p2: [] }, // previews a newer one replaced (the version menu keeps them)
  finals: { p1: [{ renderId: "rf1", version: 1, url: `${M}/v2.webm?X-Amz-Signature=f`, seconds: 6, quality: "1080p", at: now - 1800e3 }], p2: [] },
};
const calls = [];
const view = (id, renderId) => {
  const p = db.projects.find((x) => x.id === id);
  // Every rendered version, newest first (as Rendrr lists them); the one asked for, else the latest preview.
  const pv = (x, kind) => x && { ...x, kind, download: x.url + "&dl=1", fileName: `${p.name} ${kind} v${x.version}.mp4` };
  const all = [pv(db.preview[id], "preview"), ...db.older[id].map((x) => pv(x, "preview")), ...db.finals[id].map((x) => pv(x, "final"))].filter(Boolean).sort((a, b) => b.at - a.at);
  const shown = (renderId && all.find((x) => x.renderId === renderId)) || pv(db.preview[id], "preview") || all.find((x) => x.kind === "final") || null;
  return { project: { id: p.id, name: p.name, folder: p.folder, folderId: p.folderId, aspect: p.aspect, status: p.status, version: p.version, updated: p.updated, seconds: p.seconds, editorUrl: `https://app.rendrr.live/editor/${p.id}` },
    preview: shown, versions: all.map(({ renderId: r, version, kind, quality, at }) => ({ renderId: r, version, kind, quality, at })), rendering: db.rendering[id], failed: null, comments: [...db.comments[id]].sort((a, b) => a.time - b.time) };
};
function tool(name, args) {
  calls.push({ name, args });
  if (name === "app_list_projects") {
    const ps = db.projects.filter((p) => (!args.query || p.name.toLowerCase().includes(args.query.toLowerCase())) && (!args.folderId || p.folderId === args.folderId));
    const f = args.folderId ? db.folders.find((x) => x.id === args.folderId) : null;
    return { projects: ps, total: ps.length, offset: 0, ...(!args.folderId && !args.query ? { folders: db.folders } : {}), folder: f ? { id: f.id, name: f.name } : null };
  }
  if (name === "app_get_project") {
    const r = db.rendering[args.projectId];
    if (r) { r.percent += 45; r.queued = false; r.step = "Encoding"; if (r.percent >= 100) { db.rendering[args.projectId] = null; db.older[args.projectId].unshift(db.preview[args.projectId]); db.preview[args.projectId] = { renderId: "r2", version: 2, url: `${M}/v2.webm?X-Amz-Signature=c`, seconds: 6, quality: "540p", at: Date.now() }; } }
    return view(args.projectId, args.renderId);
  }
  if (name === "app_rename_project") { db.projects.find((x) => x.id === args.projectId).name = args.name; return view(args.projectId); }
  // Pictures come back as data: links here (Rendrr gives signed storage links); drawings as their strokes.
  const pics = (ims = []) => ims.map((im, i) => ({ id: "im" + calls.length + "-" + i, url: `data:${im.type};base64,${im.data}`, w: im.w ?? null, h: im.h ?? null, name: im.name ?? null }));
  if (name === "app_add_comment") { db.comments[args.projectId].push({ id: "c" + calls.length, time: args.time, text: args.text, author: "Ana", mine: true, resolved: false, at: Date.now(), edited: false, renderId: args.renderId ?? null, drawing: args.drawing ? { w: args.drawing.w, h: args.drawing.h, strokes: args.drawing.strokes } : null, images: pics(args.images) }); return view(args.projectId); }
  if (name === "app_edit_comment") {
    const c = db.comments[args.projectId].find((x) => x.id === args.commentId);
    if (args.text !== undefined) c.text = args.text;
    if (args.drawing !== undefined) c.drawing = args.drawing && { w: args.drawing.w, h: args.drawing.h, strokes: args.drawing.strokes };
    c.images = c.images.filter((im) => !(args.removeImages || []).includes(im.id)).concat(pics(args.images));
    c.edited = true; return view(args.projectId);
  }
  if (name === "app_share_link") return { url: `https://app.rendrr.live/review/tok-${args.projectId}`, version: args.version ?? 2, created: true, expires: null, allowDownload: false };
  if (name === "app_delete_comment") { db.comments[args.projectId] = db.comments[args.projectId].filter((x) => x.id !== args.commentId); return view(args.projectId); }
  if (name === "app_resolve_comment") { const c = db.comments[args.projectId].find((x) => x.id === args.commentId); c.resolved = args.resolved !== false; return view(args.projectId); }
  if (name === "app_render_preview") { db.rendering[args.projectId] = { renderId: "r2", version: 2, percent: 10, step: null, etaSec: 40, queued: true }; return view(args.projectId); }
  throw new Error("no tool " + name);
}

// The host page: a sandboxed frame, the CSP built from the declared domains, the MCP Apps host side.
const FONTS = "https://fonts.googleapis.com https://fonts.gstatic.com";
const csp = `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline' ${FONTS}; img-src ${M} data:; media-src ${M}; font-src ${FONTS}; connect-src 'none'; frame-src 'none'; base-uri 'none'`;
const doc = APP.replace("<head>", `<head><meta http-equiv="Content-Security-Policy" content="${csp}">`);
const hostHtml = `<!doctype html><meta charset=utf8><meta name=viewport content="width=device-width, initial-scale=1"><body style="margin:0;background:#fff"><iframe id=app sandbox="allow-scripts" style="width:900px;border:0;height:600px"></iframe><script>
const f = document.getElementById("app");
const phone = location.search.includes("phone");
// tall: a panel that gives the app a frame taller than the screen and cuts it off (nothing outside the app scrolls).
const tall = location.search.includes("tall");
if (phone) f.style.width = "100vw";
if (tall) document.body.style.overflow = "hidden";
window.log = [];
window.addEventListener("message", async (e) => {
  if (e.source !== f.contentWindow) return;
  const m = e.data; window.log.push(m);
  const reply = (result) => f.contentWindow.postMessage({ jsonrpc: "2.0", id: m.id, result }, "*");
  if (m.method === "ui/initialize") reply({ protocolVersion: "2026-01-26", hostInfo: { name: "test-host", version: "1" }, hostCapabilities: { openLinks: {}, serverTools: {}, message: { text: {} }, updateModelContext: { text: {} } },
    hostContext: { theme: "light", displayMode: "inline", availableDisplayModes: ["inline", "fullscreen"], styles: { variables: { "--color-background-primary": "rgb(250, 249, 245)" } }, ...(phone ? { platform: "mobile" } : {}) } });
  else if (m.method === "ui/notifications/initialized") {
    f.contentWindow.postMessage({ jsonrpc: "2.0", method: "ui/notifications/tool-input", params: { arguments: {} } }, "*");
    const data = await window.hostTool("open", {});
    f.contentWindow.postMessage({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: { content: [{ type: "text", text: "Showing" }], structuredContent: data } }, "*");
  }
  else if (m.method === "tools/call") { try { const d = await window.hostTool(m.params.name, m.params.arguments); reply({ content: [{ type: "text", text: "ok" }], structuredContent: d }); } catch (err) { reply({ content: [{ type: "text", text: String(err.message || err) }], isError: true }); } }
  else if (m.method === "ui/message" || m.method === "ui/open-link" || m.method === "ui/update-model-context") reply({});
  // Full screen: a fixed panel, as a host gives it; inline: the frame follows the app's height.
  else if (m.method === "ui/request-display-mode") {
    window.fs = m.params.mode === "fullscreen";
    f.style.width = phone ? "100vw" : window.fs ? "1200px" : "900px"; f.style.height = window.fs ? (phone ? (tall ? "2000px" : "100vh") : "1000px") : (window.inlineH || 600) + "px";
    reply({ mode: m.params.mode });
    // A phone's full-screen panel lays its header and chat box over the app, but its safe area insets count only the
    // phone's notch and home bar (as Claude's phone app does).
    f.contentWindow.postMessage({ jsonrpc: "2.0", method: "ui/notifications/host-context-changed", params: { displayMode: m.params.mode, ...(phone ? { safeAreaInsets: window.fs ? { top: 47, right: 0, bottom: 34, left: 0 } : { top: 0, right: 0, bottom: 0, left: 0 } } : {}) } }, "*");
  }
  else if (m.method === "ui/notifications/size-changed") { window.inlineH = Math.min(1400, m.params.height); if (!window.fs) f.style.height = window.inlineH + "px"; }
});
f.srcdoc = ${JSON.stringify(doc).replace(/<\//g, "<\\/")};
</script>`;
const host = createServer((_req, res) => { res.setHeader("content-type", "text/html"); res.end(hostHtml); }).listen(0, "127.0.0.1");
await new Promise((r) => host.on("listening", r));

const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome", args: ["--autoplay-policy=no-user-gesture-required"] }).catch(() => chromium.launch());
const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
const errors = [], violations = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => { if (/Content Security Policy|Refused to/i.test(m.text())) violations.push(m.text()); if (m.type() === "error") errors.push(m.text()); });
await page.exposeFunction("hostTool", (name, args) => (name === "open" ? { ...tool("app_list_projects", {}), open: null, webUrl: "https://app.rendrr.live" } : tool(name, args)));
await page.goto(`http://127.0.0.1:${host.address().port}/`);
const app = page.frameLocator("#app");
const frame = () => page.frame({ url: /about:srcdoc/ }) ?? page.frames()[1];
const hostLog = () => page.evaluate(() => window.log.map((m) => ({ method: m.method, params: m.params })));
const seekTo = (t) => frame().evaluate((x) => new Promise((ok) => { const v = document.querySelector("video"); v.pause(); v.addEventListener("seeked", () => ok(), { once: true }); v.currentTime = x; }), t);

// 1. The projects first, one card each; open one to see only its videos (in the Rendrr web app's look, sized to fit).
await app.locator(".card").first().waitFor({ timeout: 10000 }).catch(async (e) => { console.log("LOG", JSON.stringify(await hostLog()).slice(0, 2000)); console.log("ERR", errors, violations); console.log("HTML", (await frame()?.content())?.slice(-1500)); throw e; });
check((await app.locator(".card.proj").count()) === 2 && !(await app.locator("[data-edit]").count()) && /^Projects$/i.test(await app.locator("#list-title").innerText()), "the app opens on the projects, not a pile of every edit");
const f1Text = await app.locator('[data-folder="f1"]').innerText();
check(/Spine clinic/.test(f1Text) && /2 videos/.test(f1Text) && /1 open comment/.test(f1Text), `a project card names it, counts its videos and open comments (${f1Text.replace(/\s+/g, " ")})`);
check(/0 videos/.test(await app.locator('[data-folder="f2"]').innerText()) && /No videos yet/.test(await app.locator('[data-folder="f2"]').innerText()), "an empty project says so");
await app.locator('[data-folder="f1"]').click();
await app.locator("[data-edit]").first().waitFor({ timeout: 5000 });
check(calls.some((c) => c.name === "app_list_projects" && c.args.folderId === "f1") && /Spine clinic/i.test(await app.locator("#list-title").innerText()), "opening a project asks Rendrr for its videos and names it");
check((await app.locator(".card").count()) === 2, "the project shows its two videos");
check(/Knee pain reel/.test(await app.locator(".card").first().innerText()) && /Preview v1/.test(await app.locator(".card").first().innerText()) && /1 open comment/.test(await app.locator(".card").first().innerText()), "a card says its preview and open comments");
check(/No preview/.test(await app.locator(".card").nth(1).innerText()), "an edit without a preview says so");
check(await frame().evaluate(() => getComputedStyle(document.body).backgroundColor === "rgb(15, 17, 19)" && !document.documentElement.style.getPropertyValue("--color-background-primary")), "the Rendrr web app's own dark look, though the host is light");
check(await frame().evaluate(() => { const t = getComputedStyle(document.querySelector("h1")); return /Space Grotesk/.test(t.fontFamily) && t.textTransform === "uppercase" && t.fontWeight === "700"; }), "titles in the web app's Space Grotesk, bold, upper case");
check(await frame().evaluate(() => { const c = document.querySelector(".card"); const o = c.querySelector(".thumb .over .name"); return getComputedStyle(c).backgroundColor === "rgb(28, 30, 33)" && !!o && o.textContent.length > 0; }), "project cards as in the web app (surface colour, the name over the picture)");
const thumbOk = await frame().evaluate(() => new Promise((r) => { const i = document.querySelector(".thumb img"); if (!i) return r("no picture"); const done = () => r(i.complete && i.naturalWidth > 0 ? true : "not loaded"); i.complete ? done() : (i.onload = done, i.onerror = done); }));
check(thumbOk === true, `thumbnails load from the storage origin, their signed links as given (${thumbOk})`);
check(await frame().evaluate(() => { const r = (q) => document.querySelector(q).getBoundingClientRect(); const h1 = r("h1"); return h1.height < 40 && r(".top .ibtn.accent").top < h1.bottom + 20; }), "the header fits: the title on one line, the buttons beside it");
const sized = (await hostLog()).filter((m) => m.method === "ui/notifications/size-changed");
check(sized.length >= 1 && sized[sized.length - 1].params.height > 200, `the app tells the host its height (${sized.map((s) => s.params.height).join(", ")})`);
check((await app.locator('button[aria-label="Full screen"]').count()) === 1, "the grid offers full screen");
await page.screenshot({ path: join(dir, "app-list.png") });

// 2. Search keeps the field focused while results come back.
await app.locator(".search").click(); await app.locator(".search").pressSequentially("knee", { delay: 40 }); await sleep(700);
check(calls.some((c) => c.name === "app_list_projects" && c.args.query === "knee" && c.args.folderId === "f1") && (await app.locator(".card").count()) === 1, "search in a project asks Rendrr and shows the match");
check(await frame().evaluate(() => document.activeElement?.classList.contains("search") && document.activeElement.value === "knee"), "the search field keeps focus and text");
await app.locator(".search").fill(""); await sleep(600);

// 3. Open an edit: it opens full screen (the host's panel): the player on top, the comments in the middle, the box to
// write one at the bottom. Its preview plays, from the storage origin, under the policy, with Rendrr's own controls
// (the time in milliseconds, a seek bar with the comments on it, steps of 0.1 s).
await app.locator(".card").first().click();
await app.locator("video").waitFor({ timeout: 10000 });
// While the first picture is on its way: a shimmer over the player, at the edit's shape (not a small black box).
const loading = await frame().evaluate(() => { const f = document.querySelector(".frame"), l = document.querySelector(".load"), v = document.querySelector("video").getBoundingClientRect(); return { on: f.classList.contains("loading"), shown: getComputedStyle(l).visibility === "visible", text: l.innerText, w: v.width, h: v.height, ready: document.querySelector("video").readyState }; });
check(loading.on && loading.shown && /Loading preview/.test(loading.text) && loading.ready < 2, `a shimmer shows while the preview loads (${loading.text}, ready ${loading.ready})`);
check(Math.abs(loading.w / loading.h - 9 / 16) < 0.02 && loading.h >= 400, `the player keeps the edit's shape while it loads (${Math.round(loading.w)}x${Math.round(loading.h)})`);
await page.screenshot({ path: join(dir, "app-loading.png") });
await frame().waitForFunction(() => !document.querySelector(".frame").classList.contains("loading"), null, { timeout: 10000 }).catch(() => {});
check(await frame().evaluate(() => document.querySelector("video").readyState >= 2 && !document.querySelector(".frame").classList.contains("loading")), "the shimmer goes once the picture is in");
check(await frame().evaluate(() => document.querySelector("video").paused && document.querySelector("video").currentTime === 0), "opening an edit does not play it: the user presses play");
await sleep(300);
check((await hostLog()).some((m) => m.method === "ui/request-display-mode" && m.params.mode === "fullscreen") && await frame().evaluate(() => document.documentElement.classList.contains("fs")), "opening an edit asks the host for full screen");
const boxes = () => frame().evaluate(() => {
  const r = (q) => document.querySelector(q).getBoundingClientRect();
  const v = r(".stage"), l = r(".side > .list, .side > .empty"), c = r(".compose");
  return { vh: document.querySelector("video").getBoundingClientRect().height, listH: l.height, order: v.bottom <= l.top && l.bottom <= c.top, gapBelow: Math.round(innerHeight - c.bottom), h: innerHeight, fs: document.documentElement.classList.contains("fs") };
});
const fsBox = await boxes();
check(fsBox.order && fsBox.gapBelow <= 30 && fsBox.vh >= 400 && fsBox.listH >= 140, `full screen: the player on top (${Math.round(fsBox.vh)} of ${fsBox.h} px), the comments in the middle (${Math.round(fsBox.listH)} px), the box at the bottom (${fsBox.gapBelow} px from the edge)`);
const fsSizes = (await hostLog()).filter((m) => m.method === "ui/notifications/size-changed").length;
check(calls.some((c) => c.name === "app_get_project" && c.args.projectId === "p1"), "opening an edit asks Rendrr for it");
await frame().waitForFunction(() => document.querySelector("video").readyState >= 2, null, { timeout: 10000 }).catch(() => {});
check(await frame().evaluate(() => document.querySelector("video").readyState >= 2), "the preview loads in the player");
check(await frame().evaluate(() => !document.querySelector("video").controls), "the player has Rendrr's controls, not the browser's (they show whole seconds)");
check(await frame().evaluate(() => [...document.querySelector(".frame").children].every((e) => ["VIDEO", "CANVAS"].includes(e.tagName) || e.matches(".load, .fail"))), "nothing sits on the picture (no time or version over the video)");
await app.locator(".ctrl .ibtn").first().click();
await frame().waitForFunction(() => document.querySelector("video").currentTime > 1.6, null, { timeout: 10000 }).catch(() => {});
const tcPlaying = await app.locator(".tc").innerText();
check(/^00:0[1-9]\.\d{3} \/ 00:08\.\d{3}$/.test(tcPlaying) && await frame().evaluate(() => !document.querySelector("video").paused), `the play button plays; the time shows milliseconds (${tcPlaying})`);
await page.screenshot({ path: join(dir, "app-fullscreen.png") });
await app.locator(".ctrl .ibtn").first().click(); await sleep(150);
check(await frame().evaluate(() => document.querySelector("video").paused), "and pauses");
const seekW = await app.locator(".seek").evaluate((e) => e.getBoundingClientRect().width);
await app.locator(".seek").click({ position: { x: seekW * 0.75, y: 11 } }); await sleep(250);
const afterSeek = await frame().evaluate(() => document.querySelector("video").currentTime);
check(Math.abs(afterSeek - 6) < 0.25, `the seek bar moves the player (to ${afterSeek.toFixed(3)} s)`);
await app.locator(".pv .top .meta").click(); // the page (the name itself opens to rename)
await page.keyboard.press("ArrowLeft"); await sleep(150);
await page.keyboard.press("Shift+ArrowLeft"); await sleep(150);
const afterKeys = await frame().evaluate(() => document.querySelector("video").currentTime);
check(Math.abs(afterSeek - 1.1 - afterKeys) < 0.02, `arrow keys step 0.1 s, with Shift 1 s (${afterSeek.toFixed(3)} to ${afterKeys.toFixed(3)})`);
await app.locator(".ctrl .step", { hasText: "+0.1" }).click(); await sleep(150);
const t = await frame().evaluate(() => document.querySelector("video").currentTime);
check(Math.abs(t - afterKeys - 0.1) < 0.02, `the +0.1 s button steps on (${t.toFixed(3)})`);
{ // The shown time is the video's to the ms (2 ms of slack: the clock and the text are read a moment apart).
  const tc = await app.locator(".tc").innerText(), m = /^(\d+):(\d+)\.(\d{3})/.exec(tc), now = await frame().evaluate(() => document.querySelector("video").currentTime);
  check(!!m && Math.abs(+m[1] * 60 + +m[2] + +m[3] / 1000 - now) <= 0.002, `the time shows the exact moment (${tc}, video at ${now.toFixed(4)})`); }
check(/^at 00:0\d\.\d{3}$/.test(await app.locator(".at").innerText()), `the new comment's moment follows the player (${await app.locator(".at").innerText()})`);
check(/v2 has changes the latest preview \(v1\) does not show yet/.test(await app.locator("body").innerText()), "it says the latest version has no preview yet");
check((await app.locator(".seek .mk").count()) === 1, "the client's comment is a pin under the seek bar");
// The seek bar is big enough to hold: a tall strip to press, dragged with the picture following.
const sb = await app.locator(".seek .hit").boundingBox(), bar = await app.locator(".seek .bar").boundingBox();
check(sb.height >= 36 && (await app.locator(".seek").boundingBox()).height >= 60, `the seek bar is a tall strip to grab (${Math.round((await app.locator(".seek").boundingBox()).height)} px, was 22)`);
await page.mouse.move(bar.x + bar.width * 0.2, sb.y + 4); await page.mouse.down();
for (let k = 1; k <= 10; k++) { await page.mouse.move(bar.x + bar.width * (0.2 + k * 0.04), sb.y + 30); await sleep(15); }
check(await frame().evaluate(() => document.querySelector(".seek").classList.contains("drag") && /^00:0\d\.\d{3}$/.test(document.querySelector(".seek .tip").textContent)), "dragging shows the time under the finger");
await page.mouse.up(); await sleep(300);
const dragged = await frame().evaluate(() => document.querySelector("video").currentTime / document.querySelector("video").duration);
check(Math.abs(dragged - 0.6) < 0.04, `dragging along it moves the player with it, even below the strip (${(dragged * 100).toFixed(1)}%)`);
// The pin: its author's initial, pointing at its moment; pressing it goes there, paused, and shows the comment.
const pin = app.locator(".seek .mk").first();
check((await pin.innerText()) === "D" && await pin.evaluate((e) => e.classList.contains("client")), "the pin shows its author's initial (Dana, a client)");
const pinX = await pin.evaluate((e) => { const r = e.getBoundingClientRect(), b = document.querySelector(".seek .bar").getBoundingClientRect(); return (r.left + r.width / 2 - b.left) / b.width; });
const want = await frame().evaluate(() => 1.2 / document.querySelector("video").duration);
check(Math.abs(pinX - want) < 0.01, `it sits under its moment (${(pinX * 100).toFixed(1)}% for ${(want * 100).toFixed(1)}%)`);
await pin.click(); await sleep(400);
check(await frame().evaluate(() => Math.abs(document.querySelector("video").currentTime - 1.2) < 0.05 && document.querySelector("video").paused && document.querySelector(".seek .mk.on") !== null), "pressing it goes to the comment's moment, paused");
await frame().evaluate((x) => { document.querySelector("video").currentTime = x; }, t); await sleep(200); // back where the steps left it
check((await hostLog()).filter((m) => m.method === "ui/notifications/size-changed").length === fsSizes, "full screen, the app does not resize the host's panel");
// Back in the chat: the same order, the frame as tall as the app.
await app.locator('button[aria-label="Exit full screen"]').click(); await sleep(400);
const inBox = await boxes();
check(!inBox.fs && inBox.order && inBox.vh >= 500, `in the chat: the same order, a tall player (${Math.round(inBox.vh)} px; the frame grows to fit, so no vh)`);
check(await frame().evaluate(() => document.querySelector("video").currentTime > 1.6), "the player keeps its place when the view changes");

// 4. A comment at this moment: saved with the player's time, listed, marked, and the AI is told.
await app.locator("textarea").click();
check(!(await app.locator(".seek .pin.draft.show").count()), "no lime pin before anything is written");
await app.locator("textarea").pressSequentially("Cut the pause before this line", { delay: 10 });
check((await app.locator(".seek .pin.draft.show").count()) === 1, "the comment being written has a lime pin at its moment");
await app.locator("textarea").press("Control+Enter");
await app.locator(".cm", { hasText: "Cut the pause before this line" }).waitFor({ timeout: 5000 });
const added = calls.find((c) => c.name === "app_add_comment");
check(!!added && Math.abs(added.args.time - t) < 0.01 && added.args.projectId === "p1", `the comment is saved at the player's moment (${added?.args.time})`);
check((await app.locator(".seek .mk").count()) === 2, "it gets a pin too");
check((await hostLog()).some((m) => m.method === "ui/update-model-context" && /Cut the pause before this line/.test(m.params.content[0].text)), "the AI's context hears about the new comment");
check((await app.locator("textarea").inputValue()) === "", "the box is empty again");

// 5. Jump to a comment; resolve and open it again.
await app.locator(".cm .t").first().click(); await sleep(400);
check(Math.abs((await frame().evaluate(() => document.querySelector("video").currentTime)) - 1.2) < 0.05, "a comment's time jumps the player there");
await app.locator(".cm .chk").first().click(); await sleep(300);
check(calls.some((c) => c.name === "app_resolve_comment" && c.args.commentId === "c0" && c.args.resolved === true), "resolving asks Rendrr");
check(/Open 1/.test(await app.locator(".tabs").innerText()) && /All 2/.test(await app.locator(".tabs").innerText()), "the open count goes down");
check((await app.locator(".seek .mk").count()) === 1 && (await app.locator(".seek .tick").count()) === 1 && (await app.locator(".seek .mk.client").count()) === 0, "a resolved comment's pin leaves the seek bar (the change is done)");
await app.locator(".tab", { hasText: "All" }).click();
await app.locator(".cm.done .chk").first().click(); await sleep(300);
check(calls.some((c) => c.name === "app_resolve_comment" && c.args.resolved === false), "a resolved comment opens again");
check((await app.locator(".seek .mk").count()) === 2 && (await app.locator(".seek .mk.client").count()) === 1, "and its pin comes back");

// 6. Send to Claude: one message with the open comments and how to work through them.
await app.locator("button", { hasText: "Send to Claude" }).click(); await sleep(300);
const msg = (await hostLog()).find((m) => m.method === "ui/message");
check(!!msg && msg.params.role === "user" && /Knee pain reel/.test(msg.params.content[0].text) && /00:01\.200 The client wants the logo smaller/.test(msg.params.content[0].text) && /get_comments/.test(msg.params.content[0].text) && /render one preview/.test(msg.params.content[0].text), "Send to Claude posts the open comments to the chat");
await page.screenshot({ path: join(dir, "app-project.png") });

// 6b. Draw on the picture, add a picture and a link, comment; the comment shows them all; edit it; delete it.
const picFile = join(dir, "shot.png");
ff("-f", "lavfi", "-i", "color=c=0x3366ff:s=200x120", "-frames:v", "1", picFile);
await seekTo(3.5);
await app.locator(".ctrl button", { hasText: "Draw" }).click(); await sleep(200);
check(await frame().evaluate(() => document.querySelector(".ink").classList.contains("on") && document.querySelector("video").paused), "Draw pauses the player and turns on drawing over the picture");
const inkBox = await app.locator(".ink").boundingBox(), vidBox = await frame().evaluate(() => { const v = document.querySelector("video"), r = v.getBoundingClientRect(), k = Math.min(r.width / v.videoWidth, r.height / v.videoHeight); return { w: v.videoWidth * k, h: v.videoHeight * k }; });
check(Math.abs(inkBox.width - vidBox.w) < 2 && Math.abs(inkBox.height - vidBox.h) < 2, `the drawing area is exactly the picture (${Math.round(inkBox.width)}x${Math.round(inkBox.height)} for ${Math.round(vidBox.w)}x${Math.round(vidBox.h)})`);
await app.locator(".pen").nth(1).click();
const fBox = await page.locator("#app").boundingBox();
const at = (fx, fy) => [fBox.x + inkBox.x + inkBox.width * fx, fBox.y + inkBox.y + inkBox.height * fy];
await page.mouse.move(...at(0.3, 0.3)); await page.mouse.down();
for (let k = 1; k <= 10; k++) await page.mouse.move(...at(0.3 + 0.03 * k, 0.3 + 0.02 * k));
await page.mouse.up(); await sleep(150);
const inked = await frame().evaluate(() => { const c = document.querySelector(".ink"), d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 100) n++; return n; });
check(inked > 200, `the stroke shows on the picture (${inked} px)`);
await app.locator(".ctrl button", { hasText: "Done" }).click(); await sleep(150);
check((await app.locator(".compose .badge", { hasText: "Drawing" }).count()) === 1, "the comment box holds the drawing");
const chooser = page.waitForEvent("filechooser");
await app.locator(".compose button", { hasText: "Picture" }).click();
await (await chooser).setFiles(picFile); await sleep(500);
check((await app.locator(".compose .att canvas").count()) === 1, "a picture added from a file shows in the box");
// A picture pasted into the box too, then taken off again.
await app.locator("textarea").click();
await frame().evaluate(async () => { const b = new Blob([Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="), (ch) => ch.charCodeAt(0))], { type: "image/png" }); const dt = new DataTransfer(); dt.items.add(new File([b], "pasted.png", { type: "image/png" })); document.querySelector("textarea").dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true })); });
await sleep(400);
check((await app.locator(".compose .att").count()) === 2, "a picture pasted into the box shows too");
await app.locator(".compose .att .x").nth(1).click(); await sleep(150);
check((await app.locator(".compose .att").count()) === 1, "and comes off with its ×");
await app.locator("textarea").click();
await app.locator("textarea").pressSequentially("Make the logo smaller like www.example.com/ref.", { delay: 5 });
await app.locator("textarea").press("Control+Enter");
await app.locator(".cm", { hasText: "Make the logo smaller" }).waitFor({ timeout: 5000 });
const sent = calls.filter((c) => c.name === "app_add_comment").pop().args;
const st = sent.drawing?.strokes?.[0];
check(!!st && st.c === "#ffd60a" && sent.drawing.strokes.length === 1 && st.p.length >= 10 && Math.abs(st.p[0] - 0.3) < 0.02 && Math.abs(st.p[1] - 0.3) < 0.02 && Math.abs(sent.time - 3.5) < 0.05, `the drawing goes with the comment, at its moment, in picture terms (${st?.c}, ${st?.p.length / 2} points from ${st?.p.slice(0, 2)})`);
check(/^iVBORw0KGgo/.test(sent.drawing.png || "") && sent.drawing.w === 320 && sent.drawing.h === 568, `with its clear PNG at the picture's size (${sent.drawing.w}x${sent.drawing.h})`);
check(sent.images?.length === 1 && sent.images[0].type === "image/png" && sent.images[0].name === "shot.png" && sent.renderId === "r1", "the picture goes with it, and the preview it was made on");
const cm = app.locator(".cm", { hasText: "Make the logo smaller" });
check((await cm.locator("a").getAttribute("href")) === "https://www.example.com/ref", "a web address in a comment is a link");
await cm.locator("a").click(); await sleep(200);
check((await hostLog()).some((m) => m.method === "ui/open-link" && m.params.url === "https://www.example.com/ref"), "and opens through the host");
await seekTo(0.5);
await cm.locator(".badge", { hasText: "Drawing" }).click(); await sleep(300);
const shown = await frame().evaluate(() => { const v = document.querySelector("video"), c = document.querySelector(".ink"), d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 100) n++; return { t: v.currentTime, n }; });
check(Math.abs(shown.t - 3.5) < 0.05 && shown.n > 200, `its drawing shows on the picture at its moment (${shown.t.toFixed(3)} s, ${shown.n} px)`);
await cm.locator(".thumbimg").click(); await sleep(200);
check((await app.locator(".lightbox img").count()) === 1, "a picture opens big");
await app.locator(".lightbox").click(); await sleep(150);
check((await app.locator(".lightbox").count()) === 0, "and closes");
await page.screenshot({ path: join(dir, "app-comments.png") });
// Edit: new words, the picture off.
await cm.locator(".act", { hasText: "Edit" }).click(); await sleep(200);
check(/Editing your comment at 00:03\.5/.test(await app.locator(".compose").innerText()) && (await app.locator("textarea").inputValue()).startsWith("Make the logo smaller"), "Edit puts the comment in the box");
await app.locator("textarea").fill("Logo 20% smaller");
await app.locator(".compose .att .x").first().click();
await app.locator(".compose button", { hasText: "Save" }).click();
await app.locator(".cm", { hasText: "Logo 20% smaller" }).waitFor({ timeout: 5000 });
const ed = calls.filter((c) => c.name === "app_edit_comment").pop().args;
check(ed.text === "Logo 20% smaller" && ed.removeImages?.length === 1 && ed.drawing === undefined, "Save sends the new words and the picture to take off (the drawing stays)");
check(/edited/.test(await app.locator(".cm", { hasText: "Logo 20% smaller" }).innerText()), "the comment says it was edited");
// Delete asks once more.
const del = app.locator(".cm", { hasText: "Logo 20% smaller" }).locator(".act", { hasText: "Delete" });
await del.click(); await sleep(100);
check((await del.innerText()) === "Delete?" && !calls.some((c) => c.name === "app_delete_comment"), "Delete asks again first");
await del.click(); await sleep(300);
check(calls.some((c) => c.name === "app_delete_comment") && (await app.locator(".cm", { hasText: "Logo 20% smaller" }).count()) === 0, "and then deletes it");

// 6c. Share: a review link for the version being watched, to copy or open.
await app.locator('.top button[aria-label="Share"]').click();
await app.locator(".share input").waitFor({ timeout: 5000 });
const shareCall = calls.filter((c) => c.name === "app_share_link").pop();
check(shareCall?.args.version === 1 && (await app.locator(".share input").inputValue()) === "https://app.rendrr.live/review/tok-p1", "Share makes the review link for the version being watched");
check(/Share v1/.test(await app.locator(".share").innerText()) && /no account needed/.test(await app.locator(".share").innerText()), "and says who can use it");
await app.locator(".share button", { hasText: "Copy link" }).click(); await sleep(200);
check(/Link copied|Select the link/.test(await app.locator("#toast").innerText()), `Copy link copies it (${await app.locator("#toast").innerText()})`);
await app.locator(".share button", { hasText: "Open" }).click(); await sleep(200);
check((await hostLog()).some((m) => m.method === "ui/open-link" && m.params.url === "https://app.rendrr.live/review/tok-p1"), "Open opens it through the host");
await app.locator(".share button", { hasText: "×" }).click(); await sleep(100);
check((await app.locator(".share").count()) === 0, "the panel closes");

// 7. Render the latest version: progress while it renders, typing survives the polls, then the new preview, waiting for
// play.
await app.locator("button", { hasText: "Render preview" }).click();
await app.locator(".prog").waitFor({ timeout: 5000 });
check(/Waiting to render v2/.test(await app.locator(".note").first().innerText()), "the render shows as waiting");
await app.locator("textarea").click(); await app.locator("textarea").pressSequentially("half typed", { delay: 10 });
await app.locator(".note", { hasText: "Rendering v2" }).waitFor({ timeout: 6000 });
check(/Rendering v2 · 55% · Encoding/.test(await app.locator(".note").first().innerText()), `progress comes in (${(await app.locator(".note").first().innerText()).split("\n")[0]})`);
check(await frame().evaluate(() => document.activeElement?.tagName === "TEXTAREA" && document.activeElement.value === "half typed"), "typing keeps its place while progress comes in");
await frame().waitForFunction(() => /v2\.webm/.test(document.querySelector("video")?.getAttribute("src") || ""), null, { timeout: 8000 }).catch(() => {});
check(/v2\.webm/.test(await frame().evaluate(() => document.querySelector("video").getAttribute("src"))), "the new preview replaces the old one when it is done");
await frame().waitForFunction(() => document.querySelector("video").readyState >= 2, null, { timeout: 8000 }).catch(() => {});
await sleep(1200);
check(await frame().evaluate(() => { const v = document.querySelector("video"); return v.readyState >= 2 && v.paused && v.currentTime === 0; }), "and does not play on its own");
check(/Preview v2 is ready\. Press play to watch\./.test(await app.locator("#toast").innerText()), "it says the new preview is ready to play");
check(!/has changes the latest preview/.test(await app.locator("body").innerText()), "the note about missing changes is gone");

// 7b. The header: icons with their names on hover; download what is watched; the versions to watch; rename.
const acts = await frame().evaluate(() => [...document.querySelectorAll(".pv .top .acts button, .pv .top > button")].map((b) => ({ label: b.getAttribute("aria-label"), title: b.title, svg: !!b.querySelector("svg"), text: b.innerText.trim() })));
check(acts.length === 5 && acts.every((a) => a.svg && !a.text && a.title) && ["Back to Spine clinic", "Share", "Download", "Open in Rendrr"].every((l) => acts.some((a) => a.label === l)) && acts.some((a) => /^(Exit )?[Ff]ull screen$/.test(a.label)), `the header buttons are icons, named on hover (${acts.map((a) => a.label).join(", ")})`);
await app.locator('button[aria-label="Download"]').click(); await sleep(200);
check((await hostLog()).some((m) => m.method === "ui/open-link" && /v2\.webm\?X-Amz-Signature=c&dl=1$/.test(m.params.url)) && /Downloading Knee pain reel preview v2\.mp4/.test(await app.locator("#toast").innerText()), "Download gets the file being watched (through the host)");
const opts = await app.locator("select.ver option").allInnerTexts();
check(opts.join(" | ") === "v2 · Preview | v1 · Final 1080p | v1 · Preview", `the version menu lists every render, newest first (${opts.join(" | ")})`);
await app.locator("select.ver").selectOption("rf1");
await frame().waitForFunction(() => /X-Amz-Signature=f/.test(document.querySelector("video")?.getAttribute("src") || ""), null, { timeout: 5000 }).catch(() => {});
check(calls.some((c) => c.name === "app_get_project" && c.args.renderId === "rf1") && /X-Amz-Signature=f/.test(await frame().evaluate(() => document.querySelector("video").getAttribute("src"))), "picking the final plays the final");
check(/v1 · Final/.test(await app.locator("select.ver option:checked").innerText()) && /the final/.test(await app.locator('button[aria-label="Download"]').getAttribute("title")) && await frame().evaluate(() => document.querySelector("video").paused), "the player says it is the final, Download takes the final, nothing plays on its own");
check(!/has changes the latest preview/.test(await app.locator("body").innerText()) && !/Preview v1 is ready/.test(await app.locator("#toast").innerText()), "watching an older render is not news, and no note asks for a render");
await app.locator("select.ver").selectOption("r2");
await frame().waitForFunction(() => /v2\.webm\?X-Amz-Signature=c/.test(document.querySelector("video")?.getAttribute("src") || ""), null, { timeout: 5000 }).catch(() => {});
check(/v2\.webm\?X-Amz-Signature=c/.test(await frame().evaluate(() => document.querySelector("video").getAttribute("src"))), "and back to the latest preview");
// Rename: click the name, type, Enter; Esc leaves it as it was.
await app.locator("h1.name").click();
check(await frame().evaluate(() => document.activeElement?.classList.contains("rename") && document.activeElement.value === "Knee pain reel"), "clicking the name opens it to rename");
await app.locator(".rename").fill("Knee pain reel FINAL"); await app.locator(".rename").press("Enter"); await sleep(300);
check(calls.some((c) => c.name === "app_rename_project" && c.args.name === "Knee pain reel FINAL") && (await app.locator("h1.name").innerText()).toLowerCase() === "knee pain reel final", "Enter renames the edit in Rendrr");
await app.locator("h1.name").click(); await app.locator(".rename").fill("Oops"); await app.locator(".rename").press("Escape"); await sleep(200);
check((await app.locator("h1.name").innerText()).toLowerCase() === "knee pain reel final" && !calls.some((c) => c.name === "app_rename_project" && c.args.name === "Oops"), "Esc leaves the name as it was");
db.projects[0].name = "Knee pain reel";

// 8. Full screen with the button, Open in Rendrr, back to every edit.
await app.locator('button[aria-label="Full screen"]').click(); await sleep(200);
check((await hostLog()).some((m) => m.method === "ui/request-display-mode" && m.params.mode === "fullscreen") && await frame().evaluate(() => document.documentElement.classList.contains("fs")), "full screen asks the host and lays out for it");
await app.locator('button[aria-label="Open in Rendrr"]').click(); await sleep(200);
check((await hostLog()).some((m) => m.method === "ui/open-link" && m.params.url === "https://app.rendrr.live/editor/p1"), "Open in Rendrr opens the editor");
await app.locator('button[aria-label="Back to Spine clinic"]').click();
await app.locator("[data-edit]").first().waitFor();
check((await app.locator(".card").count()) === 2 && /Spine clinic/i.test(await app.locator("#list-title").innerText()), "back goes to the project's videos");
// An edit never rendered (the editor plays edits live, so many have no preview): its first preview starts on its own.
const renders = () => calls.filter((c) => c.name === "app_render_preview" && c.args.projectId === "p2").length;
await app.locator(".card", { hasText: "Founder story" }).click();
await app.locator(".noprev").waitFor({ timeout: 5000 }); await sleep(600);
check(renders() === 1 && /Making a preview to watch here/.test(await app.locator(".noprev").innerText()), `an edit with no preview starts one on its own and says so (${renders()} render asked)`);
await app.locator('button[aria-label="Back to Spine clinic"]').click(); await app.locator("[data-edit]").first().waitFor();
await app.locator(".card", { hasText: "Founder story" }).click(); await sleep(800);
check(renders() === 1, "opening it again does not start another");
await app.locator('button[aria-label="Back to Spine clinic"]').click(); await app.locator("[data-edit]").first().waitFor();

// From a project back to all projects, and into another one (empty).
await app.locator('button[aria-label="All projects"]').click(); await app.locator(".card.proj").first().waitFor();
check((await app.locator(".card.proj").count()) === 2 && !(await app.locator("[data-edit]").count()), "back from a project to all projects");
await app.locator('[data-folder="f2"]').click(); await app.locator(".empty").waitFor({ timeout: 5000 });
check(/New client/i.test(await app.locator("#list-title").innerText()) && /No videos in this project yet/.test(await app.locator(".empty").innerText()), "any project opens; an empty one says so");
await app.locator('button[aria-label="All projects"]').click(); await app.locator(".card.proj").first().waitFor();
// An edit the AI opened (open_projects with its id): back goes to that edit's project.
const opened = view("p2");
await page.evaluate((o) => document.getElementById("app").contentWindow.postMessage({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: { structuredContent: { open: o, webUrl: "https://app.rendrr.live" } } }, "*"), opened);
await app.locator('button[aria-label="Back to Spine clinic"]').waitFor({ timeout: 5000 });
await app.locator('button[aria-label="Back to Spine clinic"]').click(); await app.locator("[data-edit]").first().waitFor({ timeout: 5000 });
check(/Spine clinic/i.test(await app.locator("#list-title").innerText()) && (await app.locator(".card").count()) === 2, "an edit the AI opened goes back to its project's videos");
await app.locator('button[aria-label="All projects"]').click(); await app.locator(".card.proj").first().waitFor();

// The host switches theme: the app keeps Rendrr's look.
await page.evaluate(() => document.getElementById("app").contentWindow.postMessage({ jsonrpc: "2.0", method: "ui/notifications/host-context-changed", params: { theme: "dark", styles: { variables: { "--color-background-primary": "rgb(31, 30, 29)" } } } }, "*"));
await sleep(200);
check(await frame().evaluate(() => getComputedStyle(document.body).backgroundColor === "rgb(15, 17, 19)"), "a theme change from the host leaves the Rendrr look as it is");
await page.screenshot({ path: join(dir, "app-dark.png") });

// 9. On a phone: nothing wider than the screen, full screen on open, comment, draw and share with the thumb.
// Enough comments that they go past the screen.
for (const pid of Object.keys(db.comments)) for (let k = 0; k < 9; k++) db.comments[pid].push({ id: `m${pid}${k}`, time: 2 + k, text: `Note ${k + 1}: tighten this part`, author: "Dana", mine: false, resolved: false, at: now - k * 60e3 });
const phoneCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, screen: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
// Playwright's screen size does not reach the sandboxed frame (it says 800 x 600 there): every frame gets the phone's.
const phoneScreen = (ctx) => ctx.addInitScript(() => { Object.defineProperty(screen, "width", { get: () => 390 }); Object.defineProperty(screen, "height", { get: () => 844 }); });
await phoneScreen(phoneCtx);
const ph = await phoneCtx.newPage();
ph.on("pageerror", (e) => errors.push("phone: " + e.message));
await ph.exposeFunction("hostTool", (name, args) => (name === "open" ? { ...tool("app_list_projects", {}), open: null, webUrl: "https://app.rendrr.live" } : tool(name, args)));
await ph.goto(`http://127.0.0.1:${host.address().port}/?phone`);
const papp = ph.frameLocator("#app");
const pframe = () => ph.frames().find((f) => f !== ph.mainFrame());
await papp.locator(".card").first().waitFor({ timeout: 10000 });
const fits = () => pframe().evaluate(() => { const d = document.documentElement; const wide = Array.from(document.querySelectorAll("button, input, textarea, video, .card")).filter((e) => { const r = e.getBoundingClientRect(); return r.width && (r.right > innerWidth + 1 || r.left < -1); }).map((e) => (e.textContent || e.tagName).trim().slice(0, 20)); return { over: d.scrollWidth - d.clientWidth, wide, w: innerWidth }; });
let fit = await fits();
check(fit.over <= 1 && !fit.wide.length, `phone, the grid fits the screen (${fit.w} px; ${fit.wide.join(", ") || "nothing sticks out"})`);
check(await pframe().evaluate(() => { const cs = Array.from(document.querySelectorAll(".card")).map((c) => c.getBoundingClientRect().top); return cs.length === 2 && Math.abs(cs[0] - cs[1]) < 2; }), "two project cards side by side");
await papp.locator('[data-folder="f1"]').tap(); await papp.locator("[data-edit]").first().waitFor({ timeout: 5000 });
fit = await fits();
check(fit.over <= 1 && !fit.wide.length && (await papp.locator("[data-edit]").count()) === 2, `phone, a project's videos fit the screen (${fit.wide.join(", ") || "nothing sticks out"})`);
await papp.locator("[data-edit]").first().tap();
await papp.locator("video").waitFor({ timeout: 10000 }); await sleep(400);
fit = await fits();
check(await pframe().evaluate(() => document.documentElement.classList.contains("fs")) && fit.over <= 1 && !fit.wide.length, `phone, the edit opens full screen and fits (${fit.wide.join(", ") || "nothing sticks out"})`);
const pBox = await pframe().evaluate(() => { const r = (q) => document.querySelector(q).getBoundingClientRect(); return { top: r(".top").top, v: r("video"), c: r(".compose"), l: r(".side > .list, .side > .empty"), h: innerHeight, padB: parseFloat(getComputedStyle(document.getElementById("root")).paddingBottom) }; });
check(pBox.top >= 100, `phone: the app's header is clear of Claude's header (${Math.round(pBox.top)} px down)`);
check(pBox.v.height >= 250 && pBox.c.top > pBox.v.bottom && pBox.c.bottom < pBox.l.top && pBox.c.bottom <= pBox.h - 140, `phone: the player (${Math.round(pBox.v.height)} px), then the box to write a comment, clear of Claude's chat box (${Math.round(pBox.h - pBox.c.bottom)} px above the bottom), then the comments`);
check(pBox.padB >= 140, "phone: the page ends clear of Claude's chat box");
// The comments scroll with a swipe (the app scrolls in its own box), and the last one comes up clear of the chat box.
const scrollPhone = async (pg, fr) => {
  const lb = await pg.frameLocator("#app").locator(".side > .list").boundingBox();
  await pg.mouse.move(lb.x + lb.width / 2, Math.min(lb.y + 40, 700));
  for (let k = 0; k < 12; k++) await pg.mouse.wheel(0, 400);
  await sleep(300);
  return fr().evaluate(() => { const root = document.getElementById("root"), cms = document.querySelectorAll(".cm"), last = cms[cms.length - 1].getBoundingClientRect();
    return { y: root.scrollTop, box: root.clientHeight, all: root.scrollHeight, last: last.bottom, rootBottom: root.getBoundingClientRect().bottom, n: cms.length, scr: screen.height }; });
};
const pScroll = await scrollPhone(ph, pframe);
check(pScroll.y > 100 && pScroll.last <= pScroll.rootBottom - 140, `phone: a swipe scrolls the ${pScroll.n} comments (${Math.round(pScroll.y)} px) and the last one comes up clear of Claude's chat box (${Math.round(pScroll.rootBottom - pScroll.last)} px above the bottom)`);
await pframe().evaluate(() => { document.getElementById("root").scrollTop = 0; });
await papp.locator("textarea").tap();
await papp.locator("textarea").fill("From my phone");
check(await pframe().evaluate(() => parseFloat(getComputedStyle(document.querySelector("textarea")).fontSize) >= 16), "the box's text is 16 px (phones do not zoom in)");
await papp.locator(".compose button", { hasText: "Comment" }).tap();
await papp.locator(".cm", { hasText: "From my phone" }).waitFor({ timeout: 5000 });
check(calls.some((c) => c.name === "app_add_comment" && c.args.text === "From my phone"), "a comment from the phone is saved");
await papp.locator(".ctrl button", { hasText: "Draw" }).tap(); await sleep(200);
const pInk = await papp.locator(".ink").boundingBox();
await ph.mouse.move(pInk.x + pInk.width * 0.2, pInk.y + pInk.height * 0.2); await ph.mouse.down();
for (let k = 1; k <= 6; k++) await ph.mouse.move(pInk.x + pInk.width * (0.2 + k * 0.05), pInk.y + pInk.height * 0.3);
await ph.mouse.up(); await sleep(150);
fit = await fits();
check((await papp.locator(".ctrl .pen").count()) === 5 && fit.over <= 1 && !fit.wide.length, `phone: the drawing tools fit (${fit.wide.join(", ") || "nothing sticks out"})`);
await papp.locator(".ctrl button", { hasText: "Done" }).tap();
await papp.locator(".compose button", { hasText: "Comment" }).tap();
await sleep(400);
check(calls.filter((c) => c.name === "app_add_comment").pop().args.drawing?.strokes?.length === 1, "a drawing from the phone is saved");
await papp.locator('.top button[aria-label="Share"]').tap();
await papp.locator(".share input").waitFor({ timeout: 5000 });
fit = await fits();
check(fit.over <= 1 && !fit.wide.length, `phone: the share panel fits (${fit.wide.join(", ") || "nothing sticks out"})`);
const pAfter = await pframe().evaluate(() => { const r = (q) => document.querySelector(q).getBoundingClientRect(); return { c: r(".compose").bottom, h: innerHeight, ctrlRows: new Set(Array.from(document.querySelectorAll(".ctrl > *")).map((e) => e.getBoundingClientRect()).filter((r) => r.width && r.height).map((r) => Math.round((r.top + r.bottom) / 2 / 12))).size }; });
check(pAfter.c <= pAfter.h + 1, "phone: with the share panel open the comment box is still on screen (the panel floats)");
check(pAfter.ctrlRows === 1, `phone: the player controls fit on one line (${pAfter.ctrlRows})`);
await ph.screenshot({ path: join(dir, "app-phone.png") });
await papp.locator(".shade").tap({ position: { x: 20, y: 800 } }); await sleep(150);
check((await papp.locator(".share").count()) === 0, "phone: a tap outside closes the share panel");
await papp.locator('button[aria-label="Exit full screen"]').tap(); await sleep(400);
fit = await fits();
check(!(await pframe().evaluate(() => document.documentElement.classList.contains("fs"))) && fit.over <= 1 && !fit.wide.length, `phone, in the chat: it fits (${fit.wide.join(", ") || "nothing sticks out"})`);
await sleep(500); await ph.screenshot({ path: join(dir, "app-phone-inline.png") });
await phoneCtx.close();

// 10. A phone panel that gives the app a frame taller than the screen and cuts it off: the app's box is the screen's
// height, so the comments still scroll into view.
const tallCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, screen: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
await phoneScreen(tallCtx);
const tp = await tallCtx.newPage();
tp.on("pageerror", (e) => errors.push("tall phone: " + e.message));
await tp.exposeFunction("hostTool", (name, args) => (name === "open" ? { ...tool("app_list_projects", {}), open: null, webUrl: "https://app.rendrr.live" } : tool(name, args)));
await tp.goto(`http://127.0.0.1:${host.address().port}/?phone&tall`);
const tapp = tp.frameLocator("#app"), tframe = () => tp.frames().find((f) => f !== tp.mainFrame());
await tapp.locator(".card").first().waitFor({ timeout: 10000 });
await tapp.locator('[data-folder="f1"]').tap(); await tapp.locator("[data-edit]").first().waitFor({ timeout: 5000 });
await tapp.locator("[data-edit]").first().tap();
await tapp.locator("video").waitFor({ timeout: 10000 }); await sleep(400);
const tScroll = await scrollPhone(tp, tframe);
check(tScroll.box <= tScroll.scr && tScroll.y > 100 && tScroll.last <= tScroll.scr - 140, `phone, a frame taller than the screen: the app's box is ${tScroll.box} px (screen ${tScroll.scr}), a swipe scrolls the comments and the last one shows above the chat box`);
await tp.screenshot({ path: join(dir, "app-phone-tall.png") });
await tallCtx.close();

check(violations.length === 0, `nothing blocked by the content security policy${violations.length ? ": " + violations.join(" | ") : ""}`);
check(errors.length === 0, `no errors${errors.length ? ": " + errors.join(" | ") : ""}`);
console.log(`screenshots: ${["app-loading", "app-list", "app-fullscreen", "app-project", "app-comments", "app-dark", "app-phone", "app-phone-inline", "app-phone-tall"].map((n) => join(dir, n + ".png")).join(" ")}`);
await browser.close(); host.close(); media.close();
if (fails.length) { console.log(`\n${fails.length} failed`); process.exit(1); }
console.log("\nall passed");
