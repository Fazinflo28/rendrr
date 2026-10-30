// The Rendrr app as ChatGPT can show it: a host that gives the page window.openai (ChatGPT's own bridge: toolOutput,
// callTool, sendFollowUpMessage, openExternal, requestDisplayMode, notifyIntrinsicHeight) and does not answer the
// standard MCP Apps bridge. The page must fall back to it: the projects from toolOutput, an edit opened through
// callTool, its preview loaded (not playing on its own), a comment added, Send to ChatGPT, full screen, its height; a
// preview that does not load says so and Try again gets a fresh link; two cards in one chat play one at a time.
// Real Chromium (Playwright).
//   node test/app-chatgpt.mjs   (from apps/mcp; needs ffmpeg)
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

const dir = mkdtempSync(join(tmpdir(), "rendrr-chatgpt-"));
execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=320x568:r=25:d=6", "-f", "lavfi", "-i", "sine=f=440:d=6", "-c:v", "libvpx-vp9", "-b:v", "300k", "-c:a", "libopus", "-shortest", join(dir, "v1.webm")]);
const media = createServer((req, res) => {
  const f = join(dir, new URL(req.url, "http://x").pathname.slice(1));
  let size; try { size = statSync(f).size; } catch { res.statusCode = 404; return res.end(); }
  const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || "");
  if (m) { const a = +m[1], b = m[2] ? +m[2] : size - 1; res.writeHead(206, { "content-type": "video/webm", "content-range": `bytes ${a}-${b}/${size}`, "accept-ranges": "bytes", "content-length": b - a + 1 }); createReadStream(f, { start: a, end: b }).pipe(res); }
  else { res.writeHead(200, { "content-type": "video/webm", "content-length": size, "accept-ranges": "bytes" }); createReadStream(f).pipe(res); }
}).listen(0, "127.0.0.1");
await new Promise((r) => media.on("listening", r));
const M = `http://127.0.0.1:${media.address().port}`;

const now = Date.now();
const db = {
  projects: [{ id: "p1", name: "SaaS launch video", folder: "Acme", aspect: "16:9", status: "Preview ready", version: 3, updated: now - 600e3, seconds: 6, thumb: null, previewVersion: 3, rendering: false, openComments: 1 }],
  comments: { p1: [{ id: "c0", time: 2.4, text: "Make the logo pop in faster", author: "Dana", mine: false, resolved: false, at: now - 3600e3 }] },
};
const calls = [];
const view = () => ({ project: { id: "p1", name: "SaaS launch video", folder: "Acme", aspect: "16:9", status: "Preview ready", version: 3, updated: now, seconds: 6, editorUrl: "https://app.rendrr.live/editor/p1" },
  preview: { renderId: "r3", version: 3, url: `${M}/v1.webm`, seconds: 6, quality: "540p", at: now - 60e3 }, rendering: null, failed: null, comments: [...db.comments.p1] });
function tool(name, args) {
  calls.push({ name, args });
  if (name === "app_list_projects") return { projects: db.projects, total: 1, offset: 0 };
  if (name === "app_get_project") return view();
  if (name === "app_add_comment") { db.comments.p1.push({ id: "c" + calls.length, time: args.time, text: args.text, author: "Ana", mine: true, resolved: false, at: Date.now(), edited: false, drawing: null, images: [] }); return view(); }
  if (name === "app_resolve_comment") { db.comments.p1.find((c) => c.id === args.commentId).resolved = args.resolved !== false; return view(); }
  throw new Error("no tool " + name);
}

