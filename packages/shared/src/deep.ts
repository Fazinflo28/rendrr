// The deeper measurements of a video (Engine Part 2), shared by the worker that makes them and the tools that read
// them: the sound every 10 ms (a summary in the database, the frames in storage), where each word starts and ends in
// the sound, and what the picture does (faces 10 times a second, motion, shake, sharpness and light every 0.5 s).
// Measurements only: what to do with them is the AI's call.
import type { Word } from "./transcript";

/** Bumped when the measurements change: older videos are measured again on first use (and by the backfill). */
export const DEEP_VERSION = 1;

export type DeepAudio = {
  v: number; frameMs: number; frames: number; seconds: number; layout: string;
  /** Sample peak (dBFS), the quietest usual level (10th percentile with no speech), the room (median with no speech), the voice (median). */
  peakDb: number; noiseFloorDb: number; roomDb: number; speechDb: number;
  /** Integrated loudness and true peak of the preview copy's sound (ffmpeg ebur128). */
  lufs?: number | null; truePeakDb?: number | null;
  speech: [number, number][]; speechShare: number;
  onsets: number[];
  /** [start, end, level dBFS, confidence 0-1] */
  breaths: [number, number, number, number][];
  /** [time, dB over the high frequencies around it] */
  clicks: [number, number][];
  /** [start, end, peak dBFS]: flat tops near full scale */
  clipping: [number, number, number][];
  /** Loudness every 100 ms, int8 dBFS, base64. */
  rms100: string;
  /** Storage key of the 10 ms frames (audio.bin). */
  key?: string;
};

export type Alignment = {
  v: number; model: string | null; error: string | null; seconds?: number;
  /** [word id, start in the sound, end in the sound, model confidence or null] */
  words: [string, number, number, number | null][];
  unaligned: string[];
};

export type VisionSummary = {
  v: number; fps: number; metricsEvery: number; size: [number, number]; frames: number; landmarks: boolean;
  faces: { present: number; tracks: number; lost: [number, number][]; offCamera: [number, number, number | null][]; turns: [number, number, number, number][]; mouthOpenShare: number | null; medianShare: number | null };
  sharpness: { median: number; soft: [number, number][] };
  shake: { median: number; shaky: [number, number][] };
  light: { median: number | null; dark: [number, number][]; blown: [number, number][]; skinMedian: number | null };
  motion: { median: number };
  safeArea: { face: [number, number, number, number]; free: Record<"top" | "bottom" | "left" | "right", [number, number, number, number]> } | null;
  /** Storage key of the details (vision.json.gz). */
  key?: string;
};
/** A face in one frame: track id, box (shares of the frame), detector score, jawOpen 0-1, yaw, pitch (degrees), blink 0-1. */
export type VisionFace = [number, number, number, number, number, number, number | null, number | null, number | null, number | null];
export type VisionDetails = {
  v: number; fps: number; size: [number, number]; faceFields: string; frames: [number, VisionFace[]][];
  /** [t, brightness 0-1, sharpness (Laplacian variance), motion 0-1, shake (share of the width), face exposure 0-1, colours, contrast] */
  metricFields: string; metrics: [number, number, number, number, number, number | null, string[], number?][];
};

const r2 = (n: number) => Math.round(n * 100) / 100;
const r3 = (n: number) => Math.round(n * 1000) / 1000;
const inRange = (a: number, b: number, from: number, to: number) => b >= from && a <= to;

export function b64ToInt8(s: string): Int8Array {
  const bin = typeof atob === "function" ? atob(s) : "";
  const out = new Int8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = (bin.charCodeAt(i) << 24) >> 24;
  return out;
}

/** The usual level of a stretch (dBFS, the median of its 100 ms values: a click or a breath in a pause does not make the
 *  pause loud), or null outside the measured sound. */
export function levelDb(a: Pick<DeepAudio, "rms100">, s: number, e: number): number | null {
  const v = b64ToInt8(a.rms100);
  const i0 = Math.max(0, Math.floor(s * 10)), i1 = Math.min(v.length, Math.max(i0 + 1, Math.ceil(e * 10)));
  if (i0 >= v.length || i1 <= i0) return null;
  const xs = Array.from(v.subarray(i0, i1)).sort((x, y) => x - y);
  return xs.length % 2 ? xs[xs.length >> 1] : (xs[xs.length / 2 - 1] + xs[xs.length / 2]) / 2;
}

