import { downloadFile, headObject, uploadFile } from "@rendrr/core";
import { copyFile, mkdir, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "./ffmpeg";

// Music, sound effects and b-roll proxies are reused across renders: keep a local copy.
const CACHE = join(tmpdir(), "rendrr-asset-cache");
export async function cachedAsset(key: string, copyTo?: string): Promise<string> {
  await mkdir(CACHE, { recursive: true });
  const local = join(CACHE, key.replace(/[^\w.\-]+/g, "_"));
  const have = await stat(local).then((s) => s.size > 0).catch(() => false);
  if (!have) await downloadFile(key, local);
  if (copyTo) { await copyFile(local, copyTo); return copyTo; }
  return local;
}

const MAKE_ASSETS = join(dirname(fileURLToPath(import.meta.url)), "../../assets/make-assets.sh");
const REQUIRED = ["samples/sample-talking-head.mp4", "samples/sample-portrait.mp4", "samples/sample-broll.mp4", "assets/music/m_lofi.m4a", "assets/music/m_gameshow.m4a", "assets/sfx/sfx_hit.m4a"];

/** Built-in media (samples, music, sound effects) are generated once and uploaded if storage does not have them. */
export async function ensureAssets() {
  const missing = [];
  for (const k of REQUIRED) if (!(await headObject(k))) missing.push(k);
  if (!missing.length) return { generated: false };
  console.log("[assets] generating built-in media, missing:", missing.join(", "));
  const out = join(tmpdir(), "rendrr-assets-out");
  await run("bash", [MAKE_ASSETS, out]);
  for (const sub of ["samples", "music", "sfx"]) {
    for (const f of await readdir(join(out, sub))) {
      const key = sub === "samples" ? `samples/${f}` : `assets/${sub}/${f}`;
      await uploadFile(key, join(out, sub, f), f.endsWith(".mp4") ? "video/mp4" : "audio/mp4");
    }
  }
  console.log("[assets] uploaded built-in media:", basename(out));
  return { generated: true };
}