// ChatGPT's bridge, as the page sees it: window.openai set before the page's scripts run, its calls carried to the host.
const toolOutput = { projects: db.projects, total: 1, offset: 0, open: null, webUrl: "https://app.rendrr.live" };
const shim = `<script>(() => {
  let n = 0; const wait = new Map();
  addEventListener("message", (e) => { const m = e.data; if (m && m.openaiReply && wait.has(m.id)) { wait.get(m.id)(m.result); wait.delete(m.id); } });
  const ask = (call, args) => new Promise((ok) => { const id = ++n; wait.set(id, ok); parent.postMessage({ openai: true, id, call, args }, "*"); });
  window.openai = { toolInput: {}, toolOutput: ${JSON.stringify(toolOutput)}, displayMode: "inline", theme: "dark", maxHeight: 900, locale: "en-US",
    safeArea: { insets: { top: 0, right: 0, bottom: 0, left: 0 } }, userAgent: { device: { type: "desktop" }, capabilities: { hover: true, touch: false } },
    callTool: (name, args) => ask("callTool", { name, args }), sendFollowUpMessage: (a) => ask("sendFollowUpMessage", a), openExternal: (a) => ask("openExternal", a),
    requestDisplayMode: (a) => ask("requestDisplayMode", a), notifyIntrinsicHeight: (h) => { parent.postMessage({ openai: true, id: 0, call: "notifyIntrinsicHeight", args: { height: h } }, "*"); } };
})();</script>`;
const csp = `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline' https://fonts.googleapis.com; img-src ${M} data:; media-src ${M}; font-src https://fonts.gstatic.com; connect-src 'none'; frame-src 'none'; base-uri 'none'`;
const doc = APP.replace("<head>", `<head><meta http-equiv="Content-Security-Policy" content="${csp}">${shim}`);
const hostHtml = `<!doctype html><meta charset=utf8><body style="margin:0;background:#212121"><iframe id=app sandbox="allow-scripts" style="width:760px;border:0;height:500px"></iframe><script>
const f = document.getElementById("app");
window.log = [];
addEventListener("message", async (e) => {
  if (e.source !== f.contentWindow) return;
  const m = e.data;
  // The standard bridge is not answered here (an older ChatGPT): only window.openai's calls are.
  if (m && m.jsonrpc === "2.0") { window.log.push({ standard: m.method }); return; }
  if (!m || !m.openai) return;
  window.log.push({ call: m.call, args: m.args });
  let result = {};
  if (m.call === "callTool") { try { result = { structuredContent: await window.hostTool(m.args.name, m.args.args), content: [{ type: "text", text: "ok" }] }; } catch (err) { result = { isError: true, content: [{ type: "text", text: String(err) }] }; } }
  else if (m.call === "requestDisplayMode") { f.style.width = m.args.mode === "fullscreen" ? "1200px" : "760px"; f.style.height = m.args.mode === "fullscreen" ? "900px" : "500px"; result = { mode: m.args.mode }; }
  else if (m.call === "notifyIntrinsicHeight") { f.style.height = Math.min(1400, m.args.height) + "px"; return; }
  f.contentWindow.postMessage({ openaiReply: true, id: m.id, result }, "*");
});
f.srcdoc = ${JSON.stringify(doc).replace(/<\//g, "<\\/")};
</script>`;
const host = createServer((_q, res) => { res.setHeader("content-type", "text/html"); res.end(hostHtml); }).listen(0, "127.0.0.1");
await new Promise((r) => host.on("listening", r));

const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome", args: ["--autoplay-policy=no-user-gesture-required"] }).catch(() => chromium.launch());
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
const errors = [], violations = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => { if (/Content Security Policy|Refused to/i.test(m.text())) violations.push(m.text()); if (m.type() === "error") errors.push(m.text()); });
await page.exposeFunction("hostTool", (name, args) => tool(name, args));
await page.goto(`http://127.0.0.1:${host.address().port}/`);
const app = page.frameLocator("#app");
const frame = () => page.frame({ url: /about:srcdoc/ }) ?? page.frames()[1];
const hostLog = () => page.evaluate(() => window.log);

// 1. The projects from toolOutput, though the standard bridge never answers.
await app.locator(".card").first().waitFor({ timeout: 10000 });
check((await hostLog()).some((l) => l.standard === "ui/initialize"), "the page tries the standard bridge first");
check(/SaaS launch video/.test(await app.locator(".card").first().innerText()), "the projects show from ChatGPT's toolOutput");
check((await hostLog()).some((l) => l.call === "notifyIntrinsicHeight" && l.args.height > 150), "the app tells ChatGPT its height");

// 2. Open the edit: callTool, full screen through requestDisplayMode, the preview plays.
await app.locator(".card").first().click();
await app.locator("video").waitFor({ timeout: 10000 });
check(calls.some((c) => c.name === "app_get_project" && c.args.projectId === "p1"), "opening an edit calls the tool through window.openai");
check((await hostLog()).some((l) => l.call === "requestDisplayMode" && l.args.mode === "fullscreen"), "opening an edit asks ChatGPT for full screen");
await frame().waitForFunction(() => document.querySelector("video").readyState >= 2, null, { timeout: 10000 }).catch(() => {});
check(await frame().evaluate(() => document.querySelector("video").readyState >= 2), "the preview loads in the player");
await sleep(800);
check(await frame().evaluate(() => document.querySelector("video").paused && document.querySelector("video").currentTime === 0), "and waits for play (nothing plays on its own)");

// 3. A comment at the player's moment, through the tool.
await app.locator(".compose textarea").fill("Hold the end card one second longer");
await app.locator(".compose button", { hasText: /Comment|Add/ }).first().click(); await sleep(500);
check(calls.some((c) => c.name === "app_add_comment" && /end card/.test(c.args.text)), "a comment is added through window.openai");

// 4. Send to ChatGPT: the open comments as a follow-up message.
const send = app.locator("button", { hasText: "Send to ChatGPT" });
check((await send.count()) === 1, "the button says Send to ChatGPT");
if (await send.count()) { await send.click(); await sleep(400); }
const follow = (await hostLog()).find((l) => l.call === "sendFollowUpMessage");
check(!!follow && /SaaS launch video/.test(follow.args.prompt) && /logo pop in faster/.test(follow.args.prompt), "Send to ChatGPT posts the open comments to the chat");

