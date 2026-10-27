// Engine Part 4.2: the bundled icon set for search_icons and the library's Icon item. Tabler Icons (MIT licence,
// https://tabler.io/icons): every outline and filled icon except the "Brand" category (real brand logos stay out of the
// library). Run with the unpacked npm package: node scripts/build-icons.mjs <path to @tabler/icons package>
// Writes apps/api/src/data/icons.json.gz: { source, icons: [[id, category, tags, inner svg, filled 0/1]] }.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

const dir = process.argv[2];
if (!dir) throw new Error("usage: node scripts/build-icons.mjs <@tabler/icons package dir>");
const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
if (pkg.license !== "MIT") throw new Error(`licence is ${pkg.license}, not MIT`);
const meta = JSON.parse(readFileSync(join(dir, "icons.json"), "utf8"));
const nodes = { outline: JSON.parse(readFileSync(join(dir, "tabler-nodes-outline.json"), "utf8")), filled: JSON.parse(readFileSync(join(dir, "tabler-nodes-filled.json"), "utf8")) };
const attr = (a) => Object.entries(a).filter(([k]) => /^(d|fill|stroke|opacity|cx|cy|r|x|y|width|height|rx|points|x1|y1|x2|y2)$/.test(k)).map(([k, v]) => `${k}="${String(v).replace(/"/g, "")}"`).join(" ");
const icons = [];
let brand = 0;
for (const [name, m] of Object.entries(meta)) {
  if (m.category === "Brand" || name.startsWith("brand-")) { brand++; continue; }
  const tags = Array.from(new Set([...(m.tags || []).map(String), ...name.split("-")])).join(" ").toLowerCase();
  for (const style of ["outline", "filled"]) {
    const n = nodes[style][name];
    if (!n || !m.styles?.[style]) continue;
    const inner = n.filter(([, a]) => !(a.d === "M0 0h24v24H0z")).map(([t, a]) => `<${t} ${attr(a)}/>`).join("");
    icons.push([style === "filled" ? `${name}-filled` : name, m.category || "", tags, inner, style === "filled" ? 1 : 0]);
  }
}
const out = { source: `Tabler Icons ${pkg.version} (MIT licence, Pawel Kuna and contributors, tabler.io/icons); Brand category left out`, icons };
const file = new URL("../apps/api/src/data/icons.json.gz", import.meta.url);
writeFileSync(file, gzipSync(JSON.stringify(out), { level: 9 }));
console.log(`${icons.length} icons (${brand} brand logos left out) -> ${file.pathname}`);
