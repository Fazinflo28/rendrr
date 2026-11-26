// Audit #13: a cloud preview made in pieces keeps each piece under a key made from what decides its pixels, so the next
// preview of the same edit makes only the pieces that changed. The key must stay the same for the same piece in another
// job (another folder, other thread counts) and change when anything the piece shows changes.
import assert from "node:assert/strict";
import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { applyOp, buildInitialTimeline, type EditContext, type Snapshot } from "@rendrr/shared";
import { ffmpegArgs, pieceRanges, planRender, windowPlan, type PlanFiles, type RenderPlan, type SourceInfo } from "@rendrr/shared/renderPlan";
import { assInWindow, inputPaths, pieceKey } from "../src/lib/pieceCache";

const SECONDS = 90;
const source: SourceInfo = { width: 360, height: 640, fps: 30, seconds: SECONDS, hasAudio: true };
const ctx: EditContext = { videoId: "v", transcript: [], silences: [], sceneCuts: [], duration: SECONDS, getStyle: () => undefined };

/** An edit of 12 clips of 5 s; `lastEnd` moves the end of the last clip (a change at the end of the edit only). */
function planOf(lastEnd = 0): RenderPlan {
  const clips = Array.from({ length: 12 }, (_, i) => ({ id: `c${i}`, start: i * 7, end: i * 7 + 5 + (i === 11 ? lastEnd : 0), label: "" }));
  const s = applyOp({ timeline: buildInitialTimeline([], SECONDS, "clean", [], "v"), name: "t", aspect: "9:16", styleId: "s2" } as Snapshot, { op: "batch", ops: [{ op: "set_captions", on: false }, { op: "set_clips", track: "v1", clips }] } as never, ctx).snap;
  return planRender({ kind: "preview", snapshot: s, transcript: [], source, videoId: "v" });
}

async function keys(plan: RenderPlan, dir: string, threads: number): Promise<string[]> {
  const files: PlanFiles = { source: join(dir, "source"), output: join(dir, "out.mp4") } as PlanFiles;
  const seen = new Map<string, string>();
  const out: string[] = [];
  for (const [n, pc] of pieceRanges(plan).entries()) {
    const piece = join(dir, `piece-${n}.mov`);
    const a = ffmpegArgs(windowPlan(plan, pc.a, pc.b), { ...files, output: piece }, source, { threads, filterThreads: threads, inputThreads: threads * 2, sound: "none" });
    out.push(await pieceKey({ args: a.args, graph: a.filterGraph, files, output: piece, dir, win: pc, version: "ffmpeg test", seen }));
  }
  return out;
}

describe("the pieces a preview keeps for the next one", () => {
  let d1 = "", d2 = "";
  before(async () => {
    d1 = await mkdtemp(join(tmpdir(), "rendrr-preview-a-"));
    d2 = await mkdtemp(join(tmpdir(), "rendrr-preview-b-"));
    await writeFile(join(d1, "source"), Buffer.alloc(3 * 1024 * 1024, 7));
    await copyFile(join(d1, "source"), join(d2, "source"));
  });
  after(async () => { await rm(d1, { recursive: true, force: true }); await rm(d2, { recursive: true, force: true }); });

  it("a long preview is made in several pieces", () => {
    assert.ok(pieceRanges(planOf()).length >= 4);
  });

  it("the same piece has the same key in another job (another folder, other thread counts)", async () => {
    const plan = planOf();
    assert.deepEqual(await keys(plan, d1, 4), await keys(plan, d2, 1));
  });

  it("every piece of an edit has its own key", async () => {
    const k = await keys(planOf(), d1, 2);
    assert.equal(new Set(k).size, k.length);
  });

  it("a change at the end makes only the last piece again", async () => {
    const a = await keys(planOf(), d1, 2), b = await keys(planOf(-1.5), d1, 2);
    assert.equal(a.length, b.length);
    assert.deepEqual(b.slice(0, -1), a.slice(0, -1));
    assert.notEqual(b.at(-1), a.at(-1));
  });

  it("other footage in the same file name makes every piece again", async () => {
    const d3 = await mkdtemp(join(tmpdir(), "rendrr-preview-c-"));
    try {
      await writeFile(join(d3, "source"), Buffer.alloc(3 * 1024 * 1024, 9));
      const a = await keys(planOf(), d1, 2), c = await keys(planOf(), d3, 2);
      for (let i = 0; i < a.length; i++) assert.notEqual(a[i], c[i]);
    } finally { await rm(d3, { recursive: true, force: true }); }
  });

  it("captions count only around the piece", () => {
    const ass = ["[Script Info]", "PlayResX: 360", "[Events]", "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
      "Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,early", "Dialogue: 0,0:00:31.00,0:00:32.50,Default,,0,0,0,,middle", "Dialogue: 0,0:01:20.00,0:01:21.00,Default,,0,0,0,,late"].join("\n");
    const w = assInWindow(ass, 30, 45);
    assert.match(w, /PlayResX/);
    assert.match(w, /middle/);
    assert.doesNotMatch(w, /early|late/);
    assert.match(assInWindow(ass, 0, 15), /early/);
  });

  it("names every input but the output", () => {
    const p = inputPaths({ source: "/a/source", output: "/a/out.mp4", broll: { b1: "/a/broll-b1.mp4" }, fontsDir: "/fonts", graphicSeconds: { g: 3 } });
    assert.deepEqual(p.sort(), ["/a/broll-b1.mp4", "/a/source", "/fonts"]);
  });
});
