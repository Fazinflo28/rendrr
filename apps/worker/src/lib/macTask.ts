// A render's FFmpeg runs made into a task for the user's Mac (core/macRender.ts): every path made relative to the job's
// folder, each file the runs read given by where it came from (a storage key the Mac downloads by signed link, the
// user's Google Drive, or the file itself: small ones inline, larger ones uploaded under mac/<render>/ for this task),
// the caption fonts by link, and what the runs make uploaded by the Mac to the render's own keys. Then the wait: the
// Mac takes it, says how far it is, and is done; or it does not, and the caller makes it on the cloud.
import { createHash } from "node:crypto";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import { copyObject, createMacTask, deleteObjects, expireMacTask, headObject, MAC_CLAIM_MS, MAC_QUIET_MS, originOf, stopMacTask, uploadFile, viewMacTask, type MacInput, type MacTaskSpec } from "@rendrr/core";
import { PREFIX } from "@rendrr/shared";
import { JobError } from "./ffmpeg";

/** Files at most this big go inside the task itself (captions, colour files, lists, small masks). */
const INLINE_MAX = 384 * 1024;
const NAME_CHARS = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;
const NAME_OK = { test: (n: string) => NAME_CHARS.test(n) && !n.split("/").some((p) => p === "." || p === "..") };
/** FFmpeg features a render may use that a Mac's FFmpeg must have (its app reports which of these it has). */
export const MAC_FEATURES = ["ass", "lut3d", "zscale", "tonemap", "vidstabtransform", "minterpolate", "afir", "sendcmd", "libvpx-vp9", "libx264", "libx265", "prores_ks", "ffv1", "palettegen", "paletteuse", "alphamerge", "h264_videotoolbox", "h264_nvenc", "h264_qsv", "h264_amf"] as const;

/** A render that cannot be handed to the Mac as it is (the cloud makes it); the message says why, for the log. */
export class NotForMac extends Error {}

export type MacRun = { args: string[]; graph?: string; seconds?: number };
export type MacOut = { path: string; key: string; type: string; save?: string };

const words = (s: string) => new Set(s.match(/[A-Za-z0-9._/-]+/g) ?? []);
const isText = (b: Buffer) => !b.subarray(0, 8192).includes(0) && !/�/.test(b.subarray(0, 8192).toString("utf8"));

/** The features of MAC_FEATURES these runs use. */
export function needsOf(runs: MacRun[]): string[] {
  const all = runs.map((r) => `${r.args.join(" ")}\n${r.graph ?? ""}`).join("\n");
  return MAC_FEATURES.filter((f) => new RegExp(`(^|[^A-Za-z0-9_-])${f.replace(/-/g, "\\-")}([^A-Za-z0-9_-]|$)`).test(all));
}

async function listFiles(dir: string, under = dir, out: string[] = []): Promise<string[]> {
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const p = join(dir, e.name);
    if (e.isDirectory()) await listFiles(p, under, out);
    else if (e.isFile() && !e.name.endsWith(".part")) out.push(p);
  }
  return out;
}

const fontKeys = new Map<string, { key: string; size: number }>();
/** The caption fonts, each uploaded once (by its content) for Macs to fetch. */
async function fontsFor(fontsDir: string): Promise<{ name: string; key: string; size: number }[]> {
  const out: { name: string; key: string; size: number }[] = [];
  for (const name of (await readdir(fontsDir).catch(() => [] as string[])).sort()) {
    if (!/\.(ttf|otf|ttc)$/i.test(name) || !NAME_OK.test(name)) continue;
    const p = join(fontsDir, name);
    let k = fontKeys.get(p);
    if (!k) {
      const buf = await readFile(p);
      const key = `${PREFIX.mac}fonts/${createHash("sha256").update(buf).digest("hex").slice(0, 16)}-${name}`;
      if (!(await headObject(key))) await uploadFile(key, p, "font/ttf");
      k = { key, size: buf.length };
      fontKeys.set(p, k);
    }
    out.push({ name, ...k });
  }
  return out;
}

/**
 * The task for these runs. dir: the job's folder (every file a run reads or writes is in it, or named in the runs by
 * an absolute path elsewhere: those come too); fontsDir: the caption fonts' folder; driveSource: the original read
 * from the user's Drive (the Mac fetches it there, never through Rendrr). temps: what was uploaded for this task only.
 */
