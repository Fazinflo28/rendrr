// The Transcript tab of the Rendrr app as Claude shows it: the app page in a sandboxed frame under the host's content
// security policy, talking MCP Apps to a stand-in host. Checks: the tab loads the edit's words (for the preview
// watched), cut and out-of-the-edit words struck through, fillers marked; a click picks a word and the preview goes
// there; dragging picks a run, Cut (or Delete) marks them to cut; a tap on a cut word marks it to come back, a tap on one
// marked to cut keeps it; Apply sends them as one change (Claude is told, the card shows the new version and offers a
// preview), Undo takes it back; Send to Claude sends them as a message with the word ids; the word playing is lit; on a
// touch screen a tap picks a word and a second tap picks up to it. Real Chromium (Playwright), a real video.
//   node test/app-transcript.mjs   (from apps/mcp; needs ffmpeg)
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

const dir = mkdtempSync(join(tmpdir(), "rendrr-transcript-"));
execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=320x568:r=25:d=8", "-f", "lavfi", "-i", "sine=f=440:d=8", "-c:v", "libvpx-vp9", "-b:v", "300k", "-c:a", "libopus", "-shortest", join(dir, "v.webm")]);
const media = createServer((req, res) => {
  const f = join(dir, new URL(req.url, "http://x").pathname.slice(1));
  let size; try { size = statSync(f).size; } catch { res.statusCode = 404; return res.end(); }
  const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || "");
  if (m) { const a = +m[1], b = m[2] ? +m[2] : size - 1; res.writeHead(206, { "content-type": "video/webm", "content-range": `bytes ${a}-${b}/${size}`, "accept-ranges": "bytes", "content-length": b - a + 1 }); createReadStream(f, { start: a, end: b }).pipe(res); }
  else { res.writeHead(200, { "content-type": "video/webm", "content-length": size, "accept-ranges": "bytes" }); createReadStream(f).pipe(res); }
}).listen(0, "127.0.0.1");
await new Promise((r) => media.on("listening", r));
const M = `http://127.0.0.1:${media.address().port}`;

// The edit: three lines of talk; "um" cut, "you know" out of the edit (a range cut), the rest playing in preview v2.
const TEXT = [["Hello", "um", "this", "is", "the", "knee", "pain", "reel"], ["Today", "we", "look", "at", "you", "know", "three", "simple", "moves"], ["Try", "them", "every", "morning"]];
const words = [];
let t = 0.2;
TEXT.forEach((line, li) => line.forEach((w, wi) => { words.push({ id: `w${li}_${wi}`, text: w, line: li, t: Math.round(t * 1000) / 1000, end: Math.round((t + 0.25) * 1000) / 1000, filler: w === "um", state: w === "um" ? "cut" : w === "you" || w === "know" ? "out" : "in" }); t += 0.3; }));
const db = { version: 2, comments: [], previewV: 2 };
const atOf = () => { let at = 0; const m = new Map(); for (const w of words) { if (w.state === "in" || w.keepAt) { m.set(w.id, Math.round(at * 1000) / 1000); at += 0.3; } } return m; };
let frozenAt = atOf(); // the times of preview v2, as rendered
const transcript = () => ({ projectId: "p1", name: "Knee pain reel", version: db.version, timesOf: { version: db.previewV, renderId: "r1" },
  lines: TEXT.map((_, li) => ({ id: "l" + li, start: words.find((w) => w.line === li).t, gap: li === 2 ? 0.8 : 0, words: words.filter((w) => w.line === li).map((w) => [w.id, w.text, w.t, w.end, w.state, frozenAt.get(w.id) ?? null, w.filler ? 1 : 0]) })),
  counts: { words: words.length, cut: words.filter((w) => w.state === "cut").length, out: words.filter((w) => w.state === "out").length }, note: null });
const view = () => ({ project: { id: "p1", name: "Knee pain reel", folder: "Spine clinic", folderId: "f1", aspect: "9:16", status: "In review", version: db.version, updated: Date.now(), seconds: 8, editorUrl: "https://app.rendrr.live/editor/p1" },
  preview: { renderId: "r1", version: db.previewV, kind: "preview", url: `${M}/v.webm`, download: `${M}/v.webm?dl=1`, fileName: "x.mp4", seconds: 8, quality: "540p", at: Date.now() - 60e3, where: "Made on Rendrr's cloud server" },
  versions: [{ renderId: "r1", version: db.previewV, kind: "preview", quality: "540p", at: Date.now() - 60e3 }], rendering: null, failed: null, comments: db.comments, mac: { online: false, device: null } });
