// The check an AI reads after a render instead of looking at frames: what the rendered FILE measured (stream
// lengths, black and silent stretches, loudness, graphics on screen) next to what the edit says, and every place
// they disagree. Facts and fixed thresholds only, no judgement.
import { fmtT } from "./breakdown";
import { audioText, colorSummary, lookText, speedText } from "./ops";
import { exportText, planTransitions, type FootageInfo } from "./renderPlan";
import type { Key } from "./motion";
import { asSequence, editOf, isSequence, layoutTimeline, mergeRanges, normalSpeed, rateOf, sequenceView, type Range, type SeqClip, type SequenceView } from "./sequence";
import { audioSettings, type Clip, type Snapshot, type Timeline } from "./timeline";
import { captionStyleOf, drawnOf, styleText, textPreset, textRect, type CaptionStyle, type Card, type TextAnim, type TextStyle } from "./captions";
import { allWords, type Transcript, type Word } from "./transcript";
import type { Aligned } from "./deep";
import { clippedLine, clippedWords, gapsLine, heardDiff, heardDiffLine, joinClicks, speechGaps, wordsAsPlayed, type FileSound, type HeardTranscript } from "./previewCheck";

export type FileLoudness = { lufs: number | null; peakDb: number | null };
/** What the worker measured in a rendered file (edit seconds). */
export type FileMeasure = FileLoudness & {
  videoSeconds: number | null;
  audioSeconds: number | null;
  black: Range[];    // black picture, 0.15 s or longer
  silences: Range[]; // silence (below -45 dB), 0.15 s or longer
  /** Each graphic overlaid: where it is on screen and how much of the frame its picture covers (0-100), measured at 8
   *  moments across that time: coverPct is the average, coverMin and coverMax the least and most (older checks: only
   *  coverPct, from one moment). */
  graphics: { clipId: string; start: number; end: number; coverPct: number | null; coverMin?: number; coverMax?: number;
    /** Engine Part 3: moments sampled across its whole time, and how many of them show any of it (invisible: none). */
    samples?: number; visible?: number;
    /** How much of the main face's box it covers at most (0-100), at which edit moment, over how many moments with a
     *  face on screen (null: no face measured under it). */
    face?: { max: number; at: number; of: number } | null }[];
  /** Momentary loudness (LUFS, 400 ms windows) every 0.2 s: value i is the window ending at (i + 1) * 0.2 s. */
  momentary?: number[];
  /** Engine Part 3: the file's sound every 10 ms (speech, breaths, clicks at joins). Previews only. */
  sound?: FileSound;
  error?: string;
};
export const MEASURE_MIN = 0.15;

/** Reads blackdetect, silencedetect and ebur128 output from one FFmpeg pass. Open stretches close at `fileEnd`. */
export function parseMeasureLog(stderr: string, fileEnd: number): Pick<FileMeasure, "black" | "silences" | "lufs" | "peakDb" | "momentary"> {
  const r3 = (n: number) => Math.round(n * 1000) / 1000;
  const black: Range[] = [];
  for (const m of stderr.matchAll(/black_start:\s*([\d.]+)\s+black_end:\s*([\d.]+)/g)) black.push({ start: r3(Number(m[1])), end: r3(Number(m[2])) });
  const silences: Range[] = [];
  let open: number | null = null;
  for (const line of stderr.split("\n")) {
    const s = /silence_start:\s*(-?[\d.]+)/.exec(line), e = /silence_end:\s*([\d.]+)/.exec(line);
    if (s) open = Math.max(0, Number(s[1]));
    if (e && open != null) { silences.push({ start: r3(open), end: r3(Number(e[1])) }); open = null; }
  }
  if (open != null && fileEnd - open >= MEASURE_MIN) silences.push({ start: r3(open), end: r3(fileEnd) });
  const summary = stderr.slice(stderr.lastIndexOf("Summary:"));
  const num = (re: RegExp) => { const m = summary.includes("Summary:") ? re.exec(summary) : null; const n = m ? Number(m[1]) : NaN; return Number.isFinite(n) ? Math.round(n * 10) / 10 : null; };
  // ebur128 logs the momentary loudness every 0.1 s; every second one is kept (0.2 s steps).
  const momentary: number[] = [];
  for (const m of stderr.matchAll(/\bt:\s*([\d.]+)\s+TARGET:[^\n]*?M:\s*(-?[\d.]+|-inf|nan)/g)) {
    const k = Math.round(Number(m[1]) * 10);
    if (k % 2 !== 0) continue;
    const v = Number(m[2]);
    momentary[k / 2 - 1] = Number.isFinite(v) ? Math.max(-99, Math.round(v * 10) / 10) : -99;
  }
  return { black: black.filter((b) => b.end - b.start >= MEASURE_MIN - 1e-6), silences: silences.filter((x) => x.end - x.start >= MEASURE_MIN - 1e-6), lufs: num(/I:\s+(-?[\d.]+) LUFS/), peakDb: num(/Peak:\s+(-?[\d.]+) dBFS/), ...(momentary.length ? { momentary: Array.from(momentary, (x) => x ?? -99) } : {}) };
}

