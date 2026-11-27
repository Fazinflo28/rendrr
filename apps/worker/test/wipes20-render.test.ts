// Phase 20: the new shape wipes (Iris Box, Iris Cross, Venetian Blinds both ways, Checker Wipe, Wedge Wipe), rendered by
// FFmpeg and drawn by the player's CSS in Chromium, each read on a 32 x 18 grid at the middle of the window and checked
// against the shared rule (wipeCovers): B (blue) where it says, A (red) elsewhere. Points within a few hundredths of
// progress of the shape's edge are left out (a frame's exact progress differs a little). Needs ffmpeg and Chromium.
import { existsSync } from "node:fs";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { after, before, describe, it } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { applyOp, buildInitialTimeline, transitionAt, wipeCovers, type Dir, type EditContext, type Op, type Snapshot } from "@rendrr/shared";
import { ffmpegArgs, lookFileData, planRender, type PlanFiles, type SourceInfo } from "@rendrr/shared/renderPlan";
import { run } from "../src/lib/ffmpeg";

const execFileP = promisify(execFile);
const require = createRequire(import.meta.url);
const SECONDS = 10, W = 640, H = 360;
const source: SourceInfo = { width: W, height: H, fps: 30, seconds: SECONDS, hasAudio: true };
type Wipe = "box" | "cross" | "blinds" | "checker" | "wedge";
const CASES: [Wipe, Dir | undefined][] = [["box", undefined], ["cross", undefined], ["blinds", undefined], ["blinds", "left"], ["checker", undefined], ["wedge", undefined]];
const GRID = Array.from({ length: 18 }, (_, j) => Array.from({ length: 32 }, (_, i) => [(i + 0.5) / 32, (j + 0.5) / 18] as [number, number])).flat();