const calls = [];
function tool(name, args) {
  calls.push({ name, args });
  if (name === "app_log") return {};
  if (name === "app_get_project") return view();
  if (name === "app_get_transcript") return transcript();
  if (name === "app_cut_words") {
    const n = { cut: 0, back: 0 };
    for (const id of args.cut || []) { const w = words.find((x) => x.id === id); if (w && w.state === "in") { w.state = "cut"; n.cut++; } }
    for (const id of args.restore || []) { const w = words.find((x) => x.id === id); if (w && w.state !== "in") { w.state = "in"; n.back++; } }
    db.version++;
    const summary = [n.cut ? `cut ${n.cut} words` : "", n.back ? `restored ${n.back} cut words` : ""].filter(Boolean).join("; ");
    return { transcript: transcript(), view: view(), summary, version: db.version, changed: true, cut: n.cut, restored: n.back };
  }
  throw new Error("no tool " + name);
}

const csp = `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline' https://fonts.googleapis.com; img-src ${M} data:; media-src ${M}; font-src https://fonts.gstatic.com; connect-src 'none'; frame-src 'none'; base-uri 'none'`;
const doc = APP.replace("<head>", `<head><meta http-equiv="Content-Security-Policy" content="${csp}">`);
const hostHtml = `<!doctype html><meta charset=utf8><meta name=viewport content="width=device-width, initial-scale=1"><body style="margin:0;background:#fff"><iframe id=app sandbox="allow-scripts" style="width:900px;border:0;height:900px"></iframe><script>
const f = document.getElementById("app");
if (location.search.includes("phone")) f.style.width = "100vw";
window.log = [];
window.addEventListener("message", async (e) => {
  if (e.source !== f.contentWindow) return;
  const m = e.data; window.log.push(m);
  const reply = (result) => f.contentWindow.postMessage({ jsonrpc: "2.0", id: m.id, result }, "*");
  if (m.method === "ui/initialize") reply({ protocolVersion: "2026-01-26", hostInfo: { name: "test-host", version: "1" }, hostCapabilities: { openLinks: {}, serverTools: {}, message: { text: {} }, updateModelContext: { text: {} } }, hostContext: { displayMode: "inline", availableDisplayModes: ["inline"] } });
  else if (m.method === "ui/notifications/initialized") {
    f.contentWindow.postMessage({ jsonrpc: "2.0", method: "ui/notifications/tool-input", params: { arguments: { projectId: "p1" } } }, "*");
    const data = await window.hostTool("open", {});
    f.contentWindow.postMessage({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: { content: [{ type: "text", text: "Showing" }], structuredContent: data } }, "*");
  }
  else if (m.method === "tools/call") { try { const d = await window.hostTool(m.params.name, m.params.arguments); reply({ content: [{ type: "text", text: "ok" }], structuredContent: d }); } catch (err) { reply({ content: [{ type: "text", text: String(err.message || err) }], isError: true }); } }
  else if (m.method === "ui/message" || m.method === "ui/open-link" || m.method === "ui/update-model-context") reply({});
  else if (m.method === "ui/notifications/size-changed") f.style.height = Math.min(1600, m.params.height) + "px";
});
f.srcdoc = ${JSON.stringify(doc).replace(/<\//g, "<\\/")};
</script>`;
const host = createServer((_req, res) => { res.setHeader("content-type", "text/html"); res.end(hostHtml); }).listen(0, "127.0.0.1");
await new Promise((r) => host.on("listening", r));

const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" }).catch(() => chromium.launch());
const errors = [], violations = [];
async function openCard(opts = {}, q = "") {
  const ctx = await browser.newContext(opts);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (/Content Security Policy|Refused to/i.test(m.text())) violations.push(m.text()); if (m.type() === "error") errors.push(m.text()); });
  await page.exposeFunction("hostTool", (name, args) => (name === "open" ? { open: view(), webUrl: "https://app.rendrr.live" } : tool(name, args)));
  await page.goto(`http://127.0.0.1:${host.address().port}/${q}`);
  return { page, ctx, app: page.frameLocator("#app"), frame: () => page.frame({ url: /about:srcdoc/ }) ?? page.frames()[1], hostLog: () => page.evaluate(() => window.log.map((m) => ({ method: m.method, params: m.params }))) };
}