export async function macTaskFor(o: {
  /** The only computer that may take it (its id). */
  deviceId?: string | null;
  renderId: string; userId: string; kind: string; label: string; dir: string; fontsDir?: string;
  runs: MacRun[]; outputs: MacOut[]; driveSource?: { path: string; fileId: string; version?: string } | null;
  /** Files here that stand for originals kept on the user's Mac (their preview copies): the Mac reads the original. */
  macSources?: Map<string, { videoId: string; size: number }>;
}): Promise<{ spec: MacTaskSpec; temps: string[] }> {
  const dir = o.dir.replace(/\/+$/, "");
  const outPaths = new Set(o.outputs.map((x) => x.path));
  // Paths named outside the job's folder (built-in music from the asset cache): each comes as ext/<n>-<name>.
  const ext = new Map<string, string>();
  for (const r of o.runs) for (const a of r.args) {
    if (!a.startsWith("/") || a.startsWith(dir + "/") || outPaths.has(a) || ext.has(a)) continue;
    if (!(await stat(a).then((s) => s.isFile()).catch(() => false))) throw new NotForMac(`a run reads ${basename(a)}, which is not a file here`);
    ext.set(a, `ext/${ext.size}-${basename(a).replace(/[^A-Za-z0-9._-]+/g, "_")}`);
  }
  // Longest first, so a path is never cut by a shorter one inside it.
  const swaps: [string, string][] = [...ext.entries(), [dir + "/", ""] as [string, string], ...(o.fontsDir ? [[o.fontsDir.replace(/\/+$/, ""), "fonts"] as [string, string]] : [])].sort((a, b) => b[0].length - a[0].length);
  const rewrite = (s: string) => swaps.reduce((acc, [from, to]) => acc.split(from).join(to), s);
  const runs = o.runs.map((r) => ({ args: r.args.map(rewrite), ...(r.graph != null ? { graph: rewrite(r.graph) } : {}), ...(r.seconds != null ? { seconds: r.seconds } : {}) }));
  // Nothing may still point into this machine.
  for (const r of runs) {
    for (const a of r.args) if (a.startsWith("/") || a.startsWith("~") || a.split("/").includes("..")) throw new NotForMac(`an argument still names a path here (${a.slice(0, 80)})`);
    if (r.graph && (r.graph.includes(dir) || r.graph.includes("/tmp/") || (o.fontsDir && r.graph.includes(o.fontsDir)))) throw new NotForMac("the filter graph still names a path here");
  }
  const usesFonts = runs.some((r) => /fontsdir='?fonts'?/.test(r.graph ?? ""));

  // Which files the runs read: named in the arguments or graphs, or in a text file they read (a list of matte blocks).
  const all = new Map<string, string>(); // name -> path
  for (const p of await listFiles(dir)) { const n = relative(dir, p); if (NAME_OK.test(n) && !outPaths.has(p)) all.set(n, p); }
  for (const [p, n] of ext) all.set(n, p);
  const named = new Set<string>();
  for (const r of runs) { for (const w of words(r.args.join(" "))) named.add(w); for (const w of words(r.graph ?? "")) named.add(w); }
  const texts = new Map<string, Buffer>();
  const inputs = new Map<string, MacInput>();
  const temps: string[] = [];
  const queue = Array.from(all.keys()).filter((n) => named.has(n));
  while (queue.length) {
    const name = queue.shift()!;
    if (inputs.has(name)) continue;
    const path = all.get(name)!;
    const size = (await stat(path)).size;
    // A text file that names other files (a matte block list) names them as the Mac will have them.
    let body: Buffer | null = null;
    if (size <= 2 * 1024 * 1024) {
      const head = await readFile(path);
      if (isText(head)) {
        const text = rewrite(head.toString("utf8"));
        if (text.includes(dir) || text.includes("/tmp/")) throw new NotForMac(`${name} still names a path here`);
        body = Buffer.from(text, "utf8");
        texts.set(name, body);
        for (const w of words(text)) if (all.has(w) && !inputs.has(w) && !queue.includes(w)) queue.push(w);
      }
    }
    const origin = originOf(path);
    const local = o.macSources?.get(path);
    if (local) inputs.set(name, { name, local: { videoId: local.videoId, size: local.size } });
    else if (o.driveSource && o.driveSource.path === path) inputs.set(name, { name, drive: { fileId: o.driveSource.fileId, ...(o.driveSource.version ? { version: o.driveSource.version } : {}) }, size });
    // A graphic's recording is the task's own copy (made inside storage: nothing goes up): its recordings are dropped
    // the moment its code changes, and a Mac that fetched the old one after that got a 404 and lost the render.
    else if (!body && origin && (origin.size == null || origin.size === size) && origin.key.startsWith(PREFIX.graphics)) {
      const key = `${PREFIX.mac}${o.renderId}/${name}`;
      await copyObject(origin.key, key);
      temps.push(key);
      inputs.set(name, { name, key, size });
    }
    else if (!body && origin && (origin.size == null || origin.size === size)) inputs.set(name, { name, key: origin.key, size, ...(origin.etag ? { etag: origin.etag } : {}) });
    else if ((body?.length ?? size) <= INLINE_MAX) inputs.set(name, { name, data: (body ?? (await readFile(path))).toString("base64") });
    else {
      const key = `${PREFIX.mac}${o.renderId}/${name}`;
      if (body) { const tmp = `${path}.mac`; await writeFile(tmp, body); await uploadFile(key, tmp, "application/octet-stream"); }
      else await uploadFile(key, path, "application/octet-stream");
      temps.push(key);
      inputs.set(name, { name, key, size: body?.length ?? size });
    }
  }
  // What the runs make: in the job's folder, named in a run, uploaded by the Mac to the render's own key.
  const outputs = o.outputs.map((x) => {
    const name = relative(dir, x.path);
    if (!NAME_OK.test(name) || !runs.some((r) => r.args.includes(name))) throw new NotForMac(`the output ${basename(x.path)} is not made by a run`);
    return { name, key: x.key, type: x.type, ...(x.save ? { save: x.save } : {}) };
  });
  const spec: MacTaskSpec = {
    renderId: o.renderId, userId: o.userId, kind: o.kind, label: o.label, ...(o.deviceId ? { deviceId: o.deviceId } : {}),
    inputs: Array.from(inputs.values()), ...(usesFonts && o.fontsDir ? { fonts: await fontsFor(o.fontsDir) } : {}),
    commands: runs, outputs, needs: needsOf(o.runs), stallSec: 120,
  };
  return { spec, temps };
}

