// The check an AI reads after a render instead of looking at frames: what the rendered FILE measured (stream
// lengths, black and silent stretches, loudness, graphics on screen) next to what the edit says, and every place
// they disagree. Facts and fixed thresholds only, no judgement.
import { fmtT } from "./breakdown";
import { dialogueMismatch, keptRanges, makeTimeMap, type Range } from "./sequence";
import type { Clip, Snapshot } from "./timeline";
import { allWords, type Transcript } from "./transcript";

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

/** pauseOver: pauses longer than this are listed (default 0.15 s). measured: the rendered file (render_preview). */
export function editCheck(snap: Snapshot, tr: Transcript, opts: { pauseOver?: number | null; loudness?: FileLoudness | null; measured?: FileMeasure | null } = {}): string {
  const tl = snap.timeline;
  const words = allWords(tr);
  const kept = keptRanges(tl, words);
  const map = makeTimeMap(kept);
  const total = map.total;
  const cut = new Set(tl.cut);
  const inKept = (time: number) => kept.some((k) => time >= k.start && time < k.end);
  const spoken = words.filter((w) => !cut.has(w.id) && inKept(w.t));
  const at = (src: number) => fmtT(map.toOutput(src));
  const flags: string[] = [];

  // Pauses people will hear: between spoken words, and before the first and after the last word.
  const over = opts.pauseOver ?? MEASURE_MIN;
  const pauses: { at: number; len: number }[] = [];
  if (spoken.length) {
    const lead = map.toOutput(spoken[0].t);
    if (lead > over) pauses.push({ at: 0, len: lead });
    for (let i = 0; i + 1 < spoken.length; i++) {
      const a = map.toOutput(spoken[i].end), b = map.toOutput(spoken[i + 1].t);
      if (b - a > over) pauses.push({ at: a, len: b - a });
    }
    const tail = total - map.toOutput(spoken[spoken.length - 1].end);
    if (tail > over) pauses.push({ at: total - tail, len: tail });
  }
  // Pauses are listed, not flagged: how long they may be is the edit's choice (cut_silences leaves 0.16 s).

  const fillers = spoken.filter((w) => w.filler);
  if (fillers.length) flags.push(`${fillers.length} filler word${fillers.length === 1 ? "" : "s"}`);

  // Captions follow transcript lines; a deleted caption clip leaves its words without captions.
  const lineOf = new Map(tr.flatMap((l) => l.words.map((w) => [w.id, l.id] as const)));
  const captioned = new Set((tl.tracks.v3 as Clip[]).filter((c) => (c as Record<string, unknown>).kind === "caption").map((c) => String((c as Record<string, unknown>).lineId)));
  const covered = spoken.filter((w) => captioned.has(lineOf.get(w.id) || "")).length;
  const coverPct = spoken.length ? Math.round((covered / spoken.length) * 100) : 100;
  if (tl.captionsOn && coverPct < 100) flags.push(`${spoken.length - covered} spoken words without captions`);

  const v2 = tl.tracks.v2 as (Clip & Record<string, unknown>)[];
  const shown = (c: Clip) => kept.some((k) => overlap(k, c) > 0.05);
  const zooms = v2.filter((c) => c.kind === "zoom" && shown(c));
  const broll = v2.filter((c) => c.kind === "broll" && shown(c));
  const graphics = (tl.tracks.v3 as (Clip & Record<string, unknown>)[]).filter((c) => c.kind === "graphic" && shown(c));
  const music = (tl.tracks.a2 as (Clip & Record<string, unknown>)[]).filter(shown);
  const musicCover = total ? kept.reduce((a, k) => a + Math.min(k.end - k.start, music.reduce((m, c) => m + overlap(k, c), 0)), 0) / total : 0;

  const segs = kept.map((k) => ({ at: map.toOutput(k.start), len: k.end - k.start }));
  const short = segs.filter((s) => s.len < 0.5);
  if (short.length) flags.push(`${short.length} clip${short.length === 1 ? "" : "s"} under 0.5s`);
  const m = opts.measured ?? null;
  const ld = m && !m.error ? m : opts.loudness;
  if (ld?.peakDb != null && ld.peakDb > -1) flags.push(`peak ${ld.peakDb}dB (may clip)`);
  if (ld?.lufs != null && ld.lufs < -40) flags.push("sound is almost silent");

  // Where the edit and the file disagree. Each one is a flag; "Flags: none" only when they agree.
  const fileLines: string[] = [];
  const gShown = graphics.map((g) => ({ g, on: m?.graphics.find((x) => x.clipId === g.id) }));
  // Picture without its dialogue: kept V1 that no A1 clip covers (the render mutes it).
  for (const r of dialogueMismatch(tl, words).muted) flags.push(`${(r.end - r.start).toFixed(1)}s of picture without its dialogue at ${at(r.start)} (A1 does not cover V1)`);
  if (m && !m.error) {
    const v = m.videoSeconds, a = m.audioSeconds;
    if (v != null && Math.abs(v - total) > 0.1) flags.push(`file is ${v.toFixed(2)}s but the edit is ${total.toFixed(2)}s`);
    if (v != null && a != null && Math.abs(v - a) > 0.1) flags.push(`audio ${a.toFixed(2)}s vs video ${v.toFixed(2)}s (out of sync at the end)`);
    for (const b of m.black) flags.push(`black ${(b.end - b.start).toFixed(2)}s at ${fmtT(b.start)}`);
    // Silent in the file while the edit has someone speaking: a muted or lost stretch of dialogue.
    const speech = spoken.map((w) => ({ start: map.toOutput(w.t), end: map.toOutput(w.end) }));
    for (const x of m.silences) {
      const hit = speech.reduce((acc, w) => acc + overlap(w, x), 0);
      if (hit >= 0.2) flags.push(`silent ${(x.end - x.start).toFixed(2)}s at ${fmtT(x.start)} where words should play`);
    }
    for (const { g, on } of gShown) {
      if (!on) flags.push(`graphic "${g.label}" at ${at(g.start)} is not in the file`);
      else if (on.coverPct != null && on.coverPct < 0.2) flags.push(`graphic "${g.label}" at ${fmtT(on.start)} is invisible (fully transparent)`);
    }
    fileLines.push(`File: video ${v != null ? v.toFixed(2) + "s" : "missing"}, audio ${a != null ? a.toFixed(2) + "s" : "none"} | black from ${MEASURE_MIN}s: ${m.black.length ? list(m.black.map((b) => `${fmtT(b.start)} (${(b.end - b.start).toFixed(2)}s)`), 4) : "none"} | silent from ${MEASURE_MIN}s: ${m.silences.length ? `${m.silences.length}: ` + list(m.silences.map((x) => `${fmtT(x.start)} (${(x.end - x.start).toFixed(2)}s)`), 6) : "none"}`);
  } else {
    fileLines.push(`File: not measured${m?.error ? ` (${m.error})` : ""}; the lines below come from the edit only`);
  }
  const gText = gShown.map(({ g, on }) => on ? `${fmtT(on.start)}-${fmtT(on.end)} ${g.label}${on.coverPct != null ? ` (${on.coverPct < 1 ? on.coverPct.toFixed(1) : Math.round(on.coverPct)}% of frame)` : ""}` : `${at(g.start)} ${g.label}`);

  const lines = [
    m && !m.error && m.videoSeconds != null
      ? `CHECK file ${m.videoSeconds.toFixed(2)}s, edit ${total.toFixed(2)}s of ${tl.duration.toFixed(1)}s footage | ${snap.aspect} | ${spoken.length} words spoken${total ? `, ${Math.round((spoken.length / total) * 60)}/min` : ""}`
      : `CHECK ${total.toFixed(1)}s of ${tl.duration.toFixed(1)}s footage | ${snap.aspect} | ${spoken.length} words spoken${total ? `, ${Math.round((spoken.length / total) * 60)}/min` : ""}`,
    ...fileLines,
    `Pauses over ${over}s: ${pauses.length ? list(pauses.map((p) => `${fmtT(p.at)} (${p.len.toFixed(1)}s)`)) : "none"}`,
    `Fillers left: ${fillers.length ? list(fillers.map((w) => `"${w.text.replace(/[^\w'-]/g, "")}" ${at(w.t)}`)) : "none"}`,
    `Captions: ${tl.captionsOn ? `on (${tl.captionLook}), ${coverPct}% of spoken words` : "off"}`,
    `Zooms ${zooms.length}${zooms.length ? ": " + list(zooms.map((z) => `${at(z.start)} ${Math.round(Number(z.zoom || 1) * 100)}%`)) : ""} | B-roll ${broll.length}${broll.length ? ": " + list(broll.map((b) => at(b.start))) : ""} | Graphics ${graphics.length}${m && !m.error ? ` (${gShown.filter((x) => x.on).length} on screen)` : ""}${graphics.length ? ": " + list(gText) : ""}`,
    `Music: ${music.length ? `${list(music.map((m) => `${m.label} ${m.gainDb ?? -18}dB`), 3)}, under ${Math.round(musicCover * 100)}% of the edit` : "none"}`,
    `Cuts ${Math.max(0, kept.length - 1)}${total ? ` (${(((kept.length - 1) / total) * 60).toFixed(1)}/min)` : ""}, shortest clip ${segs.length ? Math.min(...segs.map((s) => s.len)).toFixed(1) + "s" : "-"}${short.length ? ` at ${list(short.map((s) => fmtT(s.at)), 4)}` : ""}`,
    ...(ld ? [`Loudness of the file: ${ld.lufs != null ? ld.lufs + " LUFS" : "unknown"}, peak ${ld.peakDb != null ? ld.peakDb + "dB" : "unknown"}`] : []),
    `Flags: ${flags.length ? flags.join("; ") : "none"}`,
  ];
  return lines.join("\n");
}