export type AudioFrames = { n: number; min: Int8Array; max: Int8Array; db: Int8Array; vad: Uint8Array };
/** audio.bin: 4 bytes per 10 ms frame (min, max as int8 of full scale, dBFS as int8, speech probability uint8). */
export function audioFrames(buf: Uint8Array): AudioFrames {
  const n = Math.floor(buf.length / 4);
  const min = new Int8Array(n), max = new Int8Array(n), db = new Int8Array(n), vad = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    min[i] = (buf[i * 4] << 24) >> 24; max[i] = (buf[i * 4 + 1] << 24) >> 24; db[i] = (buf[i * 4 + 2] << 24) >> 24; vad[i] = buf[i * 4 + 3];
  }
  return { n, min, max, db, vad };
}

/** The frames from..to in steps of `step` seconds (a multiple of 10 ms): loudness (energy mean), peaks, speech probability. */
export function audioSeries(f: AudioFrames, from: number, to: number, step: number) {
  const per = Math.max(1, Math.round(step / 0.01));
  const i0 = Math.max(0, Math.floor(from / 0.01)), i1 = Math.min(f.n, Math.ceil(to / 0.01));
  const db: number[] = [], min: number[] = [], max: number[] = [], vad: number[] = [];
  for (let i = i0; i < i1; i += per) {
    let p = 0, lo = 127, hi = -127, sp = 0;
    const j1 = Math.min(i1, i + per);
    for (let j = i; j < j1; j++) { p += 10 ** (f.db[j] / 10); lo = Math.min(lo, f.min[j]); hi = Math.max(hi, f.max[j]); sp = Math.max(sp, f.vad[j]); }
    db.push(Math.round(10 * Math.log10(p / (j1 - i)))); min.push(r2(lo / 127)); max.push(r2(hi / 127)); vad.push(r2(sp / 255));
  }
  return { t0: r3(i0 * 0.01), step: per * 0.01, db, min, max, vad };
}

export type Aligned = { s: number; e: number; c: number | null };
export function alignedMap(al?: Pick<Alignment, "words"> | null): Map<string, Aligned> {
  return new Map((al?.words ?? []).map(([id, s, e, c]) => [id, { s, e, c }]));
}

/** Words whose edges in the sound are more than `over` seconds from the transcriber's times. */
export function alignmentDiffs(al: Pick<Alignment, "words"> | null | undefined, words: Word[], over = 0.06) {
  const m = alignedMap(al);
  const out: { id: string; text: string; t: number; end: number; s: number; e: number }[] = [];
  for (const w of words) {
    const a = m.get(w.id);
    if (a && (Math.abs(a.s - w.t) > over || Math.abs(a.e - w.end) > over)) out.push({ id: w.id, text: w.text, t: w.t, end: w.end, s: a.s, e: a.e });
  }
  return out;
}

/**
 * A V1 clip's sound at its edges and inside: how long before the first word and after the last (in the sound, from
 * the alignment when there is one), a word the cut goes through (and how much of it is lost), and the pauses inside.
 */
export function clipEdges(c: { sourceIn: number; sourceOut: number }, words: Word[], aligned: Map<string, Aligned>, cut: Set<string> = new Set()): string {
  const at = (w: Word) => aligned.get(w.id) ?? { s: w.t, e: w.end, c: null };
  const live = words.filter((w) => !cut.has(w.id));
  const inside = live.filter((w) => { const a = at(w); return a.e > c.sourceIn && a.s < c.sourceOut; });
  if (!inside.length) return "no words";
  const parts: string[] = [];
  const first = at(inside[0]), last = at(inside[inside.length - 1]);
  if (first.s < c.sourceIn) parts.push(`cuts into "${inside[0].text}" at the start (${Math.round((c.sourceIn - first.s) * 1000)}ms of it lost)`);
  else parts.push(`${(first.s - c.sourceIn).toFixed(2)}s before the first word`);
  if (last.e > c.sourceOut) parts.push(`cuts into "${inside[inside.length - 1].text}" at the end (${Math.round((last.e - c.sourceOut) * 1000)}ms lost)`);
  else parts.push(`${(c.sourceOut - last.e).toFixed(2)}s after the last`);
  const gaps: [number, number][] = [];
  for (let i = 1; i < inside.length; i++) { const g = at(inside[i]).s - at(inside[i - 1]).e; if (g > 0.3) gaps.push([g, at(inside[i - 1]).e]); }
  if (gaps.length) { const g = gaps.reduce((a, b) => (b[0] > a[0] ? b : a)); parts.push(`${gaps.length} ${gaps.length === 1 ? "pause" : "pauses"} over 0.3s inside (longest ${g[0].toFixed(2)}s at ${g[1].toFixed(2)}s)`); }
  return parts.join("; ");
}

