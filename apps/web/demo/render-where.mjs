// Where a render runs and where finals go, in the web app. Connect AI: with the Rendrr Mac app closed, renders run on
// Rendrr's cloud server and the AI's finals go to Google Drive; open but unable to render (an older app), still the
// cloud, saying why, finals to that Mac; open and able, renders run on that Mac, by name. The Export window says where
// the render is made (the cloud, or "Studio Mac") and the finished final where it was made. In the Mac app: its name
// and what it can render go with its ping, a switch turns rendering on this Mac off and on, and a render Rendrr holds
// for this Mac is taken and handed to the app.
// Runs on the demo build (node demo/build.mjs first).   node demo/render-where.mjs   (from apps/web)
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const web = resolve(here, "..");
const require = createRequire(import.meta.url);
const { chromium } = require(require.resolve("playwright-core", { paths: [web, ...(process.env.NODE_PATH || "").split(":").filter(Boolean)] }));
const html = readFileSync(join(here, "dist", "rendrr-preview.html"));
const server = createServer((_req, res) => { res.setHeader("content-type", "text/html"); res.end(html); }).listen(0);
const base = `http://localhost:${server.address().port}`;
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" }).catch(() => chromium.launch());
const fails = [];
const check = (ok, what) => { console.log(`${ok ? "ok  " : "FAIL"} ${what}`); if (!ok) fails.push(what); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const text = (page, sel) => page.locator(sel).first().innerText().then((t) => t.trim()).catch(() => "");

async function login(page) {
  await page.evaluate(() => globalThis.__rendrrNav.go("/projects")); await sleep(500);
  const email = page.locator('input[type="email"]').first();
  if (await email.count()) { await email.fill("you@example.com"); await page.locator('input[type="password"]').first().fill("x"); await page.locator('button[type="submit"]').first().click(); await sleep(900); }
}

for (const [tag, w, h, mobile] of [["desktop", 1440, 900, false], ["phone", 390, 844, true]]) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, isMobile: mobile, hasTouch: mobile });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(base + "/"); await sleep(600); await login(page);

  // Connect AI with the Mac app closed: renders in the cloud, finals to Google Drive.
  await page.evaluate(() => globalThis.__rendrrNav.go("/connect")); await page.locator("#exports-card #mac-status").waitFor({ timeout: 8000 });
  check((await text(page, "#render-place-text")) === "Renders run on Rendrr's cloud server" && /Open the Rendrr app on your Mac or PC to render on your computer/.test(await text(page, "#exports-card")), `${tag}: Connect AI says renders run on Rendrr's cloud server while the Mac app is closed`);
  check((await text(page, "#mac-status")) === "App closed" && /go to Google Drive/.test(await text(page, "#exports-to")), `${tag}: with the Mac app closed, the AI's finals go to Google Drive`);

  // An older Mac app opens on "Studio Mac" (it cannot render): connected, by name, renders still in the cloud, saying why.
  await page.evaluate(() => { globalThis.__demoMac = { online: true, device: "Studio Mac", version: "0.1.9", seenAt: Date.now(), renders: false, why: "this Mac app cannot render yet: update it" }; globalThis.__rendrrWrites = (globalThis.__rendrrWrites || 0) + 1; });
  await page.locator('#exports-card button[aria-label="Refresh"]').click(); await sleep(500);
  check((await text(page, "#mac-status")) === "Mac connected" && (await text(page, "#exports-to")) === "Finals go to Studio Mac" && /Saved to Downloads/.test(await text(page, "#exports-card")), `${tag}: with the Mac app open, finals go to that Mac by name (${await text(page, "#exports-to")})`);
  check((await text(page, "#render-place-text")) === "Renders run on Rendrr's cloud server" && /The Mac app is open, but this Mac app cannot render yet: update it/.test(await text(page, "#exports-card")), `${tag}: an older Mac app: renders stay in the cloud, and it says why`);
  // The new Mac app, able to render: renders run on that Mac.
  await page.evaluate(() => { globalThis.__demoMac = { online: true, device: "Studio Mac", version: "0.2.0", seenAt: Date.now(), renders: true, why: null }; globalThis.__rendrrWrites = (globalThis.__rendrrWrites || 0) + 1; });
  await page.locator('#exports-card button[aria-label="Refresh"]').click(); await sleep(500);
  check((await text(page, "#render-place")) === "Mac" && (await text(page, "#render-place-text")) === "Renders run on Studio Mac", `${tag}: with the Mac app open and able, renders run on that Mac (${await text(page, "#render-place-text")})`);
  // The Windows app open on "Gaming PC" and able: renders run on that PC, said as a PC.
  await page.evaluate(() => { globalThis.__demoMac = { online: true, device: "Gaming PC", version: "0.1.1", seenAt: Date.now(), renders: true, why: null, platform: "windows" }; globalThis.__rendrrWrites = (globalThis.__rendrrWrites || 0) + 1; });
  await page.locator('#exports-card button[aria-label="Refresh"]').click(); await sleep(500);
  check((await text(page, "#render-place")) === "PC" && (await text(page, "#render-place-text")) === "Renders run on Gaming PC" && (await text(page, "#mac-status")) === "PC connected" && /while the Rendrr Windows app is open/.test(await text(page, "#exports-card")), `${tag}: with the Windows app open, renders run on that PC (${await text(page, "#render-place")} / ${await text(page, "#mac-status")})`);
  await page.evaluate(() => { globalThis.__demoMac = { online: true, device: "Studio Mac", version: "0.2.0", seenAt: Date.now(), renders: true, why: null }; globalThis.__rendrrWrites = (globalThis.__rendrrWrites || 0) + 1; });
  await page.locator('#exports-card button[aria-label="Refresh"]').click(); await sleep(500);
  const wide = await page.evaluate(() => { const W = document.documentElement.clientWidth; return [...document.querySelectorAll("#exports-card *")].filter((e) => e.getBoundingClientRect().right > W + 1).length; });
  check(wide === 0, `${tag}: the card fits the screen`);
  // The account open on two computers that can render (a Mac and a busy PC): both listed; the AI asks, or the one picked.
  const two = () => ({ online: true, device: "M1", version: "0.2.0", seenAt: Date.now(), renders: true, why: null, deviceId: "a1", choice: null, devices: [{ id: "a1", name: "M1", platform: "mac", version: "0.2.0", seenAt: Date.now(), renders: true, busy: false, why: null }, { id: "b2", name: "Gaming PC", platform: "windows", version: "0.1.2", seenAt: Date.now(), renders: true, busy: true, why: null }] });
  await page.evaluate(`globalThis.__demoMac = (${two.toString()})(); globalThis.__rendrrWrites = (globalThis.__rendrrWrites || 0) + 1;`);
  await page.locator('#exports-card button[aria-label="Refresh"]').click(); await sleep(500);
  check((await text(page, "#render-place")) === "2 computers" && (await text(page, "#render-place-text")) === "Your AI asks which computer renders" && (await page.locator("#devices [data-device]").count()) === 2 && /Gaming PC[\s\S]*Rendering now/.test(await text(page, "#devices")), `${tag}: two computers: both listed, and the AI asks which renders (${await text(page, "#render-place-text")})`);
  await page.locator("#render-choice").selectOption("b2"); await sleep(400);
  check((await page.evaluate(() => globalThis.__demoChoice)) === "b2" && (await text(page, "#render-place-text")) === "Renders run on Gaming PC", `${tag}: picking one in Settings: renders run there (${await text(page, "#render-place-text")})`);
  await page.evaluate(() => { globalThis.__demoMac = { online: true, device: "Studio Mac", version: "0.2.0", seenAt: Date.now(), renders: true, why: null }; globalThis.__rendrrWrites = (globalThis.__rendrrWrites || 0) + 1; });
  if (process.env.SHOTS) await page.screenshot({ path: join(process.env.SHOTS, `render-where-connect-${tag}.png`) });

  // The Export window: while it runs it says where; when done, that it was made in the cloud.
  if (!mobile) {
    await page.evaluate(() => globalThis.__rendrrNav.go("/editor/p6")); await page.locator("#timeline").waitFor({ timeout: 8000 }); await sleep(800);
    await page.locator("#render-final").click(); await page.locator("#export-panel").waitFor();
    await page.locator("#export-render").click(); await page.locator("#export-run").waitFor({ timeout: 6000 });
    check((await text(page, "#render-where")) === "Rendering on Rendrr's cloud server, not on this computer", `${tag}: the Export window says it renders on Rendrr's cloud server, not this computer`);
    await page.locator("#render-done").waitFor({ timeout: 30000 }).catch(() => {});
    check((await text(page, "#render-made")) === "Made on Rendrr's cloud server", `${tag}: the finished final says it was made on Rendrr's cloud server`);
    // Made on the Mac: the window says so while it runs, and the final where it was made.
    await page.evaluate(() => { globalThis.__demoMadeOn = { on: "mac", device: "Studio Mac" }; });
    await page.keyboard.press("Escape"); await sleep(400);
    await page.locator("#render-final").click(); await page.locator("#export-panel").waitFor();
    await page.locator("#export-render").click(); await page.locator("#export-run").waitFor({ timeout: 6000 });
    await sleep(700);
    check((await text(page, "#render-where")) === "Rendering on Studio Mac by the Rendrr Mac app", `${tag}: made on the Mac, the Export window says so (${await text(page, "#render-where")})`);
    await page.locator("#render-done").waitFor({ timeout: 30000 }).catch(() => {});
    check((await text(page, "#render-made")) === "Made on Studio Mac · saved to Downloads", `${tag}: the finished final says it was made on that Mac and is in Downloads (${await text(page, "#render-made")})`);
    await page.evaluate(() => { globalThis.__demoMadeOn = null; });
    // Two computers can render: the Export window offers them and Rendrr's cloud; the one chosen goes with the export.
    await page.evaluate(`globalThis.__demoMac = (${two.toString()})(); globalThis.__rendrrWrites = (globalThis.__rendrrWrites || 0) + 1;`);
    await page.keyboard.press("Escape"); await sleep(400);
    await page.locator("#render-final").click(); await page.locator("#export-panel").waitFor();
    await page.locator("#export-device").waitFor({ timeout: 4000 }).catch(() => {});
    const opts = await page.locator("#export-device option").allInnerTexts().catch(() => []);
    check(opts.join(" | ") === "M1 (Mac) | Gaming PC (PC) · busy | Rendrr's cloud server" && (await page.locator("#export-device").inputValue()) === "a1", `${tag}: the Export window offers the computers and the cloud (${opts.join(" | ")})`);
    await page.locator("#export-device").selectOption("cloud");
    await page.locator("#export-render").click(); await sleep(600);
    check((await page.evaluate(() => globalThis.__lastRenderOpts?.device)) === "cloud", `${tag}: the computer chosen goes with the export (${await page.evaluate(() => JSON.stringify(globalThis.__lastRenderOpts))})`);
    await page.locator("#render-done").waitFor({ timeout: 30000 }).catch(() => {});
    await page.evaluate(() => { globalThis.__demoMac = null; });
  }
  check(errors.length === 0, `${tag}: no page errors${errors.length ? ": " + errors.join(" | ") : ""}`);
  await ctx.close();
}

