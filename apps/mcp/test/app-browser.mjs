// The Rendrr app as Claude shows it: the page from the connector, in a sandboxed frame with the content security policy
// a host builds from its declared domains, talking MCP Apps (JSON-RPC over postMessage) to a stand-in host whose tools
// answer like Rendrr's. Checks: the projects grid; opening an edit plays its preview (from the storage origin only);
// comments at the player's moment, markers, jump, resolve; Send to Claude; a render's progress, then the new preview
// playing on its own; typing survives the polls; search; theme; size. Real Chromium (Playwright), real video files.
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

// The storage: files with ranges, like signed links.
const media = createServer((req, res) => {
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
    { id: "p1", name: "Knee pain reel", folder: "Spine clinic", aspect: "9:16", status: "In review", version: 2, updated: now - 3600e3, seconds: 8, thumb: `${M}/thumb.jpg?X-Amz-Signature=a`, previewVersion: 1, rendering: false, openComments: 1 },
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
  if (name === "app_add_comment") { db.comments[args.projectId].push({ id: "c" + calls.length, time: args.time, text: args.text, author: "Ana", mine: true, resolved: false, at: Date.now() }); return view(args.projectId); }
  if (name === "app_resolve_comment") { const c = db.comments[args.projectId].find((x) => x.id === args.commentId); c.resolved = args.resolved !== false; return view(args.projectId); }
  if (name === "app_render_preview") { db.rendering[args.projectId] = { renderId: "r2", version: 2, percent: 10, step: null, etaSec: 40, queued: true }; return view(args.projectId); }
  throw new Error("no tool " + name);
}

// The host page: a sandboxed frame, the CSP built from the declared domains, the MCP Apps host side.
const csp = `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src ${M} data:; media-src ${M}; font-src 'none'; connect-src 'none'; frame-src 'none'; base-uri 'none'`;
const doc = APP.replace("<head>", `<head><meta http-equiv="Content-Security-Policy" content="${csp}">`);
const hostHtml = `<!doctype html><meta charset=utf8><body style="margin:0;background:#fff"><iframe id=app sandbox="allow-scripts" style="width:900px;border:0;height:600px"></iframe><script>
const f = document.getElementById("app");
window.log = [];
window.addEventListener("message", async (e) => {
  if (e.source !== f.contentWindow) return;
  const m = e.data; window.log.push(m);
  const reply = (result) => f.contentWindow.postMessage({ jsonrpc: "2.0", id: m.id, result }, "*");
  if (m.method === "ui/initialize") reply({ protocolVersion: "2026-01-26", hostInfo: { name: "test-host", version: "1" }, hostCapabilities: { openLinks: {}, serverTools: {}, message: { text: {} }, updateModelContext: { text: {} } },
    hostContext: { theme: "light", displayMode: "inline", availableDisplayModes: ["inline", "fullscreen"], styles: { variables: { "--color-background-primary": "rgb(250, 249, 245)" } } } });
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
    f.style.width = window.fs ? "1200px" : "900px"; f.style.height = window.fs ? "1000px" : (window.inlineH || 600) + "px";
    reply({ mode: m.params.mode });
    f.contentWindow.postMessage({ jsonrpc: "2.0", method: "ui/notifications/host-context-changed", params: { displayMode: m.params.mode } }, "*");
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

// 1. The grid of every edit, in the host's theme, sized to its content.
await app.locator(".card").first().waitFor({ timeout: 10000 }).catch(async (e) => { console.log("LOG", JSON.stringify(await hostLog()).slice(0, 2000)); console.log("ERR", errors, violations); console.log("HTML", (await frame()?.content())?.slice(-1500)); throw e; });
check((await app.locator(".card").count()) === 2, "All projects shows both edits");
check(/Knee pain reel/.test(await app.locator(".card").first().innerText()) && /Preview v1/.test(await app.locator(".card").first().innerText()) && /1 open comment/.test(await app.locator(".card").first().innerText()), "a card says its preview and open comments");
check(/No preview/.test(await app.locator(".card").nth(1).innerText()), "an edit without a preview says so");
check(await frame().evaluate(() => document.documentElement.dataset.theme === "light" && getComputedStyle(document.body).backgroundColor === "rgb(250, 249, 245)"), "the host's theme and colours are used");
const thumbOk = await frame().evaluate(() => new Promise((r) => { const i = new Image(); i.onload = () => r(true); i.onerror = () => r(false); i.src = getComputedStyle(document.querySelector(".thumb")).backgroundImage.slice(5, -2); }));
check(thumbOk, "thumbnails load from the storage origin");
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

// The host switches to dark: the app follows.
await page.evaluate(() => document.getElementById("app").contentWindow.postMessage({ jsonrpc: "2.0", method: "ui/notifications/host-context-changed", params: { theme: "dark", styles: { variables: { "--color-background-primary": "rgb(31, 30, 29)" } } } }, "*"));
await sleep(200);
check(await frame().evaluate(() => document.documentElement.dataset.theme === "dark" && getComputedStyle(document.body).backgroundColor === "rgb(31, 30, 29)"), "a theme change from the host is followed");
await page.screenshot({ path: join(dir, "app-dark.png") });

check(violations.length === 0, `nothing blocked by the content security policy${violations.length ? ": " + violations.join(" | ") : ""}`);
check(errors.length === 0, `no errors${errors.length ? ": " + errors.join(" | ") : ""}`);
console.log(`screenshots: ${join(dir, "app-list.png")} ${join(dir, "app-fullscreen.png")} ${join(dir, "app-project.png")} ${join(dir, "app-dark.png")}`);
await browser.close(); host.close(); media.close();
if (fails.length) { console.log(`\n${fails.length} failed`); process.exit(1); }
console.log("\nall passed");