// The Chromium the graphics recorder uses (CHROMIUM_PATH, the system's, or Playwright's); without one this is skipped.
const exe = [process.env.CHROMIUM_PATH, "/usr/bin/chromium", "/usr/bin/chromium-browser", "/opt/pw-browsers/chromium-1194/chrome-linux/chrome"].find((x) => x && existsSync(x));
describe("phase 20 shape wipes: render and player against the shared rule", () => {
  let dir = "", redblue = "";
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "wipes20-"));
    redblue = join(dir, "redblue.mp4");
    await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", `color=black:s=${W}x${H}:r=30:d=${SECONDS}`, "-f", "lavfi", "-i", `sine=f=440:d=${SECONDS}:sample_rate=48000`, "-vf", "geq=r='if(lt(T,5),208,32)':g='32':b='if(lt(T,5),32,208)',format=yuv420p", "-c:v", "libx264", "-preset", "ultrafast", "-qp", "0", "-c:a", "aac", "-shortest", redblue]);
  });
  after(async () => { if (process.env.KEEP) console.log("kept " + dir); else await rm(dir, { recursive: true, force: true }); });

  const ctx: EditContext = { videoId: "v", transcript: [], silences: [], sceneCuts: [], duration: SECONDS, getStyle: () => undefined };
  const edit = (op: Op): Snapshot => applyOp({ timeline: buildInitialTimeline([], SECONDS, "clean", [], "v"), name: "x", aspect: "16:9", styleId: "s2" }, { op: "batch", ops: [{ op: "set_captions", on: false }, { op: "set_audio", loudness: null }, { op: "set_clips", track: "v1", clips: [{ id: "a", start: 1, end: 4, label: "" }, { id: "b", start: 6, end: 9, label: "" }] }, op] as never }, ctx).snap;
  const isB = (p: number[]) => p[2] > 150 && p[0] < 80, isA = (p: number[]) => p[0] > 150 && p[2] < 80;
  /** Grid points whose answer is the same a little before and after q (away from the shape's edge). */
  const steady = (type: Wipe, q: number, d?: Dir) => GRID.filter(([x, y]) => [q - 0.04, q, q + 0.04].map((k) => wipeCovers(type, k, x * W, y * H, W, H, d)).every((v, _, a) => v === a[0]));

  it("FFmpeg's expressions draw each shape", async () => {
    for (const [type, d] of CASES) {
      const s = edit({ op: "set_transition", clipId: "b", type, duration: 1, ...(d ? { dir: d } : {}) } as Op);
      const plan = planRender({ kind: "preview", snapshot: s, transcript: [], source, videoId: "v" });
      const looks: Record<string, string> = {};
      for (const [n, spec] of Object.entries(plan.lookFiles ?? {})) { const p = join(dir, n); await writeFile(p, lookFileData(spec, plan, {})); looks[n] = p; }
      const pf: PlanFiles = { source: redblue, output: join(dir, `${type}${d ?? ""}.mp4`), looks };
      const { args, filterGraph } = ffmpegArgs(plan, pf, source);
      await writeFile(join(dir, `${type}.txt`), filterGraph);
      await run("ffmpeg", args.map((a) => (a === "__FILTER_SCRIPT__" ? join(dir, `${type}.txt`) : a)));
      const t = plan.transitions!.find((x) => x.type === type)!, q = 0.5;
      const f = (await execFileP("ffmpeg", ["-hide_banner", "-loglevel", "error", "-ss", (t.start + q * (t.end - t.start)).toFixed(3), "-i", pf.output, "-frames:v", "1", "-vf", `scale=${W}:${H},format=rgb24`, "-f", "rawvideo", "-"], { encoding: "buffer", maxBuffer: 1 << 26 })).stdout as Buffer;
      const pts = steady(type, q, d);
      const wrong = pts.filter(([x, y]) => { const o = (Math.floor(y * H) * W + Math.floor(x * W)) * 3, p = [f[o], f[o + 1], f[o + 2]]; return wipeCovers(type, q, x * W, y * H, W, H, d) ? !isB(p) : !isA(p); });
      console.log(`${type}${d ? " " + d : ""}: ${pts.length - wrong.length}/${pts.length} grid points as the rule says`);
      assert.ok(wrong.length <= pts.length * 0.01, `${type}${d ? " " + d : ""}: ${wrong.length} points differ, e.g. ${JSON.stringify(wrong.slice(0, 3))}`);
    }
  });

  it("the player's CSS draws the same shapes", { skip: !exe && "needs Chromium" }, async () => {
    const { chromium } = require(require.resolve("playwright-core", { paths: [resolve(import.meta.dirname, "../../web")] }));
    const browser = await chromium.launch({ executablePath: exe });
    try {
      const page = await browser.newPage({ viewport: { width: W, height: H } });
      for (const [type, d] of CASES) {
        const q = 0.5, look = transitionAt({ type, dir: d }, q, W, H);
        const style = `${look.clip ? `clip-path:${look.clip};` : ""}${look.mask ? `-webkit-mask-image:${look.mask};mask-image:${look.mask};mask-size:100% 100%;-webkit-mask-size:100% 100%;mask-repeat:no-repeat;-webkit-mask-repeat:no-repeat;` : ""}`;
        await page.setContent(`<body style="margin:0"><div style="position:relative;width:${W}px;height:${H}px;background:rgb(208,32,32)"><div style="position:absolute;inset:0;background:rgb(32,32,208);${style.replace(/"/g, "&quot;")}"></div></div></body>`);
        await page.waitForTimeout(50);
        const png = await page.screenshot();
        const raw = await new Promise<Buffer>((ok, no) => { const p = execFile("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", "pipe:0", "-vf", "format=rgb24", "-f", "rawvideo", "pipe:1"], { encoding: "buffer", maxBuffer: 1 << 26 }, (e, out) => (e ? no(e) : ok(out as Buffer))); p.stdin!.end(png); });
        const pts = steady(type, q, d);
        const wrong = pts.filter(([x, y]) => { const o = (Math.floor(y * H) * W + Math.floor(x * W)) * 3, p = [raw[o], raw[o + 1], raw[o + 2]]; return wipeCovers(type, q, x * W, y * H, W, H, d) ? !isB(p) : !isA(p); });
        console.log(`player ${type}${d ? " " + d : ""}: ${pts.length - wrong.length}/${pts.length} grid points as the rule says`);
        assert.ok(wrong.length <= pts.length * 0.01, `player ${type}${d ? " " + d : ""}: ${wrong.length} points differ, e.g. ${JSON.stringify(wrong.slice(0, 3))}`);
      }
    } finally { await browser.close(); }
  });
});
