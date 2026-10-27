// Part 2: the deeper measurements as the tools read them: the 10 ms sound frames, word edges in the sound, clip edges,
// the text of get_audio and get_vision, and the marks they make (breaths, clicks, clipping, soft, face lost, looking away).
import { describe, expect, it } from "vitest";
import {
  alignedMap, alignmentDiffs, audioFrames, audioSeries, b64ToInt8, clipEdges, deepAudioText, deepMarks, footageMarks, levelDb, silenceMarks, visionText,
  type Alignment, type DeepAudio, type FootageInput, type Transcript, type VisionDetails, type VisionSummary, type Word,
} from "../src/index";

const b64 = (xs: number[]) => Buffer.from(Int8Array.from(xs).buffer).toString("base64");

// 4 s of sound: room tone at -60 dBFS, speech at -20 from 1.0 to 3.0, a click at 0.5 inside the quiet.
const rms100 = Array.from({ length: 40 }, (_, i) => (i >= 10 && i < 30 ? -20 : i === 5 ? -30 : -60));
const audio: DeepAudio = {
  v: 1, frameMs: 10, frames: 400, seconds: 4, layout: "min,max,db,vad",
  peakDb: -3, noiseFloorDb: -62, roomDb: -60, speechDb: -20, lufs: -18.2, truePeakDb: -2.4,
  speech: [[1, 3]], speechShare: 0.5, onsets: [1.0],
  breaths: [[0.6, 0.9, -45, 0.8]], clicks: [[0.5, 32]], clipping: [[2.0, 2.05, -0.1]],
  rms100: b64(rms100), key: "frames/u/v/audio.bin",
};

function frames(): Uint8Array {
  const buf = new Uint8Array(400 * 4);
  for (let i = 0; i < 400; i++) {
    const sp = i >= 100 && i < 300;
    const a = sp ? 64 : 1;
    buf[i * 4] = (-a) & 0xff; buf[i * 4 + 1] = a; buf[i * 4 + 2] = (sp ? -20 : -60) & 0xff; buf[i * 4 + 3] = sp ? 230 : 5;
  }
  return buf;
}

const w = (id: string, text: string, t: number, end: number): Word => ({ id, text, t, end, filler: false });
const words = [w("w0", "Hello", 1.0, 1.4), w("w1", "there", 1.45, 1.9), w("w2", "friend.", 2.6, 3.0)];
const tr: Transcript = [{ id: "l0", start: 1, end: 3, gapBefore: 0, words }];
const alignment: Alignment = { v: 1, model: "wav2vec2", error: null, words: [["w0", 1.02, 1.38, 0.9], ["w1", 1.45, 1.99, 0.8], ["w2", 2.7, 2.98, 0.7]], unaligned: [] };

const vision: VisionSummary = {
  v: 1, fps: 10, metricsEvery: 0.5, size: [640, 360], frames: 40, landmarks: true,
  faces: { present: 0.75, tracks: 1, lost: [[3, 4]], offCamera: [[1.5, 2.2, 38]], turns: [[1.4, 2.0, 2, 38]], mouthOpenShare: 0.4, medianShare: 0.42 },
  sharpness: { median: 120, soft: [[0.5, 1.5]] }, shake: { median: 0.001, shaky: [] },
  light: { median: 0.45, dark: [[3.5, 4]], blown: [], skinMedian: 0.55 }, motion: { median: 0.02 },
  safeArea: { face: [0.35, 0.1, 0.65, 0.6], free: { top: [0, 0, 1, 0.1], bottom: [0, 0.6, 1, 1], left: [0, 0, 0.35, 1], right: [0.65, 0, 1, 1] } },
  key: "frames/u/v/vision.json.gz",
};
const details: VisionDetails = {
  v: 1, fps: 10, size: [640, 360], faceFields: "track,x,y,w,h,score,jawOpen,yaw,pitch,blink",
  frames: [[0, [[1, 0.4, 0.1, 0.2, 0.4, 0.95, 0.1, 2, -3, 0]]], [0.5, [[1, 0.41, 0.1, 0.2, 0.4, 0.94, 0.6, 5, -2, 0]]], [3.5, []]],
  metricFields: "t,brightness,sharpness,motion,shake,skin,colours,contrast",
  metrics: [[0, 0.45, 130, 0.01, 0.001, 0.55, ["#202020", "#d0a080"], 0.6], [0.5, 0.44, 40, 0.02, 0.001, 0.54, ["#202020"], 0.6], [3.5, 0.1, 20, 0, 0, null, ["#050505"], 0.1]],
};

