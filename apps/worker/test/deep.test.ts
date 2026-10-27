// Engine Part 2: the deeper measurements. A test video with known events (synthetic speech, a pause with a breath and a
// click, a clipped tone; a face that leaves the frame, a shaky stretch, a dark end) is measured by the worker's job,
// and every event is found where it was put. The aligner's parts are checked on numbers too: the CTC path on a known
// emission matrix, and a word edge moved onto the sound. Needs ffmpeg, espeak-ng, Python with OpenCV, onnxruntime and
// mediapipe (PYTHON_BIN), and for the job a database and storage (as in .env).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { after, before, describe, it } from "node:test";
import type { Job } from "bullmq";
import { audioFrames, footageMarks, footageInputOf, levelDb, type Alignment, type DeepAudio, type Transcript, type VisionDetails, type VisionSummary } from "@rendrr/shared";

const here = dirname(fileURLToPath(import.meta.url));
const PY = process.env.PYTHON_BIN || "python3";
const has = (cmd: string, args: string[]) => { try { execFileSync(cmd, args, { stdio: "ignore" }); return true; } catch { return false; } };
const pyOk = has(PY, ["-c", "import cv2, onnxruntime, mediapipe, numpy"]);
const espeak = has("espeak-ng", ["--version"]);
const db = !!process.env.DATABASE_URL && !!process.env.S3_BUCKET && !!process.env.REDIS_URL;
const run6 = Math.random().toString(36).slice(2, 8);

describe("the aligner's parts", { skip: !pyOk && "needs Python with numpy" }, () => {
  const py = (code: string) => execFileSync(PY, ["-c", `import sys; sys.path.insert(0, ${JSON.stringify(join(here, "../python"))})\n${code}`]).toString().trim();
  it("the CTC path puts each token on the frames it is said on, blanks around it left out", () => {
    const out = py(`
import numpy as np, align
lab=[0,0,0,1,1,1,0,2,2,0,0,0,3,4,4,0,0,0,0,0]
em=np.full((len(lab),5),np.log(0.02))
for t,l in enumerate(lab): em[t,l]=np.log(0.9)
print([s[:2] for s in align.token_spans(align.viterbi(em,[1,2,3,4]),4)])
print(align.viterbi(em[:3],[1,2,3,4]))`);
    assert.equal(out, "[(3, 6), (7, 9), (12, 13), (13, 15)]\nNone");
  });
  it("a word's edges move onto the sound, within limits and never across a neighbour", () => {
    const out = py(`
import numpy as np, align
db=np.full(400,-60.0); db[100:150]=-20; db[148:152]=-50; db[152:200]=-22
print(align.snap([['a','x',1.06,1.40],['b','y',1.45,2.10]],[(1.06,1.40),(1.45,2.10)],db,-60.0))`);
    // a starts where the sound does (1.00); a and b touch, so their boundary goes into the dip between them
    // (1.48-1.52); b ends where the sound falls back (2.00, the transcriber said 2.10).
    assert.equal(out, "[['a', 1.0, 1.48], ['b', 1.52, 2.0]]");
  });
});

