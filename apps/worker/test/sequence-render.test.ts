// The sequence renders: the same edit planned by the old model A planner and by the sequence planner gives the same
// frames and the same sound (decoded and hashed), and a sequence that cuts between two videos with a J cut and a
// muted clip plays each video and each sound where the plan says. Needs ffmpeg.
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { applyOp, buildInitialTimeline, buildInitialTimelineA, buildTranscript, normalizeTimeline, STYLES, toModelB, type Clip, type EditContext, type Snapshot } from "@rendrr/shared";
import { ffmpegArgs, planRender, type PlanFiles, type RenderPlan, type SourceInfo } from "@rendrr/shared/renderPlan";
import { run } from "../src/lib/ffmpeg";

const SECONDS = 12;
const tr = buildTranscript([Array.from({ length: 22 }, (_, i) => ({ text: `word${i}`, start: 0.5 + i * 0.5, end: 0.9 + i * 0.5 }))], { maxWordsPerLine: 6 })
  .map((l) => ({ ...l, words: l.words.map((w) => ({ ...w, filler: false })) }));
const words = tr.flatMap((l) => l.words);
const source: SourceInfo = { width: 640, height: 360, fps: 30, seconds: SECONDS, hasAudio: true };

describe("sequence renders", () => {
  let dir = "", main = "", other = "";
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "seq-render-"));
    main = join(dir, "main.mp4"); other = join(dir, "other.mp4");
    // Main: a moving test pattern, a tone around -27 dB. Other: blue, 4:3, 25 fps, a tone around -51 dB.
    await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", `testsrc=s=640x360:r=30:d=${SECONDS}`, "-f", "lavfi", "-i", `sine=f=300:d=${SECONDS}:sample_rate=48000`, "-af", "volume=-6dB", "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-shortest", main]);
    await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "color=blue:s=320x240:r=25:d=8", "-f", "lavfi", "-i", "sine=f=600:d=8:sample_rate=44100", "-af", "volume=-30dB", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", other]);
  });
  after(async () => { await rm(dir, { recursive: true, force: true }); });

  async function render(plan: RenderPlan, name: string, files: Partial<PlanFiles> = {}) {
    const all: PlanFiles = { source: main, output: join(dir, `${name}.mp4`), assPath: join(dir, `${name}.ass`), ...files };
    if (plan.ass) await writeFile(all.assPath!, plan.ass);
    const { args, filterGraph } = ffmpegArgs(plan, all, source);
    await writeFile(join(dir, `${name}.txt`), filterGraph);
    await run("ffmpeg", args.map((a) => (a === "__FILTER_SCRIPT__" ? join(dir, `${name}.txt`) : a)));
    return all.output;
  }
  /** Hash of every decoded frame of one stream. */
  const hashes = async (file: string, stream: "v" | "a") => {
    const { stdout } = await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", file, "-map", `0:${stream}`, "-f", "framemd5", "-"]);
    return stdout.split("\n").filter((l) => l && !l.startsWith("#"));
  };
  const meanDb = async (file: string, from: number, len: number) => {
    const { stderr } = await run("ffmpeg", ["-hide_banner", "-ss", String(from), "-t", String(len), "-i", file, "-af", "volumedetect", "-f", "null", "-"]);
    return Number(/mean_volume:\s*(-?[\d.]+|-inf)/.exec(stderr)?.[1] ?? "-999");
  };
  const color = async (file: string, t: number) => {
    const { stderr } = await run("ffmpeg", ["-hide_banner", "-ss", String(t), "-i", file, "-frames:v", "1", "-vf", "crop=16:16:iw/2-8:ih/2-8,signalstats,metadata=print", "-f", "null", "-"]);
    const v = (k: string) => Number(new RegExp(`signalstats\\.${k}=([\\d.]+)`).exec(stderr)?.[1]);
    return { y: v("YAVG"), u: v("UAVG"), v: v("VAVG") };
  };

  it("model A and its sequence render the same frames and the same sound", async () => {
    // Cut words, a removed range, a zoom and captions, as an edit stored in model A.
    let a = buildInitialTimelineA(tr, SECONDS, "clean", [words[2].id, words[3].id, words[9].id]);
    a = normalizeTimeline({ ...a, tracks: { ...a.tracks, v1: a.tracks.v1.map((c) => ({ ...c, end: Math.min(c.end, 10.4) })), a1: a.tracks.a1.map((c) => ({ ...c, end: Math.min(c.end, 10.4) })), v2: [{ id: "z1", start: 6, end: 7.5, label: "Zoom", kind: "zoom", zoom: 1.3 } as Clip] } });
    const snapA: Snapshot = { timeline: a, name: "t", aspect: "9:16", styleId: "s2" };
    // Loudness off: the comparison is about the picture and the dialogue (Phase 3 sets loudness on top).
    const snapB: Snapshot = { ...snapA, timeline: { ...toModelB(a, words, "v", { seconds: SECONDS }), audio: { loudness: null } } };
    const pa = planRender({ kind: "preview", snapshot: snapA, transcript: tr, source, videoId: "v" });
    const pb = planRender({ kind: "preview", snapshot: snapB, transcript: tr, source, videoId: "v" });
    assert.equal(pa.model, "A");
    assert.equal(pb.model, "B");
    assert.ok(pa.parts.length > 1);
    const [fa, fb] = [await render(pa, "a"), await render(pb, "b")];
    const [va, vb] = [await hashes(fa, "v"), await hashes(fb, "v")];
    assert.equal(va.length, vb.length);
    assert.deepEqual(vb, va, "video frames differ");
    assert.deepEqual(await hashes(fb, "a"), await hashes(fa, "a"), "audio differs");
  });

  it("two videos, a J cut and a muted clip: each picture and each sound plays where the plan says", async () => {
    const ctx: EditContext = { videoId: "v", transcript: tr, silences: [], sceneCuts: [], duration: SECONDS, getStyle: (id) => STYLES.find((s) => s.id === id),
      getVideo: (id) => (id === "o" ? { id, name: "Other", seconds: 8, ready: true } : undefined) };
    let s: Snapshot = { timeline: buildInitialTimeline(tr, SECONDS, "clean", [], "v"), name: "t", aspect: "16:9", styleId: "s2" };
    s = applyOp(s, { op: "batch", ops: [
      { op: "set_clips", track: "v1", clips: [{ start: 0, end: 3, label: "a" }, { videoId: "o", start: 1, end: 3, label: "b" }, { start: 5, end: 8, label: "c" }, { videoId: "o", start: 3, end: 5, label: "d" }] },
      { op: "set_captions", on: false },
      { op: "set_audio", loudness: null }, // levels below are absolute: no loudness step
    ] }, ctx).snap;
    const [, b, c, d] = s.timeline.tracks.v1;
    s = applyOp(s, { op: "batch", ops: [{ op: "set_audio_offset", clipId: c.id, start: -0.5 }, { op: "set_audio_offset", clipId: d.id, muted: true }] }, ctx).snap;
    const sources = { o: { width: 320, height: 240, fps: 25, seconds: 8, hasAudio: true } };
    const plan = planRender({ kind: "preview", snapshot: s, transcript: tr, source, videoId: "v", sources });
    assert.equal(plan.outputSeconds, 10); // 3 + 2 + 3 + 2
    assert.deepEqual(plan.sources, ["v", "o"]);
    const out = await render(plan, "multi", { videos: { o: other } });
    const probe = (await run("ffprobe", ["-v", "error", "-show_entries", "stream=duration", "-of", "csv=p=0", out])).stdout.trim().split("\n").map(Number);
    for (const x of probe) assert.ok(Math.abs(x - 10) < 0.1, `stream length ${x}`);
    // Picture: the test pattern 0-3, blue 3-5 (the other video), the pattern 5-8, blue 8-10.
    assert.ok((await color(out, 3.9)).u > 180, "3.9 s: the other video (blue)");
    assert.ok((await color(out, 8.5)).u > 180, "8.5 s: the other video again");
    assert.ok((await color(out, 5.5)).u < 180, "5.5 s: the main footage");
    // Sound: main is loud, the other quiet. The J cut brings main's sound in 0.5 s before its picture (4.5 s).
    assert.ok(await meanDb(out, 3.2, 1.1) < -40, "the other video's quiet sound under its picture");
    assert.ok(await meanDb(out, 4.55, 0.4) > -35, "J cut: the next clip's loud sound under the other video's last half second");
    assert.ok(await meanDb(out, 0.5, 2) > -35, "main's own sound under its picture");
    assert.ok(await meanDb(out, 8.1, 1.8) < -80, "muted clip: silence");
    void b;
  });
});