describe("the sound every 10 ms", () => {
  it("reads the 100 ms levels; a pause's level is its median, so a click in it does not make it loud", () => {
    expect(Array.from(b64ToInt8(audio.rms100)).slice(4, 7)).toEqual([-60, -30, -60]);
    expect(levelDb(audio, 0, 1)).toBe(-60);
    expect(levelDb(audio, 1, 3)).toBe(-20);
    expect(levelDb(audio, 10, 11)).toBeNull();
  });
  it("unpacks audio.bin and sums it into steps (energy mean, peaks, speech probability)", () => {
    const f = audioFrames(frames());
    expect(f.n).toBe(400);
    expect([f.min[150], f.max[150], f.db[150], f.vad[150]]).toEqual([-64, 64, -20, 230]);
    const s = audioSeries(f, 0.5, 1.5, 0.5);
    expect(s).toMatchObject({ t0: 0.5, step: 0.5, db: [-60, -20], vad: [0.02, 0.9] });
    expect(s.max).toEqual([0.01, 0.5]);
    // Half quiet, half loud: the energy mean sits 3 dB under the loud half.
    expect(audioSeries(f, 0.75, 1.25, 0.5).db).toEqual([-23]);
  });
  it("get_audio as text: the whole video, then what happens in the range, then the series", () => {
    const t = deepAudioText(audio, { name: "Talk", from: 0, to: 4, frames: audioFrames(frames()), step: 1, peaks: true });
    expect(t).toContain("-18.2 LUFS, true peak -2.4 dBTP");
    expect(t).toContain("Room -60 dBFS");
    expect(t).toContain("SPEECH regions (Silero VAD) 1: 1-3");
    expect(t).toContain("BREATHS 1 (start-end level confidence): 0.6-0.9 -45dB 0.8");
    expect(t).toContain("CLICKS 1 (time, dB over the sound around it): 0.5 32dB");
    expect(t).toContain("CLIPPING 1 (start-end, peak dBFS; flat tops near full scale): 2-2.05 -0.1dB");
    expect(t).toContain("LOUDNESS dBFS every 1s from 0s (4): -60 -20 -20 -60");
    expect(t).toMatch(/PEAKS min\/max of full scale every 1s: -0\.01\/0\.01 -0\.5\/0\.5/);
    // A range leaves out what happens outside it.
    expect(deepAudioText(audio, { name: "Talk", from: 2.5, to: 4 })).toContain("BREATHS 0 (start-end level confidence): none");
  });
});

describe("word edges in the sound", () => {
  it("lists the words whose edges moved more than 60 ms", () => {
    const m = alignedMap(alignment);
    expect(m.get("w1")).toEqual({ s: 1.45, e: 1.99, c: 0.8 });
    expect(alignmentDiffs(alignment, words).map((d) => d.id)).toEqual(["w1", "w2"]);
    expect(alignmentDiffs(null, words)).toEqual([]);
  });
  it("notes a clip's sound at its edges: time before the first word and after the last, a word cut into, pauses", () => {
    const m = alignedMap(alignment);
    expect(clipEdges({ sourceIn: 0.8, sourceOut: 3.2 }, words, m)).toBe("0.22s before the first word; 0.22s after the last; 1 pause over 0.3s inside (longest 0.71s at 1.99s)");
    // In the transcript "friend." starts at 2.6; in the sound at 2.7: a cut at 2.65 does not cut into it.
    expect(clipEdges({ sourceIn: 2.65, sourceOut: 3.1 }, words, m)).toBe("0.05s before the first word; 0.12s after the last");
    expect(clipEdges({ sourceIn: 2.65, sourceOut: 3.1 }, words, new Map())).toBe('cuts into "friend." at the start (50ms of it lost); 0.10s after the last');
    expect(clipEdges({ sourceIn: 1.2, sourceOut: 1.9 }, words, m)).toBe('cuts into "Hello" at the start (180ms of it lost); cuts into "there" at the end (90ms lost)');
    expect(clipEdges({ sourceIn: 3.5, sourceOut: 4 }, words, m)).toBe("no words");
  });
});

