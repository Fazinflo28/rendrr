// Engine Part 3: what render_preview's check reads from the preview FILE's sound and from the footage's measurements,
// next to the edit. Measurements and fixed rules only, no judgement:
//   joins    where the dialogue jumps: a cut between two clips' sounds, or inside a clip where words were cut out
//   gaps     stretches with no speech in the file's sound (0.15 s or more), each placed in the edit: its edit time, its
//            footage time and clip, and at a join which side of it the silence is on (the end of clip A, the start of B)
//   clipped  words whose sound (the alignment's edges) a cut goes through, and by how many ms
//   clicks   clicks in the file's sound at a join
//   faces    where a footage's main face is on screen at an edit moment, to say how much of it a graphic covers
//   heard    the preview's sound transcribed again, against the words the edit plays
import type { Aligned, VisionDetails } from "./deep";
import { motionAt, keyTracks, type Key } from "./motion";
import type { ZoomOp } from "./renderPlan";
import { rateOf, srcAt, type Range, type SeqClip, type SequenceView, type SoundPart } from "./sequence";
import type { Word } from "./transcript";

/** The preview file's sound, measured every 10 ms (edit seconds): speech (Silero VAD, its edges moved onto the
 *  level), the room's and the voice's level (dBFS), breaths, and clicks within 20 ms of a join of the edit's sound
 *  ([time, dB over the sound around it]). */
export type FileSound = { speech: [number, number][]; roomDb: number; speechDb: number; breaths: [number, number][]; joinClicks: [number, number][]; error?: string };

/** The preview's sound transcribed again (edit seconds), kept with the render. status: queued and transcribing (the
 *  job runs after the render), done, failed (error), off (no transcriber set up), skipped (a newer preview came). */
export type HeardTranscript = {
  status: "queued" | "transcribing" | "done" | "failed" | "off" | "skipped";
  /** [text, start, end] in edit seconds; sentences: [start, text]. */
  words?: [string, number, number][];
  sentences?: [number, string][];
  error?: string;
  /** When the job started (ISO) and the preview's length, for the time left. */
  startedAt?: string;
  seconds?: number;
};

/** Edit time to the hundredth: 1:02.35. */
export const fmtT2 = (t: number) => { const s = Math.max(0, t); return `${Math.floor(s / 60)}:${(s % 60).toFixed(2).padStart(5, "0")}`; };
const f3 = (n: number) => n.toFixed(3);
const ms = (s: number) => Math.round(s * 1000);
const listed = (xs: string[], max: number) => xs.slice(0, max).join("; ") + (xs.length > max ? `; +${xs.length - max} more` : "");

// ---------------------------------------------------------------------------------------------
// Joins
// ---------------------------------------------------------------------------------------------
/** The dialogue plays on from a to b: same video, footage continuing, both heard or both not. */
const goesOn = (a: SoundPart, b: SoundPart) => a.videoId === b.videoId && !!a.muted === !!b.muted && !!a.silent === !!b.silent
  && ((rateOf(a) > 0 && rateOf(b) > 0 && Math.abs(a.srcOut - b.srcIn) < 1e-3) || (rateOf(a) < 0 && rateOf(b) < 0 && Math.abs(a.srcIn - b.srcOut) < 1e-3));

export type SoundJoin = { at: number; a: SoundPart; b: SoundPart };
/** Where the edit's dialogue jumps (edit seconds), in order. */
export function soundJoins(sound: SoundPart[]): SoundJoin[] {
  const out: SoundJoin[] = [];
  for (let i = 1; i < sound.length; i++) if (!goesOn(sound[i - 1], sound[i])) out.push({ at: sound[i].start, a: sound[i - 1], b: sound[i] });
  return out;
}

/** The V1 clip whose sound plays at edit time t (with `before`, the one playing just before t). */
function soundClipAt(view: SequenceView, t: number, before = false): string | null {
  for (const c of view.clips) {
    if (!c.pieces.length) continue;
    if (before ? c.soundStart < t - 1e-9 && t <= c.soundEnd + 1e-9 : c.soundStart <= t + 1e-9 && t < c.soundEnd - 1e-9) return c.id;
  }
  return null;
}
const partAt = (sound: SoundPart[], t: number) => sound.find((p) => p.start <= t + 1e-9 && t < p.end - 1e-9) ?? null;
const joinName = (view: SequenceView, j: SoundJoin) => `${soundClipAt(view, j.at, true) ?? "?"}|${soundClipAt(view, j.at) ?? "?"}`;

