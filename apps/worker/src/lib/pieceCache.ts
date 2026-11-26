// Audit #13: a preview made again re-renders only the pieces of the edit that changed. A cloud preview long enough to
// be made in pieces (pieceRanges) keeps each piece's picture in storage under a key made from everything that decides
// its pixels: its FFmpeg run (the filter graph and the arguments) with every input file named by what is in it, not by
// where this job put it. The next preview of the same edit finds the pieces whose key is the same, takes them back
// instead of rendering them, renders the rest, and joins all under the sound made once for the whole edit. Captions
// count only where they show in the piece, so a caption changed at 2:10 does not make the piece at 0:30 again. A
// change that moves the edit's timing (a cut) makes every piece after it again; pieces before it come back as they were.
import { createHash } from "node:crypto";
import { open, readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { run } from "./ffmpeg";

/** Changes when what a piece's key covers changes, so pieces stored before are made again. */
export const PIECE_CACHE_VERSION = "1";
/** Off with PREVIEW_PIECE_CACHE=0 (previews are then made in one pass, as before). */
export const previewPieceCache = () => process.env.PREVIEW_PIECE_CACHE !== "0";

const SMALL = 8 * 1024 * 1024, EDGE = 1024 * 1024;
const TEXT = /\.(ass|txt|ffconcat|srt|vtt|cube|json|svg)$/i;

/** ASS times (H:MM:SS.cc) in seconds. */
const assTime = (s: string) => {
  const m = /^(\d+):(\d{1,2}):(\d{1,2}(?:\.\d+)?)$/.exec(s.trim());
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : NaN;
};
/**
 * An ASS file as a piece from edit second `a` to `b` sees it: its styles and every line around the window (a second
 * either side), the rest left out.
 */
export function assInWindow(text: string, a: number, b: number): string {
  return text.split(/\r?\n/).filter((l) => {
    if (!l.startsWith("Dialogue:")) return true;
    const f = l.slice(9).split(",");
    const s = assTime(f[1] ?? ""), e = assTime(f[2] ?? "");
    if (!Number.isFinite(s) || !Number.isFinite(e)) return true;
    return e > a - 1 && s < b + 1;
  }).join("\n");
}

async function headTail(path: string, size: number): Promise<Buffer> {
  const fh = await open(path, "r");
  try {
    const a = Buffer.alloc(Math.min(EDGE, size)), b = Buffer.alloc(Math.min(EDGE, size));
    await fh.read(a, 0, a.length, 0);
    await fh.read(b, 0, b.length, Math.max(0, size - b.length));
    return Buffer.concat([a, b]);
  } finally { await fh.close(); }
}

/**
 * What is in a file, as a short hash: a small file by its bytes (a text file with this job's folder taken out of it, an
 * ASS file only around the window), a big one by its size, first and last megabyte, a folder by its files' names and
 * sizes. A file that cannot be read gets a hash of its name and a random part, so the piece is never taken back.
 */
export async function fingerprint(path: string, dir: string, win?: { a: number; b: number }): Promise<string> {
  const h = createHash("sha256");
  try {
    const st = await stat(path);
    if (st.isDirectory()) {
      const names = (await readdir(path)).sort();
      for (const n of names) { const s = await stat(join(path, n)).catch(() => null); h.update(`${n}:${s?.size ?? "?"}\n`); }
      return "d" + h.digest("hex").slice(0, 32);
    }
    if (st.size <= SMALL) {
      if (TEXT.test(path)) {
        let t = (await readFile(path, "utf8")).split(dir).join("@");
        if (win && /\.ass$/i.test(path)) t = assInWindow(t, win.a, win.b);
        h.update(t);
      } else h.update(await readFile(path));
      return "s" + h.digest("hex").slice(0, 32);
    }
    h.update(String(st.size)); h.update(await headTail(path, st.size));
    return "b" + h.digest("hex").slice(0, 32);
  } catch {
    h.update(`${path}:${Math.random()}:${Date.now()}`);
    return "x" + h.digest("hex").slice(0, 32);
  }
}

/** Every file a plan's run can read (PlanFiles, nested), but the output. */
export function inputPaths(files: object): string[] {
  const out = new Set<string>();
  const walk = (v: unknown, key?: string) => {
    if (key === "output") return;
    if (typeof v === "string") { if (v.startsWith("/")) out.add(v); return; }
    if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, k);
  };
  walk(files);
  return [...out];
}

/** A path as the filter graph writes it (renderPlan's q, without its quotes). */
const inGraph = (s: string) => s.replace(/\\/g, "\\\\").replace(/'/g, "'\\''").replace(/:/g, "\\:");
const THREAD_FLAGS = new Set(["-threads", "-filter_threads", "-filter_complex_threads"]);

let ffVersion: Promise<string> | null = null;
/** The FFmpeg build's first line: pieces from another build are made again (their picture is copied when joined). */
export function ffmpegVersion(): Promise<string> {
  ffVersion ??= run("ffmpeg", ["-hide_banner", "-version"], { signal: AbortSignal.timeout(15_000) })
    .then((r) => r.stdout.split("\n")[0].trim() || "ffmpeg")
    .catch(() => "ffmpeg");
  return ffVersion;
}

/**
 * The key of one piece: a hash of its run (thread counts left out: they change how fast, not what) with the output
 * left out and every input named by what is in it. `seen` keeps the hashes of big files for the whole job.
 */
export async function pieceKey(o: { args: string[]; graph: string; files: object; output: string; dir: string; win: { a: number; b: number }; version: string; seen: Map<string, string> }): Promise<string> {
  const args = o.args.map((x, i) => (i > 0 && THREAD_FLAGS.has(o.args[i - 1]) ? "N" : x === o.output ? "<out>" : x));
  let text = JSON.stringify(args) + "\n" + o.graph;
  const paths = inputPaths(o.files).sort((x, y) => y.length - x.length);
  for (const p of paths) {
    if (!text.includes(p) && !text.includes(inGraph(p))) continue;
    // An ASS file's hash depends on the window; every other file's is the same for the whole job.
    const ass = /\.ass$/i.test(p);
    const memo = ass ? `${p}@${o.win.a}-${o.win.b}` : p;
    let fp = o.seen.get(memo);
    if (!fp) { fp = await fingerprint(p, o.dir, ass ? o.win : undefined); o.seen.set(memo, fp); }
    text = text.split(p).join(`<${fp}>`).split(inGraph(p)).join(`<${fp}>`);
  }
  text = text.split(o.dir).join("@").split(inGraph(o.dir)).join("@");
  return createHash("sha256").update(`${PIECE_CACHE_VERSION}\n${o.version}\n${text}`).digest("hex").slice(0, 40);
}