const list = <T,>(xs: T[], f: (x: T) => string, max = 60) => (xs.length ? xs.slice(0, max).map(f).join(", ") + (xs.length > max ? `, …(${xs.length - max} more)` : "") : "none");

/** get_audio as text: the whole-video numbers, then what happens in from..to, and the loudness series. */
export function deepAudioText(a: DeepAudio, o: { name: string; from: number; to: number; frames?: AudioFrames | null; step?: number; peaks?: boolean }): string {
  const { from, to } = o;
  const sp = a.speech.filter(([s, e]) => inRange(s, e, from, to));
  const br = a.breaths.filter(([s, e]) => inRange(s, e, from, to));
  const ck = a.clicks.filter(([t]) => t >= from && t <= to);
  const cl = a.clipping.filter(([s, e]) => inRange(s, e, from, to));
  const on = a.onsets.filter((t) => t >= from && t <= to);
  const lines = [
    `AUDIO "${o.name}" ${r2(from)}-${r2(to)}s (footage seconds; measured every 10 ms). Loudness ${a.lufs != null ? `${a.lufs} LUFS` : "?"}, true peak ${a.truePeakDb != null ? `${a.truePeakDb} dBTP` : "?"}, sample peak ${a.peakDb} dBFS. Room ${a.roomDb} dBFS (noise floor ${a.noiseFloorDb}), voice ${a.speechDb} dBFS, speech ${Math.round(a.speechShare * 100)}% of the video.`,
    `SPEECH regions (Silero VAD) ${sp.length}: ${list(sp, ([s, e]) => `${s}-${e}`, 80)}`,
    `BREATHS ${br.length} (start-end level confidence): ${list(br, ([s, e, d, c]) => `${s}-${e} ${d}dB ${c}`)}`,
    `CLICKS ${ck.length} (time, dB over the sound around it): ${list(ck, ([t, d]) => `${t} ${d}dB`)}`,
    `CLIPPING ${cl.length} (start-end, peak dBFS; flat tops near full scale): ${list(cl, ([s, e, n]) => `${s}-${e} ${n}dB`)}`,
    `ONSETS ${on.length} (the sound jumps 10 dB in 30 ms): ${list(on, (t) => String(t), 80)}`,
  ];
  if (o.frames) {
    const step = o.step ?? Math.max(0.01, Math.ceil(((to - from) / 300) * 100) / 100);
    const s = audioSeries(o.frames, from, to, step);
    lines.push(`LOUDNESS dBFS every ${r2(s.step)}s from ${s.t0}s (${s.db.length}): ${s.db.join(" ")}`);
    lines.push(`SPEECH probability every ${r2(s.step)}s: ${s.vad.join(" ")}`);
    if (o.peaks) lines.push(`PEAKS min/max of full scale every ${r2(s.step)}s: ${s.min.map((m, i) => `${m}/${s.max[i]}`).join(" ")}`);
  }
  return lines.join("\n");
}