describe("the deeper measurements job", { skip: (!pyOk || !espeak) && "needs espeak-ng and Python with OpenCV, onnxruntime and mediapipe" }, () => {
  let dir = "", video = "";
  // Where things are in the test video (seconds), worked out while making it.
  const at = { s1: 0, s1End: 0, breath: 0, s2: 0, s2End: 0, click: 0, tone: 0, total: 0 };
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "deep-"));
    execFileSync("espeak-ng", ["-v", "en-us", "-s", "150", "-w", join(dir, "s1.wav"), "Today we are going to build a website from scratch."]);
    execFileSync("espeak-ng", ["-v", "en-us", "-s", "150", "-w", join(dir, "s2.wav"), "It is really easy if you follow along."]);
    const made = execFileSync(PY, ["-c", `
import numpy as np, wave, json, sys
d=sys.argv[1]
def read(p):
    w=wave.open(p); sr=w.getframerate(); return np.frombuffer(w.readframes(w.getnframes()),np.int16).astype(np.float32)/32768, sr
s1,sr=read(d+"/s1.wav"); s2,_=read(d+"/s2.wav")
rng=np.random.default_rng(1)
room=lambda t:(rng.standard_normal(int(t*sr))*0.001).astype(np.float32)
breath=(rng.standard_normal(int(0.35*sr))*0.02*np.hanning(int(0.35*sr))).astype(np.float32)
tone=(0.6*np.sin(2*np.pi*220*np.arange(int(0.5*sr))/sr)).astype(np.float32)
x=np.concatenate([room(0.5),s1,room(1.2),breath,room(0.3),s2,room(1.0),tone,room(1.0)])
at={"s1":0.5,"s1End":0.5+len(s1)/sr}
at["breath"]=at["s1End"]+1.2; at["s2"]=at["breath"]+0.35+0.3; at["s2End"]=at["s2"]+len(s2)/sr; at["tone"]=at["s2End"]+1.0
ci=int((at["s1End"]+0.6)*sr); x[ci]=0.6; x[ci+1]=-0.5; at["click"]=ci/sr
ti=int(at["tone"]*sr); x[ti:ti+int(0.5*sr)]=np.clip(x[ti:ti+int(0.5*sr)]*2.5,-1,1)
at["total"]=len(x)/sr
w=wave.open(d+"/test.wav","wb"); w.setnchannels(1); w.setsampwidth(2); w.setframerate(sr); w.writeframes((np.clip(x,-1,1)*32767).astype(np.int16).tobytes()); w.close()
print(json.dumps(at))`, dir]).toString();
    Object.assign(at, JSON.parse(made.trim().split("\n").pop()!));
    // The picture: the portrait (a face) on a grey frame; it leaves from 3 to 5 s, shakes from 6 to 8 s, dark from 9 s.
    video = join(dir, "talk.mp4");
    execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", `color=0x506070:s=1280x720:r=30:d=${at.total.toFixed(3)}`, "-i", join(here, "fixtures/astronaut.jpg"), "-i", join(dir, "test.wav"),
      "-filter_complex", "[1:v]scale=600:600[f];[0:v][f]overlay=x='340+if(between(t,6,8),30*sin(t*40),0)':y='60+if(between(t,6,8),25*cos(t*53),0)':enable='lt(t,3)+gte(t,5)',eq=brightness='if(gte(t,9),-0.45,0)':eval=frame,format=yuv420p[v]",
      "-map", "[v]", "-map", "2:a", "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-b:a", "192k", "-shortest", video]);
  });
  after(async () => { await rm(dir, { recursive: true, force: true }); });

  it("measures the sound, aligns the words and watches the picture; the marks come from them", { skip: !db && "needs a database, Redis and storage", timeout: 240_000 }, async () => {
    const { prisma } = await import("@rendrr/db");
    const { deletePrefix, downloadFile, readDeepProgress, redis, uploadFile } = await import("@rendrr/core");
    const { deepJob, deepFailed, queueMissingDeep } = await import("../src/jobs/deep");
    const userId = (await prisma.user.create({ data: { clerkId: `deep_${run6}`, email: `deep-${run6}@test.rendrr.dev`, name: "Deep" } })).id;
    try {
      const proxyKey = `proxies/${userId}/talk.mp4`;
      await uploadFile(proxyKey, video, "video/mp4");
      // A transcriber's words: each sentence spread evenly over its speech, the first word 60 ms late.
      const words = (text: string, s: number, e: number, from: number) => text.split(" ").map((w, i, a) => ({ id: `w${from + i}`, text: w, t: +(s + 0.06 + ((e - s - 0.3) * i) / a.length).toFixed(3), end: +(s + 0.06 + ((e - s - 0.3) * (i + 0.85)) / a.length).toFixed(3), filler: false }));
      const w1 = words("Today we are going to build a website from scratch.", at.s1, at.s1End, 0), w2 = words("It is really easy if you follow along.", at.s2, at.s2End, 20);
      const transcript: Transcript = [{ id: "l0", start: w1[0].t, end: w1.at(-1)!.end, gapBefore: 0, words: w1 }, { id: "l1", start: w2[0].t, end: w2.at(-1)!.end, gapBefore: 1, words: w2 }];
      const videoId = (await prisma.video.create({ data: { userId, name: "Talk", seconds: at.total, width: 1280, height: 720, source: "local", status: "ready", hasAudio: true, proxyKey, analysis: { create: { transcriber: "stub", transcript: transcript as never, silences: [], sceneCuts: [], keyFrames: [] } } } })).id;

      // The backfill finds it (never measured).
      assert.ok((await queueMissingDeep()) >= 1);
      let seen: string[] = [];
      const poll = setInterval(async () => { const p = await readDeepProgress(videoId); if (p && !seen.includes(p.step)) seen = [...seen, p.step]; }, 150);
      const t0 = Date.now();
      await deepJob({ signal: new AbortController().signal, dir, isLastAttempt: true, job: { data: { videoId } } } as unknown as Job);
      clearInterval(poll);
      console.log(`measured ${at.total.toFixed(1)}s of footage in ${((Date.now() - t0) / 1000).toFixed(1)}s; steps seen: ${seen.join(" > ")}`);
      assert.equal(await readDeepProgress(videoId), null, "progress is cleared when done");
      assert.ok(seen.length >= 2, `progress was reported (${seen.join(", ")})`);

      const an = await prisma.footageAnalysis.findUniqueOrThrow({ where: { videoId } });
      assert.equal(an.deepVersion, 1);
      assert.equal(an.deepError, null);
      const audio = an.audio as unknown as DeepAudio, al = an.alignment as unknown as Alignment, vision = an.vision as unknown as VisionSummary;
      console.log(JSON.stringify({ speech: audio.speech, breaths: audio.breaths, clicks: audio.clicks, clipping: audio.clipping, lufs: audio.lufs, tp: audio.truePeakDb, room: audio.roomDb }));

      // The sound: two stretches of speech, the breath, the click and the clipped tone where they were put.
      assert.equal(audio.speech.length, 2);
      assert.ok(Math.abs(audio.speech[0][0] - at.s1) < 0.25 && Math.abs(audio.speech[1][0] - at.s2) < 0.25, JSON.stringify(audio.speech));
      assert.ok(audio.speech.every(([s, e]) => e < at.tone), "the tone is not speech");
      assert.equal(audio.breaths.length, 1);
      assert.ok(audio.breaths[0][0] >= at.breath - 0.05 && audio.breaths[0][1] <= at.breath + 0.4, JSON.stringify(audio.breaths));
      assert.equal(audio.clicks.length, 1);
      assert.ok(Math.abs(audio.clicks[0][0] - at.click) < 0.005, JSON.stringify(audio.clicks));
      assert.equal(audio.clipping.length, 1);
      assert.ok(Math.abs(audio.clipping[0][0] - at.tone) < 0.05, JSON.stringify(audio.clipping));
      assert.ok(typeof audio.lufs === "number" && typeof audio.truePeakDb === "number");
      // The 10 ms frames in storage match the summary, and the levels read from the summary are the room's in a pause.
      const bin = join(dir, "audio-check.bin");
      await downloadFile(audio.key!, bin);
      const fr = audioFrames(new Uint8Array(await readFile(bin)));
      assert.equal(fr.n, audio.frames);
      assert.ok(Math.abs(fr.n * 0.01 - at.total) < 0.15, `${fr.n} frames for ${at.total}s`); // AAC pads the sound a little
      const pause = levelDb(audio, at.s1End + 0.2, at.s1End + 0.5)!;
      assert.ok(Math.abs(pause - audio.roomDb) < 4, `pause ${pause} dB, room ${audio.roomDb} dB`);

      // The words: every word has its edges in the sound; the first word's start moves from 60 ms late onto the speech.
      assert.equal(al.words.length, w1.length + w2.length);
      const first = al.words.find((x) => x[0] === "w0")!;
      assert.ok(first[1] < w1[0].t && Math.abs(first[1] - audio.speech[0][0]) < 0.08, `w0 ${w1[0].t} -> ${first[1]} (speech from ${audio.speech[0][0]})`);

      // The picture: the face leaves from 3 to 5 s, the shake from 6 to 8 s, the dark end.
      assert.ok(vision.faces.present > 0.6 && vision.faces.present < 0.9, String(vision.faces.present));
      assert.ok(vision.faces.lost.some(([s, e]) => Math.abs(s - 3) < 0.2 && Math.abs(e - 5) < 0.2), JSON.stringify(vision.faces.lost));
      assert.ok(vision.shake.shaky.some(([s, e]) => s >= 5.9 && s <= 6.6 && e >= 7.8 && e <= 8.3), JSON.stringify(vision.shake.shaky));
      assert.ok(vision.light.dark.some(([s, e]) => Math.abs(s - 9) < 0.3 && e <= at.total + 0.1), JSON.stringify(vision.light.dark));
      assert.equal(vision.sharpness.soft.length, 0, "a plain or dark frame is not out of focus");
      assert.ok(vision.safeArea && vision.safeArea.face[0] > 0.3 && vision.safeArea.face[2] < 0.7, JSON.stringify(vision.safeArea));
      const gz = join(dir, "vision-check.json.gz");
      await downloadFile(vision.key!, gz);
      const details = JSON.parse(gunzipSync(await readFile(gz)).toString()) as VisionDetails;
      assert.ok(Math.abs(details.frames.length - Math.round(at.total * 10)) <= 2);
      const withFace = details.frames.find(([t, fs]) => t > 1 && fs.length)!;
      assert.ok(withFace[1][0][6] != null && withFace[1][0][7] != null, "mouth and head pose are read");

      // The marks: breath, click, clipping, face lost, dark; silences carry their measured level.
      const marks = footageMarks(footageInputOf(videoId, an, at.total));
      for (const k of ["breath", "click_pop", "clipped_audio", "face_lost", "low_light"]) assert.ok(marks.some((m) => m.kind === k), `a ${k} mark`);
      const gap = marks.find((m) => m.kind === "silence" && m.label === "between words" && m.end - m.start > 1)!;
      assert.ok(gap.level_db != null && gap.level_db < -40, JSON.stringify(gap));

      // Queued again (the backfill and a tool's first use): not measured twice; force (after a new analysis) measures again.
      const at1 = an.deepAt!.getTime();
      await deepJob({ signal: new AbortController().signal, dir, isLastAttempt: true, job: { data: { videoId } } } as unknown as Job);
      assert.equal((await prisma.footageAnalysis.findUniqueOrThrow({ where: { videoId } })).deepAt!.getTime(), at1, "already measured: skipped");

      // A failure is kept on the analysis for the tools to say.
      await deepFailed(videoId, "Measuring the footage took too long. Try again.");
      assert.equal((await prisma.footageAnalysis.findUniqueOrThrow({ where: { videoId } })).deepError, "Measuring the footage took too long. Try again.");
    } finally {
      await deletePrefix(`proxies/${userId}/`).catch(() => {});
      await deletePrefix(`frames/${userId}/`).catch(() => {});
      await prisma.user.deleteMany({ where: { id: userId } });
      await redis().quit().catch(() => {});
    }
  });
});
