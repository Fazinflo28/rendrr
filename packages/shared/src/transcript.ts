import { FILLER_PHRASES, FILLER_WORDS } from "./constants";

// Same shape as the UI's buildTranscript(): lines -> words with t (start), text, filler.
// `end` is extra: the UI ignores it, the renderer uses it.
export type Word = { id: string; text: string; t: number; end: number; filler: boolean };
export type Line = { id: string; start: number; end: number; gapBefore: number; words: Word[] };
export type Transcript = Line[];
export type Silence = { start: number; end: number };
export type KeyFrame = { t: number; key: string };

export type RawWord = { text: string; start: number; end: number };

const clean = (s: string) => s.toLowerCase().replace(/[^a-z']/g, "");

/** Marks um, uh, like, basically, honestly, and both words of "you know". */
export function markFillers(words: RawWord[]): boolean[] {
  const flags = words.map((w) => (FILLER_WORDS as readonly string[]).includes(clean(w.text)));
  for (const phrase of FILLER_PHRASES) {
    for (let i = 0; i + phrase.length <= words.length; i++) {
      if (phrase.every((p, k) => clean(words[i + k].text) === p)) for (let k = 0; k < phrase.length; k++) flags[i + k] = true;
    }
  }
  return flags;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Builds lines from sentence groups of raw words. Word ids are w0..wN and line ids l0..lN, stable for
 * a given analysis, because project cut lists refer to them.
 * gapBefore is the silence before a line, shown in the UI when it is long enough to matter.
 */
export function buildTranscript(sentences: RawWord[][], { minGap = 0.8, maxWordsPerLine = 18 } = {}): Transcript {
  // Split very long sentences so a line stays readable as one caption block.
  const groups: RawWord[][] = [];
  for (const s of sentences) {
    if (!s.length) continue;
    for (let i = 0; i < s.length; i += maxWordsPerLine) groups.push(s.slice(i, i + maxWordsPerLine));
  }
  const all = groups.flat();
  const fill = markFillers(all);
  let wid = 0;
  let prevEnd = 0;
  return groups.map((g, li) => {
    const words: Word[] = g.map((w) => ({ id: "w" + wid, text: w.text, t: r2(w.start), end: r2(Math.max(w.end, w.start + 0.05)), filler: fill[wid++] }));
    const start = words[0].t;
    const gap = li === 0 ? 0 : start - prevEnd;
    prevEnd = words[words.length - 1].end;
    return { id: "l" + li, start, end: words[words.length - 1].end, gapBefore: gap >= minGap ? r2(gap) : 0, words };
  });
}

/** Splits a flat word list into sentences on . ? ! endings and long pauses. */
export function sentencesFromWords(words: RawWord[], pause = 1.0): RawWord[][] {
  const out: RawWord[][] = [];
  let cur: RawWord[] = [];
  words.forEach((w, i) => {
    const next = words[i + 1];
    cur.push(w);
    if (/[.?!]["')\]]?$/.test(w.text) || !next || next.start - w.end >= pause) { out.push(cur); cur = []; }
  });
  if (cur.length) out.push(cur);
  return out;
}

export const allWords = (tr: Transcript) => tr.flatMap((l) => l.words);
export const lineText = (l: Line) => l.words.map((w) => w.text).join(" ");

// Used when no transcription key is set: the same script the UI demo used, timed across the footage.
const SAMPLE_SCRIPT = [
  "So the thing nobody tells you about starting an agency",
  "um is that the first ten clients are the hardest",
  "like you are basically selling a promise",
  "and the promise is that you will make them look good",
  "once we figured out cold outreach everything changed",
  "we went from two clients to fourteen in ninety days",
  "and um the trick was not volume it was the follow up",
  "most people stop after one message",
  "we send five and every one of them is personal",
  "like we actually watch their content before we write",
  "that is the whole playbook honestly",
  "and now the AI does the first draft for us",
];
export { SAMPLE_SCRIPT };

export function stubTranscript(seconds: number): Transcript {
  const total = Math.max(4, Math.min(seconds, 60) - 0.6);
  const perLine = total / SAMPLE_SCRIPT.length;
  let t = 0.4;
  const sentences: RawWord[][] = SAMPLE_SCRIPT.map((line, li) => {
    const words = line.split(" ");
    const gapBefore = li === 2 || li === 7 ? Math.min(1.4, perLine * 0.4) : 0;
    t += gapBefore;
    const start = t;
    const dur = Math.max(0.5, perLine - gapBefore - 0.3);
    const out = words.map((w, i) => ({ text: w, start: start + (i * dur) / words.length, end: start + ((i + 0.85) * dur) / words.length }));
    t = start + perLine - gapBefore;
    return out;
  });
  return buildTranscript(sentences, { minGap: 0.8 });
}

/** Sentence-level text for the AI: "[0:12] text" per line. Cut words are left out when a cut set is given. */
export function transcriptAsText(tr: Transcript, cut?: Set<string>, detail: "sentences" | "words" = "sentences"): string {
  const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
  return tr
    .map((l) => {
      const words = cut ? l.words.filter((w) => !cut.has(w.id)) : l.words;
      if (!words.length) return null;
      if (detail === "words") return `${l.id} [${fmt(l.start)}] ` + words.map((w) => `${w.text}(${w.id}@${w.t.toFixed(2)}${w.filler ? ",filler" : ""})`).join(" ");
      return `${l.id} [${fmt(l.start)}] ${words.map((w) => w.text).join(" ")}`;
    })
    .filter(Boolean)
    .join("\n");
}
