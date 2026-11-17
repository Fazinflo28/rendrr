// Phase 12 rendered and read back: a final at a set frame rate and bitrate; sound only as WAV and as AAC; a GIF made
// from the render (15 fps, 640 wide, its own palette); the overlay export (the edit over black and over white, merged
// into ProRes 4444: the text box opaque in its colour, the rest transparent, the footage gone); captions and chapters
// files. Needs ffmpeg with libass and prores_ks.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { applyOp, buildInitialTimeline, buildTranscript, withExportFormat, type EditContext, type Op, type Snapshot } from "@rendrr/shared";
import { ffmpegArgs, planRender, type PlanFiles, type SourceInfo } from "@rendrr/shared/renderPlan";
import { run } from "../src/lib/ffmpeg";
import { makeGif, mergeOverlay, writeSideFiles } from "../src/lib/deliver";

const execFileP = promisify(execFile);
const SECONDS = 4;
const source: SourceInfo = { width: 640, height: 360, fps: 30, seconds: SECONDS, hasAudio: true };
const tr = buildTranscript([["Rendrr", "makes", "files", "for", "every", "place", "you", "post"].map((t, i) => ({ text: t, start: 0.3 + i * 0.45, end: 0.65 + i * 0.45 }))], { maxWordsPerLine: 4 }).map((l) => ({ ...l, words: l.words.map((w) => ({ ...w, filler: false })) }));