/** get_vision as text: the summary, then 0.5 s rows (and faces at 10 fps with detail "faces") in from..to. */
export function visionText(v: VisionSummary, o: { name: string; from: number; to: number; details?: VisionDetails | null; faces?: boolean; maxRows?: number }): string {
  const { from, to } = o;
  const f = v.faces;
  const rng = (xs: [number, number][]) => list(xs.filter(([s, e]) => inRange(s, e, from, to)), ([s, e]) => `${s}-${e}`);
  const lines = [
    `VISION "${o.name}" ${r2(from)}-${r2(to)}s (footage seconds). Faces at ${v.fps} fps${v.landmarks ? " with mouth and head pose (MediaPipe)" : ""}; picture every ${v.metricsEvery}s. Frame ${v.size[0]}x${v.size[1]}.`,
    `FACES on screen ${Math.round(f.present * 100)}% of the time, ${f.tracks} ${f.tracks === 1 ? "track" : "tracks"}, main face ${f.medianShare != null ? Math.round(f.medianShare * 100) + "% of the frame height" : "-"}, mouth open ${f.mouthOpenShare != null ? Math.round(f.mouthOpenShare * 100) + "% of the time" : "-"}.`,
    `FACE LOST (no face 0.5s+): ${rng(f.lost)}`,
    `LOOKING AWAY (head turned over 30 degrees 0.5s+, max yaw): ${list(f.offCamera.filter(([s, e]) => inRange(s, e, from, to)), ([s, e, y]) => `${s}-${e} ${y ?? "?"}deg`)}`,
    `HEAD TURNS (yaw moves 25+ degrees within 1s): ${list(f.turns.filter(([s, e]) => inRange(s, e, from, to)), ([s, e, a, b]) => `${s}-${e} ${a}->${b}deg`)}`,
    `SOFT (out of focus 1s+): ${rng(v.sharpness.soft)}; median sharpness ${v.sharpness.median}`,
    `SHAKY (camera jitter 1s+): ${rng(v.shake.shaky)}`,
    `DARK: ${rng(v.light.dark)}; BLOWN OUT: ${rng(v.light.blown)}; brightness median ${v.light.median}, face exposure median ${v.light.skinMedian ?? "-"}`,
    `SAFE AREA: ${v.safeArea ? `main face in x ${v.safeArea.face[0]}-${v.safeArea.face[2]}, y ${v.safeArea.face[1]}-${v.safeArea.face[3]} (shares of the frame); free for text: top 0-${v.safeArea.face[1]}, below the face ${v.safeArea.free.bottom[1]}-1, left 0-${v.safeArea.face[0]}, right ${v.safeArea.face[2]}-1` : "no face to keep clear"}`,
  ];
  const d = o.details;
  if (d) {
    const rows = d.metrics.filter((m) => m[0] >= from && m[0] <= to);
    const max = o.maxRows ?? 120;
    const faceAt = (t: number) => d.frames.find((fr) => Math.abs(fr[0] - t) < 0.051)?.[1] ?? [];
    const faceText = (q: VisionFace) => `#${q[0]} ${q[1]},${q[2]} ${q[3]}x${q[4]}${q[6] != null ? ` mouth ${q[6]}` : ""}${q[7] != null ? ` yaw ${q[7]}` : ""}`;
    lines.push(`EVERY ${v.metricsEvery}s (t | brightness sharpness motion shake face-exposure | colours | faces: #track x,y wxh mouth yaw):`);
    lines.push(...rows.slice(0, max).map((m) => `${m[0]} | ${m[1]} ${m[2]} ${m[3]} ${m[4]} ${m[5] ?? "-"} | ${m[6].join(" ")} | ${faceAt(m[0]).map(faceText).join("; ") || "no face"}`));
    if (rows.length > max) lines.push(`…${rows.length - max} more rows: narrow from/to`);
    if (o.faces) {
      const fr = d.frames.filter((x) => x[0] >= from && x[0] <= to);
      lines.push(`FACES every ${r2(1 / d.fps)}s (t: #track x,y wxh score mouth yaw pitch blink):`);
      lines.push(...fr.slice(0, max * 5).map(([t, qs]) => `${t}: ${qs.map((q) => `#${q[0]} ${q[1]},${q[2]} ${q[3]}x${q[4]} ${q[5]} ${q[6] ?? "-"} ${q[7] ?? "-"} ${q[8] ?? "-"} ${q[9] ?? "-"}`).join("; ") || "none"}`));
      if (fr.length > max * 5) lines.push(`…${fr.length - max * 5} more frames: narrow from/to`);
    }
  }
  return lines.join("\n");
}
