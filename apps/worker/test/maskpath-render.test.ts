// Mask path keyframes rendered and read back: a darken path that changes shape over its clip, from a thin triangle on
// the left (footage 0 s) to a big square on the right (footage 4 s). On frames at the keys and between them, the dark
// pixels match the shape the shared rule (areaAt) gives for that moment (the same rule the player draws), point for
// point, within an edge's width. Needs ffmpeg.
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { applyOp, areaAt, buildInitialTimeline, maskPicture, type Area, type EditContext, type Op, type Snapshot } from "@rendrr/shared";
import { ffmpegArgs, lookFileData, planRender, type PlanFiles, type RenderPlan, type SourceInfo } from "@rendrr/shared/renderPlan";
import { run } from "../src/lib/ffmpeg";
import { writeMoving } from "../src/lib/moving";

const execFileP = promisify(execFile);
const SECONDS = 6;
const source: SourceInfo = { width: 640, height: 360, fps: 30, seconds: SECONDS, hasAudio: true };
const GW = 160, GH = 90;

describe("mask path keyframes, rendered", () => {
  let dir = "", main = "";
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "maskpath-"));
    main = join(dir, "main.mp4");
    await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", `color=0xB4B4B4:s=640x360:r=30:d=${SECONDS}`, "-f", "lavfi", "-i", `sine=f=440:d=${SECONDS}:sample_rate=48000`, "-c:v", "libx264", "-preset", "ultrafast", "-crf", "4", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", main]);
  });
  after(async () => { if (process.env.KEEP) console.log("kept " + dir); else await rm(dir, { recursive: true, force: true }); });

  const ctx: EditContext = { videoId: "v", transcript: [], silences: [], sceneCuts: [], duration: SECONDS, getStyle: () => undefined };
  const triangle: [number, number][] = [[0.05, 0.2], [0.25, 0.5], [0.05, 0.8]];
  const square: [number, number][] = [[0.5, 0.1], [0.9, 0.1], [0.9, 0.9], [0.5, 0.9]];
  const area: Area = { shape: "path", points: triangle, pathKeys: [{ at: 0, points: triangle }, { at: 4, points: square }] };

  it("the dark area follows the shape between its keys, as the shared rule draws it", async () => {
    const s: Snapshot = applyOp({ timeline: buildInitialTimeline([], SECONDS, "clean", [], "v"), name: "m", aspect: "16:9", styleId: "s2" }, { op: "batch", ops: [
      { op: "set_captions", on: false }, { op: "set_audio", loudness: null },
      { op: "set_clips", track: "v1", clips: [{ id: "c", start: 0, end: 5, label: "" }] },
      { op: "set_effects", clipId: "c", effects: [{ type: "darken", amount: 100, area }] },
    ] as Op[] } as never, ctx).snap;
    const plan: RenderPlan = planRender({ kind: "preview", snapshot: s, transcript: [], source, videoId: "v" });
    assert.ok(Object.values(plan.lookFiles ?? {}).some((f) => f.kind === "moving"), "a changing path is drawn as a moving mask");
    assert.match(plan.operations.join("\n"), /changing shape \(2 keys, 0-4s\)/);
    const looks: Record<string, string> = {};
    for (const [n, spec] of Object.entries(plan.lookFiles ?? {})) { const p = join(dir, n); if (spec.kind === "moving") await writeMoving(spec, plan, p); else await writeFile(p, lookFileData(spec, plan, {})); looks[n] = p; }
    const files: PlanFiles = { source: main, output: join(dir, "out.mp4"), looks };
    const { args, filterGraph } = ffmpegArgs(plan, files, source);
    await writeFile(join(dir, "g.txt"), filterGraph);
    await run("ffmpeg", args.map((a) => (a === "__FILTER_SCRIPT__" ? join(dir, "g.txt") : a)));
    for (const t of [0.5, 2, 3.5]) {
      const f = (await execFileP("ffmpeg", ["-hide_banner", "-loglevel", "error", "-ss", t.toFixed(3), "-i", files.output, "-frames:v", "1", "-vf", `scale=${GW}:${GH}:flags=area`, "-f", "rawvideo", "-pix_fmt", "gray", "-"], { encoding: "buffer", maxBuffer: 1 << 24 })).stdout as Buffer;
      const want = maskPicture([areaAt(area, t)], GW, GH);
      let agree = 0, inside = 0, edge = 0;
      for (let i = 0; i < GW * GH; i++) {
        const dark = f[i] < 90, w = want[i];
        if (w > 32 && w < 224) { edge++; continue; } // the shape's own soft edge
        if (w >= 224) inside++;
        if (dark === w >= 224) agree++;
      }
      const share = agree / (GW * GH - edge);
      console.log(`t ${t}: ${(share * 100).toFixed(1)}% of pixels as the shape says (${inside} inside)`);
      assert.ok(share > 0.985, `at ${t} s the dark area is the shape between the keys (${(share * 100).toFixed(1)}%)`);
    }
  });
});
