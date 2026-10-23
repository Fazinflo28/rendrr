// The video breakdown: every video (footage or reference) as text and frames, so an AI can read it without watching.
// The worker measures (frames, light, colour, motion, loudness, beat); this file turns the numbers into the document
// the AI reads (breakdownAsText) and the UI shows. Pure functions, no I/O.
import type { Silence, Transcript } from "./transcript";

export type VideoKind = "footage" | "reference";
export const VIDEO_KINDS: VideoKind[] = ["footage", "reference"];

/** What breakdown.py prints. */
export type VisualSample = { t: number; shot: number; b: number; s: number; m: number; c: string[] };
export type Measured = {
  interval: number;
  size: [number, number];
  samples: VisualSample[];
  sheets: { file: string; times: number[]; cols: number; rows: number; tile: [number, number] }[];
  /** One sheet of 16 frames spread over the whole video (only when the video has more than one sheet). */
  overview?: { file: string; times: number[]; cols: number; rows: number; tile: [number, number] } | null;
  loudness: number[];
  tempo: { bpm: number; confidence: number; beats: number[] } | null;
};

export type Shot = {
  id: string; start: number; end: number; sec: number;
  light: "dark" | "normal" | "bright"; colour: "muted" | "colourful"; motion: "still" | "some" | "lots";
  colours: string[]; loudnessDb: number | null; words: number; says: string;
};
export type Sheet = { key: string; from: number; to: number; times: number[]; cols: number; rows: number };
export type Breakdown = {
  v: 1;
  video: { id: string; name: string; kind: VideoKind; seconds: number; width: number; height: number; orientation: string; fps: number; hasAudio: boolean };
  pacing: {
    shots: number; avgShotSec: number; minShotSec: number; maxShotSec: number; cutsPerMin: number;
    words: number; wordsPerMin: number; speechShare: number; silenceShare: number; fillers: number;
  };
  hook: { sec: number; says: string; shots: number };
  shots: Shot[];
  audio: { loudnessDb: number[]; avgDb: number | null; beat: { bpm: number; confidence: number; beats: number[] } | null; musicLikely: boolean };
  frames: { interval: number; count: number; sheets: Sheet[]; overview?: Sheet | null };
};

export const BEAT_CONFIDENCE = 0.5; // below this the audio has no steady beat
const r1 = (n: number) => Math.round(n * 10) / 10;
const r2 = (n: number) => Math.round(n * 100) / 100;
const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

export function fmtT(t: number): string {
  const s = Math.max(0, t);
  return `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, "0")}`;
}

/** The most common colours across a set of samples. */
function topColours(samples: VisualSample[], n = 3): string[] {
  const count = new Map<string, number>();
  for (const s of samples) s.c.forEach((c, i) => count.set(c, (count.get(c) || 0) + (3 - i)));
  const rgb = (c: string) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
  const near = (a: string, b: string) => rgb(a).reduce((d, x, i) => d + Math.abs(x - rgb(b)[i]), 0) < 40;
  const out: string[] = [];
  for (const [c] of [...count.entries()].sort((a, b) => b[1] - a[1])) {
    if (!out.some((o) => near(o, c))) out.push(c);
    if (out.length === n) break;
  }
  return out;
}

function quote(text: string, max = 14): string {
  const w = text.split(/\s+/).filter(Boolean);
  return w.length > max ? w.slice(0, max).join(" ") + " …" : w.join(" ");
}

export function buildBreakdown(input: {
  video: Breakdown["video"];
  transcript: Transcript;
  silences: Silence[];
  sceneCuts: number[];
  measured: Measured;
  sheetKeys: string[]; // storage keys, in the same order as measured.sheets
  overviewKey?: string | null;
}): Breakdown {
  const { video, transcript, silences, measured } = input;
  const dur = Math.max(0.01, video.seconds);
  const cuts = [...new Set(input.sceneCuts.filter((c) => c > 0 && c < dur))].sort((a, b) => a - b);
  const bounds = [0, ...cuts, dur];
  const words = transcript.flatMap((l) => l.words);
  const loud = measured.loudness;

  const shots: Shot[] = bounds.slice(0, -1).map((start, i) => {
    const end = bounds[i + 1];
    const inShot = measured.samples.filter((s) => s.shot === i || (s.t >= start && s.t < end));
    const b = avg(inShot.map((s) => s.b)), sat = avg(inShot.map((s) => s.s)), m = avg(inShot.map((s) => s.m));
    const said = words.filter((w) => w.t >= start && w.t < end);
    const secs = loud.slice(Math.floor(start), Math.max(Math.floor(start) + 1, Math.ceil(end))).filter((d) => d > -90);
    return {
      id: `sh${i + 1}`, start: r2(start), end: r2(end), sec: r2(end - start),
      light: b < 0.25 ? "dark" : b > 0.7 ? "bright" : "normal",
      colour: sat < 0.25 ? "muted" : "colourful",
      motion: m < 0.012 ? "still" : m < 0.045 ? "some" : "lots",
      colours: topColours(inShot),
      loudnessDb: secs.length ? r1(avg(secs)) : null,
      words: said.length,
      says: quote(said.map((w) => w.text).join(" ")),
    };
  });

  const lens = shots.map((s) => s.sec);
  const speech = transcript.reduce((a, l) => a + Math.max(0, l.end - l.start), 0);
  const quiet = silences.filter((s) => s.end - s.start >= 0.4).reduce((a, s) => a + (s.end - s.start), 0);
  const hookSec = Math.min(3, dur);
  const beat = measured.tempo && measured.tempo.confidence >= BEAT_CONFIDENCE ? measured.tempo : null;
  const heard = loud.filter((d) => d > -90);
  // Music: a steady beat, or sound that stays loud while nobody speaks.
  const noSpeechLoud = loud.filter((d, sec) => d > -30 && !words.some((w) => w.t >= sec && w.t < sec + 1)).length;
  const sheets: Sheet[] = measured.sheets.map((s, i) => ({ key: input.sheetKeys[i], from: s.times[0] ?? 0, to: s.times[s.times.length - 1] ?? 0, times: s.times, cols: s.cols, rows: s.rows }));
  const ov = measured.overview;
  const overview: Sheet | null = ov && input.overviewKey ? { key: input.overviewKey, from: ov.times[0] ?? 0, to: ov.times[ov.times.length - 1] ?? 0, times: ov.times, cols: ov.cols, rows: ov.rows } : sheets.length === 1 ? sheets[0] : null;

  return {
    v: 1,
    video,
    pacing: {
      shots: shots.length, avgShotSec: r2(avg(lens)), minShotSec: r2(Math.min(...lens)), maxShotSec: r2(Math.max(...lens)),
      cutsPerMin: r1((cuts.length / dur) * 60),
      words: words.length, wordsPerMin: Math.round((words.length / dur) * 60),
      speechShare: r2(Math.min(1, speech / dur)), silenceShare: r2(Math.min(1, quiet / dur)),
      fillers: words.filter((w) => w.filler).length,
    },
    hook: { sec: r1(hookSec), says: quote(words.filter((w) => w.t < hookSec).map((w) => w.text).join(" "), 20), shots: shots.filter((s) => s.start < hookSec).length },
    shots,
    audio: { loudnessDb: loud, avgDb: heard.length ? r1(avg(heard)) : null, beat, musicLikely: !!beat || noSpeechLoud >= Math.max(3, dur * 0.2) },
    frames: { interval: measured.interval, count: measured.samples.length, sheets, overview },
  };
}