describe("deliverables, rendered", () => {
  let dir = "", main = "";
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "deliver-"));
    main = join(dir, "main.mp4");
    await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", `testsrc2=s=640x360:r=30:d=${SECONDS}`, "-f", "lavfi", "-i", `sine=f=440:d=${SECONDS}:sample_rate=48000`, "-c:v", "libx264", "-preset", "ultrafast", "-crf", "16", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", main]);
  });
  after(async () => { if (process.env.KEEP) console.log("kept " + dir); else await rm(dir, { recursive: true, force: true }); });

  const ctx: EditContext = { videoId: "v", transcript: tr, silences: [], sceneCuts: [], duration: SECONDS, getStyle: () => undefined };
  const edit = (ops: Op[]): Snapshot => applyOp({ timeline: buildInitialTimeline(tr, SECONDS, "clean", [], "v"), name: "d", aspect: "16:9", styleId: "s2" }, { op: "batch", ops: [{ op: "set_captions", on: false }, { op: "set_audio", loudness: null }, ...ops] as never }, ctx).snap;
  const render = async (s: Snapshot, out: string, pictureAs?: "black" | "white") => {
    const plan = planRender({ kind: "final", snapshot: s, transcript: tr, source, videoId: "v" });
    const files: PlanFiles = { source: main, output: join(dir, out), assPath: join(dir, `${out}.ass`) };
    if (plan.ass) await writeFile(files.assPath!, plan.ass);
    const { args, filterGraph } = ffmpegArgs(plan, files, source, { loudnessGainDb: 0, ...(pictureAs ? { pictureAs } : {}) });
    await writeFile(join(dir, `${out}.txt`), filterGraph);
    await run("ffmpeg", args.map((a) => (a === "__FILTER_SCRIPT__" ? join(dir, `${out}.txt`) : a)));
    return { file: files.output, plan };
  };
  const probe = async (file: string) => JSON.parse((await execFileP("ffprobe", ["-v", "error", "-show_streams", "-show_format", "-of", "json", file])).stdout) as { streams: { codec_type: string; codec_name: string; width?: number; r_frame_rate?: string; pix_fmt?: string; nb_frames?: string; sample_rate?: string }[]; format: { duration: string; bit_rate: string } };

  it("a final at 25 fps and 2 Mbit/s", async () => {
    const { file } = await render(edit([{ op: "set_export", fps: 25, bitrate: 2 } as Op]), "rate.mp4");
    const p = await probe(file), v = p.streams.find((x) => x.codec_type === "video")!;
    const mbps = Number(p.format.bit_rate) / 1e6;
    console.log(`final: ${v.r_frame_rate}, ${mbps.toFixed(2)} Mbit/s overall`);
    assert.equal(v.r_frame_rate, "25/1");
    assert.ok(mbps > 0.8 && mbps < 2.8, "about the bitrate asked");
  });

  it("a sound-only final of a video edit, asked for one export (render_final format), the edit unchanged", async () => {
    const video = edit([{ op: "set_export", fps: 25 } as Op]);
    const once = withExportFormat(video, "audio");
    assert.equal(video.timeline.export?.format, undefined, "the edit itself stays a video");
    const { file, plan } = await render(once, "once.m4a");
    const p = await probe(file);
    assert.equal(plan.format, "audio");
    assert.deepEqual(p.streams.map((x) => x.codec_name), ["aac"], "sound only, no picture");
    assert.ok(Math.abs(Number(p.format.duration) - SECONDS) < 0.1);
  });

  it("sound only: WAV and AAC, as long as the edit, no picture", async () => {
    for (const [fmt, out, codec] of [["wav", "s.wav", "pcm_s16le"], ["audio", "s.m4a", "aac"]] as const) {
      const { file } = await render(edit([{ op: "set_export", format: fmt } as Op]), out);
      const p = await probe(file);
      console.log(`${fmt}: ${p.streams.map((x) => `${x.codec_type} ${x.codec_name}`).join(", ")}, ${Number(p.format.duration).toFixed(2)} s`);
      assert.deepEqual(p.streams.map((x) => x.codec_name), [codec]);
      assert.ok(Math.abs(Number(p.format.duration) - SECONDS) < 0.1);
    }
  });

  it("a GIF: 15 fps, 640 wide, looping, from the render", async () => {
    const { file, plan } = await render(edit([{ op: "set_export", format: "gif" } as Op]), "g.mp4");
    const gif = join(dir, "g.gif");
    await makeGif(file, gif, plan.width, plan.height);
    const p = await probe(gif), v = p.streams[0];
    console.log(`gif: ${v.codec_name} ${v.width} px, ${v.r_frame_rate}, ${v.nb_frames ?? "?"} frames, ${(Number((await readFile(gif)).length) / 1024).toFixed(0)} KB`);
    assert.equal(v.codec_name, "gif");
    assert.equal(v.width, 640);
    assert.equal(v.r_frame_rate, "15/1");
    // Phase 20: a longer edit's GIF has fewer frames a second and is smaller (gifSpec): 10 fps, 480 wide past a minute.
    const gif2 = join(dir, "g2.gif");
    await makeGif(file, gif2, plan.width, plan.height, undefined, 90);
    const v2 = (await probe(gif2)).streams[0];
    assert.equal(v2.width, 480);
    assert.equal(v2.r_frame_rate, "10/1");
  });

  it("the overlay export: the text box opaque in its colour, the rest transparent, the footage gone", async () => {
    const s = edit([{ op: "set_export", format: "overlay" } as Op, { op: "add_text", text: "TITLE", start: 0.5, end: 3.5, edit: true, color: "#FFFFFF", box: { color: "#FF00FF", opacity: 1, padding: 30 }, x: 0.5, y: 0.5, anim: "none" } as Op]);
    const b = await render(s, "ov-b.mkv", "black"), w = await render(s, "ov-w.mkv", "white");
    const mov = join(dir, "ov.mov");
    await mergeOverlay(b.file, w.file, mov);
    const p = await probe(mov), v = p.streams.find((x) => x.codec_type === "video")!;
    assert.equal(v.codec_name, "prores");
    assert.match(v.pix_fmt!, /yuva444p/);
    const W = 1920, H = 1080;
    const raw = (await execFileP("ffmpeg", ["-hide_banner", "-loglevel", "error", "-ss", "2", "-i", mov, "-frames:v", "1", "-vf", "format=rgba", "-f", "rawvideo", "-"], { encoding: "buffer", maxBuffer: 1 << 26 })).stdout as Buffer;
    const at = (x: number, y: number) => { const o = (y * W + x) * 4; return [raw[o], raw[o + 1], raw[o + 2], raw[o + 3]]; };
    // Find the box: the magenta pixels' middle.
    let sx = 0, sy = 0, n = 0;
    for (let y = 0; y < H; y += 4) for (let x = 0; x < W; x += 4) { const q = at(x, y); if (q[3] > 240 && q[0] > 200 && q[1] < 60 && q[2] > 200) { sx += x; sy += y; n++; } }
    assert.ok(n > 50, "the box is there, opaque");
    const corner = at(40, 40), far = at(W - 60, H - 60);
    console.log(`overlay: ${n * 16} px of opaque magenta box; a corner ${corner} (rgba), far corner ${far}; ${v.codec_name} ${v.pix_fmt}`);
    assert.ok(corner[3] < 8 && far[3] < 8, "away from the text, transparent (the footage is not in it)");
  });

  it("captions (SRT, WebVTT) and chapters files", async () => {
    const s = edit([{ op: "add_marks", marks: [{ kind: "chapter", start: 0, label: "Start" }, { kind: "chapter", start: 2, label: "Middle" }] } as Op]);
    const plan = planRender({ kind: "final", snapshot: s, transcript: tr, source, videoId: "v" });
    const f = await writeSideFiles(dir, plan);
    const srt = await readFile(f.srt!, "utf8"), vtt = await readFile(f.vtt!, "utf8"), ch = await readFile(f.chapters!, "utf8");
    console.log(`srt:\n${srt.split("\n").slice(0, 3).join(" | ")}; chapters: ${ch.trim().replace(/\n/g, " | ")}`);
    assert.match(srt, /^1\n00:00:00,300 --> 00:00:0\d,\d{3}\nRendrr makes/);
    assert.match(vtt, /^WEBVTT\n\n00:00:00\.300 --> /);
    assert.equal(ch, "0:00 Start\n0:02 Middle\n");
  });
});