// 1. The tab: the words of the edit, for the preview watched.
const { page, app, frame, hostLog } = await openCard({ viewport: { width: 1200, height: 1400 } });
await app.locator(".pv").waitFor({ timeout: 10000 });
check((await app.locator('.tab[data-tab="words"]').count()) === 1 && /Transcript/.test(await app.locator('.tab[data-tab="words"]').innerText()), "the edit has a Transcript tab next to the comments");
await app.locator('.tab[data-tab="words"]').click();
await app.locator(".words .w").first().waitFor({ timeout: 5000 });
check(calls.some((c) => c.name === "app_get_transcript" && c.args.projectId === "p1" && c.args.renderId === "r1"), "it asks Rendrr for the words, timed to the preview watched");
check((await app.locator(".words .w").count()) === words.length && (await app.locator(".words p").count()) === 3, `every word, a paragraph a line (${await app.locator(".words .w").count()} words)`);
const cls = (i) => app.locator(".words .w").nth(i).getAttribute("class");
check(/\bcut\b/.test(await cls(1)) && /\bfl\b/.test(await cls(1)), "the cut filler \"um\" is struck through and marked a filler");
check(/\bout\b/.test(await cls(12)) && /\bout\b/.test(await cls(13)), "words out of the edit (a range cut) are struck through too");
check(/0\.8s silence/.test(await app.locator(".words p").nth(2).innerText()), "a long pause before a line is shown");
check(/21 words · 1 cut · 2 out of the edit/.test(await app.locator("#words-bar").innerText()) && /Drag over words/.test(await app.locator("#words-bar").innerText()), "the bar says how to cut and counts the words");

// 2. A click picks a word and the preview goes there.
await app.locator(".words .w").nth(5).click();
await sleep(300);
check(/\bsel\b/.test(await cls(5)) && /1 word/.test(await app.locator("#word-pop").innerText()), "a click picks the word");
const at5 = transcript().lines[0].words[5][5];
const cur = await frame().evaluate(() => document.querySelector("video").currentTime);
check(Math.abs(cur - at5) < 0.05, `the preview goes to the word (${cur.toFixed(3)} s, word at ${at5} s)`);

// 3. Drag over words: Cut marks them to cut; nothing is changed yet.
const box = async (i) => app.locator(".words .w").nth(i).boundingBox();
const a = await box(2), b = await box(4);
await page.mouse.move(a.x + 3, a.y + a.height / 2); await page.mouse.down();
await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 6 }); await page.mouse.up();
await sleep(150);
check(/3 words/.test(await app.locator("#word-pop").innerText()) && /\bsel\b/.test(await cls(2)) && /\bsel\b/.test(await cls(4)) && !/\bsel\b/.test(await cls(5)), "dragging picks a run of words");
await page.screenshot({ path: join(dir, "transcript-picked.png") });
await app.locator("#cut-words").click();
check(/\bpc\b/.test(await cls(2)) && /\bpc\b/.test(await cls(4)) && (await app.locator("#word-pop").count()) === 0, "Cut marks them to cut (red), and lets them go");
check(/3 words to cut/.test(await app.locator("#words-bar").innerText()) && /Apply makes v3/.test(await app.locator("#words-bar").innerText()), "the bar counts the changes waiting and says Apply makes v3");
check(!calls.some((c) => c.name === "app_cut_words"), "nothing is changed before Apply");

// 4. Taps: a cut word comes back, one marked to cut is kept.
await app.locator(".words .w").nth(1).click();
check(/\bpr\b/.test(await cls(1)), "a click on a cut word marks it to come back (lime)");
await app.locator(".words .w").nth(4).click();
check(!/\bpc\b/.test(await cls(4)), "a click on a word marked to cut keeps it");
check(/2 words to cut · 1 to bring back/.test((await app.locator("#words-bar").innerText()).replace(/\s+/g, " ")), "the bar: 2 to cut, 1 to bring back");
await page.screenshot({ path: join(dir, "transcript-waiting.png") });

// 5. Apply: one change; Claude is told; the card shows the new version and offers a preview.
await app.locator("#words-apply").click();
await app.locator(".words .w.cut").nth(1).waitFor({ timeout: 5000 });
const ap = calls.filter((c) => c.name === "app_cut_words");
check(ap.length === 1 && JSON.stringify(ap[0].args.cut) === JSON.stringify(["w0_2", "w0_3"]) && JSON.stringify(ap[0].args.restore) === JSON.stringify(["w0_1"]) && ap[0].args.renderId === "r1", `Apply sends them as one change (${JSON.stringify(ap[0]?.args)})`);
check(/\bcut\b/.test(await cls(2)) && /\bcut\b/.test(await cls(3)) && !/\bcut\b/.test(await cls(1)), "the words now show as the edit has them");
await sleep(200);
const told = (await hostLog()).filter((m) => m.method === "ui/update-model-context").map((m) => m.params.content[0].text);
check(told.some((x) => /changed the transcript of "Knee pain reel" \(p1\): cut “this is” \(footage 0\.80-1\.35 s\); brought back “um” \(footage 0\.50-0\.75 s\)\. The edit is now v3/.test(x)), `Claude is told what changed, with the words and footage times (${told[told.length - 1]?.slice(0, 220)})`);
check(/v3/.test(await app.locator(".pv .meta").innerText()) && /v3 has changes the latest preview \(v2\) does not show yet/.test(await app.locator(".pv").innerText()), "the card shows v3 and offers to render its preview");
check(/v3: cut 2 words; restored 1 cut words\./.test(await app.locator("#words-bar").innerText()), "the bar says what Apply did, with Undo");