/**
 * The noise left in the file: the median momentary loudness of the 400 ms windows that fall wholly inside pauses
 * between words (50 ms clear of each word). Null when no pause is long enough to measure.
 */
export function noiseBetweenWords(momentary: number[] | undefined, words: Range[], total: number): { lufs: number; windows: number } | null {
  if (!momentary?.length) return null;
  const sorted = [...words].sort((a, b) => a.start - b.start);
  const gaps: Range[] = [];
  let at = 0;
  for (const w of sorted) { if (w.start - at > 0) gaps.push({ start: at, end: w.start }); at = Math.max(at, w.end); }
  if (total > at) gaps.push({ start: at, end: total });
  const vals: number[] = [];
  momentary.forEach((m, i) => {
    const end = (i + 1) * 0.2, start = end - 0.4;
    if (start < 0 || end > total) return;
    if (gaps.some((g) => start >= g.start + 0.05 && end <= g.end - 0.05)) vals.push(m);
  });
  if (!vals.length) return null;
  vals.sort((a, b) => a - b);
  const mid = vals.length >> 1;
  return { lufs: Math.round((vals.length % 2 ? vals[mid] : (vals[mid - 1] + vals[mid]) / 2) * 10) / 10, windows: vals.length };
}

const overlap = (a: Range, b: Range) => Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
/** The parts of `rs` outside every range of `out`. */
const minus = (rs: Range[], out: Range[]): Range[] => rs.flatMap((r) => {
  let parts = [r];
  for (const o of out) parts = parts.flatMap((p) => (o.end <= p.start || o.start >= p.end ? [p] : [{ start: p.start, end: o.start }, { start: o.end, end: p.end }].filter((x) => x.end - x.start > 1e-6)));
  return parts;
});
const list = (xs: string[], max = 8) => xs.slice(0, max).join(", ") + (xs.length > max ? `, +${xs.length - max} more` : "");

/** "Sequence: 12 clips from 2 videos (main 10, v_x 2), 1 moved, 1 repeat, 1 J cut, 1 muted". */
function sequenceLine(tl: Timeline, view: SequenceView): string {
  const v1 = tl.tracks.v1 as SeqClip[];
  const main = view.mainVideoId;
  const per = new Map<string, number>();
  for (const c of v1) per.set(c.sourceVideoId, (per.get(c.sourceVideoId) ?? 0) + 1);
  let moved = 0, repeats = 0;
  v1.forEach((c, i) => {
    const before = v1.slice(0, i).filter((x) => x.sourceVideoId === c.sourceVideoId);
    if (before.some((x) => Math.min(x.sourceOut, c.sourceOut) - Math.max(x.sourceIn, c.sourceIn) > 0.1)) repeats++;
    else if (before.length && c.sourceIn < before[before.length - 1].sourceIn) moved++;
  });
  const live = view.clips.filter((c) => c.pieces.length);
  const j = live.filter((c, i) => i > 0 && c.soundStart < c.start - 0.005).length, l = live.filter((c, i) => i > 0 && c.soundStart > c.start + 0.005).length;
  const muted = v1.filter((c) => c.audioMuted).length;
  const videos = per.size > 1 ? ` from ${per.size} videos (${Array.from(per).map(([v, n]) => `${v === main ? "main" : v} ${n}`).join(", ")})` : "";
  const bits = [moved ? `${moved} moved` : "", repeats ? `${repeats} ${repeats === 1 ? "repeat" : "repeats"}` : "", j ? `${j} J ${j === 1 ? "cut" : "cuts"}` : "", l ? `${l} L ${l === 1 ? "cut" : "cuts"}` : "", muted ? `${muted} muted` : ""].filter(Boolean);
  return `Sequence: ${v1.length} ${v1.length === 1 ? "clip" : "clips"}${videos}${bits.length ? ", " + bits.join(", ") : per.size > 1 ? "" : ", footage order"}`;
}

