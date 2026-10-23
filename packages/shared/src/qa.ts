// The check an AI reads after a render instead of looking at frames: what the rendered FILE measured (stream
// lengths, black and silent stretches, loudness, graphics on screen) next to what the edit says, and every place
// they disagree. Facts and fixed thresholds only, no judgement.
import { fmtT } from "./breakdown";
import { lookText } from "./ops";
import { asSequence, layoutTimeline, mergeRanges, sequenceView, type Range, type SeqClip, type SequenceView } from "./sequence";
import type { Clip, Snapshot, Timeline } from "./timeline";
import { allWords, type Transcript, type Word } from "./transcript";

export type FileLoudness = { lufs: number | null; peakDb: number | null };
/** What the worker measured in a rendered file (edit seconds). */
export type FileMeasure = FileLoudness & {
  videoSeconds: number | null;
  audioSeconds: number | null;
  black: Range[];    // black picture, 0.15 s or longer
  silences: Range[]; // silence (below -45 dB), 0.15 s or longer
  /** Each graphic overlaid: where it is on screen and how much of the frame its picture covers on average (0-100). */
  graphics: { clipId: string; start: number; end: number; coverPct: number | null }[];
  error?: string;
};
export const MEASURE_MIN = 0.15;

/** Reads blackdetect, silencedetect and ebur128 output from one FFmpeg pass. Open stretches close at `fileEnd`. */
export function parseMeasureLog(stderr: string, fileEnd: number): Pick<FileMeasure, "black" | "silences" | "lufs" | "peakDb"> {
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
  return { black: black.filter((b) => b.end - b.start >= MEASURE_MIN - 1e-6), silences: silences.filter((x) => x.end - x.start >= MEASURE_MIN - 1e-6), lufs: num(/I:\s+(-?[\d.]+) LUFS/), peakDb: num(/Peak:\s+(-?[\d.]+) dBFS/) };
}

const overlap = (a: Range, b: Range) => Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
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

/**
 * pauseOver: pauses longer than this are listed (default 0.15 s). measured: the rendered file (render_preview).
 * transcripts: other videos on V1 (their words count as spoken). videoId: the project's footage (an old timeline).
 */
