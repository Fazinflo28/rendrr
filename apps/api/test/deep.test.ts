// Part 2 through the connector: get_audio, get_waveform_image, get_vision and map_time; get_footage's sound,
// alignment and picture lines; get_project's sound at each V1 clip's edges, and its pages of V1 clips. A video not
// measured yet is measured on first use (the tool says so and how long it takes, and queues the job once an hour).
// Needs a database, Redis and storage (as in .env). Run: pnpm --filter @rendrr/api test
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { gzipSync } from "node:zlib";
import type { Alignment, DeepAudio, Line, Transcript, VisionDetails, VisionSummary, Word } from "@rendrr/shared";

const ready = !!process.env.DATABASE_URL && !!process.env.REDIS_URL;
const run = Math.random().toString(36).slice(2, 8);

let wn = 0;
function line(id: string, start: number, text: string): Line {
  const words: Word[] = text.split(" ").map((w, i) => ({ id: `w${wn++}`, text: w, t: +(start + i * 0.4).toFixed(3), end: +(start + i * 0.4 + 0.3).toFixed(3), filler: false }));
  return { id, start, end: words[words.length - 1].end, gapBefore: 0, words };
}
// 10 s: two lines with a pause between them.
const tr: Transcript = [line("l0", 1, "Hello there my friend."), line("l1", 5, "This is the second line.")];
const words = tr.flatMap((l) => l.words);

const b64 = (xs: number[]) => Buffer.from(Int8Array.from(xs).buffer).toString("base64");
const speaking = (t: number) => tr.some((l) => t >= l.start && t < l.end);
function audioBin(): Buffer {
  const b = Buffer.alloc(1000 * 4);
  for (let i = 0; i < 1000; i++) { const sp = speaking(i / 100), a = sp ? 80 : 1; b[i * 4] = (-a) & 0xff; b[i * 4 + 1] = a; b[i * 4 + 2] = (sp ? -18 : -62) & 0xff; b[i * 4 + 3] = sp ? 240 : 3; }
  return b;
}