/** "Noise between words: -61.3 LUFS (median of 24 windows in pauses)". */
function noiseLine(n: { lufs: number; windows: number } | null, music: boolean): string {
  if (!n) return "Noise between words: no pause of 0.5 s or more to measure";
  return `Noise between words: ${n.lufs <= -70 ? "below -70 LUFS (silent)" : `${n.lufs} LUFS`} (median of ${n.windows} windows in pauses${music ? ", music included" : ""})`;
}

/**
 * pauseOver: pauses longer than this are listed (default 0.15 s). measured: the rendered file (render_preview).
 * transcripts: other videos on V1 (their words count as spoken). videoId: the project's footage (an old timeline).
 * planned: the length the render planned (every part on a frame); the file is measured against it.
 */
export function editCheck(snap: Snapshot, tr: Transcript, opts: { pauseOver?: number | null; loudness?: FileLoudness | null; measured?: FileMeasure | null; transcripts?: Record<string, Transcript>; videoId?: string; planned?: number | null; renderNotes?: string[]; lutName?: (id: string) => string | undefined; footage?: FootageInfo;
  /** Engine Part 3: each video's word edges in the sound (alignment), for the clipped words; the preview heard again. */
  aligned?: Record<string, Map<string, Aligned>>; heard?: HeardTranscript | null } = {}): string {
  const words = allWords(tr);
  const tl = layoutTimeline(asSequence(snap.timeline, words, opts.videoId), words);
  const view = sequenceView(tl, words);
  const main = view.mainVideoId;
  const total = view.total;
  const cut = new Set(tl.cut);
  const wordsOf = (vid: string) => (vid === main ? words : allWords(opts.transcripts?.[vid] ?? []));
  // What is said in the edit, in edit order: the words of every stretch of dialogue (muted ones are in the edit, silent).
  const spoken: { w: Word; vid: string; at: number; end: number; muted: boolean; sound: Range | null }[] = [];
  // A clip silent at its speed (reversed, frozen, too slow or fast) says nothing.
  for (const s of view.sound) {
    if (s.silent) continue;
    for (const w of wordsOf(s.videoId)) {
      if ((s.videoId === main && cut.has(w.id)) || w.t < s.srcIn || w.t >= s.srcOut) continue;
      // Engine Part 3: where the word sounds (the alignment's edges) when the video has them, else the transcriber's.
      const a = opts.aligned?.[s.videoId]?.get(w.id);
      spoken.push({ w, vid: s.videoId, at: editOf(s, w.t), end: editOf(s, Math.min(w.end, s.srcOut)), muted: s.muted, sound: a ? { start: editOf(s, a.s), end: editOf(s, Math.min(a.e, s.srcOut)) } : null });
    }
  }
  spoken.sort((a, b) => a.at - b.at);
  const flags: string[] = [];

  // Pauses people will hear: between spoken words, and before the first and after the last word.
  const over = opts.pauseOver ?? MEASURE_MIN;
  const pauses: { at: number; len: number }[] = [];
  if (spoken.length) {
    const lead = spoken[0].at;
    if (lead > over) pauses.push({ at: 0, len: lead });
    for (let i = 0; i + 1 < spoken.length; i++) {
      const a = spoken[i].end, b = spoken[i + 1].at;
      if (b - a > over) pauses.push({ at: a, len: b - a });
    }
    const tail = total - spoken[spoken.length - 1].end;
    if (tail > over) pauses.push({ at: total - tail, len: tail });
  }
  // Pauses are listed, not flagged: how long they may be is the edit's choice (cut_silences leaves 0.16 s).

  const fillers = spoken.filter((x) => x.w.filler);
  if (fillers.length) flags.push(`${fillers.length} filler word${fillers.length === 1 ? "" : "s"}`);

  // Captions follow transcript lines; a deleted caption clip leaves its words without captions (main footage).
  const lineOf = new Map(tr.flatMap((l) => l.words.map((w) => [w.id, l.id] as const)));
  const captioned = new Set((tl.tracks.v3 as Clip[]).filter((c) => (c as Record<string, unknown>).kind === "caption").map((c) => String((c as Record<string, unknown>).lineId)));
  const mainSpoken = spoken.filter((x) => x.vid === main);
  const covered = mainSpoken.filter((x) => captioned.has(lineOf.get(x.w.id) || "")).length;
  const coverPct = mainSpoken.length ? Math.round((covered / mainSpoken.length) * 100) : 100;
  if (tl.captionsOn && coverPct < 100) flags.push(`${mainSpoken.length - covered} spoken words without captions`);

  const inEdit = (c: Clip) => c.end - c.start > 0.05 && c.start < total - 0.05;
  const v2 = tl.tracks.v2 as (Clip & Record<string, unknown>)[];
  const zooms = v2.filter((c) => c.kind === "zoom" && inEdit(c));
  const broll = v2.filter((c) => c.kind === "broll" && inEdit(c));
  const graphics = (tl.tracks.v3 as (Clip & Record<string, unknown>)[]).filter((c) => c.kind === "graphic" && inEdit(c));
  const music = (tl.tracks.a2 as (Clip & Record<string, unknown>)[]).filter(inEdit);
  const musicCover = total ? mergeRanges(music.map((c) => ({ start: Math.max(0, c.start), end: Math.min(total, c.end) }))).reduce((a, r) => a + r.end - r.start, 0) / total : 0;

  // Cuts: where the picture jumps. A ramp's steps play on from each other, so they make one stretch.
  const segs: { at: number; len: number }[] = [];
  view.picture.forEach((p, i) => {
    const q = view.picture[i - 1], last = segs[segs.length - 1];
    const goesOn = q && last && q.videoId === p.videoId && rateOf(q) !== 1 && Math.sign(rateOf(q)) === Math.sign(rateOf(p)) && (rateOf(p) > 0 ? Math.abs(q.srcOut - p.srcIn) < 1e-3 : Math.abs(p.srcOut - q.srcIn) < 1e-3);
    if (goesOn) last.len += p.end - p.start; else segs.push({ at: p.start, len: p.end - p.start });
  });
  const short = segs.filter((x) => x.len < 0.5);
  if (short.length) flags.push(`${short.length} clip${short.length === 1 ? "" : "s"} under 0.5s`);
  const m = opts.measured ?? null;
  const ld = m && !m.error ? m : opts.loudness;
  // The sound settings. A version stored in model A was mixed the old way (limiter only), whatever the defaults say.
  const legacy = !isSequence(snap.timeline);
  const sound = legacy ? { ...audioSettings({}), loudness: null } : audioSettings(tl);
  const v1 = tl.tracks.v1 as SeqClip[];
  const clipSound = v1.filter((c) => c.audioGain || c.audioFadeIn || c.audioFadeOut).length + ([...tl.tracks.a2, ...tl.tracks.a3] as (Clip & { fadeIn?: number; fadeOut?: number })[]).filter((c) => c.fadeIn != null || c.fadeOut != null).length;
  // The fades the edit asks for (the mix's and each dialogue clip's): words there may go quiet in the file on purpose.
  const faded: Range[] = legacy ? [] : mergeRanges([
    ...(sound.fadeIn > 0 ? [{ start: 0, end: Math.min(total, sound.fadeIn) }] : []),
    ...(sound.fadeOut > 0 ? [{ start: Math.max(0, total - sound.fadeOut), end: total }] : []),
    ...v1.flatMap((c) => {
      const p = view.clip(c.id);
      if (!p) return [];
      return [...(c.audioFadeIn ? [{ start: p.soundStart, end: p.soundStart + c.audioFadeIn }] : []), ...(c.audioFadeOut ? [{ start: p.soundEnd - c.audioFadeOut, end: p.soundEnd }] : [])];
    }),
  ]);
  if (sound.loudness != null) {
    // Loudness is set by the render: the file must be within 1 LU of the target and under the true-peak ceiling.
    if (ld?.lufs != null && Math.abs(ld.lufs - sound.loudness) > 1) flags.push(`loudness ${ld.lufs} LUFS, target ${sound.loudness}`);
    if (ld?.peakDb != null && ld.peakDb > sound.peak + 0.2) flags.push(`true peak ${ld.peakDb} dBTP over the ${sound.peak} dBTP ceiling`);
  } else if (ld?.peakDb != null && ld.peakDb > -1) flags.push(`peak ${ld.peakDb}dB (may clip)`);
  if (ld?.lufs != null && ld.lufs < -40) flags.push("sound is almost silent");

  // Text layers (Phase 4): where they sit at the preview size; one that does not fit or covers the captions is flagged.
  const [W, H] = snap.aspect === "9:16" ? [540, 960] : snap.aspect === "1:1" ? [540, 540] : [960, 540];
  const texts = (tl.tracks.v3 as (Clip & { kind?: string; text?: string; style?: TextStyle; card?: Card | null; anim?: TextAnim })[])
    .filter((c) => c.kind === "text" && c.text?.trim() && c.end - c.start >= 0.05)
    .map((c) => ({ c, lines: c.text!.split("\n"), style: c.style ?? textPreset("plain").style, card: c.card ?? null, anim: c.anim ?? "fade" }));
  const capStyle: CaptionStyle = captionStyleOf(tl, snap.aspect);
  const capD = drawnOf(capStyle, W, H);
  const capPad = capD.box?.pad ?? capD.stroke?.px ?? 0;
  const capRect = { x: W * 0.08, y: capStyle.y * H - capStyle.lines * capD.size - capPad, w: W * 0.84, h: capStyle.lines * capD.size + 2 * capPad };
  for (const x of texts) {
    const r = textRect(x, W, H);
    if (r.x < -1 || r.y < -1 || r.x + r.w > W + 1 || r.y + r.h > H + 1) flags.push(`text "${x.lines[0].slice(0, 30)}" at ${fmtT(x.c.start)} does not fit in the frame`);
    const talks = tl.captionsOn && spoken.some((w) => w.at < x.c.end && w.end > x.c.start);
    if (talks && r.x < capRect.x + capRect.w && r.x + r.w > capRect.x && r.y < capRect.y + capRect.h && r.y + r.h > capRect.y) flags.push(`text "${x.lines[0].slice(0, 30)}" at ${fmtT(x.c.start)} covers the captions`);
  }

  // Phase 5: speed, transitions, keyframes. Transitions made shorter or left out are flagged; black the edit asks for (a
  // dip, a keyframed fade) is not.
  const offSpeed = v1.filter((c) => !normalSpeed(c) && view.clip(c.id)?.pieces.length);
  const trans = planTransitions(view, new Map(v1.map((c) => [c.id, c])), (vid) => (vid === main ? tl.duration : undefined));
  for (const x of trans) if (x.note && !x.note.startsWith("first clip")) flags.push(`${x.type} at ${fmtT(x.at)} ${x.end > x.start ? `is ${(x.end - x.start).toFixed(2)}s, not ${x.asked}s` : "is left out"} (${x.note.replace(/^left out: /, "")})`);
  type Keyed = { id: string; keys: Key[] };
  const keyed: Keyed[] = [...v1, ...tl.tracks.v2, ...tl.tracks.v3].filter((c) => ((c as { keys?: Key[] }).keys ?? []).length).map((c) => ({ id: c.id, keys: (c as { keys: Key[] }).keys }));
  const asked: Range[] = [
    ...trans.filter((x) => x.type.startsWith("dip") && x.end > x.start).map((x) => ({ start: x.start - 0.1, end: x.end + 0.1 })),
    ...v1.filter((c) => c.keys?.some((k) => k.opacity != null && k.opacity < 0.5)).map((c) => { const p = view.clip(c.id)!; return { start: p.start - 0.1, end: p.end + 0.1 }; }),
  ];
  const keyProps = (ks: Key[]) => (["x", "y", "scale", "rotation", "opacity"] as const).filter((p) => ks.some((k) => k[p] != null)).join(", ");

  // Where the edit and the file disagree. Each one is a flag; "Flags: none" only when they agree.
  const fileLines: string[] = [];
  const gShown = graphics.map((g) => ({ g, on: m?.graphics.find((x) => x.clipId === g.id) }));
  // Picture without its dialogue: a muted clip.
  for (const r of mergeRanges(view.sound.filter((x) => x.muted).map((x) => ({ start: x.start, end: x.end })))) if (r.end - r.start >= 0.1) flags.push(`${(r.end - r.start).toFixed(1)}s of picture without its dialogue at ${fmtT(r.start)} (clip muted)`);
  if (m && !m.error) {
    const v = m.videoSeconds, a = m.audioSeconds;
    // The render puts every part on a frame of the output, so its length can differ from the edit's by a few frames.
    const want = opts.planned ?? total;
    if (v != null && Math.abs(v - want) > 0.1) flags.push(`file is ${v.toFixed(2)}s but the ${opts.planned != null ? "render planned" : "edit is"} ${want.toFixed(2)}s`);
    if (v != null && a != null && Math.abs(v - a) > 0.1) flags.push(`audio ${a.toFixed(2)}s vs video ${v.toFixed(2)}s (out of sync at the end)`);
    for (const b of m.black) if (!asked.some((r) => b.start >= r.start && b.end <= r.end)) flags.push(`black ${(b.end - b.start).toFixed(2)}s at ${fmtT(b.start)}`);
    // Silent in the file while the edit has someone speaking: a lost stretch of dialogue (muted clips are flagged above,
    // and words inside a fade the edit asks for may go quiet on purpose).
    const speech = minus(spoken.filter((x) => !x.muted).map((x) => x.sound ?? { start: x.at, end: x.end }), faded);
    for (const x of m.silences) {
      const hit = speech.reduce((acc, w) => acc + overlap(w, x), 0);
      if (hit >= 0.2) flags.push(`silent ${(x.end - x.start).toFixed(2)}s at ${fmtT(x.start)} where words should play`);
    }
    for (const { g, on } of gShown) {
      if (!on) flags.push(`graphic "${g.label}" at ${fmtT(g.start)} is not in the file`);
      // Invisible only when it is blank at every moment measured (a graphic that fades in or flashes is not). Older
      // checks have no count of the moments that show it: their most covered moment decides.
      else if (on.visible != null ? on.visible === 0 : (on.coverMax ?? on.coverPct) != null && (on.coverMax ?? on.coverPct)! < 0.2) flags.push(`graphic "${g.label}" at ${fmtT(on.start)} is invisible (fully transparent at ${on.samples ? `all ${on.samples} moments` : "every moment"} measured)`);
      else if (on.face && on.face.max >= 25) flags.push(`graphic "${g.label}" at ${fmtT(on.start)} covers the face (up to ${Math.round(on.face.max)}% of it, at ${fmtT(on.face.at)})`);
    }
    fileLines.push(`File: video ${v != null ? v.toFixed(2) + "s" : "missing"}, audio ${a != null ? a.toFixed(2) + "s" : "none"} | black from ${MEASURE_MIN}s: ${m.black.length ? list(m.black.map((b) => `${fmtT(b.start)} (${(b.end - b.start).toFixed(2)}s)`), 4) : "none"} | silent from ${MEASURE_MIN}s: ${m.silences.length ? `${m.silences.length}: ` + list(m.silences.map((x) => `${fmtT(x.start)} (${(x.end - x.start).toFixed(2)}s)`), 6) : "none"}`);
  } else {
    fileLines.push(`File: not measured${m?.error ? ` (${m.error})` : ""}; the lines below come from the edit only`);
  }
  const pc = (x: number) => (x < 1 ? x.toFixed(1) : String(Math.round(x)));
  const faceText = (on: FileMeasure["graphics"][number]) => on.face === undefined ? "" : on.face === null ? "; no face under it" : `; over the face up to ${pc(on.face.max)}% (${fmtT(on.face.at)})`;
  const cover = (on: FileMeasure["graphics"][number]) => on.coverPct == null ? "" : on.coverMin != null && on.coverMax != null ? ` (of frame: min ${pc(on.coverMin)}%, avg ${pc(on.coverPct)}%, max ${pc(on.coverMax)}%${on.samples ? `, shows in ${on.visible ?? "?"} of ${on.samples} moments` : ""}${faceText(on)})` : ` (${pc(on.coverPct)}% of frame)`;
  const gText = gShown.map(({ g, on }) => on ? `${fmtT(on.start)}-${fmtT(on.end)} ${g.label}${cover(on)}` : `${fmtT(g.start)} ${g.label}`);
  // Engine Part 3: the file's own sound (gaps in speech placed at the joins, clicks at the joins), the words a cut
  // goes through, and what is heard when the preview is transcribed again.
  const isCut = (vid: string, id: string) => vid === main && cut.has(id);
  const fileSound = m && !m.error && m.sound && !m.sound.error ? m.sound : null;
  const pauseLine = fileSound ? gapsLine(view, speechGaps(view, fileSound, m!.silences, total, over), over)
    : `Pauses over ${over}s: ${pauses.length ? list(pauses.map((p) => `${fmtT(p.at)} (${p.len.toFixed(1)}s)`)) : "none"}${m?.sound?.error ? ` (from the words' times: the file's sound was not measured: ${m.sound.error})` : ""}`;
  const clicks = fileSound ? joinClicks(view, fileSound) : [];
  if (clicks.length) flags.push(`${clicks.length} ${clicks.length === 1 ? "click" : "clicks"} at joins`);
  const clipped = opts.aligned ? clippedWords(view, { wordsOf, alignedOf: (v) => opts.aligned![v], isCut }) : null;
  if (clipped?.words.length) flags.push(`${clipped.words.length} ${clipped.words.length === 1 ? "word" : "words"} cut through (see Clipped words)`);
  const h = opts.heard;
  let heardLine: string | null = null;
  if (h?.status === "done" && h.words) { const ex = wordsAsPlayed(view, wordsOf, isCut, (v) => opts.aligned?.[v]); heardLine = heardDiffLine(heardDiff(ex, h.words), h.words.length, ex.length); }
  else if (h?.status === "queued" || h?.status === "transcribing") heardLine = "Heard vs the edit's words: the preview's sound is being transcribed again (get_preview_frames shows what is heard once it is done)";
  else if (h?.status === "failed") heardLine = `Heard vs the edit's words: the preview's sound could not be transcribed again (${h.error ?? "unknown error"})`;
  const look = lookText(tl);
  const head = `${snap.aspect}${look ? ` | ${look}` : ""} | ${spoken.length} words spoken${total ? `, ${Math.round((spoken.length / total) * 60)}/min` : ""}`;

  const lines = [
    m && !m.error && m.videoSeconds != null
      ? `CHECK file ${m.videoSeconds.toFixed(2)}s, edit ${(opts.planned ?? total).toFixed(2)}s of ${tl.duration.toFixed(1)}s footage | ${head}`
      : `CHECK ${total.toFixed(1)}s of ${tl.duration.toFixed(1)}s footage | ${head}`,
    ...fileLines,
    sequenceLine(tl, view),
    pauseLine,
    ...(fileSound ? [`Clicks at joins: ${clicks.length ? `${clicks.length}: ${list(clicks, 10)}` : "none"}`] : []),
    ...(clipped ? [clippedLine(clipped, main)] : []),
    ...(heardLine ? [heardLine] : []),
    `Fillers left: ${fillers.length ? list(fillers.map((x) => `"${x.w.text.replace(/[^\w'-]/g, "")}" ${fmtT(x.at)}`)) : "none"}`,
    `Captions: ${tl.captionsOn ? `on (${tl.captionStyle ? "own style: " + styleText(tl.captionStyle) : tl.captionLook}), ${coverPct}% of spoken words` : "off"}`,
    `Text: ${texts.length ? `${texts.length} ${texts.length === 1 ? "layer" : "layers"}: ` + list(texts.map((x) => `${fmtT(x.c.start)}-${fmtT(x.c.end)} ${JSON.stringify(x.lines.join(" / ").slice(0, 40))}${x.card ? " (card)" : ""}${x.anim !== "none" ? ` ${x.anim}` : ""}`), 6) : "none"}`,
    // Only when the edit uses them (short outputs).
    ...(offSpeed.length ? [`Speed: ${list(offSpeed.map((c) => `${c.id} ${speedText(c)}`), 6)}`] : []),
    ...(trans.some((x) => x.end > x.start) ? [`Transitions: ${list(trans.filter((x) => x.end > x.start).map((x) => `${fmtT(x.at)} ${x.type}${x.dir ? " " + x.dir : ""} ${(x.end - x.start).toFixed(2)}s`), 8)}`] : []),
    ...(keyed.length ? [`Keyframes: ${list(keyed.map((k) => `${k.id} ${keyProps(k.keys)}`), 6)}`] : []),
    // Phase 6: looks (grade, key, masks, blur), b-roll behind V1, and what the render said about LUTs and HDR.
    ...colorSummary(tl, opts.lutName),
    ...((tl.tracks.v2 as (Clip & { under?: boolean })[]).some((c) => c.under) ? [`Under V1: ${(tl.tracks.v2 as (Clip & { under?: boolean })[]).filter((c) => c.under).map((c) => c.id).join(", ")}`] : []),
    ...(opts.renderNotes ?? []),
    // Phase 7: what the final will be (size, codec, frame rate).
    exportText(snap, opts.footage),
    `Zooms ${zooms.length}${zooms.length ? ": " + list(zooms.map((z) => `${fmtT(z.start)} ${Math.round(Number(z.zoom || 1) * 100)}%`)) : ""} | B-roll ${broll.length}${broll.length ? ": " + list(broll.map((b) => fmtT(b.start))) : ""} | Graphics ${graphics.length}${m && !m.error ? ` (${gShown.filter((x) => x.on).length} on screen)` : ""}${graphics.length ? ": " + list(gText) : ""}`,
    `Music: ${music.length ? `${list(music.map((c) => `${c.label} ${c.gainDb ?? -18}dB`), 3)}, under ${Math.round(musicCover * 100)}% of the edit` : "none"}`,
    `Sound: ${legacy ? "mixed before Phase 3 (limiter only)" : audioText(sound)}${clipSound ? `; ${clipSound} ${clipSound === 1 ? "clip has its" : "clips have their"} own gain or fades` : ""}`,
    `Cuts ${Math.max(0, segs.length - 1)}${total ? ` (${(((segs.length - 1) / total) * 60).toFixed(1)}/min)` : ""}, shortest clip ${segs.length ? Math.min(...segs.map((x) => x.len)).toFixed(1) + "s" : "-"}${short.length ? ` at ${list(short.map((x) => fmtT(x.at)), 4)}` : ""}`,
    ...(ld ? [`Loudness of the file: ${ld.lufs != null ? ld.lufs + " LUFS" : "unknown"}, true peak ${ld.peakDb != null ? ld.peakDb + " dBTP" : "unknown"}${sound.loudness != null ? ` (target ${sound.loudness} LUFS, ceiling ${sound.peak} dBTP)` : ""}`] : []),
    ...(m && !m.error && m.momentary ? [noiseLine(noiseBetweenWords(m.momentary, fileSound ? fileSound.speech.map(([a, b]) => ({ start: a, end: b })) : spoken.map((x) => x.sound ?? { start: x.at, end: x.end }), total), music.length > 0)] : []),
    `Flags: ${flags.length ? flags.join("; ") : "none"}`,
  ];
  return lines.join("\n");
}
