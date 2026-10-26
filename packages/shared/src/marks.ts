// Marks: what Rendrr (or the AI) noticed in the footage, with exact times. A mark never changes the video: the AI
// reads them and decides what to cut, with explicit edits. Rendrr's own marks come from the footage analysis (the
// same for every edit of that footage, never stored in an edit); the AI's marks, and its notes on Rendrr's, are kept
// with the edit (timeline.marks, timeline.markEdits) and so go back with undo. Times are seconds of the footage
// (videoId), so a mark stays on its moment whatever the edit does; reads add the edit time where it plays.
import type { Breakdown } from "./breakdown";
import type { Mark, MarkEdit, Timeline } from "./timeline";
import type { Line, Silence, Transcript, Word } from "./transcript";
import { editOf, srcAt, type SequenceView } from "./sequence";

/** A Rendrr mark with what only it carries (a silence's level, a filler's word). */
export type FootageMark = Mark & { level_db?: number | null; wordId?: string; text?: string };

const r3 = (n: number) => Math.round(n * 1000) / 1000;
/** Short and stable: the same footage gives the same ids, and two videos never share one. */
const tagOf = (videoId: string) => videoId.slice(-4);
const idFor = (prefix: string, t: number, videoId: string) => `${prefix}_${Math.round(t * 1000)}_${tagOf(videoId)}`;
/** Ids Rendrr gives its own marks (an AI's mark gets "mk_…"). */
export const RENDRR_MARK = /^(sil|fil|rt|stb|fs|dir|scn|beat|dark|loud)_/;

export type FootageInput = {
  videoId: string;
  transcript: Transcript;
  /** Silences the audio analysis found (no speech, below about -35 dB, 0.4 s or longer). */
  silences: Silence[];
  sceneCuts?: number[];
  /** Loudness in dB per second from 0 s (the breakdown's). */
  loudnessDb?: number[];
  beats?: number[];
  /** Stretches of footage the breakdown calls dark. */
  dark?: { start: number; end: number }[];
  /** The video's length: the silence after the last word runs to it. */
  duration?: number;
};

// ---------------------------------------------------------------------------------------------
// Silences: between words (the transcript) and where there is no speech at all (the audio).
// ---------------------------------------------------------------------------------------------
export const SILENCE_MIN = 0.15;
export function silenceMarks(f: FootageInput): FootageMark[] {
  const words = f.transcript.flatMap((l) => l.words);
  const out: FootageMark[] = [];
  const quiet = (a: number, b: number) => f.silences.some((s) => s.start <= a + 0.05 && s.end >= b - 0.05);
  // Before the first word, between words, after the last word.
  for (let i = 0; i <= words.length; i++) {
    const a = i === 0 ? 0 : words[i - 1].end, b = i === words.length ? (words.length ? Math.max(a, f.duration ?? 0, ...f.silences.map((s) => s.end)) : 0) : words[i].t;
    if (b - a >= SILENCE_MIN) out.push({ id: idFor("sil", a, f.videoId), kind: "silence", videoId: f.videoId, start: r3(a), end: r3(b), source: "rendrr", confidence: quiet(a, b) ? 0.95 : 0.7, level_db: quiet(a, b) ? -35 : null, label: i === 0 ? "before the first word" : i === words.length ? "after the last word" : "between words" });
  }
  // The audio's own silences where the transcript has no words (nothing said for a while: not between two words).
  for (const s of f.silences) {
    if (words.some((w) => w.t < s.end && w.end > s.start)) continue;
    if (out.some((m) => m.start <= s.start + 0.05 && m.end >= s.end - 0.05)) continue;
    out.push({ id: idFor("sil", s.start, f.videoId), kind: "silence", videoId: f.videoId, start: r3(s.start), end: r3(s.end), source: "rendrr", confidence: 0.95, level_db: -35, label: "no speech" });
  }
  return out.sort((a, b) => a.start - b.start);
}

