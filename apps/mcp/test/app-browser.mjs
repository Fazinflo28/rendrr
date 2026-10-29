// The Rendrr app as Claude shows it: the page from the connector, in a sandboxed frame with the content security policy
// a host builds from its declared domains, talking MCP Apps (JSON-RPC over postMessage) to a stand-in host whose tools
// answer like Rendrr's. Checks: the projects grid; opening an edit plays its preview (from the storage origin only);
// comments at the player's moment, markers, jump, resolve; Send to Claude; a render's progress, then the new preview
// playing on its own; typing survives the polls; search; the web app's look; size. Real Chromium (Playwright), real video files.
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
// signature, as on the real storage.
const media = createServer((req, res) => {
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

// Rendrr behind the host: two edits, comments, a render that moves on with each look.
const now = Date.now();
const db = {
  projects: [
    { id: "p1", name: "Knee pain reel", folder: "Spine clinic", aspect: "9:16", status: "In review", version: 2, updated: now - 3600e3, seconds: 8, thumb: `${M}/thumb.jpg?X-Amz-Credential=tid%2F20261029%2Fiad&X-Amz-Signature=a`, previewVersion: 1, rendering: false, openComments: 1 },
    { id: "p2", name: "Founder story", folder: "Brand", aspect: "16:9", status: "Draft", version: 1, updated: now - 86400e3 * 2, seconds: null, thumb: null, previewVersion: null, rendering: false, openComments: 0 },
  ],
  comments: { p1: [{ id: "c0", time: 1.2, text: "The client wants the logo smaller", author: "Dana", mine: false, resolved: false, at: now - 7200e3 }], p2: [] },
  preview: { p1: { renderId: "r1", version: 1, url: `${M}/v1.webm?X-Amz-Signature=b`, seconds: 8, quality: "540p", at: now - 3600e3 }, p2: null },
  rendering: { p1: null, p2: null },
};
const calls = [];
const view = (id) => {
  const p = db.projects.find((x) => x.id === id);
  return { project: { id: p.id, name: p.name, folder: p.folder, aspect: p.aspect, status: p.status, version: p.version, updated: p.updated, seconds: p.seconds, editorUrl: `https://app.rendrr.live/editor/${p.id}` },
    preview: db.preview[id], rendering: db.rendering[id], failed: null, comments: [...db.comments[id]].sort((a, b) => a.time - b.time) };
};
function tool(name, args) {
  calls.push({ name, args });
  if (name === "app_list_projects") { const ps = db.projects.filter((p) => !args.query || p.name.toLowerCase().includes(args.query.toLowerCase())); return { projects: ps, total: ps.length, offset: 0 }; }
  if (name === "app_get_project") {
    const r = db.rendering[args.projectId];
    if (r) { r.percent += 45; r.queued = false; r.step = "Encoding"; if (r.percent >= 100) { db.rendering[args.projectId] = null; db.preview[args.projectId] = { renderId: "r2", version: 2, url: `${M}/v2.webm?X-Amz-Signature=c`, seconds: 6, quality: "540p", at: Date.now() }; } }
    return view(args.projectId);
  }
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
if (phone) f.style.width = "100vw";
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
    f.style.width = phone ? "100vw" : window.fs ? "1200px" : "900px"; f.style.height = window.fs ? (phone ? "100vh" : "1000px") : (window.inlineH || 600) + "px";
    reply({ mode: m.params.mode });
    // A phone's full-screen panel lays its header and chat box over the app, and says so.
    f.contentWindow.postMessage({ jsonrpc: "2.0", method: "ui/notifications/host-context-changed", params: { displayMode: m.params.mode, ...(phone ? { safeAreaInsets: window.fs ? { top: 100, right: 0, bottom: 140, left: 0 } : { top: 0, right: 0, bottom: 0, left: 0 } } : {}) } }, "*");
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

// 1. The grid of every edit, in the Rendrr web app's look, sized to its content.
await app.locator(".card").first().waitFor({ timeout: 10000 }).catch(async (e) => { console.log("LOG", JSON.stringify(await hostLog()).slice(0, 2000)); console.log("ERR", errors, violations); console.log("HTML", (await frame()?.content())?.slice(-1500)); throw e; });
check((await app.locator(".card").count()) === 2, "All projects shows both edits");
check(/Knee pain reel/.test(await app.locator(".card").first().innerText()) && /Preview v1/.test(await app.locator(".card").first().innerText()) && /1 open comment/.test(await app.locator(".card").first().innerText()), "a card says its preview and open comments");
check(/No preview/.test(await app.locator(".card").nth(1).innerText()), "an edit without a preview says so");
check(await frame().evaluate(() => getComputedStyle(document.body).backgroundColor === "rgb(15, 17, 19)" && !document.documentElement.style.getPropertyValue("--color-background-primary")), "the Rendrr web app's own dark look, though the host is light");
check(await frame().evaluate(() => { const t = getComputedStyle(document.querySelector("h1")); return /Space Grotesk/.test(t.fontFamily) && t.textTransform === "uppercase" && t.fontWeight === "700"; }), "titles in the web app's Space Grotesk, bold, upper case");
check(await frame().evaluate(() => { const c = document.querySelector(".card"); const o = c.querySelector(".thumb .over .name"); return getComputedStyle(c).backgroundColor === "rgb(28, 30, 33)" && !!o && o.textContent.length > 0; }), "project cards as in the web app (surface colour, the name over the picture)");
const thumbOk = await frame().evaluate(() => new Promise((r) => { const i = document.querySelector(".thumb img"); if (!i) return r("no picture"); const done = () => r(i.complete && i.naturalWidth > 0 ? true : "not loaded"); i.complete ? done() : (i.onload = done, i.onerror = done); }));
check(thumbOk === true, `thumbnails load from the storage origin, their signed links as given (${thumbOk})`);
check(await frame().evaluate(() => { const r = (q) => document.querySelector(q).getBoundingClientRect(); const h1 = r("h1"); return h1.height < 40 && r(".top .btn.big").top < h1.bottom + 20; }), "the header fits: the title on one line, the buttons beside it");
const sized = (await hostLog()).filter((m) => m.method === "ui/notifications/size-changed");
check(sized.length >= 1 && sized[sized.length - 1].params.height > 200, `the app tells the host its height (${sized.map((s) => s.params.height).join(", ")})`);
check((await app.locator(".btn.big", { hasText: "Full screen" }).count()) === 1, "the grid offers full screen");
await page.screenshot({ path: join(dir, "app-list.png") });

// 2. Search keeps the field focused while results come back.
await app.locator(".search").click(); await app.locator(".search").pressSequentially("knee", { delay: 40 }); await sleep(700);
check(calls.some((c) => c.name === "app_list_projects" && c.args.query === "knee") && (await app.locator(".card").count()) === 1, "search asks Rendrr and shows the match");
check(await frame().evaluate(() => document.activeElement?.classList.contains("search") && document.activeElement.value === "knee"), "the search field keeps focus and text");
await app.locator(".search").fill(""); await sleep(600);

// 3. Open an edit: it opens full screen (the host's panel): the player on top, the comments in the middle, the box to
// write one at the bottom. Its preview plays, from the storage origin, under the policy, with Rendrr's own controls
// (the time in milliseconds, a seek bar with the comments on it, steps of 0.1 s).
await app.locator(".card").first().click();
await app.locator("video").waitFor({ timeout: 10000 });
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
await app.locator("h1").click();
await page.keyboard.press("ArrowLeft"); await sleep(150);
await page.keyboard.press("Shift+ArrowLeft"); await sleep(150);
const afterKeys = await frame().evaluate(() => document.querySelector("video").currentTime);
check(Math.abs(afterSeek - 1.1 - afterKeys) < 0.02, `arrow keys step 0.1 s, with Shift 1 s (${afterSeek.toFixed(3)} to ${afterKeys.toFixed(3)})`);
await app.locator(".ctrl .step", { hasText: "+0.1" }).click(); await sleep(150);
const t = await frame().evaluate(() => document.querySelector("video").currentTime);
check(Math.abs(t - afterKeys - 0.1) < 0.02, `the +0.1 s button steps on (${t.toFixed(3)})`);
check((await app.locator(".tc").innerText()).startsWith(await frame().evaluate(() => { const x = Math.floor(document.querySelector("video").currentTime * 1000 + 1e-6); return "00:0" + Math.floor(x / 1000) + "." + String(x % 1000).padStart(3, "0"); })), `the time shows the exact moment (${await app.locator(".tc").innerText()})`);
check(/^at 00:0\d\.\d{3}$/.test(await app.locator(".at").innerText()), `the new comment's moment follows the player (${await app.locator(".at").innerText()})`);
check(/v2 has changes this preview \(v1\) does not show yet/.test(await app.locator("body").innerText()), "it says the latest version has no preview yet");
check((await app.locator(".seek .mk").count()) === 1, "the client's comment is a dot on the seek bar");
check((await hostLog()).filter((m) => m.method === "ui/notifications/size-changed").length === fsSizes, "full screen, the app does not resize the host's panel");
// Back in the chat: the same order, the frame as tall as the app.
await app.locator("button", { hasText: "Exit full screen" }).click(); await sleep(400);
const inBox = await boxes();
check(!inBox.fs && inBox.order && inBox.vh >= 500, `in the chat: the same order, a tall player (${Math.round(inBox.vh)} px; the frame grows to fit, so no vh)`);
check(await frame().evaluate(() => document.querySelector("video").currentTime > 1.6), "the player keeps its place when the view changes");

// 4. A comment at this moment: saved with the player's time, listed, marked, and the AI is told.
await app.locator("textarea").click();
await app.locator("textarea").pressSequentially("Cut the pause before this line", { delay: 10 });
await app.locator("textarea").press("Control+Enter");
await app.locator(".cm", { hasText: "Cut the pause before this line" }).waitFor({ timeout: 5000 });
const added = calls.find((c) => c.name === "app_add_comment");
check(!!added && Math.abs(added.args.time - t) < 0.01 && added.args.projectId === "p1", `the comment is saved at the player's moment (${added?.args.time})`);
check((await app.locator(".seek .mk").count()) === 2, "it gets a dot too");
check((await hostLog()).some((m) => m.method === "ui/update-model-context" && /Cut the pause before this line/.test(m.params.content[0].text)), "the AI's context hears about the new comment");
check((await app.locator("textarea").inputValue()) === "", "the box is empty again");

// 5. Jump to a comment; resolve and open it again.
await app.locator(".cm .t").first().click(); await sleep(400);
check(Math.abs((await frame().evaluate(() => document.querySelector("video").currentTime)) - 1.2) < 0.05, "a comment's time jumps the player there");
await app.locator(".cm .chk").first().click(); await sleep(300);
check(calls.some((c) => c.name === "app_resolve_comment" && c.args.commentId === "c0" && c.args.resolved === true), "resolving asks Rendrr");
check(/Open 1/.test(await app.locator(".tabs").innerText()) && /All 2/.test(await app.locator(".tabs").innerText()), "the open count goes down");
await app.locator(".tab", { hasText: "All" }).click();
await app.locator(".cm.done .chk").first().click(); await sleep(300);
check(calls.some((c) => c.name === "app_resolve_comment" && c.args.resolved === false), "a resolved comment opens again");

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
await app.locator(".top button", { hasText: "Share" }).click();
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

// 7. Render the latest version: progress while it renders, typing survives the polls, then the new preview plays.
await app.locator("button", { hasText: "Render preview" }).click();
await app.locator(".prog").waitFor({ timeout: 5000 });
check(/Waiting to render v2/.test(await app.locator(".note").first().innerText()), "the render shows as waiting");
await app.locator("textarea").click(); await app.locator("textarea").pressSequentially("half typed", { delay: 10 });
await app.locator(".note", { hasText: "Rendering v2" }).waitFor({ timeout: 6000 });
check(/Rendering v2 · 55% · Encoding/.test(await app.locator(".note").first().innerText()), `progress comes in (${(await app.locator(".note").first().innerText()).split("\n")[0]})`);
check(await frame().evaluate(() => document.activeElement?.tagName === "TEXTAREA" && document.activeElement.value === "half typed"), "typing keeps its place while progress comes in");
await frame().waitForFunction(() => /v2\.webm/.test(document.querySelector("video")?.getAttribute("src") || ""), null, { timeout: 8000 }).catch(() => {});
check(/v2\.webm/.test(await frame().evaluate(() => document.querySelector("video").getAttribute("src"))), "the new preview replaces the old one when it is done");
await frame().waitForFunction(() => { const v = document.querySelector("video"); return v && !v.paused && v.currentTime > 0.3; }, null, { timeout: 8000 }).catch(() => {});
check(await frame().evaluate(() => { const v = document.querySelector("video"); return !v.paused && v.currentTime > 0.3; }), "and plays on its own");
check(!/has changes this preview/.test(await app.locator("body").innerText()), "the note about missing changes is gone");

// 8. Full screen with the button, Open in Rendrr, back to every edit.
await app.locator("button", { hasText: "Full screen" }).click(); await sleep(200);
check((await hostLog()).some((m) => m.method === "ui/request-display-mode" && m.params.mode === "fullscreen") && await frame().evaluate(() => document.documentElement.classList.contains("fs")), "full screen asks the host and lays out for it");
await app.locator("button", { hasText: "Open in Rendrr" }).click(); await sleep(200);
check((await hostLog()).some((m) => m.method === "ui/open-link" && m.params.url === "https://app.rendrr.live/editor/p1"), "Open in Rendrr opens the editor");
await app.locator("button", { hasText: "All projects" }).click();
await app.locator(".card").first().waitFor();
check((await app.locator(".card").count()) === 2, "back to all projects");
// An edit never rendered (the editor plays edits live, so many have no preview): its first preview starts on its own.
const renders = () => calls.filter((c) => c.name === "app_render_preview" && c.args.projectId === "p2").length;
await app.locator(".card", { hasText: "Founder story" }).click();
await app.locator(".noprev").waitFor({ timeout: 5000 }); await sleep(600);
check(renders() === 1 && /Making a preview to watch here/.test(await app.locator(".noprev").innerText()), `an edit with no preview starts one on its own and says so (${renders()} render asked)`);
await app.locator("button", { hasText: "All projects" }).click(); await app.locator(".card").first().waitFor();
await app.locator(".card", { hasText: "Founder story" }).click(); await sleep(800);
check(renders() === 1, "opening it again does not start another");
await app.locator("button", { hasText: "All projects" }).click(); await app.locator(".card").first().waitFor();

// The host switches theme: the app keeps Rendrr's look.
await page.evaluate(() => document.getElementById("app").contentWindow.postMessage({ jsonrpc: "2.0", method: "ui/notifications/host-context-changed", params: { theme: "dark", styles: { variables: { "--color-background-primary": "rgb(31, 30, 29)" } } } }, "*"));
await sleep(200);
check(await frame().evaluate(() => getComputedStyle(document.body).backgroundColor === "rgb(15, 17, 19)"), "a theme change from the host leaves the Rendrr look as it is");
await page.screenshot({ path: join(dir, "app-dark.png") });

// 9. On a phone: nothing wider than the screen, full screen on open, comment, draw and share with the thumb.
const phoneCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
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
check(await pframe().evaluate(() => { const cs = Array.from(document.querySelectorAll(".card")).map((c) => c.getBoundingClientRect().top); return cs.length === 2 && Math.abs(cs[0] - cs[1]) < 2; }), "two cards side by side");
await papp.locator(".card").first().tap();
await papp.locator("video").waitFor({ timeout: 10000 }); await sleep(400);
fit = await fits();
check(await pframe().evaluate(() => document.documentElement.classList.contains("fs")) && fit.over <= 1 && !fit.wide.length, `phone, the edit opens full screen and fits (${fit.wide.join(", ") || "nothing sticks out"})`);
const pBox = await pframe().evaluate(() => { const r = (q) => document.querySelector(q).getBoundingClientRect(); return { top: r(".top").top, v: r("video"), c: r(".compose"), l: r(".side > .list, .side > .empty"), h: innerHeight, padB: parseFloat(getComputedStyle(document.body).paddingBottom) }; });
check(pBox.top >= 100, `phone: the app's header is clear of Claude's header (${Math.round(pBox.top)} px down)`);
check(pBox.v.height >= 250 && pBox.c.top > pBox.v.bottom && pBox.c.bottom < pBox.l.top && pBox.c.bottom <= pBox.h - 140, `phone: the player (${Math.round(pBox.v.height)} px), then the box to write a comment, clear of Claude's chat box (${Math.round(pBox.h - pBox.c.bottom)} px above the bottom), then the comments`);
check(pBox.padB >= 140, "phone: the page ends clear of Claude's chat box");
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
await papp.locator(".top button", { hasText: "Share" }).tap();
await papp.locator(".share input").waitFor({ timeout: 5000 });
fit = await fits();
check(fit.over <= 1 && !fit.wide.length, `phone: the share panel fits (${fit.wide.join(", ") || "nothing sticks out"})`);
const pAfter = await pframe().evaluate(() => { const r = (q) => document.querySelector(q).getBoundingClientRect(); return { c: r(".compose").bottom, h: innerHeight, ctrlRows: new Set(Array.from(document.querySelectorAll(".ctrl > *")).map((e) => e.getBoundingClientRect()).filter((r) => r.width && r.height).map((r) => Math.round((r.top + r.bottom) / 2 / 12))).size }; });
check(pAfter.c <= pAfter.h + 1, "phone: with the share panel open the comment box is still on screen (the panel floats)");
check(pAfter.ctrlRows === 1, `phone: the player controls fit on one line (${pAfter.ctrlRows})`);
await ph.screenshot({ path: join(dir, "app-phone.png") });
await papp.locator(".shade").tap({ position: { x: 20, y: 800 } }); await sleep(150);
check((await papp.locator(".share").count()) === 0, "phone: a tap outside closes the share panel");
await papp.locator("button", { hasText: "Exit" }).tap(); await sleep(400);
fit = await fits();
check(!(await pframe().evaluate(() => document.documentElement.classList.contains("fs"))) && fit.over <= 1 && !fit.wide.length, `phone, in the chat: it fits (${fit.wide.join(", ") || "nothing sticks out"})`);
await sleep(500); await ph.screenshot({ path: join(dir, "app-phone-inline.png") });
await phoneCtx.close();

check(violations.length === 0, `nothing blocked by the content security policy${violations.length ? ": " + violations.join(" | ") : ""}`);
check(errors.length === 0, `no errors${errors.length ? ": " + errors.join(" | ") : ""}`);
console.log(`screenshots: ${["app-list", "app-fullscreen", "app-project", "app-comments", "app-dark", "app-phone", "app-phone-inline"].map((n) => join(dir, n + ".png")).join(" ")}`);
await browser.close(); host.close(); media.close();
if (fails.length) { console.log(`\n${fails.length} failed`); process.exit(1); }
console.log("\nall passed");
