// End to end: an edit is rendered with the real plan and FFmpeg, the file is measured, and the check compares the
// two. A clean edit must agree ("Flags: none", file length = edit length); dialogue muted under the picture must
// show up as a flag measured in the file. Needs ffmpeg.
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { applyOp, buildInitialTimeline, buildTranscript, editCheck, STYLES, type EditContext, type FileMeasure, type Snapshot } from "@rendrr/shared";
import { ffmpegArgs, planRender } from "@rendrr/shared/renderPlan";
import { graphicCover, measureFile, run } from "../src/lib/ffmpeg";

const SECONDS = 12;
// One word every 0.5 s over a steady tone, so the only silence in a file is silence the render made.
const tr = buildTranscript([Array.from({ length: 22 }, (_, i) => ({ text: `word${i}`, start: 0.5 + i * 0.5, end: 0.9 + i * 0.5 }))], { maxWordsPerLine: 6 })
  .map((l) => ({ ...l, words: l.words.map((w) => ({ ...w, filler: false })) }));
const ctx: EditContext = { videoId: "v", transcript: tr, silences: [], sceneCuts: [], duration: SECONDS, getStyle: (id) => STYLES.find((s) => s.id === id), getGraphic: (id) => ({ id, name: "Box", durationSec: 2 }) };
const source = { width: 640, height: 360, fps: 30, seconds: SECONDS, hasAudio: true };

