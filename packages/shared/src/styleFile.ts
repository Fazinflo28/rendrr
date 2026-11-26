// Engine Part 4.4: a reference video measured into a STYLE FILE (analyze_reference). Rendrr measures (worker
// python/reference.py: text on screen, the cuts, the grade, the sound; plus the breakdown, the words and the faces it
// already has); this file turns the numbers into the style file the AI reads, and its text. The AI applies parts of it
// with explicit edits; Rendrr never applies a style file on its own. Explore shows a public breakdown of one beside a
// published video (publicBreakdown.ts).
// Pure functions, no I/O.
import type { Breakdown } from "./breakdown";
import type { DeepAudio, VisionDetails } from "./deep";
import { EASING_WORDS, buildMapPart, mapText, topCounts, type MapPart, type ReferenceMap, type StyleNotes } from "./referenceMap";

/** 2: the map (scenes, camera, animations, b-roll, music, sound effects, timeline, needs) and the AI's notes. */
export const STYLE_FILE_VERSION = 2;

/** What reference.py writes. */
export type TextMotion = { kind: "cut" | "pop" | "slide" | "wipe"; ms: number; dir?: string; px?: number; from?: number; easing?: string | null };
export type MeasuredText = {
  start: number; end: number; box: [number, number, number, number]; height: number; color: string; highlight: string | null;
  stroke: { color: string; widthPct: number } | null; boxColor: string | null; weight: number; words: number; changes: number[];
  in: TextMotion; out: TextMotion; chunkIn?: string[];
};
export type ReferenceMeasure = {
  v: number; size: [number, number]; texts: MeasuredText[];
  transitions: [number, "cut" | "flash" | "dip-black" | "whip", number][];
  /** [t, brightness, contrast, saturation, warmth (R - B), tint (G - (R + B) / 2)], every 0.5 s */
  grade: [number, number, number, number, number, number][];
  sound: { speechDb: number | null; pauseDb: number | null; lowSpeechDb: number | null; lowPauseDb: number | null; pauseFrames: number; hitsAtCuts: [number, number][] } | null;
};

export type StyleFile = {
  v: number;
  video: { id: string; name: string; seconds: number; size: [number, number]; shape: string };
  pacing: { cutsPerMin: number; avgShotSec: number; minShotSec: number; maxShotSec: number; wordsPerMin: number | null; pausesKept: { medianMs: number; p90Ms: number; over500msPerMin: number; longestMs: number } | null };
  captions: null | {
    y: number; x: number; heightShare: number; sizePct: number; color: string; highlight: string | null; stroke: { color: string; widthPct: number } | null; box: string | null;
    weight: string; weightRatio: number; wordsAtOnce: number; changesPerSec: number; chunkSec: number; animation: string; lines: number; onScreenShare: number;
  };
  textGraphics: { start: number; end: number; box: [number, number, number, number]; heightShare: number; color: string; boxColor: string | null; stroke: string | null; weight: string; place: string; in: TextMotion; out: TextMotion }[];
  textHabits: { count: number; perMin: number; places: Record<string, number>; entrances: Record<string, number>; medianInMs: number | null; medianOnSec: number | null; colors: string[] };
  transitions: { counts: Record<string, number>; nonCutPerMin: number; list: [number, string, number][] };
  zooms: null | { punchIns: number; punchOuts: number; perMin: number; typicalScale: number | null; slow: { start: number; end: number; change: number }[]; list: [number, number][] };
  grade: null | { brightness: number; contrast: number; saturation: number; warmth: number; tint: number; words: string[] };
  sound: null | { lufs: number | null; truePeakDb: number | null; speechDb: number | null; bed: string; bedDb: number | null; bedUnderVoiceDb: number | null; duckDb: number | null; hitsAtCuts: number; cuts: number; hits: [number, number][] };
  moments: [number, string][];
  notMeasured: string[];
  /** v2: the reference mapped end to end (reference_map.py); absent on older files. */
  map?: MapPart | null;
  /** What the AI saw in the frames (analyze_reference {videoId, notes}). */
  notes?: StyleNotes | null;
};

