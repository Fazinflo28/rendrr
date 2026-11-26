// analyze_reference, part 2: the map of a reference video, end to end (worker python/reference_map.py measures it:
// the camera's zooms and pans, every animation, the scenes and their kinds, the colours, the music and the sound
// effects). This file turns those numbers into the parts of the style file the AI reads: scenes, camera and animation
// habits, b-roll (in a talking head video), music and sound effects in words, one timeline from start to end, the
// frames worth looking at (fonts and what each scene shows are read by the AI, never by Rendrr) and what a new video
// needs to be made the same way. Pure functions, no I/O.

export type MapMove = { start: number; end: number; ms: number; kind: string; zoom: number; pan: [number, number]; easing: string; pace: string };
export type MapAnim = { start: number; end: number; ms: number; kind: string; box: [number, number, number, number]; easing: string | null };
export type MapScene = { start: number; end: number; kind: string; flat: number; noise: number; colourful: number; light: number; split: string | null; colours: [string, number][] };
export type MapMusicSection = { start: number; end: number; bpm: number | null; beat: number; key: string | null; mode: string | null; brightHz: number; duckDb: number | null; levelDb: number[]; underVoice: boolean };
export type MapSfx = { t: number; kind: string; ms: number; db: number; jumpDb: number; near: [number, string] | null; count?: number };
/** What reference_map.py writes. */
export type ReferenceMap = {
  v: number; fps: number; size: [number, number]; cuts: number[]; moves: MapMove[]; animations: MapAnim[]; scenes: MapScene[]; palette: [string, number][];
  music: { sections: MapMusicSection[]; changes: [number, string, number][]; musicSeconds: number; levelDb: number[]; stops: number[] } | null;
  sfx: MapSfx[];
};

/** What the AI saw in the frames, saved with analyze_reference {videoId, notes}: Rendrr does not read letters. */
export type StyleNotes = {
  fonts?: { family: string; weight?: string; use: string; color?: string }[];
  scenes?: { at: number; what: string; type?: string }[];
  music?: string; sfx?: string; look?: string; summary?: string; at?: string;
};

export type BrollType = "video clip" | "image" | "image with a camera move" | "motion graphic / screen" | "split screen";
export type MapPart = {
  kind: "talking head" | "motion graphics" | "footage" | "mixed";
  scenes: { start: number; end: number; sec: number; kind: string; colours: string[]; says: string; moves: number; animations: number }[];
  camera: { count: number; perMin: number; kinds: Record<string, number>; medianMs: number | null; easings: Record<string, number>; zoomIn: number | null; zoomOut: number | null; list: MapMove[] };
  animations: { count: number; perMin: number; kinds: Record<string, number>; medianMs: number | null; easings: Record<string, number>; list: MapAnim[] };
  broll: null | { count: number; perMin: number; share: number; medianSec: number; minSec: number; maxSec: number; types: Record<string, number>; list: { start: number; end: number; type: BrollType; says: string }[] };
  palette: [string, number][];
  music: null | { words: string[]; bpm: number | null; key: string | null; mode: string | null; share: number; sections: { start: number; end: number }[]; changes: [number, string, number][]; stops: number[]; duckDb: number | null };
  sfx: { count: number; perMin: number; kinds: Record<string, number>; list: MapSfx[] };
  voice: { words: number; perMin: number } | null;
  timeline: [number, string][];
  lookAt: number[];
  needs: string[];
};