export function fillerMarks(f: FootageInput): FootageMark[] {
  return f.transcript.flatMap((l) => l.words).filter((w) => w.filler).map((w) => ({ id: `fil_${w.id}_${tagOf(f.videoId)}`, kind: "filler" as const, videoId: f.videoId, start: r3(w.t), end: r3(w.end), source: "rendrr" as const, confidence: 0.9, wordId: w.id, text: w.text, label: w.text }));
}

// ---------------------------------------------------------------------------------------------
// Retakes, stumbles, false starts and notes to the crew, read from what was said. Measurements and groups only:
// Rendrr never picks a take.
// ---------------------------------------------------------------------------------------------
const norm = (w: Word) => w.text.toLowerCase().replace(/[^\p{L}\p{N}']+/gu, "");
const tokens = (l: Line) => l.words.filter((w) => !w.filler).map(norm).filter(Boolean);
const bigrams = (ts: string[]) => new Set(ts.slice(1).map((t, i) => ts[i] + " " + t));

/** How alike two lines are (0-1): the words they start with, and the word pairs they share. */
export function lineSimilarity(a: string[], b: string[]): number {
  if (!a.length || !b.length) return 0;
  let lcp = 0;
  while (lcp < a.length && lcp < b.length && a[lcp] === b[lcp]) lcp++;
  const pa = bigrams(a), pb = bigrams(b);
  let shared = 0;
  for (const p of pa) if (pb.has(p)) shared++;
  const overlap = Math.min(pa.size, pb.size) ? shared / Math.min(pa.size, pb.size) : 0;
  const prefix = lcp >= 3 ? Math.min(1, 0.55 + lcp / 10) : 0;
  return Math.round(Math.max(overlap * (Math.min(a.length, b.length) >= 4 ? 1 : 0.6), prefix) * 100) / 100;
}

export type Take = { lineId: string; start: number; end: number; text: string; words: number; fillers: number; stumbles: number; wpm: number; loudness: number | null; pitch_var: number | null; confidence: number; score: number };
export type RetakeGroup = { groupId: string; takes: Take[] };

/** Repeated words ("I I", "the the"), a cut-off word before the full one ("buil building"), a repeated pair. */
export function stumblesIn(words: Word[]): { start: number; end: number; text: string }[] {
  const ws = words.filter((w) => !w.filler), out: { start: number; end: number; text: string }[] = [];
  for (let i = 0; i + 1 < ws.length; i++) {
    const a = norm(ws[i]), b = norm(ws[i + 1]);
    if (!a || !b || ws[i + 1].t - ws[i].end > 1) continue;
    const pair = i + 3 < ws.length && a === norm(ws[i + 2]) && b === norm(ws[i + 3]) && a !== b;
    if (a === b || (a.length >= 2 && b.length > a.length && b.startsWith(a)) || pair) {
      const last = pair ? ws[i + 3] : ws[i + 1];
      out.push({ start: ws[i].t, end: last.end, text: (pair ? [ws[i], ws[i + 1], ws[i + 2], ws[i + 3]] : [ws[i], ws[i + 1]]).map((w) => w.text).join(" ") });
      i += pair ? 3 : 1;
    }
  }
  return out;
}

const DIRECTOR = /\b(cut (that|this|it)( out)?|let me (start|try|do|say|redo) (that |this |it )?(again|over)|let me redo (that|this|it)|(one|1) more time|start (over|again)|from the top|take (two|2|three|3|four|4)|scratch that|hold on|wait,? wait|redo (that|this)|i('ll| will) (do|say) (that|this|it) again|let me (rephrase|restart)( that| this| it)?|let's (do|try) (that|this|it) again|let me go again)\b/i;

const lineText = (l: Line) => l.words.map((w) => w.text).join(" ");
const meanDb = (db: number[] | undefined, a: number, b: number) => {
  if (!db?.length) return null;
  const xs = db.slice(Math.max(0, Math.floor(a)), Math.max(Math.floor(a) + 1, Math.ceil(b))).filter((x) => Number.isFinite(x));
  return xs.length ? Math.round((xs.reduce((s, x) => s + x, 0) / xs.length) * 10) / 10 : null;
};

/**
 * Lines that say the same thing, close in time: a speaker's retakes. Two lines are takes of one another when they
 * start with the same 3 words or share most of their word pairs, within 120 s and 8 lines; groups join takes of
 * takes. Each take is measured (fillers, stumbles, words a minute, loudness) and scored 0-1 (complete, few fillers and
 * stumbles, ends a sentence): a measurement to read, never a choice made for the AI.
 */
export function findRetakes(f: FootageInput): RetakeGroup[] {
  const lines = f.transcript.filter((l) => tokens(l).length >= 2);
  const parent = lines.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const sim = new Map<number, number>();
  for (let i = 0; i < lines.length; i++) {
    const a = tokens(lines[i]);
    for (let j = i + 1; j < lines.length && j <= i + 8 && lines[j].start - lines[i].end <= 120; j++) {
      const s = lineSimilarity(a, tokens(lines[j]));
      if (s >= 0.6) { parent[find(j)] = find(i); sim.set(i, Math.max(sim.get(i) ?? 0, s)); sim.set(j, Math.max(sim.get(j) ?? 0, s)); }
    }
  }
  const groups = new Map<number, number[]>();
  lines.forEach((_, i) => { if (sim.has(i)) { const r = find(i); groups.set(r, [...(groups.get(r) ?? []), i]); } });
  return Array.from(groups.values()).filter((g) => g.length >= 2).map((g, gi) => {
    const most = Math.max(...g.map((i) => tokens(lines[i]).length));
    return {
      groupId: `rt${gi + 1}`,
      takes: g.map((i) => {
        const l = lines[i], n = tokens(l).length, dur = Math.max(0.1, l.end - l.start);
        const fillers = l.words.filter((w) => w.filler).length, stumbles = stumblesIn(l.words).length;
        const ends = /[.!?]["')\]]*$/.test(l.words[l.words.length - 1]?.text ?? "");
        const score = 0.5 * (n / most) + 0.2 * (1 - Math.min(1, fillers / 3)) + 0.2 * (1 - Math.min(1, stumbles / 2)) + 0.1 * (ends ? 1 : 0);
        return { lineId: l.id, start: r3(l.start), end: r3(l.end), text: lineText(l), words: n, fillers, stumbles, wpm: Math.round((n / dur) * 60), loudness: meanDb(f.loudnessDb, l.start, l.end), pitch_var: null, confidence: sim.get(i) ?? 0, score: Math.round(score * 100) / 100 };
      }),
    };
  });
}

/** Retakes, stumbles, false starts and notes to the crew as marks. */
export function speechMarks(f: FootageInput, groups = findRetakes(f)): FootageMark[] {
  const out: FootageMark[] = [];
  for (const g of groups) g.takes.forEach((t, k) => out.push({ id: idFor("rt", t.start, f.videoId), kind: "retake", videoId: f.videoId, start: t.start, end: t.end, source: "rendrr", confidence: t.confidence, label: `${g.groupId} take ${k + 1} of ${g.takes.length}`, note: `score ${t.score}: ${t.words} words, ${t.fillers} fillers, ${t.stumbles} stumbles, ${t.wpm} wpm` }));
  const lines = f.transcript;
  lines.forEach((l, i) => {
    for (const s of stumblesIn(l.words)) out.push({ id: idFor("stb", s.start, f.videoId), kind: "stumble", videoId: f.videoId, start: r3(s.start), end: r3(s.end), source: "rendrr", confidence: 0.8, label: s.text });
    // A short line, or one that stops mid-sentence, then a line that starts the same way within 4 s: a false start.
    const a = tokens(l), next = lines[i + 1];
    if (next && a.length && next.start - l.end <= 4) {
      const b = tokens(next);
      let same = 0;
      while (same < a.length && same < b.length && a[same] === b[same]) same++;
      const unfinished = !/[.!?]["')\]]*$/.test(l.words[l.words.length - 1]?.text ?? "");
      if (same >= 2 && (a.length <= 8 || unfinished) && b.length > same) out.push({ id: idFor("fs", l.start, f.videoId), kind: "false_start", videoId: f.videoId, start: r3(l.start), end: r3(l.end), source: "rendrr", confidence: unfinished ? 0.8 : 0.6, label: lineText(l).slice(0, 120), note: `restarted at ${r3(next.start)}s` });
    }
    // The same opening said twice inside one line ("so today I so today I want to").
    for (let k = 2; k <= 5 && 2 * k <= a.length; k++) {
      if (a.slice(0, k).join(" ") === a.slice(k, 2 * k).join(" ")) {
        const ws = l.words.filter((w) => !w.filler);
        out.push({ id: idFor("fs", ws[0].t, f.videoId), kind: "false_start", videoId: f.videoId, start: r3(ws[0].t), end: r3(ws[k - 1].end), source: "rendrr", confidence: 0.8, label: ws.slice(0, k).map((w) => w.text).join(" "), note: `restarted at ${r3(ws[k].t)}s` });
        break;
      }
    }
    const said = DIRECTOR.exec(lineText(l));
    if (said) out.push({ id: idFor("dir", l.start, f.videoId), kind: "director_note", videoId: f.videoId, start: r3(l.start), end: r3(l.end), source: "rendrr", confidence: 0.7, label: said[0], note: lineText(l).slice(0, 200) });
  });
  return out;
}

/** Shot changes, a steady beat, dark stretches and loud moments (from the breakdown). */
export function pictureMarks(f: FootageInput): FootageMark[] {
  const out: FootageMark[] = [];
  for (const t of f.sceneCuts ?? []) out.push({ id: idFor("scn", t, f.videoId), kind: "scene_change", videoId: f.videoId, start: r3(t), end: r3(t), source: "rendrr", confidence: 0.8 });
  for (const t of f.beats ?? []) out.push({ id: idFor("beat", t, f.videoId), kind: "music_beat", videoId: f.videoId, start: r3(t), end: r3(t), source: "rendrr", confidence: 0.6 });
  for (const d of f.dark ?? []) out.push({ id: idFor("dark", d.start, f.videoId), kind: "low_light", videoId: f.videoId, start: r3(d.start), end: r3(d.end), source: "rendrr", confidence: 0.7, label: "dark shot" });
  // Seconds far louder than the speech around them (9 dB over the median): a shout, a bang, a bump on the mic.
  const db = (f.loudnessDb ?? []).filter((x) => Number.isFinite(x) && x > -60);
  if (db.length >= 5) {
    const med = [...db].sort((a, b) => a - b)[db.length >> 1];
    (f.loudnessDb ?? []).forEach((x, s) => { if (Number.isFinite(x) && x > med + 9) out.push({ id: idFor("loud", s, f.videoId), kind: "loud_peak", videoId: f.videoId, start: s, end: s + 1, source: "rendrr", confidence: 0.6, label: `${Math.round(x)} dB (speech around ${Math.round(med)} dB)` }); });
  }
  return out;
}

/** Every mark Rendrr makes for one video, in time order (one per id). */
export function footageMarks(f: FootageInput): FootageMark[] {
  const seen = new Set<string>();
  return [...silenceMarks(f), ...fillerMarks(f), ...speechMarks(f), ...pictureMarks(f)].filter((m) => !seen.has(m.id) && !!seen.add(m.id)).sort((a, b) => a.start - b.start || a.kind.localeCompare(b.kind));
}

/** What the marks read from a video's stored analysis (transcript, silences, scene cuts and the breakdown). */
export function footageInputOf(videoId: string, a: { transcript?: unknown; silences?: unknown; sceneCuts?: unknown; breakdown?: unknown } | null | undefined, duration?: number): FootageInput {
  const b = a?.breakdown as Breakdown | null | undefined;
  return {
    videoId,
    duration,
    transcript: (a?.transcript as Transcript) || [],
    silences: (a?.silences as Silence[]) || [],
    sceneCuts: (a?.sceneCuts as number[]) || [],
    loudnessDb: b?.audio?.loudnessDb,
    beats: b?.audio?.beat?.beats,
    dark: (b?.shots ?? []).filter((s) => s.light === "dark").map((s) => ({ start: s.start, end: s.end })),
  };
}

// ---------------------------------------------------------------------------------------------
// The marks of an edit: Rendrr's on each of its videos, with the AI's notes on them, and the AI's own.
// ---------------------------------------------------------------------------------------------
export type MarkRow = FootageMark & { hidden?: boolean; edit?: { start: number; end: number; partly: boolean } | null };

export function marksOf(inputs: FootageInput[], tl?: Pick<Timeline, "marks" | "markEdits" | "mainVideoId"> | null, view?: SequenceView | null): MarkRow[] {
  const notes: Record<string, MarkEdit> = tl?.markEdits ?? {};
  const main = tl?.mainVideoId || inputs[0]?.videoId || "main";
  const rows: MarkRow[] = inputs.flatMap((f) => footageMarks(f)).map((m) => {
    const e = notes[m.id];
    return e ? { ...m, ...(e.label != null ? { label: e.label } : {}), ...(e.note != null ? { note: e.note } : {}), ...(e.hidden ? { hidden: true } : {}) } : m;
  });
  for (const m of tl?.marks ?? []) rows.push({ ...m, videoId: m.videoId || main });
  if (view) for (const r of rows) r.edit = markInEdit(view, r.videoId || main, r.start, r.end);
  return rows.sort((a, b) => a.start - b.start || a.kind.localeCompare(b.kind));
}

/** Seconds as short as they go, to the millisecond (1, 2.5, 3.125). */
const ms = (n: number) => String(r3(n));
/** Where a mark plays in the edit, as text: "edit 12.34-13.5", "cut" (not in the edit), "partly cut". */
export const editText = (r: MarkRow) => (r.edit === undefined ? "" : r.edit === null ? " | cut" : ` | edit ${ms(r.edit.start)}${r.edit.end > r.edit.start ? `-${ms(r.edit.end)}` : ""}${r.edit.partly ? " partly cut" : ""}`);
/** One mark per line, short: id kind start-end source confidence "label" note | edit place. */
export function marksText(rows: MarkRow[], o: { video?: boolean } = {}): string {
  return rows.map((r) => `${r.id} ${r.kind}${o.video ? ` ${r.videoId}` : ""} ${ms(r.start)}${r.end > r.start ? `-${ms(r.end)}` : ""} ${r.source}${r.confidence != null ? ` ${r.confidence}` : ""}${r.hidden ? " hidden" : ""}${r.label ? ` "${r.label}"` : ""}${r.note ? ` (${r.note})` : ""}${editText(r)}`).join("\n");
}


// ---------------------------------------------------------------------------------------------
// Where a mark plays in the edit.
// ---------------------------------------------------------------------------------------------
/** The edit time a footage range plays at (its first to its last moment that plays), or null when all of it is cut. */
export function markInEdit(view: SequenceView, videoId: string, start: number, end: number): { start: number; end: number; partly: boolean } | null {
  let s: number | null = null, e: number | null = null, played = 0;
  for (const p of view.pieces) {
    if (p.videoId !== videoId) continue;
    const a = Math.max(start, p.srcIn), b = Math.min(Math.max(end, start + 1e-6), p.srcOut);
    if (b < a || (b === a && start !== end)) continue;
    const ea = editOf(p, a), eb = editOf(p, b);
    s = s == null ? Math.min(ea, eb) : Math.min(s, ea, eb);
    e = e == null ? Math.max(ea, eb) : Math.max(e, ea, eb);
    played += b - a;
  }
  if (s == null || e == null) return null;
  return { start: r3(s), end: r3(e), partly: end - start > 0.001 && played < end - start - 0.01 };
}

/** The footage moment (video and seconds) playing at edit time t. side "end": the moment a range ending at t ends on
 *  (the piece playing just before t, so an end on a cut stays in the clip before it). */
export function editToFootage(view: SequenceView, t: number, side: "start" | "end" = "start"): { videoId: string; t: number } | null {
  const p = view.pieceAt(side === "end" ? Math.max(0, t - 1e-4) : t);
  return p ? { videoId: p.videoId, t: r3(srcAt(p, Math.min(Math.max(t, p.start), p.end))) } : null;
}