// 6. Undo takes it back (the other way round).
await app.locator("#words-bar button", { hasText: "Undo" }).click();
await sleep(400);
const un = calls.filter((c) => c.name === "app_cut_words")[1];
check(un && JSON.stringify(un.args.cut) === JSON.stringify(["w0_1"]) && JSON.stringify(un.args.restore) === JSON.stringify(["w0_2", "w0_3"]), "Undo cuts what came back and brings back what was cut");
check(/\bcut\b/.test(await cls(1)) && !/\bcut\b/.test(await cls(2)), "the words are as before");

// 7. Delete cuts the words picked; Send to Claude sends them as a message with their ids.
const c1 = await box(15), c2 = await box(16);
await page.mouse.move(c1.x + 3, c1.y + c1.height / 2); await page.mouse.down(); await page.mouse.move(c2.x + c2.width / 2, c2.y + c2.height / 2, { steps: 4 }); await page.mouse.up();
await page.keyboard.press("Delete");
check(/\bpc\b/.test(await cls(15)) && /\bpc\b/.test(await cls(16)), "Delete cuts the words picked");
await app.locator("#words-ask").click();
await sleep(300);
const msgs = (await hostLog()).filter((m) => m.method === "ui/message").map((m) => m.params.content[0].text);
check(msgs.length === 1 && /I picked these words in the transcript:\nCut: “simple moves” \(footage 4\.70-5\.25 s\)\. Word ids: w1_7, w1_8/.test(msgs[0]) && /one apply_edits \(cut_words and restore_words with these word ids/.test(msgs[0]), `Send to Claude sends a message with the words and their ids (${msgs[0]?.slice(0, 200)})`);
check(!/\bpc\b/.test(await cls(15)) && calls.filter((c) => c.name === "app_cut_words").length === 2, "sent, they are no longer waiting here, and nothing was applied");

// 8. The word playing is lit.
await frame().evaluate((x) => new Promise((ok) => { const v = document.querySelector("video"); v.addEventListener("seeked", () => ok(), { once: true }); v.currentTime = x; }), transcript().lines[1].words[2][5] + 0.05);
await sleep(200);
check((await app.locator(".words .w.now").count()) === 1 && (await app.locator(".words .w.now").innerText()) === "look", `the word at the preview's moment is lit (${await app.locator(".words .w.now").allInnerTexts()})`);
check(errors.length === 0, `no page errors${errors.length ? ": " + errors.join(" | ") : ""}`);
await page.screenshot({ path: join(dir, "transcript.png") });

// 9. A phone: a tap picks a word, a second tap picks up to it; Cut.
const ph = await openCard({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true }, "?phone");
await ph.app.locator(".pv").waitFor({ timeout: 10000 });
await ph.app.locator('.tab[data-tab="words"]').tap();
await ph.app.locator(".words .w").first().waitFor({ timeout: 5000 });
check(/Tap a word, tap another/.test(await ph.app.locator("#words-bar").innerText()), "on a phone the bar says to tap");
await ph.app.locator(".words .w").nth(17).tap();
check(/Tap another word to pick up to it/.test(await ph.app.locator("#word-pop").innerText()), "a tap picks a word and says a second tap picks up to it");
await ph.app.locator(".words .w").nth(19).tap();
check(/3 words/.test(await ph.app.locator("#word-pop").innerText()), "a second tap picks up to that word");
await ph.app.locator("#cut-words").tap();
check(/3 words to cut/.test(await ph.app.locator("#words-bar").innerText()), "Cut marks the three to cut");
check(await ph.frame().evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), "nothing wider than the phone");
await ph.page.screenshot({ path: join(dir, "transcript-phone.png") });

check(errors.length === 0, `no page errors${errors.length ? ": " + errors.join(" | ") : ""}`);
check(violations.length === 0, `nothing refused by the content security policy${violations.length ? ": " + violations.join(" | ") : ""}`);
await browser.close(); media.close(); host.close();
console.log(`\nscreenshots in ${dir}`);
console.log(fails.length ? `\n${fails.length} failed` : "\nall passed");
process.exit(fails.length ? 1 : 0);
