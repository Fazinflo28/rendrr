// The samples card (render_samples) as Claude shows it: the app page in a sandboxed frame under the host's content
// security policy, talking MCP Apps to a stand-in host. Checks: while the samples render, their progress and the strip's
// places; once done, the first frame big and every sample in the strip, numbered, with Claude's note on the one picked;
// a clip plays in the viewer (with its first frame as its poster, nothing starts on its own); next and previous; a change
// asked on a frame is a comment on the samples at that frame's moment (Claude is told), marked on its thumbnail and
// listed under it, and can be taken back; Send changes and Looks good message the chat; back opens the edit.
// Real Chromium (Playwright), real pictures and video.
//   node test/app-samples.mjs   (from apps/mcp; needs ffmpeg)
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

const dir = mkdtempSync(join(tmpdir(), "rendrr-samples-"));
const ff = (...a) => execFileSync("ffmpeg", ["-v", "error", "-y", ...a]);
for (const [i, src] of ["testsrc2", "smptebars", "rgbtestsrc", "testsrc"].entries()) ff("-f", "lavfi", "-i", `${src}=s=640x360`, "-frames:v", "1", join(dir, `s${i}.jpg`));
ff("-f", "lavfi", "-i", "testsrc2=s=640x360:r=25:d=4", "-c:v", "libvpx-vp9", "-b:v", "300k", join(dir, "c2.webm"));

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

// Rendrr behind the host: one set of samples, rendering until it is looked at twice.
const items = [
  { kind: "frame", at: 1, end: null, note: "The hook's title, big and centred" },
  { kind: "frame", at: 4.2, end: null, note: null },
  { kind: "clip", at: 6, end: 10, note: "The whip into the product shot" },
  { kind: "frame", at: 12.5, end: null, note: "The end card" },
];
const done = items.map((x, k) => ({ ...x, still: `${M}/s${k}.jpg?X-Amz-Signature=${k}`, clip: x.kind === "clip" ? `${M}/c2.webm?X-Amz-Signature=c` : null }));
const db = { looks: 0, comments: [] };
const calls = [];
const view = () => {
  const ready = db.looks >= 2;
  return { renderId: "rs1", project: { id: "p1", name: "SaaS promo", aspect: "16:9", version: 3, editorUrl: "https://app.rendrr.live/editor/p1" }, version: 3,
    status: ready ? "done" : db.looks ? "running" : "queued", percent: ready ? 100 : db.looks * 40, step: db.looks ? "Rendering samples" : null, etaSec: ready ? null : 20, error: null,
    width: 960, height: 540, items: ready ? done : items.map((x) => ({ ...x, still: null, clip: null })), comments: db.comments };
};
function tool(name, args) {
  calls.push({ name, args });
  if (name === "app_get_samples") { db.looks++; return view(); }
  if (name === "app_add_comment") { db.comments.push({ id: "c" + calls.length, time: args.time, text: args.text, author: "Ana", mine: true, resolved: false, at: Date.now(), edited: false, renderId: args.renderId ?? null, drawing: null, images: [] }); return {}; }
  if (name === "app_delete_comment") { db.comments = db.comments.filter((x) => x.id !== args.commentId); return {}; }
  if (name === "app_get_project") return { project: { id: "p1", name: "SaaS promo", folder: "Promos", aspect: "16:9", status: "Draft", version: 3, updated: Date.now(), seconds: 14, editorUrl: null }, preview: null, versions: [], rendering: null, failed: null, comments: [] };
  if (name === "app_list_projects") return { projects: [], total: 0, offset: 0 };
  if (name === "app_render_preview") return tool("app_get_project", args);
  throw new Error("no tool " + name);
}