// 5. A preview that does not load (a link run out): it says so, and Try again gets a fresh link and a new player.
await frame().evaluate((u) => { document.querySelector("video").src = u; }, `${M}/gone.webm`);
await frame().waitForFunction(() => document.querySelector(".frame").classList.contains("failed"), null, { timeout: 5000 }).catch(() => {});
await sleep(300); // its fade in
const failText = await frame().evaluate(() => getComputedStyle(document.querySelector(".fail")).visibility === "visible" ? document.querySelector(".fail").innerText : "");
check(/did not load/.test(failText) && /Try again/.test(failText), `a preview that does not load says so (${failText.replace(/\n/g, " / ")})`);
const gets = calls.filter((c) => c.name === "app_get_project").length;
await app.locator(".fail button", { hasText: "Try again" }).click();
await frame().waitForFunction(() => /v1\.webm/.test(document.querySelector("video").getAttribute("src")) && document.querySelector("video").readyState >= 2, null, { timeout: 8000 }).catch(() => {});
check(calls.filter((c) => c.name === "app_get_project").length === gets + 1 && await frame().evaluate(() => document.querySelector("video").readyState >= 2 && !document.querySelector(".frame").classList.contains("failed")), "Try again gets a fresh link and the preview loads");
errors.splice(0, errors.length, ...errors.filter((e) => !/404|gone\.webm|Failed to load resource/.test(e)));

// 6. Two Rendrr cards in one chat (frames that share an origin): neither plays on its own; playing one pauses the other.
const two = (n) => `<!doctype html><meta charset=utf8><body style="margin:0">${Array.from({ length: n }, (_, i) => `<iframe id=f${i} sandbox="allow-scripts allow-same-origin" style="width:760px;height:620px;border:0"></iframe>`).join("")}<script>
const frames = [...document.querySelectorAll("iframe")];
addEventListener("message", async (e) => {
  const f = frames.find((x) => x.contentWindow === e.source); const m = e.data;
  if (!f || !m || !m.openai || !m.id) return;
  let result = {};
  if (m.call === "callTool") result = { structuredContent: await window.hostTool(m.args.name, m.args.args), content: [] };
  f.contentWindow.postMessage({ openaiReply: true, id: m.id, result }, "*");
});
for (const f of frames) f.srcdoc = ${JSON.stringify(APP.replace("<head>", `<head><meta http-equiv="Content-Security-Policy" content="${csp}">${shim.replace(JSON.stringify(toolOutput), JSON.stringify({ ...toolOutput, open: view() }))}`)).replace(/<\//g, "<\\/")};
</script>`;
const host2 = createServer((_q, res) => { res.setHeader("content-type", "text/html"); res.end(two(2)); }).listen(0, "127.0.0.1");
await new Promise((r) => host2.on("listening", r));
const page2 = await browser.newPage({ viewport: { width: 1600, height: 800 } });
page2.on("pageerror", (e) => errors.push(e.message));
await page2.exposeFunction("hostTool", (name, args) => tool(name, args));
await page2.goto(`http://127.0.0.1:${host2.address().port}/`);
const cards = [0, 1].map((i) => page2.frameLocator("#f" + i));
const vids = () => page2.evaluate(() => [...document.querySelectorAll("iframe")].map((f) => { const v = f.contentDocument.querySelector("video"); return v ? { ready: v.readyState, paused: v.paused, t: v.currentTime } : null; }));
await page2.waitForFunction(() => [...document.querySelectorAll("iframe")].every((f) => (f.contentDocument.querySelector("video") || {}).readyState >= 2), null, { timeout: 15000 }).catch(() => {});
await sleep(1000);
let vs = await vids();
check(vs.every((v) => v && v.ready >= 2 && v.paused && v.t === 0), `two cards in one chat: both previews loaded, neither playing on its own (${JSON.stringify(vs)})`);
await cards[0].locator(".ctrl .ibtn").first().click(); await sleep(600);
vs = await vids();
check(!vs[0].paused && vs[1].paused, "pressing play on one plays it");
await cards[1].locator(".ctrl .ibtn").first().click(); await sleep(600);
vs = await vids();
check(vs[0].paused && !vs[1].paused, "pressing play on the other pauses the first: one plays at a time");
await page2.close(); host2.close();

check(!errors.length, "no page errors" + (errors.length ? ": " + errors.slice(0, 3).join("; ") : ""));
check(!violations.length, "nothing outside the declared domains" + (violations.length ? ": " + violations[0] : ""));
await page.screenshot({ path: join(dir, "chatgpt-app.png") });
await browser.close(); host.close(); media.close();
console.log(`screenshot: ${join(dir, "chatgpt-app.png")}`);
console.log(fails.length ? `FAIL: ${fails.length}` : "all passed");
process.exit(fails.length ? 1 : 0);