// The desktop app (Mac, then Windows): its name, platform and what it can render go with the ping; the switch; a held
// render taken and handed over.
for (const [plat, M, dev] of [["mac", "Mac", "Studio Mac"], ["windows", "PC", "Gaming PC"]]) {
const mctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
await mctx.addInitScript(([plat, dev]) => {
  const st = { protocol: 1, ready: true, enabled: true, busy: false, cpus: 10, have: ["libx264", "ass"], ffmpeg: "8.0", why: null };
  const subs = new Set();
  globalThis.__runs = [];
  window.rendrrDesktop = Object.freeze({ app: plat, platform: plat === "windows" ? "win32" : "darwin", version: "0.2.0", device: dev, deviceId: plat + "-id-1", openInBrowser: () => {},
    render: Object.freeze({
      info: async () => ({ ...st }),
      setEnabled: async (on) => { st.enabled = !!on; subs.forEach((f) => f({ ...st })); return { ...st }; },
      run: async (task) => { globalThis.__runs.push(task); return { started: true }; },
      onState: (cb) => { subs.add(cb); return () => subs.delete(cb); },
    }) });
  globalThis.__demoMacTasks = [{ id: "t1", label: "Preview v3 of Promo", claimed: false, task: { v: 1, id: "t1", label: "Preview v3 of Promo" } }];
}, [plat, dev]);
const mp = await mctx.newPage();
const merrors = []; mp.on("pageerror", (e) => merrors.push(e.message));
await mp.goto(base + "/"); await sleep(600); await login(mp); await sleep(800);
const ping = await mp.evaluate(() => globalThis.__demoMacPing);
check(ping && ping.device === dev && ping.platform === plat && ping.deviceId === plat + "-id-1" && ping.version === "0.2.0" && ping.render?.protocol === 1 && ping.render?.ready && ping.render?.have?.includes("libx264"), `the ${plat} app sends its name, platform and what it can render with its ping (${JSON.stringify(ping)})`);
let said = false;
const sayRe = new RegExp(`Making Preview v3 of Promo on this ${M}`);
for (let i = 0; i < 40 && !said; i++) { said = sayRe.test(await mp.locator("body").innerText()); if (!said) await sleep(100); }
await sleep(3500);
const runs = await mp.evaluate(() => globalThis.__runs.map((t) => t.id));
check(runs.length === 1 && runs[0] === "t1" && (await mp.evaluate(() => globalThis.__demoTasksFor)) === plat + "-id-1", `${plat}: a render Rendrr holds for this computer (asked for by its id) is taken once and handed to the app (${JSON.stringify(runs)})`);
check(said, `${plat}: it says it is making it on this ${M}`);
await mp.evaluate(() => globalThis.__rendrrNav.go("/connect")); await mp.locator("#render-here").waitFor({ timeout: 8000 });
check((await text(mp, "#render-here")).startsWith(`Render on this ${M}`) && (await text(mp, "#render-here-sub")) === "On · FFmpeg 8.0" && (await mp.locator("#render-here-toggle").getAttribute("aria-checked")) === "true", `${plat}: the app's switch: on (${await text(mp, "#render-here-sub")})`);
const before = await mp.evaluate(() => globalThis.__demoMacPings);
await mp.locator("#render-here-toggle").click(); await sleep(500);
check((await mp.locator("#render-here-toggle").getAttribute("aria-checked")) === "false" && /Off: renders run on Rendrr's cloud server/.test(await text(mp, "#render-here-sub")), `${plat}: turned off: renders run on the cloud`);
check((await mp.evaluate(() => globalThis.__demoMacPings)) > before && (await mp.evaluate(() => globalThis.__demoMacPing.render?.enabled)) === false, `${plat}: Rendrr is told at once`);
check(merrors.length === 0, `the ${plat} app: no page errors${merrors.length ? ": " + merrors.join(" | ") : ""}`);
await mctx.close();
}

await browser.close(); server.close();
console.log(fails.length ? `\n${fails.length} failed` : "\nall passed");
process.exit(fails.length ? 1 : 0);