const csp = `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline' https://fonts.googleapis.com; img-src ${M} data:; media-src ${M}; font-src https://fonts.gstatic.com; connect-src 'none'; frame-src 'none'; base-uri 'none'`;
const doc = APP.replace("<head>", `<head><meta http-equiv="Content-Security-Policy" content="${csp}">`);
const hostHtml = `<!doctype html><meta charset=utf8><body style="margin:0;background:#fff"><iframe id=app sandbox="allow-scripts" style="width:900px;border:0;height:700px"></iframe><script>
const f = document.getElementById("app");
window.log = [];
window.addEventListener("message", async (e) => {
  if (e.source !== f.contentWindow) return;
  const m = e.data; window.log.push(m);
  const reply = (result) => f.contentWindow.postMessage({ jsonrpc: "2.0", id: m.id, result }, "*");
  if (m.method === "ui/initialize") reply({ protocolVersion: "2026-01-26", hostInfo: { name: "test-host", version: "1" }, hostCapabilities: { openLinks: {}, serverTools: {}, message: { text: {} }, updateModelContext: { text: {} } }, hostContext: { displayMode: "inline", availableDisplayModes: ["inline", "fullscreen"] } });
  else if (m.method === "ui/notifications/initialized") {
    f.contentWindow.postMessage({ jsonrpc: "2.0", method: "ui/notifications/tool-input", params: { arguments: { projectId: "p1" } } }, "*");
    const data = await window.hostTool("open", {});
    f.contentWindow.postMessage({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: { content: [{ type: "text", text: "Samples" }], structuredContent: data } }, "*");
  }
  else if (m.method === "tools/call") { try { const d = await window.hostTool(m.params.name, m.params.arguments); reply({ content: [{ type: "text", text: "ok" }], structuredContent: d }); } catch (err) { reply({ content: [{ type: "text", text: String(err.message || err) }], isError: true }); } }
  else if (m.method === "ui/message" || m.method === "ui/open-link" || m.method === "ui/update-model-context") reply({});
  else if (m.method === "ui/request-display-mode") reply({ mode: "inline" });
  else if (m.method === "ui/notifications/size-changed") f.style.height = Math.min(1600, m.params.height) + "px";
});
f.srcdoc = ${JSON.stringify(doc).replace(/<\//g, "<\\/")};
</script>`;
const host = createServer((_req, res) => { res.setHeader("content-type", "text/html"); res.end(hostHtml); }).listen(0, "127.0.0.1");
await new Promise((r) => host.on("listening", r));

const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" }).catch(() => chromium.launch());
const page = await browser.newPage({ viewport: { width: 1200, height: 1400 } });
const errors = [], violations = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => { if (/Content Security Policy|Refused to/i.test(m.text())) violations.push(m.text()); if (m.type() === "error") errors.push(m.text()); });
// render_samples' result: the samples, nothing else (not the projects list).
await page.exposeFunction("hostTool", (name, args) => (name === "open" ? { open: null, webUrl: "https://app.rendrr.live", samples: view() } : tool(name, args)));
await page.goto(`http://127.0.0.1:${host.address().port}/`);
const app = page.frameLocator("#app");
const frame = () => page.frame({ url: /about:srcdoc/ }) ?? page.frames()[1];
const hostLog = () => page.evaluate(() => window.log.map((m) => ({ method: m.method, params: m.params })));

// 1. While they render: the progress, a place in the strip for each, no box to ask a change yet.
await app.locator(".sv").waitFor({ timeout: 10000 });
check(/Samples · SaaS promo/.test(await app.locator(".sv h1").innerText()) && /3 frames · 1 clip/.test(await app.locator(".sv .meta").innerText()), "the card names the edit and what it holds (3 frames, 1 clip)");
check(/Waiting to render the samples|Rendering samples/.test(await app.locator(".sv .note").innerText()) && (await app.locator(".strip .th.wait").count()) === 4, "while rendering: their progress, and a place for each in the strip");
check((await app.locator(".ask").count()) === 0 && (await app.locator(".viewer .wait").count()) === 1, "nothing to ask a change on until they are done");
await page.screenshot({ path: join(dir, "samples-rendering.png") });

