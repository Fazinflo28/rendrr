// Downloads the graphics fonts listed in ../fonts.txt (Google Fonts files at a pinned commit) into a folder,
// for fontconfig: node scripts/fetch-fonts.mjs <dir>. Runs at image build; any file that cannot be fetched after
// three tries stops the build with its name, so an image never ships with fonts silently missing.
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const out = process.argv[2];
if (!out) throw new Error("usage: node scripts/fetch-fonts.mjs <dir>");
const lines = (await readFile(join(here, "..", "fonts.txt"), "utf8")).split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
const commit = lines.shift()?.replace(/^commit\s+/, "");
if (!/^[0-9a-f]{40}$/.test(commit || "")) throw new Error("fonts.txt must start with 'commit <sha>'");

async function fetchOne(path) {
  const url = `https://raw.githubusercontent.com/google/fonts/${commit}/${path.split("/").map(encodeURIComponent).join("/")}`;
  // Licence files sit next to their fonts, named after the family folder.
  const dest = path.endsWith(".ttf") ? join(out, basename(path)) : join(out, "licences", `${path.split("/")[1]}-${basename(path)}`);
  if (await stat(dest).then((s) => s.size > 0, () => false)) return 0;
  for (let i = 1; ; i++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(60_000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const buf = Buffer.from(await r.arrayBuffer());
      if (path.endsWith(".ttf") && (buf.length < 1000 || buf.readUInt32BE(0) !== 0x00010000)) throw new Error("not a TrueType file");
      await mkdir(dirname(dest), { recursive: true });
      await writeFile(dest, buf);
      return buf.length;
    } catch (e) {
      if (i >= 3) throw new Error(`Could not fetch font ${path}: ${e.message}`);
      await new Promise((r) => setTimeout(r, 2000 * i));
    }
  }
}

await mkdir(out, { recursive: true });
let bytes = 0, next = 0;
await Promise.all(Array.from({ length: 8 }, async () => { while (next < lines.length) { const n = await fetchOne(lines[next++]); bytes += n; } }));
console.log(`fonts: ${lines.length} files, ${(bytes / 1e6).toFixed(1)} MB fetched into ${out}`);
