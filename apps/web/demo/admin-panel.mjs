// The admin panel (Rendrr's team): Admin in the menu only for admins; Overview (money, users, cost by day, where the
// money goes, usage, problems, queues); Users (search, plan filter, sort; open one: usage, bill, costs, renders,
// problems, and the changes: trial +7 days, complimentary, back to trial, bonus minutes, spending limit, each logged);
// Costs (totals, per export minute, by kind of job, top users); Storage; Issues (grouped errors, stuck work, browser
// errors with Mark fixed); Jobs; the sections modelled on Dragly's panel (Client folders, Billing, Render health,
// Connections, Gallery, Audit log with reasons, System health) in a side panel, the section in the address; a normal
// account sees "Admins only"; nothing wider than a phone.
// Runs on the demo build (node demo/build.mjs first).   node demo/admin-panel.mjs   (from apps/web)
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
const text = (page, sel) => page.locator(sel).first().textContent().then((t) => (t || "").trim()).catch(() => "");

async function login(page) {
  await page.evaluate(() => globalThis.__rendrrNav.go("/projects")); await sleep(500);
  const email = page.locator('input[type="email"]').first();
  if (await email.count()) { await email.fill("you@example.com"); await page.locator('input[type="password"]').first().fill("x"); await page.locator('button[type="submit"]').first().click(); await sleep(900); }
}
// A section from the side panel (on a phone, the menu button opens it first).
const tab = async (page, label) => {
  if (await page.locator("#adm-menu").isVisible().catch(() => false)) { await page.locator("#adm-menu").click(); await sleep(300); }
  await page.locator(".adm-nav .adm-navitem", { hasText: new RegExp(`^${label}$`) }).click(); await sleep(400);
};
const why = (page, reason = "Testing the panel") => page.locator("#adm-reason").fill(reason);
const fits = (page) => page.evaluate(() => {
  const W = document.documentElement.clientWidth;
  const wide = [...document.querySelectorAll("#admin *")].filter((e) => { const b = e.getBoundingClientRect(); return b.width > 0 && b.right > W + 1 && !e.closest(".tbl-wrap, table, .seg"); }).map((e) => e.id || e.className || e.tagName).slice(0, 5);
  return { ok: document.documentElement.scrollWidth <= W && wide.length === 0, wide };
});