describe("the check agrees with the rendered file", () => {
  let dir = "", src = "", gfx = "";
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "check-e2e-"));
    src = join(dir, "source.mp4"); gfx = join(dir, "box.webm");
    await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", `testsrc=s=640x360:r=30:d=${SECONDS}`, "-f", "lavfi", "-i", `sine=f=300:d=${SECONDS}:sample_rate=48000`, "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-shortest", src]);
    await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "color=black:s=320x180:r=30:d=2,format=rgba,geq=r=255:g=255:b=255:a='if(lt(X,160)*lt(Y,90),255,0)'", "-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p", "-auto-alt-ref", "0", gfx]);
  });
  after(async () => { await rm(dir, { recursive: true, force: true }); });

  async function renderAndCheck(snap: Snapshot, name: string) {
    const plan = planRender({ kind: "preview", snapshot: snap, transcript: tr, source, graphicsReady: Object.fromEntries(snap.timeline.tracks.v3.filter((c) => (c as { graphicId?: string }).graphicId).map((c) => [c.id, true])) });
    const files = { source: src, output: join(dir, `${name}.mp4`), assPath: join(dir, `${name}.ass`), graphics: Object.fromEntries(plan.graphics.map((g) => [g.clipId, gfx])) };
    if (plan.ass) await writeFile(files.assPath, plan.ass);
    const { args, filterGraph } = ffmpegArgs(plan, files, source);
    await writeFile(join(dir, `${name}.txt`), filterGraph);
    await run("ffmpeg", args.map((a) => (a === "__FILTER_SCRIPT__" ? join(dir, `${name}.txt`) : a)));
    const base = await measureFile(files.output, { timeoutMs: 60_000 });
    const graphics: FileMeasure["graphics"] = [];
    for (const g of plan.graphics) graphics.push({ clipId: g.clipId, start: g.start, end: Math.min(g.end, g.start + 2), coverPct: await graphicCover(gfx, 1) });
    const measured: FileMeasure = { ...base, graphics };
    return { plan, measured, check: editCheck(snap, tr, { measured }) };
  }

  it("a clean edit with cuts and a graphic: same length, no gaps, graphic on screen, Flags: none", async () => {
    let s: Snapshot = { timeline: buildInitialTimeline(tr, SECONDS, "clean"), name: "t", aspect: "16:9", styleId: "s2" };
    s = applyOp(s, { op: "batch", ops: [{ op: "cut_words", from: 3, to: 4.5 }, { op: "cut_words", from: 7, to: 7.6 }, { op: "add_graphic", graphicId: "box", start: 1, end: 3, params: {} }] }, ctx).snap;
    const { plan, measured, check } = await renderAndCheck(s, "clean");
    assert.ok(Math.abs((measured.videoSeconds ?? 0) - plan.outputSeconds) < 0.1, check);
    assert.ok(Math.abs((measured.audioSeconds ?? 0) - (measured.videoSeconds ?? 0)) < 0.1, check);
    assert.match(check, /Graphics 1 \(1 on screen\)/);
    assert.match(check, /Flags: none$/, check);
  });

  it("dialogue trimmed off part of the picture: the file is silent there and the check says so", async () => {
    const s0 = applyOp({ timeline: buildInitialTimeline(tr, SECONDS, "clean"), name: "t", aspect: "16:9", styleId: "s2" }, { op: "rename", name: "t" }, ctx).snap;
    const d = s0.timeline.tracks.a1[0];
    const s = applyOp(s0, { op: "trim_clip", track: "a1", clipId: d.id, start: d.start, end: d.start + 4, linked: false }, ctx).snap;
    const { measured, check } = await renderAndCheck(s, "muted");
    assert.ok(measured.silences.some((x) => x.end - x.start > 1), JSON.stringify(measured.silences));
    assert.match(check, /of picture without its dialogue/);
    assert.match(check, /where words should play/);
  });

  it("footage filmed sideways comes out upright when turned 90° clockwise", async () => {
    // A landscape source whose LEFT half is red and right half blue: turned clockwise, red must be on top.
    const side = join(dir, "side.mp4");
    await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", `color=red:s=320x180:r=30:d=${SECONDS}`, "-f", "lavfi", "-i", `color=blue:s=320x180:r=30:d=${SECONDS}`,
      "-f", "lavfi", "-i", `sine=f=300:d=${SECONDS}:sample_rate=48000`, "-filter_complex", "[0:v]crop=160:180:0:0[l];[1:v]crop=160:180:160:0[r];[l][r]hstack[v]", "-map", "[v]", "-map", "2:a",
      "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", side]);
    const s0: Snapshot = { timeline: buildInitialTimeline(tr, SECONDS, "clean"), name: "t", aspect: "9:16", styleId: "s2" };
    const s = applyOp(s0, { op: "batch", ops: [{ op: "set_rotation", degrees: 90 }, { op: "set_captions", on: false }] }, ctx).snap;
    const plan = planRender({ kind: "preview", snapshot: s, transcript: tr, source: { ...source, width: 320, height: 180 } });
    const out = join(dir, "turned.mp4");
    const { args, filterGraph } = ffmpegArgs(plan, { source: side, output: out }, { ...source, width: 320, height: 180 });
    await writeFile(join(dir, "turned.txt"), filterGraph);
    await run("ffmpeg", args.map((a) => (a === "__FILTER_SCRIPT__" ? join(dir, "turned.txt") : a)));
    // Colour of a small patch at height y: red has a high V (Cr), blue a high U (Cb).
    const px = async (y: number) => {
      const { stderr } = await run("ffmpeg", ["-hide_banner", "-ss", "1", "-i", out, "-frames:v", "1", "-vf", `crop=16:16:iw/2-8:ih*${y},signalstats,metadata=print`, "-f", "null", "-"]);
      const v = (k: string) => Number(new RegExp(`signalstats\\.${k}=([\\d.]+)`).exec(stderr)?.[1]);
      return { u: v("UAVG"), v: v("VAVG") };
    };
    const [top, bottom] = [await px(0.2), await px(0.8)];
    assert.ok(top.v > 180 && top.u < 128, `top should be red, got ${JSON.stringify(top)}`);
    assert.ok(bottom.u > 180 && bottom.v < 128, `bottom should be blue, got ${JSON.stringify(bottom)}`);
  });

  it("framing moves the footage: down by half the frame, the top is black and the old top is at the bottom", async () => {
    // A 9:16 source whose TOP half is red and bottom half blue.
    const tall = join(dir, "tall.mp4");
    await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", `color=red:s=180x320:r=30:d=${SECONDS}`, "-f", "lavfi", "-i", `color=blue:s=180x320:r=30:d=${SECONDS}`,
      "-f", "lavfi", "-i", `sine=f=300:d=${SECONDS}:sample_rate=48000`, "-filter_complex", "[0:v]crop=180:160:0:0[t];[1:v]crop=180:160:0:160[b];[t][b]vstack[v]", "-map", "[v]", "-map", "2:a",
      "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", tall]);
    const s0: Snapshot = { timeline: buildInitialTimeline(tr, SECONDS, "clean"), name: "t", aspect: "9:16", styleId: "s2" };
    const s = applyOp(s0, { op: "batch", ops: [{ op: "set_framing", y: 0.5 }, { op: "set_captions", on: false }] }, ctx).snap;
    const src = { ...source, width: 180, height: 320 };
    const plan = planRender({ kind: "preview", snapshot: s, transcript: tr, source: src });
    const out = join(dir, "framed.mp4");
    const { args, filterGraph } = ffmpegArgs(plan, { source: tall, output: out }, src);
    await writeFile(join(dir, "framed.txt"), filterGraph);
    await run("ffmpeg", args.map((a) => (a === "__FILTER_SCRIPT__" ? join(dir, "framed.txt") : a)));
    const yuv = async (y: number) => {
      const { stderr } = await run("ffmpeg", ["-hide_banner", "-ss", "1", "-i", out, "-frames:v", "1", "-vf", `crop=16:16:iw/2-8:ih*${y},signalstats,metadata=print`, "-f", "null", "-"]);
      const v = (k: string) => Number(new RegExp(`signalstats\\.${k}=([\\d.]+)`).exec(stderr)?.[1]);
      return { y: v("YAVG"), u: v("UAVG"), v: v("VAVG") };
    };
    const [top, bottom] = [await yuv(0.2), await yuv(0.8)];
    assert.ok(top.y < 30, `top should be black, got ${JSON.stringify(top)}`);
    assert.ok(bottom.v > 180, `bottom should show the red top half, got ${JSON.stringify(bottom)}`);
    const m = await measureFile(out, { timeoutMs: 60_000 });
    assert.ok(Math.abs((m.videoSeconds ?? 0) - plan.outputSeconds) < 0.1, "framing keeps the length");
  });
});