const r1 = (n: number) => Math.round(n * 10) / 10;
const r2 = (n: number) => Math.round(n * 100) / 100;
const median = (xs: number[]) => { if (!xs.length) return 0; const s = [...xs].sort((a, b) => a - b); return s.length % 2 ? s[s.length >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };
const counts = (xs: string[]) => xs.reduce((a, x) => ({ ...a, [x]: (a[x] ?? 0) + 1 }), {} as Record<string, number>);
const top = (c: Record<string, number>, n = 3) => Object.entries(c).sort((a, b) => b[1] - a[1]).slice(0, n);
export const placeOfBox = (b: [number, number, number, number]) => {
  const cx = b[0] + b[2] / 2, cy = b[1] + b[3] / 2;
  if (b[2] > 0.8 && b[3] > 0.8) return "whole frame";
  return `${cy < 0.33 ? "top" : cy > 0.66 ? "bottom" : "middle"}${b[2] > 0.6 ? "" : cx < 0.38 ? "-left" : cx > 0.62 ? "-right" : ""}`;
};
const BROLL: Record<string, BrollType> = { "graphic / screen": "motion graphic / screen", "still picture": "image", "picture moved by the camera": "image with a camera move", "camera footage": "video clip", "split screen": "split screen" };
export const EASING_WORDS: Record<string, string> = {
  "ease-in-out": "start slow, speed up, then settle", "ease-out": "start fast and settle", "ease-in": "start slow and speed up",
  linear: "move at one steady speed", spring: "overshoot a little and bounce back",
};
export { top as topCounts };

export type MapInput = {
  seconds: number; map: ReferenceMap;
  words: { t: number; end: number; w?: string }[];
  /** The main face per frame at 10 fps: [t, height share, centre across]. */
  faces?: [number, number, number][];
  /** Times where text graphics come on (worth a look for the fonts). */
  textStarts?: number[];
};

function says(words: MapInput["words"], a: number, b: number, max = 90): string {
  const s = words.filter((w) => w.t >= a - 0.05 && w.t < b && w.w).map((w) => w.w).join(" ").trim();
  return s.length > max ? `${s.slice(0, max - 3).trim()}...` : s;
}

export function musicWords(m: { bpm: number | null; beat: number; mode: string | null; brightHz: number }): string[] {
  const w: string[] = [];
  const bpm = m.bpm ?? 0;
  if (m.beat >= 0.45) w.push(bpm >= 135 ? "high energy, hard driving beat" : bpm >= 110 ? "upbeat, strong steady beat" : bpm >= 90 ? "groovy mid-tempo beat" : "slow heavy beat");
  else if (m.beat >= 0.25) w.push(bpm >= 115 ? "upbeat with a light beat" : "relaxed steady beat");
  else w.push("soft, little or no beat (a pad or ambient bed)");
  if (m.mode === "major") w.push("major key (bright, positive feel)");
  else if (m.mode === "minor") w.push("minor key (serious or moody feel)");
  w.push(m.brightHz < 380 ? "bass heavy" : m.brightHz > 1000 ? "bright and airy" : "balanced");
  // A guess at the kind of track, from tempo and beat only.
  if (m.beat >= 0.4 && bpm >= 115 && bpm < 140) w.push("sounds like modern electronic or pop (estimated)");
  else if (m.beat >= 0.4 && bpm >= 140) w.push("sounds like dance, trap or drum and bass (estimated)");
  else if (m.beat < 0.25) w.push("sounds like an ambient or cinematic bed (estimated)");
  else if (bpm < 100) w.push("sounds like lo-fi, hip hop or a chill groove (estimated)");
  return w;
}

export function buildMapPart(i: MapInput): MapPart {
  const S = Math.max(1, i.seconds), min = S / 60, m = i.map;
  const faces = i.faces ?? [];
  const faceShare = (a: number, b: number) => { const fs = faces.filter((f) => f[0] >= a && f[0] < b); return fs.length ? fs.filter((f) => f[1] > 0.12).length / fs.length : 0; };
  const inside = (t: number, a: number, b: number) => t >= a && t < b;

  // Scenes, with a talking head where the face fills the frame most of the time.
  const scenes = m.scenes.map((s) => {
    const talking = faces.length > 0 && faceShare(s.start, s.end) > 0.5;
    return {
      start: r2(s.start), end: r2(s.end), sec: r2(s.end - s.start), kind: talking ? "talking head" : s.kind, colours: s.colours.slice(0, 4).map((c) => c[0]),
      says: says(i.words, s.start, s.end), moves: m.moves.filter((x) => inside(x.start, s.start, s.end)).length, animations: m.animations.filter((x) => inside(x.start, s.start, s.end)).length,
    };
  });
  const share = (k: (s: (typeof scenes)[number]) => boolean) => scenes.filter(k).reduce((a, s) => a + s.sec, 0) / S;
  const talkingShare = share((s) => s.kind === "talking head"), graphicShare = share((s) => s.kind === "graphic / screen"), footShare = share((s) => s.kind === "camera footage");
  const kind: MapPart["kind"] = talkingShare >= 0.4 ? "talking head" : graphicShare >= 0.6 ? "motion graphics" : footShare >= 0.6 ? "footage" : "mixed";

  // B-roll: in a video with a talking head, every scene without the face.
  let broll: MapPart["broll"] = null;
  if (talkingShare > 0) {
    const list = scenes.filter((s) => s.kind !== "talking head").map((s) => ({ start: s.start, end: s.end, type: BROLL[s.kind] ?? "video clip", says: s.says }));
    const secs = list.map((b) => b.end - b.start);
    broll = { count: list.length, perMin: r2(list.length / min), share: r2(secs.reduce((a, b) => a + b, 0) / S), medianSec: r2(median(secs)), minSec: r2(secs.length ? Math.min(...secs) : 0), maxSec: r2(secs.length ? Math.max(...secs) : 0), types: counts(list.map((b) => b.type)), list };
  }

  // In a talking head scene the speaker's own movement (head, hands) changes the picture too: only small elements that
  // slide, grow in or type on there count as animations.
  const talkingAt = (t: number) => scenes.some((s) => s.kind === "talking head" && t >= s.start && t < s.end);
  const an = m.animations.filter((a) => !talkingAt(a.start) || (a.box[2] * a.box[3] < 0.2 && /^(slides|grows in|types on)/.test(a.kind)));
  for (const s of scenes) s.animations = an.filter((x) => inside(x.start, s.start, s.end)).length;
  const moves = m.moves;
  const zi = moves.filter((x) => x.zoom > 1.03).map((x) => x.zoom), zo = moves.filter((x) => x.zoom < 0.97).map((x) => x.zoom);
  const camera: MapPart["camera"] = { count: moves.length, perMin: r2(moves.length / min), kinds: counts(moves.map((x) => x.kind)), medianMs: moves.length ? Math.round(median(moves.map((x) => x.ms))) : null, easings: counts(moves.map((x) => x.easing)), zoomIn: zi.length ? r2(median(zi)) : null, zoomOut: zo.length ? r2(median(zo)) : null, list: moves };
  const animations: MapPart["animations"] = { count: an.length, perMin: r2(an.length / min), kinds: counts(an.map((a) => a.kind)), medianMs: an.length ? Math.round(median(an.map((a) => a.ms))) : null, easings: counts(an.map((a) => a.easing).filter((e): e is string => !!e)), list: an };

  // Music: the sections joined, described from the longest one.
  let music: MapPart["music"] = null;
  const ms = m.music?.sections ?? [];
  if (ms.length) {
    const main = [...ms].sort((a, b) => b.end - b.start - (a.end - a.start))[0];
    music = { words: musicWords(main), bpm: main.bpm, key: main.key, mode: main.mode, share: r2(Math.min(1, (m.music?.musicSeconds ?? 0) / S)), sections: ms.map((s) => ({ start: s.start, end: s.end })), changes: m.music?.changes ?? [], stops: m.music?.stops ?? [], duckDb: main.duckDb };
  }
  const sfx: MapPart["sfx"] = { count: m.sfx.length, perMin: r2(m.sfx.length / min), kinds: counts(m.sfx.map((x) => x.kind)), list: m.sfx };
  const voiceWords = i.words.filter((w) => w.w).length;
  const voice = voiceWords ? { words: voiceWords, perMin: Math.round(voiceWords / min) } : null;

  // One timeline from start to end (the style file adds its text graphics, transitions, punch-ins and hits).
  const timeline: [number, string][] = [
    ...scenes.map((s, k): [number, string] => [s.start, `SCENE ${k + 1} (${s.start}-${s.end}s, ${s.sec}s): ${s.kind}${s.says ? `; says "${s.says}"` : ""}`]),
    ...(broll?.list ?? []).map((b): [number, string] => [b.start, `b-roll ${b.type} for ${r2(b.end - b.start)}s`]),
    ...moves.map((x): [number, string] => [x.start, `camera ${x.kind} to ${x.end}s (${x.zoom}x, ${x.ms} ms, ${x.easing}${x.pace === "slow drift" ? ", slow drift" : ""})`]),
    ...an.map((a): [number, string] => [a.start, `${a.kind} at the ${placeOfBox(a.box)} (${Math.round(a.box[2] * 100)}% wide, ${a.ms} ms${a.easing ? `, ${a.easing}` : ""})`]),
    ...m.sfx.map((x): [number, string] => [x.t, `sound effect: ${x.kind}${x.count ? ` x${x.count}` : ""} (${x.ms} ms)${x.near ? ` with the ${x.near[1]}` : ""}`]),
    ...ms.map((s): [number, string] => [s.start, `music starts${s.bpm ? ` (${s.bpm} bpm)` : ""}`]),
    ...(m.music?.changes ?? []).map((c): [number, string] => [c[0], `music ${c[1]} (${c[2] > 0 ? "+" : ""}${c[2]} dB)`]),
    ...(m.music?.stops ?? []).map((t): [number, string] => [t, "music stops"]),
  ].map(([t, s]): [number, string] => [r2(t), s]);

  // Frames worth a look: each scene settled, after animations land, text coming on.
  const want = [
    ...scenes.map((s) => Math.min(s.end - 0.1, s.start + Math.min(0.8, s.sec / 2))),
    ...(i.textStarts ?? []).map((t) => t + 0.6),
    ...an.filter((a) => a.kind !== "changes").map((a) => a.end + 0.1),
  ].filter((t) => t >= 0 && t < S).sort((a, b) => a - b);
  const lookAt: number[] = [];
  for (const t of want) if (!lookAt.some((x) => Math.abs(x - t) < 0.8)) lookAt.push(r1(t));
  const pick = lookAt.length > 24 ? lookAt.filter((_, k) => k % Math.ceil(lookAt.length / 24) === 0).slice(0, 24) : lookAt;

  // What a new video made this way needs, in the user's words.
  const needs: string[] = [];
  if (talkingShare > 0) needs.push(`Talking-head footage of the speaker (the reference shows a face ${Math.round(talkingShare * 100)}% of the time${voice ? `, about ${voice.perMin} words a minute` : ""}).`);
  if (broll?.count) {
    const t = top(broll.types, 5).map(([k, v]) => `${v} ${k}${v > 1 ? "s" : ""}`).join(", ");
    const eg = broll.list.filter((b) => b.says).slice(0, 3).map((b) => `"${b.says}"`).join("; ");
    needs.push(`B-roll: ${broll.count} pieces (${t}), about ${broll.medianSec}s each, matching what is said at that moment${eg ? `, e.g. ${eg}` : ""}.`);
  }
  const gscenes = scenes.filter((s) => s.kind === "graphic / screen").length;
  if (kind === "motion graphics" || gscenes) needs.push(`Screens or visuals for ${gscenes || scenes.length} motion-graphic scene${(gscenes || scenes.length) > 1 ? "s" : ""}: screen recordings or screenshots of the product, or the content to animate.`);
  needs.push("The logo (a PNG with a see-through background) and brand fonts, if the reference shows a logo or branded text.");
  if (kind === "footage") needs.push(`${scenes.length} camera clips like the reference's scenes.`);
  if (m.palette.length) needs.push(`Brand colours (the reference uses ${m.palette.slice(0, 4).map((c) => c[0]).join(", ")}).`);
  if (voice && talkingShare === 0) needs.push(`A voiceover or script (the reference has about ${voice.words} spoken or sung words).`);
  if (music) needs.push(`A music track: ${music.words.slice(0, 2).join(", ")}${music.bpm ? `, about ${Math.round(music.bpm)} bpm` : ""} (the user's own, or one Rendrr finds).`);
  if (sfx.count) needs.push(`Sound effects: ${top(sfx.kinds, 4).map(([k, v]) => `${v} ${k}`).join(", ")} (the user's own, or Rendrr's).`);

  return { kind, scenes, camera, animations, broll, palette: m.palette, music, sfx, voice, timeline, lookAt: pick, needs };
}

/** The map's parts as text for the AI (get_style), after the measured parts. */
export function mapText(p: MapPart): string[] {
  const L: string[] = [];
  L.push(`SCENES (${p.scenes.length}; the video is ${p.kind}):`, ...p.scenes.map((s, k) => `${k + 1}. ${s.start}-${s.end}s (${s.sec}s) ${s.kind}; colours ${s.colours.join(" ")}; ${s.moves} camera moves, ${s.animations} animations${s.says ? `; says "${s.says}"` : ""}`));
  const c = p.camera;
  L.push(c.count ? `CAMERA (whole-frame moves): ${c.count} (${c.perMin} a minute): ${top(c.kinds, 5).map(([k, v]) => `${k} ${v}`).join(", ")}; typically ${c.medianMs} ms; easing ${top(c.easings, 4).map(([k, v]) => `${k} ${v}`).join(", ")}${c.zoomIn ? `; zoom in typically ${c.zoomIn}x` : ""}${c.zoomOut ? `; zoom out typically ${c.zoomOut}x` : ""} (make them with keyframes and the same easing).` : "CAMERA: holds still (no zooms or pans of the whole frame).");
  const a = p.animations;
  L.push(a.count ? `ANIMATIONS (parts of the frame that move while the camera holds): ${a.count} (${a.perMin} a minute): ${top(a.kinds, 6).map(([k, v]) => `${k} ${v}`).join(", ")}; typically ${a.medianMs} ms; easing ${top(a.easings, 4).map(([k, v]) => `${k} ${v}`).join(", ") || "not measured"}. What moves is read from the frames (LOOK AT).` : "ANIMATIONS: none found.");
  const b = p.broll;
  if (b) L.push(b.count ? `B-ROLL: ${b.count} (${b.perMin} a minute), ${Math.round(b.share * 100)}% of the video, ${b.medianSec}s each (${b.minSec}-${b.maxSec}s); types: ${top(b.types, 5).map(([k, v]) => `${k} ${v}`).join(", ")}:` : "B-ROLL: none (the speaker stays on screen).", ...b.list.map((x) => `- ${x.start}-${x.end}s ${x.type}${x.says ? ` over "${x.says}"` : ""}`));
  if (p.palette.length) L.push(`COLOURS (share of the picture): ${p.palette.map(([h, s]) => `${h} ${Math.round(s * 100)}%`).join(", ")}.`);
  const mu = p.music;
  L.push(mu ? `MUSIC: ${mu.words.join("; ")}${mu.bpm ? `; ${mu.bpm} bpm` : ""}${mu.key ? `; key ${mu.key} ${mu.mode}` : ""}; plays ${Math.round(mu.share * 100)}% of the video (${mu.sections.map((s) => `${s.start}-${s.end}s`).join(", ")})${mu.changes.length ? `; ${mu.changes.map((x) => `${x[1]} at ${x[0]}s`).join(", ")}` : ""}${mu.stops.length ? `; stops at ${mu.stops.join(", ")}s` : ""}${mu.duckDb != null ? `; dips ${mu.duckDb} dB under the voice` : ""}.` : "MUSIC: none found.");
  const s = p.sfx;
  L.push(s.count ? `SOUND EFFECTS (kind estimated from the sound's shape): ${s.count} (${s.perMin} a minute): ${top(s.kinds, 6).map(([k, v]) => `${k} ${v}`).join(", ")}; ${s.list.filter((x) => x.near).length} sit on a picture event.` : "SOUND EFFECTS: none found.");
  return L;
}