for (const [tag, w, h, mobile] of [["desktop", 1440, 900, false], ["phone", 390, 844, true]]) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, isMobile: mobile, hasTouch: mobile, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));

  // A normal account: no Admin in the menu, and /admin says admins only.
  await page.goto(base + "/"); await sleep(600); await login(page);
  await page.locator("#profile").click(); await sleep(200);
  check(!(await page.evaluate(() => [...document.querySelectorAll("[data-menu]")].map((e) => e.dataset.menu))).includes("Admin"), `${tag}: no Admin in a normal account's menu`);
  await page.locator("#profile").click(); await sleep(100);
  await page.evaluate(() => globalThis.__rendrrNav.go("/admin")); await sleep(800);
  check(/Admins only/.test(await text(page, "#admin")) && await page.locator("#adm-mrr").count() === 0, `${tag}: a normal account opening /admin sees "Admins only" and no numbers`);

  // An admin.
  await page.addInitScript(() => { globalThis.__demoAdmin = true; });
  await page.goto(base + "/"); await sleep(600); await login(page);
  await page.locator("#profile").click(); await sleep(200);
  check((await page.evaluate(() => [...document.querySelectorAll("[data-menu]")].map((e) => e.dataset.menu))).includes("Admin"), `${tag}: Admin is in an admin's menu`);
  await page.locator('[data-menu="Admin"]').click(); await page.locator("#adm-mrr").waitFor({ timeout: 8000 }); await sleep(300);

  // Overview.
  check((await text(page, "#adm-mrr .big")) === "$15.00", `${tag}: monthly recurring is 3 Starter accounts x $5 (${await text(page, "#adm-mrr .big")})`);
  check(/^\$\d+\.\d\d$/.test(await text(page, "#adm-revenue .big")) && /^\$\d+\.\d\d$/.test(await text(page, "#adm-cost .big")), `${tag}: paid and our cost for 30 days are shown`);
  check(/%$|^–$/.test(await text(page, "#adm-margin .big")), `${tag}: the margin is shown (${await text(page, "#adm-margin .big")})`);
  check(/Users · 2 new/.test(await text(page, "#adm-users")), `${tag}: user counts with new this week`);
  check(await page.locator("#adm-cost-chart .col-bar").count() === 30, `${tag}: our cost by day has 30 columns`);
  const parts = await text(page, "#adm-cost-parts");
  check(/CPU/.test(parts) && /Memory/.test(parts) && /Transcription/.test(parts) && /Data sent out/.test(parts) && /Storage/.test(parts) && /Fixed/.test(parts) && /export minute/.test(parts), `${tag}: where the money goes lists CPU, memory, transcription, data out, storage, fixed and the cost of an export minute`);
  check(/Export minutes/.test(await text(page, "#adm-usage")) && /Renders/.test(await text(page, "#adm-usage")), `${tag}: usage for 30 days with renders`);
  check(/Failed renders/.test(await text(page, "#adm-issues-sum")) && /AI tool errors/.test(await text(page, "#adm-issues-sum")), `${tag}: problems in the last 24 hours`);
  check(await page.locator("#adm-queues tbody tr").count() >= 3, `${tag}: each queue's waiting and running jobs`);
  check((await fits(page)).ok, `${tag}: Overview fits the screen (${(await fits(page)).wide.join(", ") || "ok"})`);
  if (process.env.SHOTS) await page.screenshot({ path: join(process.env.SHOTS, `admin-overview-${tag}.png`), fullPage: true });

  // Users: list, search, filter, sort.
  await tab(page, "Users"); await page.locator("#adm-users-list [data-user]").first().waitFor({ timeout: 6000 });
  check(await page.locator("#adm-users-list [data-user]").count() === 6, `${tag}: Users lists every account`);
  await page.locator("#adm-search").fill("maya"); await sleep(800);
  check(await page.locator("#adm-users-list [data-user]").count() === 1 && /maya@studio\.co/.test(await text(page, "#adm-users-list tbody")), `${tag}: search finds Maya by name`);
  await page.locator("#adm-search").fill(""); await sleep(700);
  await page.locator("#adm-plan").selectOption("trial"); await sleep(500);
  check(await page.locator("#adm-users-list [data-user]").count() === 2, `${tag}: the plan filter shows the 2 trial accounts`);
  await page.locator("#adm-plan").selectOption(""); await page.locator("#adm-sort").selectOption("cost"); await sleep(500);
  check((await page.locator("#adm-users-list [data-user]").first().getAttribute("data-user")) === "u2", `${tag}: sorting by our cost puts the costliest account first`);
  if (process.env.SHOTS) await page.screenshot({ path: join(process.env.SHOTS, `admin-users-${tag}.png`), fullPage: true });

  // Open a trial user (Sam, trial ended): extend, add bonus minutes, set a limit, make complimentary, back to trial.
  await page.locator('[data-user="u5"]').click(); await page.locator("#adm-user").waitFor({ timeout: 6000 }); await sleep(200);
  check(/Sam Ode/.test(await text(page, "#adm-user")) && (await text(page, "#adm-user-plan")) === "trial", `${tag}: the user window shows the account and its plan`);
  const user = await text(page, "#adm-user");
  check(/What they cost us/.test(user) && /Latest renders/.test(user) && /Problems/.test(user) && /render/.test(user), `${tag}: it shows their cost by kind of job, latest renders and problems`);
  await page.locator("#adm-extend").click(); await sleep(400);
  check(await page.evaluate(() => (globalThis.__demoAdminChanges || []).length) === 0, `${tag}: a change without a reason is not sent`);
  await why(page, "Asked for more time"); await page.locator("#adm-extend").click(); await sleep(500);
  await why(page); await page.locator("#adm-bonus").fill("15"); await page.locator("#adm-add-bonus").click(); await sleep(500);
  check(/bonus 15 export/.test(await text(page, "#adm-actions")), `${tag}: bonus export minutes are added (${(await text(page, "#adm-actions")).match(/bonus[^·]*/)?.[0]})`);
  await why(page); await page.locator("#adm-limit").fill("50"); await page.locator("#adm-set-limit").click(); await sleep(500);
  check(/limit \$50\.00/.test(await text(page, "#adm-actions")), `${tag}: the spending limit is set to $50`);
  await why(page); await page.locator("#adm-comp").click(); await sleep(500);
  check((await text(page, "#adm-user-plan")) === "comp" && await page.locator("#adm-trial").count() === 1, `${tag}: Make complimentary turns the plan to comp (and offers Back to trial)`);
  await why(page); await page.locator("#adm-trial").click(); await sleep(500);
  check((await text(page, "#adm-user-plan")) === "trial", `${tag}: Back to trial puts them on the trial again`);
  const changes = await page.evaluate(() => globalThis.__demoAdminChanges || []);
  check(changes.every((c) => c.reason) && changes[0].reason === "Asked for more time", `${tag}: every change carries its reason`);
  check(changes.length === 5 && changes[0].trialDays === 7 && changes[1].bonusExportMinutes === 15 && changes[2].spendLimitCents === 5000 && changes[3].plan === "comp" && changes[4].plan === "trial", `${tag}: each change is sent to the server (${changes.map((c) => Object.keys(c).filter((k) => k !== "id").join("+")).join(", ")})`);
  check(/Changes by the team/.test(await text(page, "#adm-user")), `${tag}: the user window lists the team's changes`);
  if (process.env.SHOTS) await page.screenshot({ path: join(process.env.SHOTS, `admin-user-${tag}.png`), fullPage: true });
  await page.keyboard.press("Escape"); await sleep(400);
  check(await page.locator("#adm-user").count() === 0, `${tag}: Escape closes the user window`);
  check(/trial/.test(await text(page, '[data-user="u5"]')), `${tag}: the list shows the change after the window closes`);

  // Costs, Storage, Issues, Jobs.
  await tab(page, "Costs"); await page.locator("#adm-cost-kinds").waitFor({ timeout: 6000 });
  check(/^\$0\.\d{4}$/.test(await text(page, "#adm-per-minute .big")), `${tag}: Costs shows the measured cost of an export minute (${await text(page, "#adm-per-minute .big")})`);
  const kinds = await page.$$eval("#adm-cost-kinds tbody tr td:first-child", (els) => els.map((e) => e.textContent));
  check(["render", "analyze", "proxy", "idle"].every((k) => kinds.includes(k)), `${tag}: costs by kind of job, idle time included (${kinds.join(", ")})`);
  await tab(page, "Storage"); await page.locator("#adm-storage-total").waitFor({ timeout: 6000 });
  check(/GB/.test(await text(page, "#adm-storage-total .big")), `${tag}: Storage shows the GB stored now (${await text(page, "#adm-storage-total .big")})`);
  await tab(page, "Issues"); await page.locator("#adm-failed-renders").waitFor({ timeout: 6000 });
  check(/ffmpeg exited/.test(await text(page, "#adm-failed-renders")) && /Unknown op/.test(await text(page, "#adm-tool-errors")) && /Nothing stuck/.test(await text(page, "#adm-stuck")), `${tag}: Issues groups failed renders, AI tool errors and stuck work`);
  check(/Cannot read properties/.test(await text(page, "#adm-client-errors")), `${tag}: errors in people's browsers are listed`);
  await page.locator("#adm-client-errors button", { hasText: "Mark fixed" }).click(); await sleep(500);
  check(/None/.test(await text(page, "#adm-client-errors")), `${tag}: Mark fixed takes a browser error off the list`);
  check((await fits(page)).ok, `${tag}: Issues fits the screen (${(await fits(page)).wide.join(", ") || "ok"})`);
  await tab(page, "Jobs"); await page.locator("#adm-jobs tbody tr").first().waitFor({ timeout: 6000 });
  check(await page.locator("#adm-jobs tbody tr").count() === 4, `${tag}: Jobs lists the latest job log`);
  await page.locator("#adm-jobs select").selectOption("fail"); await sleep(400);
  check(await page.locator("#adm-jobs tbody tr").count() === 1, `${tag}: Jobs filters by event (failed)`);

  // The sections modelled on Dragly's panel.
  const sections = await page.$$eval(".adm-nav .adm-navitem", (els) => els.map((e) => e.textContent.trim()));
  check(["Overview", "Users", "Client folders", "Billing", "Render health", "Costs", "Storage", "Connections", "Gallery", "Jobs", "Audit log", "Issues", "System health"].every((x) => sections.includes(x)), `${tag}: the side panel lists every section (${sections.join(", ")})`);
  check(/[?&]s=jobs/.test(page.url()), `${tag}: the section is in the address (${page.url().replace(base, "")})`);
  await tab(page, "Client folders"); await page.locator("#adm-folders [data-folder]").first().waitFor({ timeout: 6000 });
  check(await page.locator("#adm-folders [data-folder]").count() === 9, `${tag}: Client folders lists every folder`);
  await page.locator("#adm-folder-search").fill("maya"); await sleep(800);
  check(await page.locator("#adm-folders [data-folder]").count() === 2, `${tag}: folder search finds an owner's folders`);
  await tab(page, "Billing"); await page.locator("#adm-invoices").waitFor({ timeout: 6000 });
  check(/\$15\.00/.test(await text(page, "#adm-billing-totals")) && await page.locator("#adm-invoices tbody tr").count() === 6, `${tag}: Billing shows recurring revenue and every bill`);
  await page.locator("#adm-invoices .seg button", { hasText: "Failed" }).click(); await sleep(500);
  check(await page.locator("#adm-invoices tbody tr").count() === 1, `${tag}: bills filter by status (failed)`);
  check(/Starter/.test(await text(page, "#adm-plans")) && /Complimentary/.test(await text(page, "#adm-plans")), `${tag}: recurring revenue by plan`);
  await tab(page, "Render health"); await page.locator("#adm-render-groups").waitFor({ timeout: 6000 });
  const rg = await text(page, "#adm-render-groups");
  check(/people's computers/.test(rg) && /the cloud/.test(rg) && /render_failed/.test(rg), `${tag}: Render health splits cloud and people's computers, with why renders failed`);
  check(/ffmpeg exited/.test(await text(page, "#adm-render-fails")), `${tag}: the latest render failures are listed`);
  check((await fits(page)).ok, `${tag}: Render health fits the screen (${(await fits(page)).wide.join(", ") || "ok"})`);
  await tab(page, "Connections"); await page.locator("#adm-ai").waitFor({ timeout: 6000 });
  check(/ChatGPT/.test(await text(page, "#adm-ai")) && /0\.1\.20/.test(await text(page, "#adm-computers")) && /open now/.test(await text(page, "#adm-computers")), `${tag}: Connections lists AI apps and desktop apps with versions`);
  await tab(page, "Gallery"); await page.locator("#adm-gallery").waitFor({ timeout: 6000 });
  check(/The Lifter/.test(await text(page, "#adm-gallery")), `${tag}: Gallery lists published edits`);
  await tab(page, "Audit log"); await page.locator("#adm-audit [data-audit]").first().waitFor({ timeout: 6000 });
  check(/Asked for more time/.test(await text(page, "#adm-audit")) && /Sam Ode/.test(await text(page, "#adm-audit")), `${tag}: the audit log shows the changes made here, to whom and why`);
  await page.locator("#adm-audit-search").fill("Render failed twice"); await sleep(800);
  check(await page.locator("#adm-audit [data-audit]").count() === 1, `${tag}: the audit log searches reasons`);
  await tab(page, "System health"); await page.locator("#adm-health-live").waitFor({ timeout: 6000 });
  check(/Database/.test(await text(page, "#adm-health-live")) && /Worker/.test(await text(page, "#adm-health-live")) && /Not set/.test(await text(page, "#adm-keys")) && /c6f14f7/.test(await text(page, "#adm-deploy")), `${tag}: System health shows live checks, keys and this deployment`);
  check((await fits(page)).ok, `${tag}: System health fits the screen (${(await fits(page)).wide.join(", ") || "ok"})`);
  if (process.env.SHOTS) await page.screenshot({ path: join(process.env.SHOTS, `admin-health-${tag}.png`), fullPage: true });

  check(errors.length === 0, `${tag}: no page errors${errors.length ? ": " + errors.join(" | ") : ""}`);
  await ctx.close();
}

await browser.close(); server.close();
console.log(fails.length ? `\n${fails.length} failed` : "\nall passed");
process.exit(fails.length ? 1 : 0);