// ---------------------------------------------------------------------------------------------
// Gaps in speech, from the file
// ---------------------------------------------------------------------------------------------
export type GapSegment = { clipId: string | null; start: number; end: number; src: [number, number] | null; where: "inside" | "end" | "start" | "all" };
export type Gap = { start: number; end: number; silent: boolean; breath: boolean; segments: GapSegment[]; joins: SoundJoin[]; lead: boolean; tail: boolean };

/** A join this close outside a gap still counts as its join (speech edges are measured to about 30 ms). */
const JOIN_TOL = 0.03;

/**
 * The stretches with no speech in the file's sound from `over` seconds (the edges of the edit included), each cut at
 * the joins it holds into the clips it is made of. silent: under -45 dB for most of it (silencedetect); breath: a
 * breath measured in it.
 */
export function speechGaps(view: SequenceView, s: Pick<FileSound, "speech" | "breaths">, silences: Range[], total: number, over = 0.15): Gap[] {
  const sp = [...s.speech].sort((a, b) => a[0] - b[0]);
  const raw: Range[] = [];
  let at = 0;
  for (const [a, b] of sp) { if (a > at) raw.push({ start: at, end: Math.min(a, total) }); at = Math.max(at, b); }
  if (total > at) raw.push({ start: at, end: total });
  const joins = soundJoins(view.sound);
  const out: Gap[] = [];
  for (const g of raw) {
    if (g.end - g.start < over - 1e-6) continue;
    const js = joins.filter((j) => j.at > g.start - JOIN_TOL && j.at < g.end + JOIN_TOL);
    const cuts = js.map((j) => Math.min(g.end, Math.max(g.start, j.at)));
    const pts = [g.start, ...cuts, g.end];
    const segments: GapSegment[] = [];
    for (let i = 0; i + 1 < pts.length; i++) {
      const a = pts[i], b = pts[i + 1];
      if (b - a < 0.0005) continue;
      const mid = (a + b) / 2, part = partAt(view.sound, mid);
      const src: [number, number] | null = part ? [srcAt(part, a), srcAt(part, b)].sort((x, y) => x - y) as [number, number] : null;
      const joinAfter = cuts.some((c) => Math.abs(c - b) < 1e-6), joinBefore = cuts.some((c) => Math.abs(c - a) < 1e-6);
      segments.push({ clipId: soundClipAt(view, mid), start: a, end: b, src, where: joinAfter && joinBefore ? "all" : joinAfter ? "end" : joinBefore ? "start" : "inside" });
    }
    const len = g.end - g.start;
    const quiet = silences.reduce((acc, x) => acc + Math.max(0, Math.min(x.end, g.end) - Math.max(x.start, g.start)), 0);
    const breath = s.breaths.some(([a, b]) => Math.min(b, g.end) - Math.max(a, g.start) >= 0.5 * (b - a));
    out.push({ start: g.start, end: g.end, silent: quiet >= 0.8 * len, breath, segments, joins: js, lead: g.start <= 1e-6, tail: g.end >= total - 1e-6 });
  }
  return out;
}

function gapText(view: SequenceView, g: Gap): string {
  const tags = [g.lead ? "before the first word" : "", g.tail ? "after the last word" : "", g.silent ? "silent" : "", g.breath ? "a breath" : ""].filter(Boolean);
  const seg = (x: GapSegment) => `${x.where === "inside" ? "inside" : x.where === "all" ? "all of" : x.where === "end" ? "end of" : "start of"} ${x.clipId ?? "?"} ${(x.end - x.start).toFixed(2)}s${x.src ? ` (footage ${f3(x.src[0])}-${f3(x.src[1])})` : ""}`;
  const at = g.joins.length ? ` at the join ${g.joins.map((j) => joinName(view, j)).join(", ")}` : "";
  return `${fmtT2(g.start)} ${(g.end - g.start).toFixed(2)}s${tags.length ? ` (${tags.join(", ")})` : ""}${at}: ${g.segments.map(seg).join(" + ")}`;
}

