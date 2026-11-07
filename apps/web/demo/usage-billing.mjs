// Usage & billing (like Railway's usage page): the plan bar, money cards, meters for each allowance, the day by day
// chart, pay-as-you-go lines, usage by project, storage; the spending limit window; the Billing tab (plans, card,
// invoices); a trial account's Start Starter button (Stripe checkout) and the thank-you note after; the dialog any
// refused render or upload shows; nothing wider than a phone. Runs on the demo build (node demo/build.mjs first).
//   node demo/usage-billing.mjs   (from apps/web)
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

async function login(page) {
  await page.evaluate(() => globalThis.__rendrrNav.go("/projects")); await sleep(500);
  const email = page.locator('input[type="email"]').first();
  if (await email.count()) { await email.fill("you@example.com"); await page.locator('input[type="password"]').first().fill("x"); await page.locator('button[type="submit"]').first().click(); await sleep(900); }
}
const text = (page, sel) => page.locator(sel).first().textContent().then((t) => (t || "").trim()).catch(() => "");

for (const [tag, w, h, mobile] of [["desktop", 1440, 900, false], ["phone", 390, 844, true]]) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, isMobile: mobile, hasTouch: mobile, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(base + "/"); await sleep(600);
  await login(page);

  // --- Starter account (the demo default): 31.5 export min of 25, 72 footage min of 60, 6.4 GB of 10. ---
  await page.evaluate(() => globalThis.__rendrrNav.go("/usage")); await page.locator("#meters").waitFor({ timeout: 8000 }); await sleep(300);
  check((await text(page, "#plan-name")) === "Starter", `${tag}: the plan bar names the plan (${await text(page, "#plan-name")})`);
  check(/Active/.test(await text(page, "#plan-status")), `${tag}: the plan is Active`);
  check(/This period: .* days left/.test(await text(page, "#plan-period")), `${tag}: the plan bar shows the period and days left (${await text(page, "#plan-period")})`);
  // 6.5 export minutes over at $0.10 = $0.65, 12 footage minutes over = 0.2 h at $1 = $0.20: $0.85 so far.
  check((await text(page, "#current-usage")) === "$0.85", `${tag}: pay as you go so far is $0.85 (${await text(page, "#current-usage")})`);
  const est = Number((await text(page, "#estimated-bill")).replace("$", ""));
  check(est >= 5.85, `${tag}: the estimated bill is the $5 plus usage, projected to the period's end ($${est})`);
  check((await text(page, "#spend-limit")) === "$20.00", `${tag}: the spending limit starts at $20`);
  const meters = await page.$$eval("#meters .meter", (els) => els.map((e) => ({ m: e.dataset.metric, t: e.textContent, over: !!e.querySelector(".bar.over"), bar: !!e.querySelector(".bar") })));
  check(["export", "preview", "footage", "storage"].every((m) => meters.some((x) => x.m === m)), `${tag}: a meter for export, preview, footage and storage (${meters.map((x) => x.m).join(", ")})`);
  const ex = meters.find((x) => x.m === "export");
  check(ex && /31\.5 min of 25 min/.test(ex.t) && /6\.5 over/.test(ex.t) && ex.over, `${tag}: the export meter says 31.5 of 25 min, 6.5 over, in the over colour (${ex?.t})`);
  const pv = meters.find((x) => x.m === "preview");
  check(pv && /free on Starter/.test(pv.t) && !pv.bar, `${tag}: previews are free on Starter (no bar) (${pv?.t})`);
  const bars = await page.locator("#daily-chart .col-bar").count();
  check(bars === 12, `${tag}: the day by day chart has a column per day of the period so far (${bars})`);
  const segs = await page.locator("#daily-chart .col-bar i").count();
  check(segs > 0, `${tag}: the chart columns are filled (${segs} parts)`);
  const lines = await page.$$eval("#payg-lines tbody tr", (els) => els.map((e) => e.textContent));
  check(lines.some((l) => /Extra export minutes.*6\.5 min.*\$0\.65/.test(l)) && lines.some((l) => /Extra footage.*12 min.*\$0\.20/.test(l)) && lines.some((l) => /Total so far.*\$5\.85/.test(l)), `${tag}: the pay-as-you-go table lists the export minutes over ($0.65), the footage over ($0.20) and a $5.85 total (${lines.join(" | ")})`);
  check(await page.locator("#by-project tbody tr").count() === 2, `${tag}: usage by project lists each project`);
  check(/6\.4 GB/.test(await text(page, "#storage-card")), `${tag}: storage shows the GB kept`);

  // Spending limit: Edit, 35, Save: the card shows $35.00.
  await page.locator("#edit-limit").click(); await page.locator("input#limit-input").waitFor({ timeout: 4000 });
  await page.locator("input#limit-input").fill("35"); await page.locator("#save-limit").click(); await sleep(500);
  check((await text(page, "#spend-limit")) === "$35.00", `${tag}: the spending limit window saves a new limit ($35.00)`);
  check(await page.locator("input#limit-input").count() === 0, `${tag}: the window closes after saving`);
  if (process.env.SHOTS) await page.screenshot({ path: join(process.env.SHOTS, `usage-${tag}.png`), fullPage: true });

  // Billing tab: both plans with what they include, Current on Starter, the card and invoices, Manage billing.
  await page.locator(".page-head .seg button", { hasText: "Billing" }).click(); await page.locator("#plans").waitFor({ timeout: 4000 }); await sleep(200);
  const plans = await page.$$eval("#plans [data-plan]", (els) => els.map((e) => ({ id: e.dataset.plan, on: e.classList.contains("plan-on"), t: e.textContent })));
  check(plans.length === 2 && plans.find((p) => p.id === "starter")?.on, `${tag}: the Billing tab shows the trial and Starter, Starter marked current`);
  const st = plans.find((p) => p.id === "starter")?.t || "";
  check(/\$5\.00/.test(st) && /25 export minutes/.test(st) && /60 minutes of footage/.test(st) && /10 GB/.test(st) && /Previews free/.test(st) && /4K/.test(st) && /pay as you go/i.test(st), `${tag}: Starter says $5, 25 export min, 60 footage min, 10 GB, previews free, 4K, then pay as you go`);
  const tr = plans.find((p) => p.id === "trial")?.t || "";
  check(/Free/.test(tr) && /7 days/.test(tr) && /10 export minutes/.test(tr) && /30 minutes of footage/.test(tr) && /60 preview minutes/.test(tr) && /5 GB/.test(tr) && /1080p/.test(tr), `${tag}: the trial says free for 7 days, 10 export, 30 footage, 60 preview min, 5 GB, up to 1080p`);
  check(await page.locator("#invoices tbody tr").count() === 2, `${tag}: invoices are listed`);
  check(await page.locator("#open-portal").count() === 1 && await page.locator("#manage-billing").count() === 1, `${tag}: Manage billing opens Stripe's card page (two ways in)`);
  check(await page.locator("#plan-start").count() === 0 && await page.locator("#start-starter").count() === 0, `${tag}: no Start button when Starter is already on`);
  if (process.env.SHOTS) await page.screenshot({ path: join(process.env.SHOTS, `billing-${tag}.png`), fullPage: true });
  const portal0 = await page.evaluate(() => globalThis.__demoPortal || 0);
  await Promise.all([page.waitForURL(/\/billing$/, { timeout: 6000 }).catch(() => {}), page.locator("#open-portal").click()]);
  check((await page.evaluate(() => globalThis.__demoPortal || 0)) === portal0 + 1 || page.url().endsWith("/billing"), `${tag}: Manage card asks for Stripe's page and goes there`);

  // Menu: Usage & billing is in it; no Admin for a normal account.
  await page.goto(base + "/"); await sleep(600); await login(page);
  await page.locator("#profile").click(); await sleep(200);
  const menu = await page.evaluate(() => [...document.querySelectorAll("[data-menu]")].map((e) => e.dataset.menu));
  await page.locator("#profile").click(); await sleep(100);
  check(menu.includes("Usage & billing") && !menu.includes("Admin"), `${tag}: the menu has Usage & billing and no Admin for a normal account (${menu.join(", ")})`);

  // --- Trial account: days left, Start Starter goes to checkout, then the thank-you note. ---
  await page.evaluate(() => { globalThis.__demoPlan = "trial"; globalThis.__demoUsage = { exportMinutes: 4, previewMinutes: 12, footageMinutes: 9, storageGBNow: 1.2 }; globalThis.__rendrrWrites = (globalThis.__rendrrWrites || 0) + 1; });
  await page.evaluate(() => globalThis.__rendrrNav.go("/usage")); await page.locator("#start-starter").waitFor({ timeout: 8000 }); await sleep(200);
  check((await text(page, "#plan-name")) === "Free trial" && /days? left/.test(await text(page, "#plan-status")), `${tag}: a trial shows Free trial and the days left (${await text(page, "#plan-status")})`);
  check(/Start Starter · \$5\/mo/.test(await text(page, "#start-starter")), `${tag}: the trial's button is Start Starter · $5/mo`);
  check((await text(page, "#spend-limit")) === "–" && await page.locator("#edit-limit").count() === 0, `${tag}: no spending limit on the trial (nothing is charged)`);
  const tmeter = await page.$$eval("#meters .meter", (els) => Object.fromEntries(els.map((e) => [e.dataset.metric, e.textContent])));
  check(/4 min of 10 min/.test(tmeter.export || "") && /12 min of 60 min/.test(tmeter.preview || "") && /9 min of 30 min/.test(tmeter.footage || ""), `${tag}: the trial meters show 10 export, 60 preview and 30 footage minutes`);
  await Promise.all([page.waitForURL(/paid=1/, { timeout: 6000 }).catch(() => {}), page.locator("#start-starter").click()]);
  check(/\/usage\?paid=1/.test(page.url()), `${tag}: Start Starter goes to Stripe checkout (the demo comes back with ?paid=1) (${page.url()})`);
  await sleep(600); await login(page);
  await page.evaluate(() => globalThis.__rendrrNav.go("/usage")); await page.locator("#usage-billing").waitFor({ timeout: 8000 }); await sleep(300);
  check(await page.locator("#paid-note").count() === 1, `${tag}: back from checkout, a thank-you note says Starter is on`);

  // --- Trial ended: the bar warns and says the edits are kept. ---
  await page.evaluate(() => { globalThis.__demoPlan = "trial"; globalThis.__demoTrialEnded = true; globalThis.__rendrrWrites = (globalThis.__rendrrWrites || 0) + 1; });
  await page.evaluate(() => globalThis.__rendrrNav.go("/projects")); await sleep(200);
  await page.evaluate(() => globalThis.__rendrrNav.go("/usage")); await page.locator("#trial-ended").waitFor({ timeout: 8000 });
  check(/Trial ended/.test(await text(page, "#plan-status")) && await page.locator("#plan-bar.warn").count() === 1, `${tag}: an ended trial shows Trial ended in a warning bar`);
  check(/edits and videos are kept/.test(await text(page, "#trial-ended")), `${tag}: it says the edits and videos are kept`);

  // --- A refused render or upload anywhere (402 billing_*): the dialog, and its button opens Usage & billing. ---
  await page.goto(base + "/"); await sleep(600); await login(page);
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("rendrr:billing", { detail: { code: "billing_trial_limit", message: "Your free trial's 10 export minutes are used up. Start Starter to keep exporting." } })));
  await page.locator("#limit-see-plans").waitFor({ timeout: 4000 });
  check(/10 export minutes are used up/.test(await page.locator(".modal, [role=dialog]").first().textContent().catch(() => "")), `${tag}: a refused export shows a dialog with the server's reason`);
  await page.locator("#limit-see-plans").click(); await sleep(400);
  check(await page.evaluate(() => globalThis.__rendrrNav.path()) === "/usage" && await page.locator("#limit-see-plans").count() === 0, `${tag}: See usage & billing closes it and opens the page`);

  // Opening /billing from /usage (the menu, a link) shows the Billing tab, and back again.
  await page.evaluate(() => globalThis.__rendrrNav.go("/usage")); await page.locator("#meters").waitFor({ timeout: 8000 });
  await page.evaluate(() => globalThis.__rendrrNav.go("/billing")); await sleep(300);
  check(await page.locator("#plans").count() === 1 && await page.locator("#meters").count() === 0, `${tag}: going from /usage to /billing shows the Billing tab`);
  await page.evaluate(() => globalThis.__rendrrNav.go("/usage")); await sleep(300);
  check(await page.locator("#meters").count() === 1, `${tag}: and /usage the Usage tab again`);

  // Phone: nothing sticks out of the screen on either tab.
  await page.evaluate(() => { globalThis.__demoPlan = "starter"; globalThis.__demoTrialEnded = false; globalThis.__demoUsage = null; globalThis.__rendrrWrites = (globalThis.__rendrrWrites || 0) + 1; });
  for (const t of ["/usage", "/billing"]) {
    await page.evaluate(() => globalThis.__rendrrNav.go("/projects")); await sleep(150);
    await page.evaluate((p) => globalThis.__rendrrNav.go(p), t); await page.locator("#plan-bar").waitFor({ timeout: 8000 }); await sleep(300);
    const m = await page.evaluate(() => {
      const W = document.documentElement.clientWidth;
      const wide = [...document.querySelectorAll("#usage-billing *")].filter((e) => { const b = e.getBoundingClientRect(); return b.width > 0 && b.right > W + 1 && !e.closest(".tbl-wrap, table"); }).map((e) => e.id || e.className || e.tagName).slice(0, 5);
      return { scrollW: document.documentElement.scrollWidth, W, wide };
    });
    check(m.scrollW <= m.W && m.wide.length === 0, `${tag}: ${t} fits the screen (${m.wide.join(", ") || "ok"})`);
  }
  check(errors.length === 0, `${tag}: no page errors${errors.length ? ": " + errors.join(" | ") : ""}`);
  await ctx.close();
}

await browser.close(); server.close();
console.log(fails.length ? `\n${fails.length} failed` : "\nall passed");
process.exit(fails.length ? 1 : 0);