const r2 = (n: number) => Math.round(n * 100) / 100;
const r3 = (n: number) => Math.round(n * 1000) / 1000;
const median = (xs: number[]) => { if (!xs.length) return 0; const s = [...xs].sort((a, b) => a - b); return s.length % 2 ? s[s.length >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };
const pct = (xs: number[], p: number) => { if (!xs.length) return 0; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]; };
const mode = <T,>(xs: T[]): T | undefined => { const m = new Map<T, number>(); for (const x of xs) m.set(x, (m.get(x) ?? 0) + 1); return [...m.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]; };
const weightWord = (r: number) => (r < 0.09 ? "light" : r < 0.13 ? "regular" : r < 0.17 ? "bold" : "black");
const placeOf = (b: [number, number, number, number]) => {
  const cx = b[0] + b[2] / 2, cy = b[1] + b[3] / 2;
  return `${cy < 0.33 ? "top" : cy > 0.66 ? "bottom" : "middle"}${b[2] > 0.6 ? "" : cx < 0.38 ? "-left" : cx > 0.62 ? "-right" : ""}`;
};
const motionText = (m: TextMotion) => (m.kind === "cut" ? "straight on" : `${m.kind}${m.dir ? ` ${m.dir}` : ""}${m.from ? ` from ${Math.round(m.from * 100)}%` : ""} ${m.ms} ms${m.easing ? ` ${m.easing}` : ""}`);

/** The main face's height and centre across at 10 fps (the biggest face in each frame). */
function faceSizes(d: Pick<VisionDetails, "frames">): [number, number, number][] {
  return d.frames.filter((f) => f[1].length).map((f) => { const b = f[1].reduce((a, c) => (c[3] * c[4] > a[3] * a[4] ? c : a)); return [f[0], b[4], b[1] + b[3] / 2]; });
}

export type StyleInput = {
  video: { id: string; name: string; seconds: number; width: number; height: number };
  measure: ReferenceMeasure;
  breakdown?: Breakdown | null;
  /** Every word with its start and end (seconds), and its text when known. */
  words: { t: number; end: number; w?: string }[];
  cuts: number[];
  audio?: Pick<DeepAudio, "speech" | "lufs" | "truePeakDb"> | null;
  vision?: Pick<VisionDetails, "frames"> | null;
  /** What reference_map.py measured (none when it could not run). */
  map?: ReferenceMap | null;
};