// 2. Done (the card looks again on its own): the first frame big, every sample in the strip, numbered.
await app.locator(".viewer img").waitFor({ timeout: 15000 });
check(calls.filter((c) => c.name === "app_get_samples").length >= 2, "the card looks again while they render, by itself");
const big = await frame().evaluate(() => new Promise((r) => { const i = document.querySelector(".viewer img"); const done = () => r({ ok: i.complete && i.naturalWidth > 0, src: i.getAttribute("src") }); i.complete ? done() : (i.onload = done, i.onerror = done); }));
check(big.ok && /s0\.jpg/.test(big.src), `the first sample, big, from the storage (${big.src})`);
check((await app.locator(".strip .th").count()) === 4 && (await app.locator(".strip .th img").count()) === 4 && (await app.locator(".strip .th.on").count()) === 1, "every sample in the strip, the one shown marked");
check((await app.locator(".strip .th .n").allInnerTexts()).join(",") === "1,2,3,4" && /▶ 4s/.test(await app.locator(".strip .th").nth(2).innerText()), "numbered, a clip says its length");
check(/1\/4 · Frame 0:01\.0/.test(await app.locator(".viewer .tag").innerText()), "the viewer says which sample it is");
check(/Claude: The hook's title, big and centred/.test(await app.locator(".snote").innerText()), "Claude's note on the sample shown");
await page.screenshot({ path: join(dir, "samples-done.png") });

// 3. A clip: its video in the viewer, its first frame as the poster, waiting for play.
await app.locator(".strip .th").nth(2).click();
await app.locator(".viewer video").waitFor({ timeout: 5000 });
const vid = await frame().evaluate(() => { const v = document.querySelector(".viewer video"); return { src: v.getAttribute("src"), poster: v.getAttribute("poster"), paused: v.paused, controls: v.controls, loop: v.loop }; });
check(/c2\.webm/.test(vid.src) && /s2\.jpg/.test(vid.poster) && vid.paused && vid.controls && vid.loop, "a clip plays in the viewer: its poster is its first frame, nothing starts on its own");
check(/Claude: The whip into the product shot/.test(await app.locator(".snote").innerText()), "the clip's own note");
// Next and previous go round.
await app.locator(".viewer .nav.next").click(); await sleep(100);
check(/4\/4/.test(await app.locator(".viewer .tag").innerText()), "next: the end card");
await app.locator(".viewer .nav.next").click(); await sleep(100);
check(/1\/4/.test(await app.locator(".viewer .tag").innerText()), "next from the last goes back to the first");
await app.locator(".viewer .nav.prev").click(); await sleep(100);
check(/4\/4/.test(await app.locator(".viewer .tag").innerText()), "previous from the first goes to the last");

// 4. A change on frame 1: a comment on the samples at its moment; Claude is told; marked and listed.
await app.locator(".strip .th").nth(0).click(); await sleep(100);
check((await app.locator(".ask textarea").count()) === 1 && /this frame/.test(await app.locator(".ask textarea").getAttribute("placeholder")), "a box to ask a change on this frame");
await app.locator(".ask textarea").fill("Make the title yellow and twice as big");
await app.locator(".ask button", { hasText: "Add change" }).click();
await app.locator(".chg").first().waitFor({ timeout: 5000 });
const add = calls.find((c) => c.name === "app_add_comment");
check(add && add.args.time === 1 && add.args.renderId === "rs1" && add.args.projectId === "p1" && /yellow/.test(add.args.text), `the change is a comment on the samples at the frame's moment (${JSON.stringify(add?.args)})`);
check((await hostLog()).some((m) => m.method === "ui/update-model-context" && /asked a change on sample 1 .*yellow/.test(JSON.stringify(m.params))), "Claude is told about the change");
check(/0:01\.0.*Make the title yellow/s.test(await app.locator(".chg").first().innerText()) && (await app.locator(".strip .th").nth(0).locator(".dot").innerText()) === "1", "the change is listed under it and marked on its thumbnail");
check((await app.locator(".ask textarea").inputValue()) === "", "the box is empty again");
// Another on the clip, then one taken back.
await app.locator(".strip .th").nth(2).click(); await sleep(150);
await app.locator(".ask textarea").fill("Faster whip");
await app.locator(".ask button", { hasText: "Add change" }).click(); await sleep(400);
const clipAdd = calls.filter((c) => c.name === "app_add_comment")[1];
check(clipAdd && clipAdd.args.time >= 6 && clipAdd.args.time < 10, `a clip's change is at the moment it is paused on (${clipAdd?.args.time})`);
await app.locator(".strip .th").nth(1).click(); await sleep(100);
check((await app.locator(".chg").count()) === 0, "a sample without changes lists none");

// 5. Send the changes, and Looks good: messages in the chat.
const send = app.locator(".sendbar .btn.primary");
check(/Send 2 changes to Claude/.test(await send.innerText()), `the send button counts the changes (${await send.innerText()})`);
await send.click(); await sleep(300);
const msg = (await hostLog()).filter((m) => m.method === "ui/message").map((m) => m.params.content[0].text);
check(msg.length === 1 && /Sample 1 \(Frame 0:01\.0\): Make the title yellow/.test(msg[0]) && /Sample 3 \(Clip 0:06\.0-0:10\.0\): Faster whip/.test(msg[0]) && /render_samples again/.test(msg[0]), `Send: the changes by sample, in one message (${(msg[0] || "").slice(0, 160)})`);
await app.locator(".strip .th").nth(2).click(); await sleep(100);
await app.locator(".chg .x").first().click(); await sleep(400);
check(calls.some((c) => c.name === "app_delete_comment") && (await app.locator(".strip .th").nth(2).locator(".dot").count()) === 0, "a change can be taken back");
await app.locator(".sendbar .btn.ghost").click(); await sleep(300);
const msg2 = (await hostLog()).filter((m) => m.method === "ui/message").map((m) => m.params.content[0].text);
check(msg2.length === 2 && /look good\. Render the full preview/.test(msg2[1]), "Looks good: asks Claude for the full preview");
await page.screenshot({ path: join(dir, "samples-changes.png") });

// 6. Back: the edit opens.
await app.locator('.sv button[aria-label="Open the edit"]').click();
await app.locator(".pv").waitFor({ timeout: 5000 });
check(calls.some((c) => c.name === "app_get_project" && c.args.projectId === "p1"), "back opens the edit");
check(errors.length === 0, `no page errors${errors.length ? ": " + errors.join(" | ") : ""}`);
check(violations.length === 0, `nothing refused by the content security policy${violations.length ? ": " + violations.join(" | ") : ""}`);

await browser.close(); media.close(); host.close();
console.log(`\nscreenshots in ${dir}`);
console.log(fails.length ? `\n${fails.length} failed` : "\nall passed");
process.exit(fails.length ? 1 : 0);