describe("the picture", () => {
  it("get_vision as text: summary, stretches in range, rows every 0.5 s, faces at 10 fps on request", () => {
    const t = visionText(vision, { name: "Talk", from: 0, to: 4, details, faces: true });
    expect(t).toContain("Faces at 10 fps with mouth and head pose (MediaPipe)");
    expect(t).toContain("FACES on screen 75% of the time, 1 track, main face 42% of the frame height, mouth open 40% of the time.");
    expect(t).toContain("FACE LOST (no face 0.5s+): 3-4");
    expect(t).toContain("LOOKING AWAY (head turned over 30 degrees 0.5s+, max yaw): 1.5-2.2 38deg");
    expect(t).toContain("SOFT (out of focus 1s+): 0.5-1.5");
    expect(t).toContain("DARK: 3.5-4");
    expect(t).toContain("free for text: top 0-0.1, below the face 0.6-1");
    expect(t).toContain("0.5 | 0.44 40 0.02 0.001 0.54 | #202020 | #1 0.41,0.1 0.2x0.4 mouth 0.6 yaw 5");
    expect(t).toContain("3.5 | 0.1 20 0 0 - | #050505 | no face");
    expect(t).toContain("0: #1 0.4,0.1 0.2x0.4 0.95 0.1 2 -3 0");
    expect(visionText(vision, { name: "Talk", from: 0, to: 1, details })).not.toContain("FACES every");
  });
});

describe("marks from the deeper measurements", () => {
  const f: FootageInput = { videoId: "vidXY99", transcript: tr, silences: [{ start: 0, end: 1 }], sceneCuts: [], dark: [{ start: 0, end: 0.5 }], duration: 4, audio, vision };
  it("breaths, clicks, clipping, soft, face lost, looking away and dark, with stable ids", () => {
    const m = deepMarks(f);
    const by = (k: string) => m.filter((x) => x.kind === k);
    expect(by("breath")[0]).toMatchObject({ id: "br_600_XY99", start: 0.6, end: 0.9, confidence: 0.8, level_db: -45 });
    expect(by("click_pop")[0]).toMatchObject({ id: "ck_500_XY99", start: 0.5, end: 0.505, confidence: 0.8 });
    expect(by("clipped_audio")[0]).toMatchObject({ id: "cl_2000_XY99", label: "flat tops at -0.1 dBFS" });
    expect(by("out_of_focus")[0]).toMatchObject({ start: 0.5, end: 1.5 });
    expect(by("face_lost")[0]).toMatchObject({ start: 3, end: 4 });
    expect(by("off_camera")[0]).toMatchObject({ label: "looking away (38 degrees)" });
    expect(by("low_light")[0]).toMatchObject({ start: 3.5, end: 4, label: "dark picture" });
  });
  it("the picture measured every 0.5 s replaces the breakdown's dark shots", () => {
    const dark = footageMarks(f).filter((m) => m.kind === "low_light");
    expect(dark.map((m) => [m.start, m.end])).toEqual([[3.5, 4]]);
    expect(footageMarks({ ...f, vision: undefined }).filter((m) => m.kind === "low_light").map((m) => [m.start, m.end])).toEqual([[0, 0.5]]);
  });
  it("a silence's level comes from the measured sound when there is one", () => {
    const first = silenceMarks(f)[0];
    expect(first).toMatchObject({ start: 0, end: 1, level_db: -60, confidence: 0.95 });
    // Without the measured sound: -35 where silencedetect found it quiet.
    expect(silenceMarks({ ...f, audio: undefined })[0]).toMatchObject({ level_db: -35, confidence: 0.95 });
  });
});
