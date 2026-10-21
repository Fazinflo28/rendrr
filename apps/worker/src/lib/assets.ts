import { downloadFile, headObject, uploadFile } from "@rendrr/core";
import { copyFile, mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "./ffmpeg";

// Built-in music and sound effects are reused across renders: keep a local copy. A file only enters the cache
// once it is complete (downloaded to a temp name, size checked against storage, then renamed), so an interrupted
// download can never poison it, and two renders never write the same file.
const CACHE = join(tmpdir(), "rendrr-asset-cache");
const pending = new Map<string, Promise<string>>();
export async function cachedAsset(key: string, copyTo?: string): Promise<string> {
  const local = join(CACHE, key.replace(/[^\w.\-]+/g, "_"));
  let p = pending.get(local);
  if (!p) {
    p = (async () => {
      await mkdir(CACHE, { recursive: true });
      if (await stat(local).then((s) => s.size > 0).catch(() => false)) return local;
      const head = await headObject(key);
      const tmp = `${local}.${process.pid}.${Date.now()}.part`;
      const got = await downloadFile(key, tmp);
      if (head && got !== head.size) { await rm(tmp, { force: true }); throw new Error(`incomplete download of ${key}`); }
      await rename(tmp, local);
      return local;
    })().finally(() => pending.delete(local));
    pending.set(local, p);
  }
  await p;
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
