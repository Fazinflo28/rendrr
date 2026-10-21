// Copies the ffmpeg.wasm wrapper (not the 30 MB core) into public/ so its worker loads from our own origin.
// The core (wasm) is fetched at runtime from a CDN as a blob URL.
import { cpSync, existsSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
let pkgDir;
try { pkgDir = dirname(require.resolve("@ffmpeg/ffmpeg/package.json")); } catch { pkgDir = null; }
if (!pkgDir) {
  const guess = join(process.cwd(), "node_modules/@ffmpeg/ffmpeg");
  if (existsSync(guess)) pkgDir = guess;
}
if (!pkgDir) { console.warn("copy-ffmpeg: @ffmpeg/ffmpeg not installed, skipping"); process.exit(0); }
const out = join(process.cwd(), "public/ffmpeg");
mkdirSync(out, { recursive: true });
cpSync(join(pkgDir, "dist/esm"), out, { recursive: true });
console.log("copy-ffmpeg: copied", join(pkgDir, "dist/esm"), "->", out);