export function editCheck(snap: Snapshot, tr: Transcript, opts: { pauseOver?: number | null; loudness?: FileLoudness | null; measured?: FileMeasure | null; transcripts?: Record<string, Transcript>; videoId?: string } = {}): string {
  const words = allWords(tr);
  const tl = layoutTimeline(asSequence(snap.timeline, words, opts.videoId), words);
  const view = sequenceView(tl, words);
  const main = view.mainVideoId;
  const total = view.total;
  const cut = new Set(tl.cut);
  const wordsOf = (vid: string) => (vid === main ? words : allWords(opts.transcripts?.[vid] ?? []));
  // What is said in the edit, in edit order: the words of every stretch of dialogue (muted ones are in the edit, silent).
  const spoken: { w: Word; vid: string; at: number; end: number; muted: boolean }[] = [];
  for (const s of view.sound) {
    for (const w of wordsOf(s.videoId)) {
      if ((s.videoId === main && cut.has(w.id)) || w.t < s.srcIn || w.t >= s.srcOut) continue;
      spoken.push({ w, vid: s.videoId, at: s.start + (w.t - s.srcIn), end: s.start + (Math.min(w.end, s.srcOut) - s.srcIn), muted: s.muted });
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

  const segs = view.picture.map((p) => ({ at: p.start, len: p.end - p.start }));
  const short = segs.filter((x) => x.len < 0.5);
  if (short.length) flags.push(`${short.length} clip${short.length === 1 ? "" : "s"} under 0.5s`);
  const m = opts.measured ?? null;
  const ld = m && !m.error ? m : opts.loudness;
  if (ld?.peakDb != null && ld.peakDb > -1) flags.push(`peak ${ld.peakDb}dB (may clip)`);
  if (ld?.lufs != null && ld.lufs < -40) flags.push("sound is almost silent");

  // Where the edit and the file disagree. Each one is a flag; "Flags: none" only when they agree.
  const fileLines: string[] = [];
  const gShown = graphics.map((g) => ({ g, on: m?.graphics.find((x) => x.clipId === g.id) }));
  // Picture without its dialogue: a muted clip.
  for (const r of mergeRanges(view.sound.filter((x) => x.muted).map((x) => ({ start: x.start, end: x.end })))) if (r.end - r.start >= 0.1) flags.push(`${(r.end - r.start).toFixed(1)}s of picture without its dialogue at ${fmtT(r.start)} (clip muted)`);
  if (m && !m.error) {
    const v = m.videoSeconds, a = m.audioSeconds;
    if (v != null && Math.abs(v - total) > 0.1) flags.push(`file is ${v.toFixed(2)}s but the edit is ${total.toFixed(2)}s`);
    if (v != null && a != null && Math.abs(v - a) > 0.1) flags.push(`audio ${a.toFixed(2)}s vs video ${v.toFixed(2)}s (out of sync at the end)`);
    for (const b of m.black) flags.push(`black ${(b.end - b.start).toFixed(2)}s at ${fmtT(b.start)}`);
    // Silent in the file while the edit has someone speaking: a lost stretch of dialogue (muted clips are flagged above).
    const speech = spoken.filter((x) => !x.muted).map((x) => ({ start: x.at, end: x.end }));
    for (const x of m.silences) {
      const hit = speech.reduce((acc, w) => acc + overlap(w, x), 0);
      if (hit >= 0.2) flags.push(`silent ${(x.end - x.start).toFixed(2)}s at ${fmtT(x.start)} where words should play`);
    }
    for (const { g, on } of gShown) {
      if (!on) flags.push(`graphic "${g.label}" at ${fmtT(g.start)} is not in the file`);
      else if (on.coverPct != null && on.coverPct < 0.2) flags.push(`graphic "${g.label}" at ${fmtT(on.start)} is invisible (fully transparent)`);
    }
    fileLines.push(`File: video ${v != null ? v.toFixed(2) + "s" : "missing"}, audio ${a != null ? a.toFixed(2) + "s" : "none"} | black from ${MEASURE_MIN}s: ${m.black.length ? list(m.black.map((b) => `${fmtT(b.start)} (${(b.end - b.start).toFixed(2)}s)`), 4) : "none"} | silent from ${MEASURE_MIN}s: ${m.silences.length ? `${m.silences.length}: ` + list(m.silences.map((x) => `${fmtT(x.start)} (${(x.end - x.start).toFixed(2)}s)`), 6) : "none"}`);
  } else {
    fileLines.push(`File: not measured${m?.error ? ` (${m.error})` : ""}; the lines below come from the edit only`);
  }
  const gText = gShown.map(({ g, on }) => on ? `${fmtT(on.start)}-${fmtT(on.end)} ${g.label}${on.coverPct != null ? ` (${on.coverPct < 1 ? on.coverPct.toFixed(1) : Math.round(on.coverPct)}% of frame)` : ""}` : `${fmtT(g.start)} ${g.label}`);
  const look = lookText(tl);
  const head = `${snap.aspect}${look ? ` | ${look}` : ""} | ${spoken.length} words spoken${total ? `, ${Math.round((spoken.length / total) * 60)}/min` : ""}`;

  const lines = [
    m && !m.error && m.videoSeconds != null
      ? `CHECK file ${m.videoSeconds.toFixed(2)}s, edit ${total.toFixed(2)}s of ${tl.duration.toFixed(1)}s footage | ${head}`
      : `CHECK ${total.toFixed(1)}s of ${tl.duration.toFixed(1)}s footage | ${head}`,
    ...fileLines,
    sequenceLine(tl, view),
    `Pauses over ${over}s: ${pauses.length ? list(pauses.map((p) => `${fmtT(p.at)} (${p.len.toFixed(1)}s)`)) : "none"}`,
    `Fillers left: ${fillers.length ? list(fillers.map((x) => `"${x.w.text.replace(/[^\w'-]/g, "")}" ${fmtT(x.at)}`)) : "none"}`,
    `Captions: ${tl.captionsOn ? `on (${tl.captionLook}), ${coverPct}% of spoken words` : "off"}`,
    `Zooms ${zooms.length}${zooms.length ? ": " + list(zooms.map((z) => `${fmtT(z.start)} ${Math.round(Number(z.zoom || 1) * 100)}%`)) : ""} | B-roll ${broll.length}${broll.length ? ": " + list(broll.map((b) => fmtT(b.start))) : ""} | Graphics ${graphics.length}${m && !m.error ? ` (${gShown.filter((x) => x.on).length} on screen)` : ""}${graphics.length ? ": " + list(gText) : ""}`,
    `Music: ${music.length ? `${list(music.map((c) => `${c.label} ${c.gainDb ?? -18}dB`), 3)}, under ${Math.round(musicCover * 100)}% of the edit` : "none"}`,
    `Cuts ${Math.max(0, segs.length - 1)}${total ? ` (${(((segs.length - 1) / total) * 60).toFixed(1)}/min)` : ""}, shortest clip ${segs.length ? Math.min(...segs.map((x) => x.len)).toFixed(1) + "s" : "-"}${short.length ? ` at ${list(short.map((x) => fmtT(x.at)), 4)}` : ""}`,
    ...(ld ? [`Loudness of the file: ${ld.lufs != null ? ld.lufs + " LUFS" : "unknown"}, peak ${ld.peakDb != null ? ld.peakDb + "dB" : "unknown"}`] : []),
    `Flags: ${flags.length ? flags.join("; ") : "none"}`,
  ];
  return lines.join("\n");
}