export function buildStyleFile(i: StyleInput): StyleFile {
  const S = Math.max(1, i.video.seconds), min = S / 60, m = i.measure;
  const W = i.video.width || m.size[0], H = i.video.height || m.size[1];
  const shape = W === H ? "1:1" : W < H ? (W / H > 0.7 ? "4:5" : "9:16") : "16:9";

  // Pacing: shots from the cuts; pauses kept between words (the gaps the editor left in).
  const bounds = [0, ...i.cuts.filter((c) => c > 0.05 && c < S - 0.05), S], shots = bounds.slice(1).map((b, k) => b - bounds[k]);
  const gaps = i.words.slice(1).map((w, k) => w.t - i.words[k].end).filter((g) => g > 0.12 && g < 5);
  const pacing: StyleFile["pacing"] = {
    cutsPerMin: r2(i.cuts.length / min), avgShotSec: r2(shots.reduce((a, b) => a + b, 0) / shots.length), minShotSec: r2(Math.min(...shots)), maxShotSec: r2(Math.max(...shots)),
    wordsPerMin: i.words.length ? Math.round(i.words.length / min) : null,
    pausesKept: gaps.length ? { medianMs: Math.round(median(gaps) * 1000), p90Ms: Math.round(pct(gaps, 90) * 1000), over500msPerMin: r2(gaps.filter((g) => g > 0.5).length / min), longestMs: Math.round(Math.max(...gaps) * 1000) } : null,
  };

  // Captions: the row whose text changes most often while someone speaks (2 s and more on screen, 3 changes and more).
  const speaking = (t: number) => (i.audio?.speech ?? []).some(([a, b]) => t >= a && t <= b) || i.words.some((w) => t >= w.t - 0.2 && t <= w.end + 0.2);
  const rows = new Map<number, MeasuredText[]>();
  for (const t of m.texts) { const key = Math.round((t.box[1] + t.box[3] / 2) * 25); rows.set(key, [...(rows.get(key) ?? []), t]); }
  let capRow: MeasuredText[] = [];
  for (const ts of rows.values()) {
    const changes = ts.reduce((a, t) => a + t.changes.length, 0), on = ts.reduce((a, t) => a + (t.end - t.start), 0);
    const cap = ts.filter((t) => t.changes.length >= 3 && t.end - t.start >= 2 && speaking((t.start + t.end) / 2));
    if (cap.length && changes > capRow.reduce((a, t) => a + t.changes.length, 0) && on >= 2) capRow = cap;
  }
  let captions: StyleFile["captions"] = null;
  if (capRow.length) {
    const on = capRow.reduce((a, t) => a + (t.end - t.start), 0), changes = capRow.reduce((a, t) => a + t.changes.length, 0);
    const h = median(capRow.map((t) => t.height)), wr = median(capRow.map((t) => t.weight));
    const y = median(capRow.map((t) => t.box[1] + t.box[3] / 2)), x = median(capRow.map((t) => t.box[0] + t.box[2] / 2));
    const chunk = capRow.flatMap((t) => [t.start, ...t.changes, t.end].slice(1).map((c, k, arr) => c - (k ? arr[k - 1] : t.start)));
    const anim = mode(capRow.flatMap((t) => t.chunkIn ?? [])) ?? "cut";
    captions = {
      y: r3(y), x: r3(x), heightShare: r3(h), sizePct: Math.round((h / 0.8) * 1000) / 10, color: mode(capRow.map((t) => t.color))!, highlight: mode(capRow.map((t) => t.highlight).filter((c): c is string => !!c)) ?? null,
      stroke: capRow.find((t) => t.stroke)?.stroke ?? null, box: mode(capRow.map((t) => t.boxColor).filter((c): c is string => !!c)) ?? null,
      weight: weightWord(wr), weightRatio: r3(wr), wordsAtOnce: Math.round(median(capRow.map((t) => t.words))), changesPerSec: r2(changes / Math.max(1, on)), chunkSec: r2(median(chunk.filter((c) => c > 0))),
      animation: anim === "cut" ? "appear at once" : anim, lines: 1, onScreenShare: r2(Math.min(1, on / S)),
    };
  }

  // Text graphics: every other text on screen 0.5 s and more.
  const graphicsIn = m.texts.filter((t) => !capRow.includes(t) && t.end - t.start >= 0.5);
  const textGraphics = graphicsIn.map((t) => ({ start: t.start, end: t.end, box: t.box, heightShare: r3(t.height), color: t.color, boxColor: t.boxColor, stroke: t.stroke?.color ?? null, weight: weightWord(t.weight), place: placeOf(t.box), in: t.in, out: t.out }));
  const counts = (xs: string[]) => xs.reduce((a, x) => ({ ...a, [x]: (a[x] ?? 0) + 1 }), {} as Record<string, number>);
  const ins = textGraphics.map((g) => g.in).filter((x) => x.kind !== "cut");
  const textHabits: StyleFile["textHabits"] = {
    count: textGraphics.length, perMin: r2(textGraphics.length / min), places: counts(textGraphics.map((g) => g.place)), entrances: counts(textGraphics.map((g) => (g.in.kind === "cut" ? "straight on" : `${g.in.kind}${g.in.dir ? " " + g.in.dir : ""}`))),
    medianInMs: ins.length ? Math.round(median(ins.map((x) => x.ms))) : null, medianOnSec: textGraphics.length ? r2(median(textGraphics.map((g) => g.end - g.start))) : null,
    colors: Array.from(new Set(textGraphics.flatMap((g) => [g.color, g.boxColor].filter((c): c is string => !!c)))).slice(0, 8),
  };

  // Transitions at the cuts.
  const tc = counts(m.transitions.map((x) => x[1]));
  const transitions: StyleFile["transitions"] = { counts: tc, nonCutPerMin: r2(m.transitions.filter((x) => x[1] !== "cut").length / min), list: m.transitions.filter((x) => x[1] !== "cut").map((x) => [x[0], x[1], x[2]]) };

  // Zooms: the face's size just before and after each cut (punch in / out), and steady growth inside a shot (a zoom).
  let zooms: StyleFile["zooms"] = null;
  if (i.vision?.frames?.length) {
    const fs = faceSizes(i.vision);
    const at = (a: number, b: number) => fs.filter((f) => f[0] >= a && f[0] <= b);
    const list: [number, number][] = [];
    for (const c of i.cuts) {
      const pre = at(c - 0.6, c - 0.1), post = at(c + 0.1, c + 0.6);
      if (pre.length < 2 || post.length < 2) continue;
      const hb = median(pre.map((f) => f[1])), ha = median(post.map((f) => f[1])), dx = Math.abs(median(pre.map((f) => f[2])) - median(post.map((f) => f[2])));
      if (dx < 0.25 && hb > 0 && (ha / hb > 1.12 || ha / hb < 0.89)) list.push([r2(c), r2(ha / hb)]);
    }
    const slow: { start: number; end: number; change: number }[] = [];
    for (let k = 0; k < bounds.length - 1; k++) {
      const a = bounds[k] + 0.2, b = bounds[k + 1] - 0.2, pts = at(a, b);
      if (b - a < 1.5 || pts.length < 10) continue;
      const mt = pts.reduce((s, p) => s + p[0], 0) / pts.length, mh = pts.reduce((s, p) => s + p[1], 0) / pts.length;
      const sxy = pts.reduce((s, p) => s + (p[0] - mt) * (p[1] - mh), 0), sxx = pts.reduce((s, p) => s + (p[0] - mt) ** 2, 0), syy = pts.reduce((s, p) => s + (p[1] - mh) ** 2, 0);
      const slope = sxx ? sxy / sxx : 0, r2v = sxx && syy ? (sxy * sxy) / (sxx * syy) : 0, change = (slope * (b - a)) / mh;
      if (r2v > 0.6 && Math.abs(change) > 0.08) slow.push({ start: r2(a), end: r2(b), change: r2(change) });
    }
    const ups = list.filter((x) => x[1] > 1);
    zooms = { punchIns: ups.length, punchOuts: list.length - ups.length, perMin: r2(list.length / min), typicalScale: ups.length ? r2(median(ups.map((x) => x[1]))) : null, slow, list };
  }

  // The grade: medians of the samples.
  const g = m.grade;
  const grade: StyleFile["grade"] = g.length ? (() => {
    const b = median(g.map((x) => x[1])), c = median(g.map((x) => x[2])), s = median(g.map((x) => x[3])), wm = median(g.map((x) => x[4])), tn = median(g.map((x) => x[5]));
    const words = [b < 0.3 ? "dark" : b > 0.6 ? "bright" : "mid brightness", c < 0.15 ? "flat, low contrast" : c > 0.26 ? "high contrast" : "normal contrast", s < 0.2 ? "muted colour" : s > 0.45 ? "saturated colour" : "natural colour", wm > 0.06 ? "warm" : wm < -0.03 ? "cool" : "neutral white balance", ...(Math.abs(tn) > 0.04 ? [tn > 0 ? "green tint" : "magenta tint"] : [])];
    return { brightness: r3(b), contrast: r3(c), saturation: r3(s), warmth: r3(wm), tint: r3(tn), words };
  })() : null;

  // The sound: a bed in the pauses, its low end under the voice (ducking), hits at the cuts.
  const so = m.sound;
  const sound: StyleFile["sound"] = so ? (() => {
    const bed = so.pauseDb == null ? "no pauses long enough to hear what is under the voice" : so.pauseDb < -55 ? "no bed: the pauses drop to near silence" : `a bed in the pauses at ${so.pauseDb} dBFS${so.speechDb != null ? ` (${Math.abs(r2(so.speechDb - so.pauseDb))} dB ${so.speechDb >= so.pauseDb ? "under" : "over"} the voice's level)` : ""}`;
    const duck = so.pauseDb != null && so.pauseDb >= -55 && so.lowPauseDb != null && so.lowSpeechDb != null ? r2(so.lowPauseDb - so.lowSpeechDb) : null;
    return { lufs: i.audio?.lufs ?? null, truePeakDb: i.audio?.truePeakDb ?? null, speechDb: so.speechDb, bed, bedDb: so.pauseDb != null && so.pauseDb >= -55 ? so.pauseDb : null, bedUnderVoiceDb: so.pauseDb != null && so.speechDb != null && so.pauseDb >= -55 ? r2(so.speechDb - so.pauseDb) : null, duckDb: duck, hitsAtCuts: so.hitsAtCuts.length, cuts: i.cuts.length, hits: so.hitsAtCuts };
  })() : null;

  // The map: scenes, camera, animations, b-roll, music, sound effects, what to look at and what a new video needs.
  const mapPart = i.map ? buildMapPart({ seconds: S, map: i.map, words: i.words, faces: i.vision?.frames?.length ? faceSizes(i.vision) : [], textStarts: textGraphics.map((t) => t.start) }) : null;

  // Every graphic moment in order: texts that come and go, transitions, punch-ins, hits (and with the map, the
  // scenes, camera moves, animations, sound effects and music: one timeline from start to end).
  const moments: [number, string][] = [
    ...(mapPart?.timeline ?? []),
    ...textGraphics.filter((t) => !mapPart || t.heightShare >= 0.03).map((t): [number, string] => [t.start, `text ${Math.round(t.box[2] * 100)}% wide at the ${t.place}, ${t.color}${t.boxColor ? ` on a ${t.boxColor} box` : ""}${t.stroke ? ` with a ${t.stroke} outline` : ""}, ${t.weight}, ${Math.round(t.heightShare * 1000) / 10}% tall; in: ${motionText(t.in)}; out: ${motionText(t.out)}; on ${r2(t.end - t.start)}s`]),
    ...transitions.list.map((x): [number, string] => [x[0], `${x[1] === "flash" ? "white flash (set_transition flash)" : x[1] === "dip-black" ? "dip to black" : "whip"} at the cut (${x[2]} ms)`]),
    ...(zooms?.list ?? []).map((x): [number, string] => [x[0], `punch ${x[1] > 1 ? "in" : "out"} at the cut (face ${x[1]}x)`]),
    ...(zooms?.slow ?? []).map((x): [number, string] => [x.start, `slow zoom ${x.change > 0 ? "in" : "out"} ${Math.round(Math.abs(x.change) * 100)}% to ${x.end}s`]),
    ...(sound?.hits ?? []).map((x): [number, string] => [x[0], `sound hit at the cut (${x[1]} dBFS)`]),
  ].sort((a, b) => a[0] - b[0]).slice(0, mapPart ? 320 : 150).map(([t, s]) => [r2(t), s]);

  return {
    v: STYLE_FILE_VERSION, video: { id: i.video.id, name: i.video.name, seconds: r2(S), size: [W, H], shape }, pacing, captions, textGraphics: textGraphics.slice(0, 120), textHabits, transitions, zooms, grade, sound, moments,
    notMeasured: mapPart
      ? ["font family and what each scene shows: Rendrr does not read letters or name things; read them from the frames (LOOK AT) and save them as notes", "text drawn over a busy picture with no outline can be missed", "the music's genre and the sound effects' kinds are estimated from the sound, never named for sure"]
      : ["font family: Rendrr does not read letters; the weight is measured from the strokes", "text drawn over a busy picture with no outline can be missed", "music and sound effects are not named; only levels, ducking and hits at cuts are measured"],
    map: mapPart,
  };
}

/** The style file as text for the AI (get_style): each part with the edits it maps to. */
export function styleFileText(id: string, name: string, f: StyleFile): string {
  const L: string[] = [`STYLE FILE ${id} "${name}" from "${f.video.name}" (${f.video.seconds}s, ${f.video.shape}). Measured, never applied for you: apply the parts you want with apply_edits / add_library_item.`];
  if (f.map) {
    L.push("IN PLAIN WORDS (tell the user this in your own simple words):", ...plainWords(f).map((x) => `- ${x}`));
    L.push("WHAT A NEW VIDEO IN THIS STYLE NEEDS (before editing, check the user's footage and ask for what is missing, e.g. a Drive link; fill a gap from Rendrr's own library or stock only when the user agrees):", ...f.map.needs.map((x) => `- ${x}`));
    if (f.map.lookAt.length) L.push(`LOOK AT (get_frames on the reference, 8 at a time): ${f.map.lookAt.join(", ")}. Read the fonts (family, weight, size, colour, where), the logo, what each scene and b-roll shows and how things animate, then save it: analyze_reference {videoId, notes}.`);
  }
  if (f.notes) L.push(...notesText(f.notes));
  const p = f.pacing;
  L.push(`PACING: ${p.cutsPerMin} cuts a minute, shots ${p.avgShotSec}s on average (${p.minShotSec}-${p.maxShotSec}s)${p.wordsPerMin ? `, ${p.wordsPerMin} words a minute` : ""}${p.pausesKept ? `; pauses kept between words: median ${p.pausesKept.medianMs} ms, 90% under ${p.pausesKept.p90Ms} ms, ${p.pausesKept.over500msPerMin} over 0.5 s a minute, longest ${p.pausesKept.longestMs} ms` : ""}.`);
  const c = f.captions;
  L.push(c ? `CAPTIONS: at ${Math.round(c.y * 100)}% down (centre ${Math.round(c.x * 100)}% across), text ${Math.round(c.heightShare * 1000) / 10}% of the short side tall (set_caption_style size about ${c.sizePct}), ${c.color}${c.highlight ? `, active word ${c.highlight}` : ""}, ${c.stroke ? `outline ${c.stroke.color} about ${Math.round(c.stroke.widthPct * 0.8)}% of size` : "no outline"}${c.box ? `, box ${c.box}` : ""}, ${c.weight} strokes (${c.weightRatio}), ${c.wordsAtOnce} words at once, a new chunk every ${c.chunkSec}s (${c.changesPerSec}/s), chunks ${c.animation}; on screen ${Math.round(c.onScreenShare * 100)}% of the time.` : "CAPTIONS: none found (no text that changes with the speech).");
  const th = f.textHabits;
  L.push(`TEXT GRAPHICS: ${th.count} (${th.perMin} a minute)${th.count ? `; where: ${Object.entries(th.places).map(([k, v]) => `${k} ${v}`).join(", ")}; entrances: ${Object.entries(th.entrances).map(([k, v]) => `${k} ${v}`).join(", ")}${th.medianInMs != null ? `, median ${th.medianInMs} ms` : ""}; on screen ${th.medianOnSec}s median; colours ${th.colors.join(" ")}` : ""}.`);
  const t = f.transitions;
  L.push(`TRANSITIONS: ${Object.entries(t.counts).map(([k, v]) => `${k} ${v}`).join(", ") || "no cuts"} (${t.nonCutPerMin} that are not plain cuts a minute; set_transition flash (an overexposure flash) | dip-white | dip-black | whip).`);
  const z = f.zooms;
  L.push(z ? `ZOOMS: ${z.punchIns} punch-ins and ${z.punchOuts} punch-outs at cuts (${z.perMin} a minute${z.typicalScale ? `, typically ${z.typicalScale}x: add_zoom scale ${z.typicalScale}` : ""}); ${z.slow.length} slow zooms inside shots${z.slow.length ? ` (${z.slow.slice(0, 5).map((s) => `${s.start}-${s.end}s ${s.change > 0 ? "+" : ""}${Math.round(s.change * 100)}%`).join(", ")})` : ""}.` : "ZOOMS: not measured (no face measurements on this video).");
  const g = f.grade;
  if (g) L.push(`GRADE: ${g.words.join(", ")} (brightness ${g.brightness}, contrast ${g.contrast}, saturation ${g.saturation}, warmth ${g.warmth}, tint ${g.tint}).`);
  const s = f.sound;
  L.push(s ? `SOUND: ${s.lufs != null ? `${s.lufs} LUFS, peak ${s.truePeakDb} dBTP; ` : ""}${s.bed}${s.duckDb != null ? `; its low end is ${s.duckDb} dB lower under the voice${s.duckDb >= 3 ? " (ducking: set_audio duck about " + Math.round(s.duckDb) + ")" : " (no ducking measured)"}` : ""}; a sound hit on ${s.hitsAtCuts} of ${s.cuts} cuts.` : "SOUND: none.");
  if (f.map) L.push(...mapText(f.map));
  if (f.moments.length) L.push(`${f.map ? "TIMELINE" : "MOMENTS"} (${f.moments.length}, seconds of the reference):`, ...f.moments.map(([at, what]) => `${at}s ${what}`));
  L.push(`Not measured: ${f.notMeasured.join("; ")}.`);
  return L.join("\n");
}

/** The AI's notes from the frames, as lines. */
export function notesText(n: StyleNotes): string[] {
  const L = [`NOTES (what the AI saw in the frames${n.at ? `, ${n.at.slice(0, 10)}` : ""}):`];
  if (n.summary) L.push(`- ${n.summary}`);
  for (const f of n.fonts ?? []) L.push(`- font: ${f.family}${f.weight ? ` ${f.weight}` : ""}${f.color ? `, ${f.color}` : ""}, for ${f.use}`);
  if (n.look) L.push(`- look: ${n.look}`);
  for (const s of n.scenes ?? []) L.push(`- ${s.at}s${s.type ? ` (${s.type})` : ""}: ${s.what}`);
  if (n.music) L.push(`- music: ${n.music}`);
  if (n.sfx) L.push(`- sound effects: ${n.sfx}`);
  return L;
}

/** The style file in plain words for the user: what the video is, its pace, camera, animations, text, b-roll,
 * colours, music, sound effects, transitions and fonts. */
export function plainWords(f: StyleFile): string[] {
  const m = f.map;
  if (!m) return [];
  const S = f.video.seconds, out: string[] = [];
  const shape = f.video.shape === "9:16" ? "vertical" : f.video.shape === "16:9" ? "landscape" : f.video.shape === "1:1" ? "square" : f.video.shape;
  const what = m.kind === "talking head" ? "talking-head video (a person speaking to camera)" : m.kind === "motion graphics" ? "motion-graphics video (no person on camera)" : m.kind === "footage" ? "video made of camera footage" : "mix of camera shots and graphics";
  out.push(`A ${Math.round(S)} second ${shape} ${what}, in ${m.scenes.length} scene${m.scenes.length === 1 ? "" : "s"}.`);
  const cuts = Math.round((f.pacing.cutsPerMin * S) / 60), events = cuts + m.camera.count + m.animations.count;
  if (events) out.push(`Pace: something new happens about every ${Math.max(0.3, Math.round((S / events) * 10) / 10)} seconds (${cuts} cuts, ${m.camera.count} camera moves, ${m.animations.count} animations).`);
  if (m.camera.count) {
    const e = topCounts(m.camera.easings, 1)[0]?.[0] ?? "linear";
    out.push(`Camera: it keeps moving, ${m.camera.count} zooms and pans that take about ${Math.round((m.camera.medianMs ?? 0) / 100) / 10} s each and ${EASING_WORDS[e] ?? e}.`);
  } else out.push("Camera: it stays still between cuts.");
  if (f.zooms?.punchIns) out.push(`Punch-ins: it zooms in on the face ${f.zooms.punchIns} times at cuts (about ${f.zooms.typicalScale ?? 1.2}x).`);
  if (m.animations.count) out.push(`Animations: things on screen ${topCounts(m.animations.kinds, 3).map(([k]) => k.replace(/ \(.*\)/, "")).join(", ")}, about ${Math.round(m.animations.perMin)} times a minute, each in about ${Math.round((m.animations.medianMs ?? 0) / 100) / 10} s.`);
  const c = f.captions;
  const capFont = (f.notes?.fonts ?? []).find((x) => /caption/i.test(x.use));
  out.push(capFont ? `Captions: ${capFont.family}${capFont.weight ? ` ${capFont.weight}` : ""}, ${capFont.use.replace(/^captions?:?\s*/i, "")}.` : c ? `Captions: ${c.wordsAtOnce} word${c.wordsAtOnce === 1 ? "" : "s"} at a time, ${c.color}${c.highlight ? ` with the spoken word in ${c.highlight}` : ""}${c.box ? ` on a ${c.box} box` : ""}, ${c.y < 0.4 ? "high up" : c.y > 0.7 ? "low down" : "in the middle"}.` : "Captions: none found by measuring (check the frames: small captions can be missed).");
  // Text on screen, leaving out what sits inside screens and graphics (an app's own words are not text pop-ups).
  const inScreen = (t: number) => m.scenes.some((s) => s.kind === "graphic / screen" && t >= s.start && t < s.end);
  const pops = m.kind === "motion graphics" ? f.textGraphics.filter((t) => t.heightShare >= 0.04) : f.textGraphics.filter((t) => !inScreen(t.start) && t.heightShare >= 0.03);
  if (pops.length) out.push(`Text pop-ups: about ${pops.length} (${Math.round(pops.length / (S / 60))} a minute), mostly ${topCounts(pops.reduce((a, t) => ({ ...a, [t.place]: (a[t.place] ?? 0) + 1 }), {} as Record<string, number>), 1)[0]?.[0] ?? "middle"}.`);
  if (m.broll) out.push(m.broll.count ? `B-roll: ${m.broll.count} times (${Math.round(m.broll.perMin)} a minute), ${Math.round(m.broll.share * 100)}% of the video, about ${m.broll.medianSec} s each: ${topCounts(m.broll.types, 4).map(([k, v]) => `${v} ${k}${v > 1 ? "s" : ""}`).join(", ")}.` : "B-roll: none, the speaker stays on screen.");
  if (m.palette.length) out.push(`Colours: ${m.palette.slice(0, 4).map((p) => p[0]).join(", ")}.`);
  out.push(m.music ? `Music: ${m.music.words.slice(0, 2).join(", ")}${m.music.bpm ? `, about ${Math.round(m.music.bpm)} beats a minute` : ""}${m.music.share < 0.9 ? `, on for ${Math.round(m.music.share * 100)}% of the video` : ", the whole way through"}${m.music.changes.length ? `; it ${m.music.changes.slice(0, 2).map((x) => `${x[1].replace("drops quieter", "gets quieter")} at ${Math.round(x[0])} s`).join(" and ")}` : ""}.` : "Music: none found.");
  if (m.sfx.count) out.push(`Sound effects: about ${m.sfx.count} (${topCounts(m.sfx.kinds, 3).map(([k, v]) => `${v} ${k}`).join(", ")}), mostly on ${m.sfx.list.filter((x) => x.near).length >= m.sfx.count / 2 ? "cuts, camera moves and animations" : "their own"}.`);
  else out.push("Sound effects: none found.");
  const tc = Object.entries(f.transitions.counts).filter(([k]) => k !== "cut");
  out.push(tc.length ? `Transitions: ${tc.map(([k, v]) => `${v} ${k === "flash" ? "white flash" : k}`).join(", ")}, the rest hard cuts.` : "Transitions: hard cuts only.");
  const fonts = f.notes?.fonts ?? [];
  out.push(fonts.length ? `Fonts: ${fonts.map((x) => `${x.family}${x.weight ? ` ${x.weight}` : ""} for ${x.use}`).join("; ")}.` : "Fonts: not named yet (read from the frames).");
  if (f.notes?.summary) out.push(f.notes.summary);
  return out;
}
