// robots.txt and sitemap.xml for Google: the public pages are open, private ones closed, and the sitemap lists the
// public pages on app.rendrr.live. Google reads these pages for the favicon that Claude shows next to the connector.
//   npx tsx demo/seo-files.mjs   (from apps/web)
import * as R from "../src/app/robots.ts";
import * as S from "../src/app/sitemap.ts";
const robots = R.default?.default ?? R.default; const sitemap = S.default?.default ?? S.default;
import { readFileSync } from "node:fs";

const fails = [];
const check = (ok, what) => { console.log(`${ok ? "ok  " : "FAIL"} ${what}`); if (!ok) fails.push(what); };
const r = robots();
const rule = r.rules[0];
check(rule.userAgent === "*" && rule.allow === "/", "Google may read the site");
check(["/editor/", "/review/", "/settings"].every((p) => rule.disallow.includes(p)), "private pages are closed to it");
check(r.sitemap === "https://app.rendrr.live/sitemap.xml", `robots names the sitemap (${r.sitemap})`);
const urls = sitemap().map((u) => u.url);
check(urls[0] === "https://app.rendrr.live/" && urls.includes("https://app.rendrr.live/explore"), `the sitemap lists the public pages (${urls.join(", ")})`);
const layout = readFileSync(new URL("../src/app/layout.tsx", import.meta.url), "utf8");
check(/<link rel="icon" href="\/icons\/icon-192\.png" type="image\/png" sizes="192x192" \/>/.test(layout), "the page names a 192 px PNG icon (a multiple of 48, as Google asks)");
if (fails.length) { console.log(`${fails.length} failed`); process.exit(1); }
console.log("all passed");