export type MacDone = { ok: true; outputs: Record<string, number>; saved: string | null; device: string | null; platform: "mac" | "windows" };
export type MacNot = { ok: false; why: string };

/**
 * Hands the task to the Mac and waits: for it to be taken (MAC_CLAIM_MS), then for it to finish, as long as the Mac keeps
 * reporting (MAC_QUIET_MS). Its progress comes through the callbacks. Stopped (signal): the Mac is told to stop too.
 */
export async function runOnMac(spec: MacTaskSpec, o: {
  signal: AbortSignal; onClaim: (device: string | null, platform: "mac" | "windows") => void; onDownload: (frac: number) => void;
  onRender: (cmd: number, seconds: number) => void; onUpload: (frac: number) => void; pollMs?: number;
  /** "Mac" or "PC", for the reasons it gives. */
  machine?: string;
}): Promise<MacDone | MacNot> {
  const your = `your ${o.machine || "Mac"}`;
  const id = await createMacTask(spec);
  const t0 = Date.now();
  let claimed = false;
  for (;;) {
    if (o.signal.aborted) { await stopMacTask(id, "stopped").catch(() => {}); throw new JobError("Stopped."); }
    const v = await viewMacTask(id);
    if (!v.owner && Date.now() - t0 > MAC_CLAIM_MS) {
      if (await expireMacTask(id)) return { ok: false, why: `${your} did not pick it up` };
      continue;
    }
    if (v.owner === "mac" && v.run) {
      const platform = v.run.platform === "windows" ? "windows" : "mac";
      if (!claimed) { claimed = true; o.onClaim(v.run.device, platform); }
      if (v.run.state === "done") return { ok: true, outputs: v.run.outputs ?? {}, saved: v.run.saved ?? null, device: v.run.device, platform };
      if (v.run.state === "failed") return { ok: false, why: v.run.error || `${your} could not render it` };
      if (Date.now() - v.run.at > MAC_QUIET_MS) { await stopMacTask(id, "quiet"); return { ok: false, why: `${your} stopped answering` }; }
      if (v.run.phase === "download") o.onDownload(v.run.frac ?? 0);
      else if (v.run.phase === "upload") o.onUpload(v.run.frac ?? 0);
      else o.onRender(v.run.cmd ?? 0, v.run.seconds ?? 0);
    }
    await new Promise((r) => setTimeout(r, o.pollMs ?? 500));
  }
}

/**
 * Seconds left while the user's computer fetches a task's files (a big original the first time): the download's own pace
 * so far, then afterSec for the encode. Null until there is a pace to go by.
 */
export function fetchEtaSec(dl: { start: number; frac: number }, now: number, afterSec: number): number | null {
  const spent = (now - dl.start) / 1000;
  if (!(dl.frac > 0.02) || spent < 2) return null;
  return Math.max(5, Math.round(spent / Math.min(1, dl.frac) - spent + afterSec));
}

/** The files uploaded for a task only, removed when it is over (the daily cleanup is the safety net). */
export const dropTemps = (keys: string[]) => (keys.length ? deleteObjects(keys).catch(() => {}) : Promise.resolve());
