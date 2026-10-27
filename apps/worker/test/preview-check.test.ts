// Engine Part 3: the preview check, end to end. A talking-head video made of real (synthetic) words whose edges are
// known is measured as the footage is (its sound every 10 ms, the word edges in the sound). An AI-style script builds
// clips from the start and end of chosen words in the sound (start_audio, end_audio); the preview is rendered with the
// real plan and FFmpeg, its sound measured, and the check must report no clipped word and no gap over 0.15 s the
// script did not choose. A sloppy script shows up as gaps at the joins (with their sides) and a clipped word (in ms); a
// hard cut clicks; a graphic over the face is said. With a database the render job does all of it, and the preview is
// transcribed again. Needs ffmpeg, espeak-ng and Python with numpy and onnxruntime (PYTHON_BIN).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { after, before, describe, it } from "node:test";
import type { Job } from "bullmq";
import {
  alignedMap, applyOp, boxCover, buildRawTimeline, editCheck, faceOnScreenAt, PREVIEW_STEPS, sequenceView, soundJoins, speechGaps, wordsAsPlayed,
  type Alignment, type EditContext, type EditOp, type FileMeasure, type HeardTranscript, type Snapshot, type Transcript, type VisionDetails, type Word,
} from "@rendrr/shared";
import { ffmpegArgs, planRender, zoomAt } from "@rendrr/shared/renderPlan";
import { COVER_SIZE, graphicCover, measureFile, run } from "../src/lib/ffmpeg";
import { measureMix } from "../src/lib/mix";
import { measureSound } from "../src/lib/sound";

const here = dirname(fileURLToPath(import.meta.url));
const PY = process.env.PYTHON_BIN || "python3";
const has = (cmd: string, args: string[]) => { try { execFileSync(cmd, args, { stdio: "ignore" }); return true; } catch { return false; } };
const pyOk = has(PY, ["-c", "import onnxruntime, numpy"]);
const espeak = has("espeak-ng", ["--version"]);
const db = !!process.env.DATABASE_URL && !!process.env.S3_BUCKET && !!process.env.REDIS_URL;
const run6 = Math.random().toString(36).slice(2, 8);

const SENTENCES = ["today we are going to build a website from scratch", "it is really easy if you follow along", "first we pick a simple layout for the page"];
// The face the vision measured (x, y, w, h of the frame): the portrait's place in the picture, held still.
const FACE: [number, number, number, number] = [0.3, 0.1, 0.4, 0.75];
const W = 640, H = 360;