describe("deeper measurements through the connector", { skip: !ready && "needs DATABASE_URL and REDIS_URL" }, async () => {
  const { prisma } = await import("@rendrr/db");
  const { createProject } = await import("../src/services/projects");
  const { TOOL_HANDLERS } = await import("../src/tools");
  const { getBytes, putObject, queue, redis, writeDeepProgress } = await import("@rendrr/core");
  const { DEEP_VERSION, PREFIX } = await import("@rendrr/shared");

  let userId = "", videoId = "", fresh = "", projectId = "";
  const c = () => ({ userId, ai: "claude" as const, clerkId: `deep_${run}` });

  before(async () => {
    userId = (await prisma.user.create({ data: { clerkId: `deep_${run}`, email: `deep-${run}@test.rendrr.dev`, name: "Deep" } })).id;
    await prisma.folder.create({ data: { userId, name: "My edits", workspace: "Deep's Workspace" } });
    const base = `${PREFIX.frames}${userId}/`;
    const analysis = (extra: object) => ({ create: { transcriber: "stub", transcript: tr as never, silences: [{ start: 3, end: 5 }] as never, sceneCuts: [], keyFrames: [], ...extra } });
    // A video measured before Part 2: nothing deeper yet.
    fresh = (await prisma.video.create({ data: { userId, name: `Old ${run}`, seconds: 10, width: 1280, height: 720, source: "drive", status: "ready", proxyKey: `proxies/${run}-old.mp4`, analysis: analysis({}) } })).id;
    // A measured one: summary in the database, frames and details in storage.
    videoId = (await prisma.video.create({ data: { userId, name: `Talk ${run}`, seconds: 10, width: 1280, height: 720, fps: 30, source: "drive", status: "ready", proxyKey: `proxies/${run}.mp4`, analysis: analysis({}) } })).id;
    const audio: DeepAudio = {
      v: 1, frameMs: 10, frames: 1000, seconds: 10, layout: "min,max,db,vad", peakDb: -1.5, noiseFloorDb: -64, roomDb: -62, speechDb: -18, lufs: -16.4, truePeakDb: -1.1,
      speech: [[1, 2.5], [5, 7.3]], speechShare: 0.38, onsets: [1, 5], breaths: [[4.2, 4.6, -44, 0.7]], clicks: [[3.5, 28]], clipping: [[6, 6.04, -0.2]],
      rms100: b64(Array.from({ length: 100 }, (_, i) => (speaking(i / 10) ? -18 : -62))), key: `${base}${videoId}/audio.bin`,
    };
    // "friend." starts 120 ms later in the sound than the transcriber says; "line." ends 80 ms earlier.
    const alignment: Alignment = { v: 1, model: "wav2vec2-base-960h", error: null, words: words.map((w) => [w.id, w.text === "friend." ? w.t + 0.12 : w.t, w.text === "line." ? w.end - 0.08 : w.end, 0.9] as [string, number, number, number]), unaligned: [] };
    const vision: VisionSummary = {
      v: 1, fps: 10, metricsEvery: 0.5, size: [640, 360], frames: 100, landmarks: true,
      faces: { present: 0.8, tracks: 1, lost: [[8, 10]], offCamera: [], turns: [], mouthOpenShare: 0.35, medianShare: 0.4 },
      sharpness: { median: 150, soft: [] }, shake: { median: 0.001, shaky: [[2, 3.5]] }, light: { median: 0.5, dark: [], blown: [], skinMedian: 0.6 }, motion: { median: 0.01 },
      safeArea: { face: [0.3, 0.1, 0.7, 0.62], free: { top: [0, 0, 1, 0.1], bottom: [0, 0.62, 1, 1], left: [0, 0, 0.3, 1], right: [0.7, 0, 1, 1] } }, key: `${base}${videoId}/vision.json.gz`,
    };
    const details: VisionDetails = {
      v: 1, fps: 10, size: [640, 360], faceFields: "track,x,y,w,h,score,jawOpen,yaw,pitch,blink", metricFields: "t,brightness,sharpness,motion,shake,skin,colours,contrast",
      frames: Array.from({ length: 100 }, (_, i) => [i / 10, i < 80 ? [[1, 0.42, 0.12, 0.18, 0.4, 0.93, speaking(i / 10) ? 0.5 : 0.05, 3, -4, 0]] : []] as [number, never[]]),
      metrics: Array.from({ length: 20 }, (_, i) => [i / 2, 0.5, 150, 0.01, i >= 4 && i < 7 ? 0.02 : 0.001, i < 16 ? 0.6 : null, ["#202020", "#c09070"], 0.6] as VisionDetails["metrics"][number]),
    };
    await putObject(audio.key!, audioBin(), "application/octet-stream");
    await putObject(vision.key!, gzipSync(JSON.stringify(details)), "application/gzip");
    await prisma.footageAnalysis.update({ where: { videoId }, data: { audio: audio as never, alignment: alignment as never, vision: vision as never, deepVersion: DEEP_VERSION, deepAt: new Date() } });
    projectId = (await createProject(userId, { videoId })).id;
  });
  after(async () => {
    const jobs = await queue("deep").getJobs(["waiting", "prioritized", "delayed"]);
    for (const j of jobs) if (j?.data?.videoId === fresh) await j.remove().catch(() => {});
    await writeDeepProgress(fresh, null);
    await prisma.project.deleteMany({ where: { userId } });
    await prisma.video.deleteMany({ where: { userId } });
    await prisma.user.deleteMany({ where: { id: userId } });
    await queue("deep").close();
    await redis().quit().catch(() => {});
  });

  it("an older video is measured on first use: the tool says so, how long, and queues it once", async () => {
    const r = await TOOL_HANDLERS.get_audio(c(), { videoId: fresh });
    assert.match(r.text, new RegExp(`^"Old ${run}" has no sound-every-10-ms, word-alignment or face measurements yet\\. Measuring it now \\(it is done once, then kept\\)\\. About 30 s; ask again then\\.$`));
    const again = await TOOL_HANDLERS.get_vision(c(), { videoId: fresh });
    assert.match(again.text, /Measuring it now/);
    const jobs = (await queue("deep").getJobs(["waiting", "prioritized", "delayed"])).filter((j) => j?.data?.videoId === fresh);
    assert.equal(jobs.length, 1, "one job an hour, however often it is asked");
    // While it runs: the step, the percent and the time left.
    await writeDeepProgress(fresh, { step: "Aligning the words", percent: 37, etaSec: 95 });
    const busy = await TOOL_HANDLERS.get_audio(c(), { videoId: fresh });
    assert.equal(busy.text, `"Old ${run}" is being measured: aligning the words, 37%, about 2 min left. Ask again then.`);
    // get_footage carries the same note and still reads the rest.
    const f = await TOOL_HANDLERS.get_footage(c(), { videoId: fresh });
    assert.match(f.text, /TRANSCRIPT/);
    assert.match(f.text, /\nDEEPER MEASUREMENTS: "Old \w+" is being measured: aligning the words, 37%/);
    await writeDeepProgress(fresh, null);
    // A failed try says why and tries again.
    await prisma.footageAnalysis.update({ where: { videoId: fresh }, data: { deepError: "The sound could not be read from the preview copy." } });
    const failed = await TOOL_HANDLERS.get_audio(c(), { videoId: fresh });
    assert.match(failed.text, /The last try failed \(The sound could not be read from the preview copy\.\); trying again now\./);
    // Measured by an older version: measured again.
    await prisma.footageAnalysis.update({ where: { videoId: fresh }, data: { deepError: null, deepVersion: DEEP_VERSION - 1 } });
    const older = await TOOL_HANDLERS.get_audio(c(), { videoId: fresh });
    assert.equal(older.text, `"Old ${run}" was measured by an older version of Rendrr; measuring it again now. About 30 s; ask again then.`);
  });

  it("get_audio: the whole video, the range, and the series every step", async () => {
    const r = await TOOL_HANDLERS.get_audio(c(), { videoId, from: 0, to: 10, step: 1 });
    assert.match(r.text, new RegExp(`^AUDIO "Talk ${run}" 0-10s .*Loudness -16\\.4 LUFS, true peak -1\\.1 dBTP`));
    assert.match(r.text, /\nSPEECH regions \(Silero VAD\) 2: 1-2\.5, 5-7\.3\n/);
    assert.match(r.text, /\nBREATHS 1 \(start-end level confidence\): 4\.2-4\.6 -44dB 0\.7\n/);
    assert.match(r.text, /\nCLICKS 1 .*: 3\.5 28dB\n/);
    assert.match(r.text, /\nCLIPPING 1 .*: 6-6\.04 -0\.2dB\n/);
    assert.match(r.text, /\nLOUDNESS dBFS every 1s from 0s \(10\): -62 -18 -21 -62 -62 -18 -18 -62 -62 -62\n/);
    const part = await TOOL_HANDLERS.get_audio(c(), { videoId, from: 4, to: 5, step: 0.5, peaks: true });
    assert.match(part.text, /\nBREATHS 1/);
    assert.match(part.text, /\nCLICKS 0/);
    assert.match(part.text, /\nPEAKS min\/max of full scale every 0\.5s: -0\.01\/0\.01 -0\.01\/0\.01$/);
    await assert.rejects(TOOL_HANDLERS.get_audio(c(), { videoId, from: 6, to: 5 }), /from must be before to/);
  });

  it("get_waveform_image: a PNG of the range with what it shows, and the words in it", async () => {
    const r = await TOOL_HANDLERS.get_waveform_image(c(), { videoId, from: 0.5, to: 3, width: 500, height: 120 });
    assert.match(r.text, /^WAVEFORM "Talk \w+" 0\.5-3s as 500x120: x = 0\.5 \+ pixel x 0\.00500s \(200\.0 px a second\)/);
    assert.match(r.text, /short ones every 0\.1 s/);
    // In the sound: "friend." starts 120 ms after the transcriber's time.
    assert.match(r.text, /WORDS in range \(id text start-end in the sound\): w0 Hello 1\.000-1\.300, w1 there 1\.400-1\.700, w2 my 1\.800-2\.100, w3 friend\. 2\.320-2\.500/);
    assert.equal(r.images?.length, 1);
    const png = await getBytes(`${PREFIX.frames}${userId}/${videoId}/wave-500-3000-500x120.png`);
    assert.deepEqual([...png.subarray(1, 4)], [0x50, 0x4e, 0x47]);
    assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [500, 120]);
  });

  it("get_vision: summary, stretches, rows every 0.5 s; faces at 10 fps on request", async () => {
    const r = await TOOL_HANDLERS.get_vision(c(), { videoId, from: 1.5, to: 3 });
    assert.match(r.text, /Faces at 10 fps with mouth and head pose \(MediaPipe\)/);
    assert.match(r.text, /\nFACE LOST \(no face 0\.5s\+\): none\n/); // 8-10 is outside the range
    assert.match(r.text, /\nSHAKY \(camera jitter 1s\+\): 2-3\.5\n/);
    assert.match(r.text, /\n2 \| 0\.5 150 0\.01 0\.02 0\.6 \| #202020 #c09070 \| #1 0\.42,0\.12 0\.18x0\.4 mouth 0\.5 yaw 3\n/);
    assert.doesNotMatch(r.text, /FACES every/);
    const all = await TOOL_HANDLERS.get_vision(c(), { videoId, from: 7.8, to: 8.2, faces: true });
    assert.match(all.text, /\nFACES every 0\.1s .*\n7\.8: #1 0\.42,0\.12 0\.18x0\.4 0\.93 0\.05 3 -4 0\n7\.9: #1 .*\n8: none\n/);
  });

  it("get_footage: the sound, the alignment and the picture in a few lines; detail words lists the words that moved", async () => {
    const r = await TOOL_HANDLERS.get_footage(c(), { videoId });
    assert.match(r.text, /\nSOUND \(get_audio\): -16\.4 LUFS, true peak -1\.1 dBTP, room -62 dBFS, voice -18 dBFS, speech 38%; 1 breaths, 1 clicks, 1 clipped stretches\./);
    assert.match(r.text, /\nALIGNMENT \(wav2vec2, then moved onto the sound\): 9 of 9 words placed in the sound; 2 differ from the transcriber's times by more than 60 ms\. detail "words" lists them\. Cut on the sound's times\./);
    assert.match(r.text, /\nPICTURE \(get_vision\): face on screen 80%, lost 1x, looking away 0x, soft 0x, shaky 1x, dark 0x, blown out 0x\./);
    const wd = await TOOL_HANDLERS.get_footage(c(), { videoId, detail: "words" });
    assert.match(wd.text, /\nWORDS IN THE SOUND \(id text start-end, transcriber's a-b\): w3 friend\. 2\.320-2\.500 \(2\.200-2\.500\), w8 line\. 6\.600-6\.820 \(6\.600-6\.900\)(\n|$)/);
    // With from/to: only the words in that range.
    const part = await TOOL_HANDLERS.get_footage(c(), { videoId, detail: "words", from: 5, to: 8 });
    assert.match(part.text, /\nWORDS IN THE SOUND in 5-8s \(id text start-end, transcriber's a-b\): w8 line\. 6\.600-6\.820 \(6\.600-6\.900\)(\n|$)/);
  });

  it("map_time: edit seconds to footage and back; a cut moment says it is cut and where the edit goes on", async () => {
    // Cut the pause between the lines (2.5-5): the second line now plays from 2.5 in the edit.
    await TOOL_HANDLERS.apply_edits(c(), { projectId, edits: [{ op: "cut_words", from: 2.5, to: 5 }] });
    const r = await TOOL_HANDLERS.map_time(c(), { projectId, editTimes: [1, 3, 99], footage: [{ t: 5.5 }, { t: 4 }] });
    const lines = r.text.split("\n");
    assert.match(lines[0], /^TIME in edit "[^"]+": the edit is 7\.500s long\.$/);
    assert.match(lines[1], new RegExp(`^edit 1s = clip \\S+, video main "Talk ${run}" at 1s$`));
    assert.match(lines[2], new RegExp(`^edit 3s = clip \\S+, video main "Talk ${run}" at 5\\.5s$`));
    assert.equal(lines[3], "edit 99s: after the end of the edit");
    assert.match(lines[4], /^video main 5\.5s plays at edit 3s \(clip \S+\)$/);
    assert.equal(lines[5], "video main 4s is not in the edit (cut); the next moment that plays is at edit 2.500s");
  });

  it("get_project: each V1 clip's sound at its edges, from the alignment; pages of clips", async () => {
    const r = await TOOL_HANDLERS.get_project(c(), { projectId });
    // Clip 1 is 0-2.5: the first word at 1.0, the last ("friend.") ends at 2.5 in the sound.
    assert.match(r.text, /\n {2}\S+ main 0\.00-2\.50 @0\.00-2\.50 "[^"]*" \| 1\.00s before the first word; 0\.00s after the last\n/);
    // Clip 2 is 5-10: "line." ends at 6.82 in the sound (6.9 by the transcriber).
    assert.match(r.text, /\n {2}\S+ main 5\.00-10\.00 @2\.50-7\.50 "[^"]*" \| 0\.00s before the first word; 3\.18s after the last\n/);
    const page = await TOOL_HANDLERS.get_project(c(), { projectId, clipsFrom: 1, clipsLimit: 1 });
    assert.match(page.text, /V1 sequence \(clips 2-2 of 2\):\n {2}\S+ main 5\.00-10\.00 /);
    const first = await TOOL_HANDLERS.get_project(c(), { projectId, clipsLimit: 1 });
    assert.match(first.text, /V1 sequence \(clips 1-1 of 2\):\n.*\n {2}…1 more: clipsFrom 1/);
  });
});