const pct = (x: number) => `${Math.round(x * 100)}%`;

/** The breakdown as compact text ("video code") for the AI. from/to (seconds) narrows the shot list. */
export function breakdownAsText(b: Breakdown, opts: { from?: number; to?: number; maxShots?: number } = {}): string {
  const v = b.video, p = b.pacing;
  const from = opts.from ?? 0, to = opts.to ?? 1e9;
  const shots = b.shots.filter((s) => s.end > from && s.start < to);
  const max = opts.maxShots ?? 120;
  const lines = [
    `VIDEO ${v.kind === "reference" ? "REFERENCE" : "FOOTAGE"} "${v.name}" ${v.id} | ${v.seconds.toFixed(1)}s | ${v.width}x${v.height} ${v.orientation.toLowerCase()} | ${Math.round(v.fps)}fps | ${v.hasAudio ? "sound" : "no sound"}`,
    `PACING shots=${p.shots} avg_shot=${p.avgShotSec}s min=${p.minShotSec}s max=${p.maxShotSec}s cuts_per_min=${p.cutsPerMin} words=${p.words} words_per_min=${p.wordsPerMin} speech=${pct(p.speechShare)} silence=${pct(p.silenceShare)} fillers=${p.fillers}`,
    `HOOK first ${b.hook.sec}s: ${b.hook.shots} shot${b.hook.shots === 1 ? "" : "s"}${b.hook.says ? `, says "${b.hook.says}"` : ", no speech"}`,
    `SHOTS${from > 0 || to < 1e9 ? ` ${fmtT(from)}-${fmtT(Math.min(to, v.seconds))}` : ""} (id start-end length | light colour motion | main colours | loudness | words: what is said)`,
    ...shots.slice(0, max).map((s) => `${s.id} ${fmtT(s.start)}-${fmtT(s.end)} ${s.sec.toFixed(1)}s | ${s.light} ${s.colour} ${s.motion} | ${s.colours.join(" ") || "-"} | ${s.loudnessDb != null ? s.loudnessDb + "dB" : "silent"} | ${s.words}w${s.says ? `: "${s.says}"` : ""}`),
    ...(shots.length > max ? [`… ${shots.length - max} more shots: ask with from/to`] : []),
    `AUDIO avg=${b.audio.avgDb != null ? b.audio.avgDb + "dB" : "silent"} ${b.audio.beat ? `beat=${b.audio.beat.bpm}bpm (confidence ${b.audio.beat.confidence}), first beats ${b.audio.beat.beats.slice(0, 8).map((t) => t.toFixed(2)).join(" ")}` : "no steady beat"} | music ${b.audio.musicLikely ? "likely" : "unlikely"}`,
    `LOUDNESS dB per second from 0s: ${b.audio.loudnessDb.slice(0, 240).map((d) => Math.round(d)).join(" ")}${b.audio.loudnessDb.length > 240 ? " …" : ""}`,
    `FRAMES ${b.frames.count} frames (every ${b.frames.interval}s plus the middle of every shot) on ${b.frames.sheets.length} contact sheet${b.frames.sheets.length === 1 ? "" : "s"} of 16, time printed on each tile`,
  ];
  return lines.join("\n");
}

/** Contact sheets that overlap a time range, at most `max`. */
export function sheetsIn(b: Breakdown, from = 0, to = 1e9, max = 4): Sheet[] {
  return b.frames.sheets.filter((s) => s.to >= from && s.from <= to).slice(0, max);
}
