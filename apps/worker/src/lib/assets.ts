import { downloadFile, headObject, uploadFile } from "@rendrr/core";
import { copyFile, link, mkdir, readdir, rename, rm, stat, utimes } from "node:fs/promises";
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

// Preview copies are reused too: a batch of shorts, or a revision rendered again, reads the same footage. Kept by key
// and version (the storage's ETag, so a rebuilt copy is fetched again), linked into the render's folder, the least
// recently used dropped past PROXY_CACHE_GB (default 3).
const PROXIES = join(tmpdir(), "rendrr-proxy-cache");
const CAP = () => Math.max(0, Number(process.env.PROXY_CACHE_GB || 3)) * 1e9;
export async function cachedCopy(key: string, dest: string): Promise<void> {
  const head = await headObject(key);
  if (!head || !CAP() || head.size > CAP() / 2) { await downloadFile(key, dest); return; }
  const local = join(PROXIES, `${key.replace(/[^\w.\-]+/g, "_")}.${(head.etag || String(head.size)).replace(/[^\w]+/g, "")}`);
  let p = pending.get(local);
  if (!p) {
    p = (async () => {
      await mkdir(PROXIES, { recursive: true });
      if (await stat(local).then((s) => s.size === head.size).catch(() => false)) return local;
      const tmp = `${local}.${process.pid}.${Date.now()}.part`;
      const got = await downloadFile(key, tmp);
      if (got !== head.size) { await rm(tmp, { force: true }); throw new Error(`incomplete download of ${key}`); }
      await rename(tmp, local);
      await trimProxies(local).catch(() => {});
      return local;
    })().finally(() => pending.delete(local));
    pending.set(local, p);
  }
  await p;
  const now = new Date();
  await utimes(local, now, now).catch(() => {});
  // A hard link costs nothing; another disk: a copy.
  await link(local, dest).catch(() => copyFile(local, dest));
}
async function trimProxies(keep: string) {
  const files = await Promise.all((await readdir(PROXIES)).filter((f) => !f.endsWith(".part")).map(async (f) => { const p = join(PROXIES, f); const s = await stat(p); return { p, size: s.size, at: s.mtimeMs }; }));
  let total = files.reduce((a, f) => a + f.size, 0);
  for (const f of files.sort((a, b) => a.at - b.at)) {
    if (total <= CAP()) break;
    if (f.p === keep) continue;
    await rm(f.p, { force: true }); // a render that linked it keeps its own link
    total -= f.size;
  }
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