describe("the preview check, end to end", { skip: (!pyOk || !espeak) && "needs espeak-ng and Python with numpy and onnxruntime" }, () => {
  let dir = "", video = "", seconds = 0;
  let truth: { text: string; s: number; e: number }[] = [];
  let tr: Transcript = [];
  let words: Word[] = [];
  let alignment: Alignment;
  let ctx: EditContext;

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "pcheck-"));
    // Each word said on its own, joined with 60 ms between words and 0.9 s between sentences, over a quiet room.
    SENTENCES.forEach((s, i) => s.split(" ").forEach((w, j) => execFileSync("espeak-ng", ["-v", "en-us", "-s", "160", "-w", join(dir, `w${i}_${j}.wav`), w])));
    const made = execFileSync(PY, ["-c", `
import numpy as np, wave, json, sys
d=sys.argv[1]; sents=json.loads(sys.argv[2])
def read(p):
    w=wave.open(p); sr=w.getframerate(); x=np.frombuffer(w.readframes(w.getnframes()),np.int16).astype(np.float32)/32768
    on=np.flatnonzero(np.abs(x)>0.01); return x[on[0]:on[-1]+1], sr
rng=np.random.default_rng(3)
parts=[]; truth=[]; t=0.5; sr=22050
room=lambda n:(rng.standard_normal(n)*0.0015).astype(np.float32)
parts.append(np.zeros(int(0.5*sr),np.float32))
for i,s in enumerate(sents):
    for j,w in enumerate(s.split(" ")):
        x,sr=read(f"{d}/w{i}_{j}.wav"); parts.append(x); truth.append([w,round(t,3),round(t+len(x)/sr,3)]); t+=len(x)/sr
        g=0.06 if j<len(s.split(" "))-1 else (0.9 if i<len(sents)-1 else 0.8)
        parts.append(np.zeros(int(round(g*sr)),np.float32)); t=t+int(round(g*sr))/sr
x=np.concatenate(parts); x=x+room(len(x))
w=wave.open(d+"/talk.wav","wb"); w.setnchannels(1); w.setsampwidth(2); w.setframerate(sr); w.writeframes((np.clip(x,-1,1)*32767).astype(np.int16).tobytes()); w.close()
print(json.dumps({"truth":truth,"total":len(x)/sr}))`, dir, JSON.stringify(SENTENCES)]).toString();
    const j = JSON.parse(made.trim().split("\n").pop()!) as { truth: [string, number, number][]; total: number };
    truth = j.truth.map(([text, s, e]) => ({ text, s, e }));
    seconds = j.total;
    // The picture: the portrait on a grey frame, where FACE says.
    video = join(dir, "talk.mp4");
    execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", `color=0x506070:s=${W}x${H}:r=30:d=${seconds.toFixed(3)}`, "-i", join(here, "fixtures/astronaut.jpg"), "-i", join(dir, "talk.wav"),
      "-filter_complex", `[1:v]scale=${Math.round(FACE[2] * W)}:${Math.round(FACE[3] * H)}[f];[0:v][f]overlay=x=${Math.round(FACE[0] * W)}:y=${Math.round(FACE[1] * H)},format=yuv420p[v]`,
      "-map", "[v]", "-map", "2:a", "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-shortest", video]);
    // A transcriber's words: 50 ms late and ending 40 ms early. Their edges in the sound are measured as the footage's
    // are (deep_audio.py, then align.py; without the wav2vec2 model the edges move onto the sound alone).
    let n = 0;
    tr = SENTENCES.map((s, i) => {
      const ws: Word[] = s.split(" ").map(() => { const x = truth[n]; return { id: `w${n++}`, text: x.text, t: +(x.s + 0.05).toFixed(3), end: +Math.max(x.s + 0.08, x.e - 0.04).toFixed(3), filler: false }; });
      return { id: `l${i}`, start: ws[0].t, end: ws[ws.length - 1].end, gapBefore: i ? 0.9 : 0, words: ws };
    });
    words = tr.flatMap((l) => l.words);
    const p48 = join(dir, "a48.raw"), p16 = join(dir, "a16.raw");
    execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", video, "-vn", "-ac", "1", "-ar", "48000", "-f", "s16le", p48]);
    execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", video, "-vn", "-ac", "1", "-ar", "16000", "-f", "f32le", p16]);
    const audio = JSON.parse(execFileSync(PY, [join(here, "../python/deep_audio.py"), "--pcm48", p48, "--pcm16", p16, "--vad", join(here, "../models/silero/silero_vad.onnx"), "--out", dir], { stdio: ["ignore", "pipe", "ignore"] }).toString().trim().split("\n").pop()!) as { roomDb: number };
    await writeFile(join(dir, "words.json"), JSON.stringify(words.map((w) => [w.id, w.text, w.t, w.end])));
    alignment = JSON.parse(execFileSync(PY, [join(here, "../python/align.py"), "--pcm16", p16, "--words", join(dir, "words.json"), "--frames", join(dir, "audio.bin"), "--floor", String(audio.roomDb)], { stdio: ["ignore", "pipe", "ignore"] }).toString().trim().split("\n").pop()!) as Alignment;
    ctx = { videoId: "v", transcript: tr, silences: [], sceneCuts: [], duration: seconds, getStyle: () => undefined, getGraphic: (id) => ({ id, name: "Face box", durationSec: 2, custom: true }) } as EditContext;
  });
  after(async () => { await rm(dir, { recursive: true, force: true }); });

  const al = () => alignedMap(alignment);
  const edge = (i: number) => al().get(words[i].id)!;
  const sentenceStart = (k: number) => SENTENCES.slice(0, k).reduce((a, s) => a + s.split(" ").length, 0);
  const raw = (): Snapshot => ({ timeline: buildRawTimeline(tr, seconds, [], "v"), name: "t", aspect: "16:9", styleId: null });
  const edit = (s: Snapshot, ...ops: EditOp[]) => applyOp(s, { op: "batch", ops }, ctx).snap;
  const clipsOf = (cs: [number, number][]) => ({ op: "set_clips", track: "v1", clips: cs.map(([a, b], i) => ({ id: `k${i}`, start: Math.round(a * 1000) / 1000, end: Math.round(b * 1000) / 1000, label: "" })) }) as EditOp;
  const source = () => ({ width: W, height: H, fps: 30, seconds, hasAudio: true });

  /** Renders a preview of the edit as the render job does (the mix measured, then the file) and measures the file. */
  async function render(s: Snapshot, name: string, graphics: Record<string, string> = {}) {
    const plan = planRender({ kind: "preview", snapshot: s, transcript: tr, source: source(), videoId: "v", graphicsReady: Object.fromEntries(Object.keys(graphics).map((k) => [k, true])) });
    const files = { source: video, output: join(dir, `${name}.mp4`), graphics };
    const mix = await measureMix(plan, files, source(), { dir });
    const { args, filterGraph } = ffmpegArgs(plan, files, source(), { loudnessGainDb: mix.gainDb });
    await writeFile(join(dir, `${name}.txt`), filterGraph);
    await run("ffmpeg", args.map((a) => (a === "__FILTER_SCRIPT__" ? join(dir, `${name}.txt`) : a)));
    const base = await measureFile(files.output, { timeoutMs: 60_000 });
    const sound = await measureSound(files.output, soundJoins(plan.sound).map((j) => j.at), { dir, seconds: plan.outputSeconds });
    assert.equal(sound.error, undefined, sound.error);
    const measured: FileMeasure = { ...base, graphics: [], sound };
    return { plan, measured, check: editCheck(s, tr, { measured, videoId: "v", aligned: { v: al() } }) };
  }

  it("the source's word edges are found in its sound", () => {
    // Without the wav2vec2 model (as here) the edges move onto the sound alone: most land within 20 ms, a few further.
    const off = truth.map((x, i) => Math.max(Math.abs(edge(i).s - x.s), Math.abs(edge(i).e - x.e))).sort((a, b) => a - b);
    console.log(`word edges: worst ${Math.round(off[off.length - 1] * 1000)} ms off, median ${Math.round(off[off.length >> 1] * 1000)} ms`);
    assert.ok(off[off.length >> 1] < 0.02 && off.filter((x) => x > 0.04).length <= 4, `edges off by: ${off.map((x) => Math.round(x * 1000)).join(" ")}`);
  });

  it("an AI-style script cutting at start_audio and end_audio: no clipped word, no gap over 0.15 s it did not choose", async () => {
    const s2 = sentenceStart(1), s3 = sentenceStart(2);
    // "today we are going" | "build a website from scratch ... it is really" (keeps the pause between the sentences:
    // the one gap the script chose) | "a simple layout for the page".
    const chosen: [number, number][] = [[0, 3], [5, s2 + 2], [s3 + 3, words.length - 1]];
    const s = edit(raw(), clipsOf(chosen.map(([a, b]) => [edge(a).s, edge(b).e])));
    const { measured, check } = await render(s, "script");
    console.log(check.split("\n").filter((l) => /^(Gaps|Clipped|Clicks|Flags)/.test(l)).join("\n"));
    assert.match(check, /^Clipped words \(a cut goes through the word's sound\): none$/m);
    assert.match(check, /^Clicks at joins: none$/m);
    const view = sequenceView(s.timeline, words);
    const gaps = speechGaps(view, measured.sound!, measured.silences, view.total);
    const chosenPause = edge(s2).s - edge(s2 - 1).e;
    // The only gap over 0.15 s is the pause the script kept, inside its clip; none at a join.
    assert.deepEqual(gaps.map((g) => [g.joins.length, g.segments.map((x) => `${x.where} ${x.clipId}`).join(" ")]), [[0, "inside k1"]], JSON.stringify(gaps));
    assert.ok(Math.abs(gaps[0].end - gaps[0].start - chosenPause) < 0.12, `gap ${(gaps[0].end - gaps[0].start).toFixed(3)} s, chosen pause ${chosenPause.toFixed(3)} s`);
    assert.doesNotMatch(check, /Flags: .*(cut through|click|silent .* where words should play)/);
  });

  it("a sloppy script: the silence kept at a join is placed on both sides of it; a cut through a word is in ms", async () => {
    const s2 = sentenceStart(1), s3 = sentenceStart(2);
    // a: all of sentence 1 and 0.25 s after it; b: sentence 2 from 0.12 s before it; c: from 80 ms into "pick".
    const s = edit(raw(), clipsOf([[edge(0).s, edge(s2 - 1).e + 0.25], [edge(s2).s - 0.12, edge(s3 - 1).e], [edge(s3 + 2).s + 0.08, edge(words.length - 1).e]]));
    const { measured, check } = await render(s, "sloppy");
    console.log(check.split("\n").filter((l) => /^(Gaps|Clipped|Clicks)/.test(l)).join("\n"));
    const view = sequenceView(s.timeline, words);
    const g = speechGaps(view, measured.sound!, measured.silences, view.total).find((x) => x.joins.length)!;
    assert.ok(g, "a gap at the join k0|k1");
    const [a, b] = g.segments;
    assert.equal(`${a.where} ${a.clipId}|${b.where} ${b.clipId}`, "end k0|start k1");
    assert.ok(Math.abs(a.end - a.start - 0.25) < 0.07 && Math.abs(b.end - b.start - 0.12) < 0.07, `sides ${(a.end - a.start).toFixed(3)} and ${(b.end - b.start).toFixed(3)} s`);
    assert.match(check, /at the join k0\|k1: end of k0 0\.\d\ds \(footage [\d.]+-[\d.]+\) \+ start of k1 0\.\d\ds/);
    assert.match(check, /^Clipped words \(a cut goes through the word's sound\): 1: "pick" start of k2 at [\d:.]+ \(footage [\d.]+\): 80ms cut off, \d+ms plays$/m);
  });

  it("a hard cut in the sound clicks at the join; a smooth one does not", async () => {
    execFileSync(PY, ["-c", `
import numpy as np, wave, sys
sr=48000; t=np.arange(sr)/sr
x=0.4*np.sin(2*np.pi*300*t); x[sr//2:]=0.4*np.sin(2*np.pi*300*t[sr//2:]+2.5)  # the phase jumps at 0.5 s
for name,y in (("hard",x),("smooth",0.4*np.sin(2*np.pi*300*t))):
    w=wave.open(sys.argv[1]+f"/{name}.wav","wb"); w.setnchannels(1); w.setsampwidth(2); w.setframerate(sr); w.writeframes((y*32767).astype(np.int16).tobytes()); w.close()`, dir]);
    const hard = await measureSound(join(dir, "hard.wav"), [0.5], { dir, seconds: 1 });
    assert.equal(hard.joinClicks.length, 1, JSON.stringify(hard));
    assert.ok(Math.abs(hard.joinClicks[0][0] - 0.5) < 0.003 && hard.joinClicks[0][1] > 20, JSON.stringify(hard.joinClicks));
    assert.deepEqual((await measureSound(join(dir, "smooth.wav"), [0.5], { dir, seconds: 1 })).joinClicks, []);
  });

  it("a graphic over the face covers it; one in a corner does not", async () => {
    // Two 2 s graphics at the output size (960x540): an opaque box where the face is drawn, and one in the top corner.
    const box = async (name: string, x: number, y: number, w: number, h: number) => {
      const f = join(dir, `${name}.webm`);
      await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", `color=black:s=960x540:r=30:d=2,format=rgba,geq=r=255:g=255:b=255:a='if(between(X,${x},${x + w})*between(Y,${y},${y + h}),255,0)'`, "-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p", "-auto-alt-ref", "0", f]);
      return f;
    };
    const onFace = await box("onface", Math.round(FACE[0] * 960), Math.round(FACE[1] * 540), Math.round(FACE[2] * 960), Math.round(FACE[3] * 540));
    const corner = await box("corner", 0, 0, 120, 60);
    const s = edit(raw(), { op: "add_graphic", graphicId: "g1", start: 1, end: 3, params: {} } as EditOp);
    const plan = planRender({ kind: "preview", snapshot: s, transcript: tr, source: source(), videoId: "v", graphicsReady: { [s.timeline.tracks.v3[0].id]: true } });
    const details = { size: [W, H] as [number, number], frames: Array.from({ length: Math.round(seconds * 10) }, (_, i) => [i / 10, [[1, ...FACE, 0.9, null, null, null, null]]]) } as unknown as VisionDetails;
    const view = sequenceView(s.timeline, words);
    const faceAt = (t: number) => faceOnScreenAt(t, { view, clips: new Map(s.timeline.tracks.v1.map((c) => [c.id, c as never])), W: plan.width, H: plan.height, vision: () => ({ details, turned: 0 }), zooms: plan.zooms, zoomAt });
    const cover = async (file: string) => {
      const c = (await graphicCover(file, 0, 2, undefined, 8))!;
      assert.equal(c.samples, 8);
      assert.equal(c.visible, 8);
      return Math.max(...c.at.map((ft, k) => boxCover(c.maps![k], COVER_SIZE, faceAt(1 + ft)!)));
    };
    const a = await cover(onFace), b = await cover(corner);
    assert.ok(a > 90, `over the face: ${a}%`);
    assert.ok(b < 5, `in the corner: ${b}%`);
  });

  it("the render job: the preview's sound and the face under a graphic are measured, and the preview is transcribed again", { skip: !db && "needs a database, Redis and storage", timeout: 240_000 }, async () => {
    const { prisma } = await import("@rendrr/db");
    const { deletePrefix, redis, uploadFile } = await import("@rendrr/core");
    const { renderJob } = await import("../src/jobs/render");
    const { heardJob } = await import("../src/jobs/heard");
    const userId = (await prisma.user.create({ data: { clerkId: `pcheck_${run6}`, email: `pcheck-${run6}@test.rendrr.dev`, name: "Check" } })).id;
    try {
      const folderId = (await prisma.folder.create({ data: { userId, name: "My edits", workspace: "Check's Workspace" } })).id;
      const proxyKey = `proxies/${userId}/talk.mp4`;
      await uploadFile(proxyKey, video, "video/mp4");
      const details = { v: 1, fps: 10, size: [W, H], faceFields: "", metricFields: "", metrics: [], frames: Array.from({ length: Math.round(seconds * 10) }, (_, i) => [i / 10, [[1, ...FACE, 0.9, null, null, null, null]]]) };
      const visionKey = `frames/${userId}/vision.json.gz`;
      await writeFile(join(dir, "vision.json.gz"), gzipSync(JSON.stringify(details)));
      await uploadFile(visionKey, join(dir, "vision.json.gz"), "application/gzip");
      const videoId = (await prisma.video.create({ data: { userId, name: "Talk", seconds, width: W, height: H, fps: 30, source: "local", status: "ready", hasAudio: true, proxyKey,
        analysis: { create: { transcriber: "stub", transcript: tr as never, silences: [], sceneCuts: [], keyFrames: [], alignment: alignment as never, vision: { v: 1, size: [W, H], key: visionKey, turned: 0 } as never } } } })).id;
      // A custom graphic: a recorded box over the face.
      const gfx = join(dir, "job-onface.webm");
      await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", `color=black:s=960x540:r=30:d=2,format=rgba,geq=r=255:g=255:b=255:a='if(between(X,${Math.round(FACE[0] * 960)},${Math.round((FACE[0] + FACE[2]) * 960)})*between(Y,${Math.round(FACE[1] * 540)},${Math.round((FACE[1] + FACE[3]) * 540)}),255,0)'`, "-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p", "-auto-alt-ref", "0", gfx]);
      const gKey = `graphics/${userId}/face.webm`;
      await uploadFile(gKey, gfx, "video/webm");
      const graphicId = (await prisma.graphic.create({ data: { ownerId: userId, name: "Face box", kind: "custom", durationSec: 2, width: 960, height: 540, transparent: true, status: "ready", renderedKey: gKey } })).id;
      // The AI-style edit, with the graphic over the face from 1 s.
      const s2 = sentenceStart(1), s3 = sentenceStart(2);
      const chosen: [number, number][] = [[0, 3], [5, s2 + 2], [s3 + 3, words.length - 1]];
      const c2 = { ...ctx, videoId, getGraphic: (id: string) => (id === graphicId ? { id, name: "Face box", durationSec: 2, custom: true } : undefined) } as EditContext;
      const snap0: Snapshot = { timeline: buildRawTimeline(tr, seconds, [], videoId), name: "Check", aspect: "16:9", styleId: null };
      const snap = applyOp(snap0, { op: "batch", ops: [clipsOf(chosen.map(([a, b]) => [edge(a).s, edge(b).e])), { op: "add_graphic", graphicId, start: 1, end: 3, edit: true, params: {} } as EditOp] }, c2).snap;
      const projectId = (await prisma.project.create({ data: { userId, folderId, videoId, name: "Check", timeline: snap.timeline as never, aspect: "16:9", versions: { create: { v: 1, note: "test", timeline: snap as never, createdBy: "claude" } } } })).id;
      const newRender = async () => (await prisma.render.create({ data: { projectId, userId, kind: "preview", version: 1, status: "queued", steps: [...PREVIEW_STEPS], quality: "540p" } })).id;
      const renderId = await newRender();
      const t0 = Date.now();
      await renderJob({ signal: new AbortController().signal, dir, isLastAttempt: true, job: { data: { renderId } } } as unknown as Job);
      const r = await prisma.render.findUniqueOrThrow({ where: { id: renderId } });
      assert.equal(r.status, "done", r.error ?? "");
      const plan = r.plan as { measured: FileMeasure; heard?: HeardTranscript };
      console.log(`preview rendered and measured in ${((Date.now() - t0) / 1000).toFixed(1)} s; graphic ${JSON.stringify(plan.measured.graphics)}; heard ${JSON.stringify(plan.heard)}`);
      assert.ok(plan.measured.sound && !plan.measured.sound.error && plan.measured.sound.speech.length, JSON.stringify(plan.measured.sound));
      const g = plan.measured.graphics[0];
      assert.ok(g.samples! >= 8 && g.visible === g.samples, JSON.stringify(g));
      assert.ok(g.face && g.face.max > 80 && g.face.of === g.samples, JSON.stringify(g.face));
      const check = editCheck(snap, tr, { measured: plan.measured, videoId, aligned: { [videoId]: alignedMap(alignment) } });
      assert.match(check, /^Clipped words \(a cut goes through the word's sound\): none$/m);
      assert.match(check, /Flags: .*graphic "Face box" at 0:01\.0 covers the face \(up to \d+% of it/);
      // The preview's sound transcribed again (queued with a transcription key, else off); here a transcriber that
      // hears exactly the words the edit plays, a little late.
      assert.ok(plan.heard && ["queued", "off"].includes(plan.heard.status), JSON.stringify(plan.heard));
      const said = wordsAsPlayed(sequenceView(snap.timeline, words), () => words, () => false);
      const fake = { name: "fake", transcribe: async () => [said.map((w) => ({ text: w.text, start: w.at + 0.02, end: w.at + 0.3 }))] };
      await heardJob({ signal: new AbortController().signal, dir, isLastAttempt: true, job: { data: { renderId } } } as unknown as Job, fake);
      const heard = ((await prisma.render.findUniqueOrThrow({ where: { id: renderId } })).plan as { heard: HeardTranscript }).heard;
      assert.equal(heard.status, "done");
      assert.equal(heard.words!.length, said.length);
      assert.match(editCheck(snap, tr, { measured: plan.measured, videoId, heard }), /^Heard vs the edit's words: the same \d+ words$/m);
      // Measured from the transcriber's times instead of the sound: no transcriber at all is said as off.
      await heardJob({ signal: new AbortController().signal, dir, isLastAttempt: true, job: { data: { renderId } } } as unknown as Job, null);
      assert.equal(((await prisma.render.findUniqueOrThrow({ where: { id: renderId } })).plan as { heard: HeardTranscript }).heard.status, "off");
      // A newer preview: the older one is not transcribed (skipped).
      const newer = await newRender();
      await prisma.render.update({ where: { id: newer }, data: { status: "done", outputKey: r.outputKey, seconds: r.seconds } });
      await heardJob({ signal: new AbortController().signal, dir, isLastAttempt: true, job: { data: { renderId } } } as unknown as Job, fake);
      assert.equal(((await prisma.render.findUniqueOrThrow({ where: { id: renderId } })).plan as { heard: HeardTranscript }).heard.status, "skipped");
    } finally {
      await deletePrefix(`proxies/${userId}/`).catch(() => {});
      await deletePrefix(`frames/${userId}/`).catch(() => {});
      await deletePrefix(`graphics/${userId}/`).catch(() => {});
      await deletePrefix(`previews/${userId}/`).catch(() => {});
      await prisma.user.deleteMany({ where: { id: userId } });
      await redis().quit().catch(() => {});
    }
  });
});