/** "Gaps in speech from 0.15s (...): 2 at joins: ...; 5 inside clips (longest first): ..." */
export function gapsLine(view: SequenceView, gaps: Gap[], over = 0.15): string {
  const atJoins = gaps.filter((g) => g.joins.length), inside = gaps.filter((g) => !g.joins.length).sort((a, b) => b.end - b.start - (a.end - a.start));
  const head = `Gaps in speech from ${over}s (measured in the file's sound; edit time, length, where; footage seconds)`;
  if (!gaps.length) return `${head}: none`;
  return `${head}: ${atJoins.length} at joins${atJoins.length ? ": " + listed(atJoins.map((g) => gapText(view, g)), 25) : ""} | ${inside.length} inside clips${inside.length ? " (longest first): " + listed(inside.map((g) => gapText(view, g)), 10) : ""}`;
}

// ---------------------------------------------------------------------------------------------
// Clipped words: a cut through a word's sound
// ---------------------------------------------------------------------------------------------
export type ClippedWord = { wordId: string; text: string; videoId: string; clipId: string | null; side: "start" | "end"; at: number; edge: number; lost: number; plays: number; cut: boolean };

/**
 * Every word whose sound a cut goes through: its sound starts before its clip's sound starts or ends after it ends
 * (edges from the alignment, else the transcriber's times; `measured` says which). lost: the part cut off; plays: the
 * part heard (seconds). A cut word partly heard is one too. Muted and silent stretches are not heard and not checked.
 */
export function clippedWords(view: SequenceView, o: { wordsOf: (videoId: string) => Word[]; alignedOf: (videoId: string) => Map<string, Aligned> | null | undefined; isCut: (videoId: string, wordId: string) => boolean }): { words: ClippedWord[]; unmeasured: string[] } {
  const out: ClippedWord[] = [];
  const unmeasured = new Set<string>();
  const edgesOf = new Map<string, { w: Word; s: number; e: number }[]>();
  const edges = (vid: string) => {
    let l = edgesOf.get(vid);
    if (!l) {
      const al = o.alignedOf(vid);
      if (!al?.size) unmeasured.add(vid);
      l = o.wordsOf(vid).map((w) => { const a = al?.get(w.id); return { w, s: a ? a.s : w.t, e: a ? a.e : w.end }; }).sort((a, b) => a.s - b.s);
      edgesOf.set(vid, l);
    }
    return l;
  };
  const S = view.sound;
  S.forEach((p, i) => {
    if (p.muted || p.silent || rateOf(p) <= 0) return;
    const checks: ["start" | "end", number, number][] = [];
    if (i === 0 || !goesOn(S[i - 1], p)) checks.push(["start", p.srcIn, p.start]);
    if (i === S.length - 1 || !goesOn(p, S[i + 1])) checks.push(["end", p.srcOut, p.end]);
    if (!checks.length) return;
    const ws = edges(p.videoId);
    for (const [side, x, at] of checks) {
      // The words that hold x: starts are in order, so look back from the last word starting before x.
      let k = lowerBound(ws, x) - 1;
      for (let n = 0; k >= 0 && n < 6; k--, n++) {
        const { w, s, e } = ws[k];
        if (!(s < x - 0.0005 && e > x + 0.0005)) continue;
        const lost = side === "start" ? x - s : e - x;
        const plays = side === "start" ? Math.min(e, p.srcOut) - x : x - Math.max(s, p.srcIn);
        if (ms(lost) < 1 || ms(plays) < 1) continue;
        out.push({ wordId: w.id, text: w.text, videoId: p.videoId, clipId: side === "start" ? soundClipAt(view, at) : soundClipAt(view, at, true), side, at, edge: x, lost, plays, cut: o.isCut(p.videoId, w.id) });
      }
    }
  });
  out.sort((a, b) => a.at - b.at);
  return { words: out, unmeasured: Array.from(unmeasured) };
}
function lowerBound(ws: { s: number }[], x: number): number {
  let lo = 0, hi = ws.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (ws[m].s < x) lo = m + 1; else hi = m; }
  return lo;
}

/** "Clipped words (a cut goes through the word's sound): none" or each with its clip, edge and amounts. */
export function clippedLine(r: { words: ClippedWord[]; unmeasured: string[] }, mainVideoId: string): string {
  const name = (w: ClippedWord) => `"${w.text.replace(/[^\w'-]/g, "")}"${w.cut ? " (a cut word)" : ""}`;
  const one = (w: ClippedWord) => `${name(w)} ${w.side} of ${w.clipId ?? "?"} at ${fmtT2(w.at)} (footage ${f3(w.edge)}): ${ms(w.lost)}ms cut off, ${ms(w.plays)}ms plays`;
  const note = r.unmeasured.length ? ` (${r.unmeasured.map((v) => (v === mainVideoId ? "the footage" : `video ${v}`)).join(", ")}: word edges from the transcriber, the sound is not aligned yet)` : "";
  return `Clipped words (a cut goes through the word's sound)${note}: ${r.words.length ? `${r.words.length}: ` + listed(r.words.map(one), 30) : "none"}`;
}

// ---------------------------------------------------------------------------------------------
// Clicks at joins
// ---------------------------------------------------------------------------------------------
/** The file's clicks within 25 ms of a join: "0:12.40 18dB at the join c3|c4". */
export function joinClicks(view: SequenceView, s: Pick<FileSound, "joinClicks">): string[] {
  const joins = soundJoins(view.sound);
  const out: string[] = [];
  for (const [t, db] of s.joinClicks) {
    const j = joins.reduce<SoundJoin | null>((best, x) => (Math.abs(x.at - t) <= 0.025 && (!best || Math.abs(x.at - t) < Math.abs(best.at - t)) ? x : best), null);
    if (j) out.push(`${fmtT2(t)} ${db}dB at the join ${joinName(view, j)}`);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Faces on screen
// ---------------------------------------------------------------------------------------------
type Box = [number, number, number, number]; // x0, y0, x1, y1 (shares)

/** The main face (the largest box) in the vision frame nearest footage time t (within 0.1 s), as x, y, w, h shares
 *  of the measured picture; null: no face there. */
export function faceAt(d: Pick<VisionDetails, "frames">, t: number): [number, number, number, number] | null {
  const fr = d.frames;
  let lo = 0, hi = fr.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (fr[m][0] < t) lo = m + 1; else hi = m; }
  const near = [fr[lo - 1], fr[lo]].filter(Boolean).sort((a, b) => Math.abs(a[0] - t) - Math.abs(b[0] - t))[0];
  if (!near || Math.abs(near[0] - t) > 0.1 || !near[1].length) return null;
  const f = near[1].reduce((a, b) => (b[3] * b[4] > a[3] * a[4] ? b : a));
  return [f[1], f[2], f[3], f[4]];
}

/** A point of a picture (shares) after the picture is turned `deg` degrees clockwise. */
function turn(u: number, v: number, deg: number): [number, number] {
  const d = ((deg % 360) + 360) % 360;
  return d === 90 ? [1 - v, u] : d === 180 ? [1 - u, 1 - v] : d === 270 ? [v, 1 - u] : [u, v];
}

export type Placement = { rotate: number; framing?: { scale: number; x: number; y: number } | null; motion?: { x: number; y: number; scale: number; rotation: number } | null; zoom?: number };
/**
 * Where a box measured on a picture turned `measured`° clockwise (vision's `turned`; `size` its width and height)
 * lands on screen, as shares of the W x H frame, when the render turns the footage `rotate`°, fits it (covering the
 * frame, centred across and 40% down), frames it (scale about the centre, then moved), moves it by its keyframes and
 * zooms the frame. Null when none of it is on screen.
 */
export function boxOnScreen(box: [number, number, number, number], measured: number, size: [number, number], W: number, H: number, pl: Placement): Box | null {
  const [x, y, w, h] = box;
  const side = (d: number) => (((d % 360) + 360) % 360) % 180 === 90;
  const filmed: [number, number] = side(measured) ? [size[1], size[0]] : [size[0], size[1]];
  const [pw, ph] = side(pl.rotate) ? [filmed[1], filmed[0]] : filmed;
  const s = Math.max(W / pw, H / ph), sw = pw * s, sh = ph * s;
  const f = pl.framing ?? { scale: 1, x: 0, y: 0 }, m = pl.motion, z = pl.zoom ?? 1;
  const pts = [[x, y], [x + w, y], [x, y + h], [x + w, y + h]].map(([u0, v0]) => {
    const [ua, va] = turn(u0, v0, 360 - measured); // as filmed
    const [u, v] = turn(ua, va, pl.rotate); // as the render turns it
    let X = (u * sw - (sw - W) / 2) / W, Y = (v * sh - (sh - H) * 0.4) / H; // fitted
    X = (1 - f.scale) / 2 + f.x + X * f.scale; Y = (1 - f.scale) / 2 + f.y + Y * f.scale; // framed
    if (m) {
      const th = (m.rotation * Math.PI) / 180, c = Math.cos(th), sn = Math.sin(th);
      const dx = (X - 0.5) * W * m.scale, dy = (Y - 0.5) * H * m.scale;
      X = (W / 2 + m.x * W + dx * c - dy * sn) / W; Y = (H / 2 + m.y * H + dx * sn + dy * c) / H;
    }
    return [X * z - (z - 1) / 2, Y * z - (z - 1) * 0.4];
  });
  const x0 = Math.max(0, Math.min(...pts.map((p) => p[0]))), x1 = Math.min(1, Math.max(...pts.map((p) => p[0])));
  const y0 = Math.max(0, Math.min(...pts.map((p) => p[1]))), y1 = Math.min(1, Math.max(...pts.map((p) => p[1])));
  return x1 - x0 > 1e-4 && y1 - y0 > 1e-4 ? [x0, y0, x1, y1] : null;
}

/**
 * The main face on screen at edit time t: the V1 clip playing then, its footage moment, the face measured there, and
 * where the render draws it. Null: no face measured there, the footage has no face measurements, or b-roll covers V1.
 */
export function faceOnScreenAt(t: number, o: {
  view: SequenceView; clips: Map<string, SeqClip>; W: number; H: number;
  vision: (videoId: string) => { details: Pick<VisionDetails, "frames" | "size">; turned: number } | null;
  zooms?: ZoomOp[]; zoomAt?: (zooms: ZoomOp[], t: number) => number; clipMotion?: Record<string, { start: number; end: number; keys: Key[] }>; covered?: (t: number) => boolean;
}): Box | null {
  if (o.covered?.(t)) return null;
  const piece = o.view.pieceAt(t);
  if (!piece || t < piece.start - 1e-6 || t > piece.end + 1e-6) return null;
  const v = o.vision(piece.videoId);
  if (!v) return null;
  const face = faceAt(v.details, srcAt(piece, t));
  if (!face) return null;
  const c = o.clips.get(piece.clipId);
  const mo = o.clipMotion?.[piece.clipId];
  return boxOnScreen(face, v.turned, v.details.size, o.W, o.H, {
    rotate: c?.rotate ?? 0, framing: c?.framing ?? null,
    motion: mo ? motionAt(keyTracks(mo.keys), t - mo.start) : null,
    zoom: o.zooms?.length && o.zoomAt ? o.zoomAt(o.zooms, t) : 1,
  });
}

/** How much of a box (shares) a picture's alpha covers: the mean of an S x S alpha map (0-255) over it, 0-100. */
export function boxCover(map: Uint8Array, S: number, b: Box): number {
  const [x0, y0, x1, y1] = b.map((v) => v * S);
  let sum = 0, area = 0;
  for (let j = Math.floor(y0); j < Math.min(S, Math.ceil(y1)); j++) {
    const wy = Math.min(j + 1, y1) - Math.max(j, y0);
    if (wy <= 0) continue;
    for (let i = Math.floor(x0); i < Math.min(S, Math.ceil(x1)); i++) {
      const wx = Math.min(i + 1, x1) - Math.max(i, x0);
      if (wx <= 0) continue;
      sum += (map[j * S + i] / 255) * wx * wy; area += wx * wy;
    }
  }
  return area > 0 ? Math.round((sum / area) * 1000) / 10 : 0;
}

// ---------------------------------------------------------------------------------------------
// Heard: the preview transcribed again, against the edit's words
// ---------------------------------------------------------------------------------------------
/** The words the edit plays, in edit order (muted, silent and cut words left out), each at its edit time. */
export function wordsAsPlayed(view: SequenceView, wordsOf: (videoId: string) => Word[], isCut: (videoId: string, wordId: string) => boolean): { text: string; at: number }[] {
  const out: { text: string; at: number }[] = [];
  for (const s of view.sound) {
    if (s.muted || s.silent) continue;
    const r = rateOf(s);
    for (const w of wordsOf(s.videoId)) {
      if (isCut(s.videoId, w.id) || w.t < s.srcIn || w.t >= s.srcOut) continue;
      out.push({ text: w.text, at: r > 0 ? s.start + (w.t - s.srcIn) / r : s.start + (s.srcOut - w.t) / -r });
    }
  }
  return out.sort((a, b) => a.at - b.at);
}

const norm = (t: string) => t.toLowerCase().replace(/[^\p{L}\p{N}']+/gu, "").replace(/^'+|'+$/g, "");

/** Myers' diff of two token lists: the index pairs that match, or null when they differ in more than maxD places. */
function matchTokens(a: string[], b: string[], maxD: number): [number, number][] | null {
  const N = a.length, M = b.length, max = Math.min(N + M, maxD), off = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  for (let d = 0; d <= max; d++) {
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
      let y = x - k;
      while (x < N && y < M && a[x] === b[y]) { x++; y++; }
      v[off + k] = x;
      if (x >= N && y >= M) {
        trace.push(v.slice(off - d, off + d + 1));
        // Walk back through the steps, keeping the diagonal (matching) moves.
        const pairs: [number, number][] = [];
        let cx = N, cy = M;
        for (let dd = d; dd > 0; dd--) {
          const prev = trace[dd - 1], at = (kk: number) => prev[kk + dd - 1];
          const kk = cx - cy;
          const down = kk === -dd || (kk !== dd && at(kk - 1) < at(kk + 1));
          const pk = down ? kk + 1 : kk - 1, px = at(pk), py = px - pk;
          const sx = down ? px : px + 1;
          while (cx > sx && cy > sx - kk) { cx--; cy--; pairs.push([cx, cy]); }
          cx = px; cy = py;
        }
        while (cx > 0 && cy > 0) { cx--; cy--; pairs.push([cx, cy]); }
        return pairs.reverse();
      }
    }
    trace.push(v.slice(off - d, off + d + 1));
  }
  return null;
}

export type HeardDiff = { at: number; expected: string[]; heard: string[] };
/** Where the words heard in the preview differ from the words the edit plays (null: too many places to list). */
export function heardDiff(expected: { text: string; at: number }[], heard: [string, number, number][], maxD = 1500): HeardDiff[] | null {
  const ex = expected.map((w) => ({ ...w, n: norm(w.text) })).filter((w) => w.n);
  const hd = heard.map(([text, at]) => ({ text, at, n: norm(text) })).filter((w) => w.n);
  const pairs = matchTokens(ex.map((w) => w.n), hd.map((w) => w.n), maxD);
  if (!pairs) return null;
  const out: HeardDiff[] = [];
  let i = 0, j = 0;
  for (const [pi, pj] of [...pairs, [ex.length, hd.length] as [number, number]]) {
    if (pi > i || pj > j) out.push({ at: pj > j ? hd[j].at : i < ex.length ? ex[i].at : (hd[hd.length - 1]?.at ?? 0), expected: ex.slice(i, pi).map((w) => w.text), heard: hd.slice(j, pj).map((w) => w.text) });
    i = pi + 1; j = pj + 1;
  }
  return out;
}

const q = (ws: string[]) => `"${ws.join(" ").replace(/"/g, "'")}"`;
/** One line: the differences between what is heard and the edit's words, or that they agree. */
export function heardDiffLine(diffs: HeardDiff[] | null, heardWords: number, expectedWords: number): string {
  if (!diffs) return `Heard vs the edit's words: too different to list (${heardWords} words heard, ${expectedWords} in the edit)`;
  if (!diffs.length) return `Heard vs the edit's words: the same ${heardWords} words`;
  const one = (d: HeardDiff) => (d.expected.length && d.heard.length ? `${fmtT2(d.at)} heard ${q(d.heard)} for ${q(d.expected)}` : d.heard.length ? `${fmtT2(d.at)} heard ${q(d.heard)} (not in the edit's words)` : `${fmtT2(d.at)} ${q(d.expected)} not heard`);
  return `Heard vs the edit's words: ${diffs.length} ${diffs.length === 1 ? "place differs" : "places differ"} (a recogniser also mishears; same transcriber as the footage): ${listed(diffs.map(one), 15)}`;
}
