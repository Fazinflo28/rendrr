// Timeline -> FFmpeg. The one place that decides what a render looks like.
// planRender() is pure: it turns a snapshot + transcript into an ordered plan in OUTPUT time.
// ffmpegArgs() turns a plan + local file paths into one FFmpeg command (a single pass: fast and lossless between steps).
// Sequences (model B) are planned here; timelines stored in model A go to the unchanged A planner (renderPlanA.ts).
import { catalogMusic, catalogSfx } from "./catalog";
import type { Aspect, CaptionLook } from "./constants";
import { cutRegions, isSequence, mainVideoOf, mergeRanges, sequenceView, type Attached, type PicturePart, type Range, type SequenceView, type SoundPart } from "./sequence";
import type { Snapshot, V2Clip, V3Clip, A2Clip, A3Clip, Framing } from "./timeline";
import { allWords, type Transcript, type Word } from "./transcript";
import { ffmpegArgsA, planRenderA } from "./renderPlanA";
import { autoMusicFades, cleanupChain, cleanupParams, cleanupText, dialogueExpr, duckExpr, speechRanges, type DialogueSpan } from "./audio";
import { audioSettings, type AudioMixSettings } from "./timeline";
import { buildStyledAss, captionStyleOf, layoutCaptions, styleText, textPreset, type Card, type CaptionStyle, type StyledCaption, type TextAnim, type TextLayer, type TextStyle } from "./captions";

export type RenderKind = "preview" | "final";
export type SourceInfo = { width: number; height: number; fps: number; seconds: number; hasAudio: boolean; hdr?: boolean };
export type CaptionRules = { wordsAtOnce: number; upper: boolean; maxLines: number };

export type PlanInput = {
  kind: RenderKind;
  snapshot: Snapshot;
  transcript: Transcript;
  source: SourceInfo;
  captionRules?: Partial<CaptionRules>;
  /** Footage length of each b-roll video, by video id. Clips whose footage is unknown are skipped. */
  brollSeconds?: Record<string, number>;
  /** Which graphic clips have a rendered file ready, by v3 clip id. */
  graphicsReady?: Record<string, boolean>;
  /** The project's footage id (the sequence's main video). */
  videoId?: string;
  /** The other videos on V1, by id. */
  sources?: Record<string, SourceInfo>;
  /** Their transcripts (captions of their speech), by id. */
  transcripts?: Record<string, Transcript>;
};

export type ZoomOp = { start: number; end: number; scale: number; mode: "punch" | "push" };
export type OverlayOp = { clipId: string; start: number; end: number; sourceStart: number; videoId?: string; graphicId?: string };
export type AudioOp = { clipId: string; start: number; end: number; gainDb: number; assetKey: string; kind: "music" | "sfx"; fadeIn?: number; fadeOut?: number };
/** The sequence's sound settings and the numbers the mix is made from (edit seconds). */
export type AudioMix = AudioMixSettings & {
  /** Where people speak: music ducks under these. */
  speech: Range[];
  /** Dialogue clips with their own gain or fades. */
  dialogue: DialogueSpan[];
};
export type CaptionEvent = { start: number; end: number; text: string };

export type RenderPlan = {
  /** "B" = planned from a sequence; "A" = from a timeline stored in model A (renderPlanA.ts). */
  model: "A" | "B";
  kind: RenderKind;
  width: number; height: number; fps: number;
  aspect: Aspect;
  /** Footage ranges of the picture parts, in edit order (each part's video is in `parts`). */
  kept: Range[];
  /** The picture: parts in edit order, each a stretch of one video with its turn and framing. */
  parts: PicturePart[];
  /** The dialogue: parts in edit order covering the whole edit (muted = silent). */
  sound: SoundPart[];
  /** The videos it plays, main footage first. */
  sources: string[];
  /** Per video: has a sound track, HDR (tone-mapped like the preview copy). */
  videos?: Record<string, { hasAudio: boolean; hdr: boolean }>;
  /** Sequences only: cleanup, loudness target, ducking, fades. */
  audioMix?: AudioMix;
  outputSeconds: number;
  rotate: 0 | 90 | 180 | 270; // clockwise turn of the footage before it is fitted
  framing: { scale: number; x: number; y: number } | null; // the footage's position and scale in the frame, after the fit
  zooms: ZoomOp[];
  broll: OverlayOp[];
  graphics: OverlayOp[];
  audio: AudioOp[];
  dialogueMutes: Range[];
  captions: CaptionEvent[];
  captionLook: CaptionLook;
  /** Sequences: the caption style, the captions with their lines and word times, the text layers (Phase 4). */
  captionStyle?: CaptionStyle;
  styledCaptions?: StyledCaption[];
  texts?: TextLayer[];
  ass: string | null;
  operations: string[];
};

export class RenderPlanError extends Error {
  friendly = true;
  constructor(message: string) { super(message); }
}

const r3 = (n: number) => Math.round(n * 1000) / 1000;
const sameFraming = (a: Framing | null, b: Framing | null) => (!a && !b) || (!!a && !!b && a.scale === b.scale && a.x === b.x && a.y === b.y);
const FPS = 30;
const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);

export function outputSize(aspect: Aspect, kind: RenderKind) {
  const short = kind === "preview" ? 540 : 1080;
  if (aspect === "9:16") return { width: short, height: even((short * 16) / 9) };
  if (aspect === "1:1") return { width: short, height: short };
  return { width: even((short * 16) / 9), height: short };
}

export const DEFAULT_CAPTION_RULES: Record<CaptionLook, CaptionRules> = {
  clean: { wordsAtOnce: 7, upper: false, maxLines: 2 },
  bold: { wordsAtOnce: 3, upper: true, maxLines: 1 },
  outline: { wordsAtOnce: 5, upper: false, maxLines: 1 },
};

// ---------------------------------------------------------------------------------------------
// Captions: timed by the server from transcript words, never by the AI.
// ---------------------------------------------------------------------------------------------
type TimedToken = { text: string; t: number; end: number };

export function captionTokens(lineWords: Word[], text: string, cut: Set<string>, inKept: (t: number) => boolean): TimedToken[] {
  const tokens = text.trim().split(/\s+/).filter(Boolean);
  if (!tokens.length || !lineWords.length) return [];
  if (tokens.length === lineWords.length) {
    // Same number of words: keep each word's own timing (typo fixes, punctuation, casing).
    return lineWords.map((w, i) => ({ text: tokens[i], t: w.t, end: w.end })).filter((_, i) => !cut.has(lineWords[i].id) && inKept(lineWords[i].t));
  }
  // Rewritten line: spread the new words evenly over the words that are still in the video. A position p in
  // "kept word" units maps to a time inside that word, so more new words than old ones still get distinct times.
  const kept = lineWords.filter((w) => !cut.has(w.id) && inKept(w.t));
  if (!kept.length) return [];
  const n = kept.length, m = tokens.length;
  const at = (p: number) => {
    if (p >= n) return kept[n - 1].end;
    const k = kept[Math.floor(p)], f = p - Math.floor(p);
    return k.t + f * Math.max(0, k.end - k.t);
  };
  return tokens.map((tok, i) => {
    const t = at((i * n) / m);
    const p2 = ((i + 1) * n) / m;
    const end = Number.isInteger(p2) ? kept[Math.min(n, p2) - 1].end : at(p2);
    return { text: tok, t, end: Math.max(end, t + 0.05) };
  });
}

/**
 * Caption events for transcript lines whose words play in one stretch of footage that moves forward (a "run"):
 * inKept says whether a footage moment plays, toOutput maps it to the edit.
 */
function lineEvents(lines: Transcript, captionText: Record<string, string>, cut: Set<string>, visible: Set<string> | null, inKept: (t: number) => boolean, toOutput: (s: number) => number, total: number, rules: CaptionRules, look: CaptionLook): CaptionEvent[] {
  const events: CaptionEvent[] = [];
  for (const line of lines) {
    if (visible && !visible.has(line.id)) continue;
    const text = captionText[line.id] ?? line.words.map((w) => w.text).join(" ");
    const toks = captionTokens(line.words, text, cut, inKept);
    if (!toks.length) continue;
    // A rewritten line with many more words than time shows them in bigger groups (each group on screen for at
    // least 0.3 s) instead of flashing some and dropping others.
    const perWord = Math.max(0.001, toOutput(toks[toks.length - 1].end) - toOutput(toks[0].t)) / toks.length;
    const step = Math.max(rules.wordsAtOnce, Math.ceil(0.3 / perWord));
    for (let i = 0; i < toks.length; i += step) {
      const chunk = toks.slice(i, i + step);
      const next = toks[i + step];
      const start = toOutput(chunk[0].t);
      let end = next ? toOutput(next.t) : toOutput(chunk[chunk.length - 1].end) + 0.25;
      end = Math.min(end, total);
      if (end - start < 0.08) continue;
      // Bold and outline looks drop trailing commas and full stops, like most social captions.
      const tidy = (w: string) => (look === "clean" ? w : w.replace(/[,.;:]+$/, ""));
      const words = chunk.map((x) => tidy(x.text)).join(" ");
      events.push({ start: r3(start), end: r3(end), text: rules.upper ? words.toUpperCase() : words });
    }
  }
  return events;
}

/** No overlaps: a caption ends when the next one starts. */
function tidyEvents(events: CaptionEvent[]): CaptionEvent[] {
  events.sort((a, b) => a.start - b.start);
  for (let i = 0; i + 1 < events.length; i++) if (events[i].end > events[i + 1].start) events[i].end = events[i + 1].start;
  return events.filter((e) => e.end - e.start >= 0.05);
}

/**
 * Captions of a sequence: they follow the dialogue. The dialogue is split into runs (one video, footage moving
 * forward); each run captions the lines spoken in it, so a line that plays twice is captioned twice. Main footage
 * lines use the edit's caption text and caption clips; other videos show their own words.
 */
/** The words each caption group shows, timed in edit seconds: one group per transcript line where it plays (as
 *  sequenceCaptions decides what plays). Phase 4 lays them out with a caption style (layoutCaptions). */
export function sequenceCaptionGroups(input: PlanInput, view: SequenceView): { text: string; start: number; end: number }[][] {
  const tl = input.snapshot.timeline;
  if (!tl.captionsOn) return [];
  const main = view.mainVideoId;
  const cut = new Set(tl.cut);
  const capClips = (tl.tracks.v3 as V3Clip[]).filter((c) => c.kind === "caption" || (!c.kind && c.lineId));
  const visible = capClips.length ? new Set(capClips.map((c) => c.lineId).filter(Boolean) as string[]) : null;
  const runs: SoundPart[][] = [];
  for (const s of view.sound) {
    const run = runs[runs.length - 1], prev = run?.[run.length - 1];
    if (prev && prev.videoId === s.videoId && s.srcIn >= prev.srcOut - 1e-6) run.push(s);
    else runs.push([s]);
  }
  const groups: { text: string; start: number; end: number }[][] = [];
  for (const run of runs) {
    const vid = run[0].videoId;
    const lines = vid === main ? input.transcript : input.transcripts?.[vid];
    if (!lines?.length) continue;
    const inKept = (t: number) => run.some((s) => t >= s.srcIn && t < s.srcOut);
    const toOutput = (src: number) => {
      for (const s of run) { if (src < s.srcIn) return r3(s.start); if (src <= s.srcOut) return r3(s.start + (src - s.srcIn)); }
      return r3(run[run.length - 1].end);
    };
    for (const line of lines) {
      if (vid === main && visible && !visible.has(line.id)) continue;
      const text = (vid === main ? tl.captionText[line.id] : undefined) ?? line.words.map((w) => w.text).join(" ");
      const toks = captionTokens(line.words, text, vid === main ? cut : new Set(), inKept);
      if (toks.length) groups.push(toks.map((x) => ({ text: x.text, start: toOutput(x.t), end: toOutput(x.end) })));
    }
  }
  return groups.sort((a, b) => a[0].start - b[0].start);
}

export function sequenceCaptions(input: PlanInput, view: SequenceView, total: number, rules: CaptionRules): CaptionEvent[] {
  const tl = input.snapshot.timeline;
  if (!tl.captionsOn) return [];
  const main = view.mainVideoId;
  const cut = new Set(tl.cut);
  const capClips = (tl.tracks.v3 as V3Clip[]).filter((c) => c.kind === "caption" || (!c.kind && c.lineId));
  const visible = capClips.length ? new Set(capClips.map((c) => c.lineId).filter(Boolean) as string[]) : null;
  const runs: SoundPart[][] = [];
  for (const s of view.sound) {
    const run = runs[runs.length - 1], prev = run?.[run.length - 1];
    if (prev && prev.videoId === s.videoId && s.srcIn >= prev.srcOut - 1e-6) run.push(s);
    else runs.push([s]);
  }
  const events: CaptionEvent[] = [];
  for (const run of runs) {
    const vid = run[0].videoId;
    const lines = vid === main ? input.transcript : input.transcripts?.[vid];
    if (!lines?.length) continue;
    const inKept = (t: number) => run.some((s) => t >= s.srcIn && t < s.srcOut);
    const toOutput = (src: number) => {
      for (const s of run) { if (src < s.srcIn) return r3(s.start); if (src <= s.srcOut) return r3(s.start + (src - s.srcIn)); }
      return r3(run[run.length - 1].end);
    };
    events.push(...lineEvents(lines, vid === main ? tl.captionText : {}, vid === main ? cut : new Set(), vid === main ? visible : null, inKept, toOutput, total, rules, tl.captionLook));
  }
  return tidyEvents(events);
}

const assTime = (s: number) => {
  const cs = Math.max(0, Math.round(s * 100));
  const h = Math.floor(cs / 360000), m = Math.floor((cs % 360000) / 6000), sec = Math.floor((cs % 6000) / 100), c = cs % 100;
  return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}.${String(c).padStart(2, "0")}`;
};
// libass's own escapes, so the text shows as typed with any font: "\{" "\}" for braces, and a word joiner after a
// backslash so it can never start an override code. Very long words (links) are broken up so they wrap.
const assEscape = (s: string) => s
  .split(/\s+/).map((w) => (w.length > 22 ? w.match(/.{1,18}/g)!.join(" ") : w)).join(" ")
  .replace(/\\/g, "\\\u2060").replace(/\{/g, "\\{").replace(/\}/g, "\\}").replace(/\r?\n/g, "\\N");

/** ASS subtitles with the UI's three caption looks: clean (dark box), bold (white pill, black caps), outline. */
export function buildAss(events: CaptionEvent[], look: CaptionLook, width: number, height: number): string {
  // Sized by shape: vertical video gets bigger captions relative to its width, like the UI's previews.
  const portrait = height > width * 1.2, square = !portrait && height > width * 0.8;
  const factor = { bold: portrait ? 0.085 : square ? 0.075 : 0.062, outline: portrait ? 0.074 : square ? 0.066 : 0.056, clean: portrait ? 0.058 : square ? 0.054 : 0.046 }[look];
  const size = Math.round(Math.min(width, height) * factor);
  const marginV = Math.round(height * 0.13);
  const marginLR = Math.round(width * 0.08);
  // ASS colours are &HAABBGGRR, alpha 00 = solid.
  const styles: Record<CaptionLook, string> = {
    clean: `Style: Cap,Inter,${size},&H00FFFFFF,&H00FFFFFF,&H73000000,&H00000000,0,0,0,0,100,100,0,0,3,${Math.round(size * 0.28)},0,2,${marginLR},${marginLR},${marginV},1`,
    bold: `Style: Cap,Inter,${size},&H000C0A0A,&H000C0A0A,&H00FFFDFC,&H00000000,-1,0,0,0,100,100,0,0,3,${Math.round(size * 0.3)},0,2,${marginLR},${marginLR},${marginV},1`,
    outline: `Style: Cap,Inter,${size},&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,${Math.max(2, Math.round(size * 0.09))},0,2,${marginLR},${marginLR},${marginV},1`,
  };
  return [
    "[Script Info]", "ScriptType: v4.00+", `PlayResX: ${width}`, `PlayResY: ${height}`, "WrapStyle: 0", "ScaledBorderAndShadow: yes", "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    styles[look], "",
    "[Events]", "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ...events.map((e) => `Dialogue: 0,${assTime(e.start)},${assTime(e.end)},Cap,,0,0,0,,${assEscape(e.text)}`),
    "",
  ].join("\n");
}

// ---------------------------------------------------------------------------------------------
// planRender
// ---------------------------------------------------------------------------------------------
export function planRender(input: PlanInput): RenderPlan {
  // A timeline stored in model A (an old version, or a project the migration left on A) renders exactly as before.
  if (!isSequence(input.snapshot.timeline)) return planRenderA(input);
  const { snapshot, transcript, kind } = input;
  const tl = snapshot.timeline;
  const words = allWords(transcript);
  const main = mainVideoOf(tl);
  const infoOf = (vid: string) => (vid === main ? input.source : input.sources?.[vid]);
  const used = Array.from(new Set([main, ...(tl.tracks.v1 as unknown as { sourceVideoId: string }[]).map((c) => c.sourceVideoId)]));
  const missing = used.filter((v) => !infoOf(v));
  if (missing.length) throw new RenderPlanError(`A clip on V1 plays a video that is no longer in your library (${missing.join(", ")}). Remove that clip, then render again.`);
  // Every part starts and ends on a frame of the 30 fps output; footage beyond a file's real length is left out.
  const view = sequenceView(tl, words, { align: FPS, seconds: Object.fromEntries(used.map((v) => [v, infoOf(v)!.seconds])) });
  if (!view.picture.length) throw new RenderPlanError("Nothing is left to render. Every part of the video is cut. Restore some words or clips, then try again.");
  const total = r3(view.total);
  const { width, height } = outputSize(snapshot.aspect, kind);
  // A clip on another track hangs on its V1 clip and keeps its length.
  const placed = (c: Attached): { start: number; end: number } | null => {
    let s: number, e: number;
    if (c.fill) { s = 0; e = total; }
    else if (c.anchorId && view.clip(c.anchorId)) { s = view.editAt(c.anchorId, Number(c.anchorAt ?? 0))!; e = s + Number(c.length ?? c.end - c.start); }
    else return null;
    s = r3(Math.max(0, s)); e = r3(Math.min(total, e));
    return e - s >= 0.05 ? { start: s, end: e } : null;
  };

  const zooms: ZoomOp[] = [];
  const broll: OverlayOp[] = [];
  for (const c of tl.tracks.v2 as (V2Clip & Attached)[]) {
    const sp = placed(c);
    if (!sp) continue;
    const x = c as V2Clip & { mode?: string };
    if (c.kind === "zoom" || (c.zoom && !c.videoId)) {
      zooms.push({ ...sp, scale: Math.min(2, Math.max(1, c.zoom ?? 1.15)), mode: x.mode === "push" || sp.end - sp.start > 4 ? "push" : "punch" });
    } else if (c.videoId && input.brollSeconds?.[c.videoId] != null) {
      const len = input.brollSeconds[c.videoId];
      const ss = Math.min(c.sourceStart ?? 0, Math.max(0, len - 0.1));
      const end = Math.min(sp.end, sp.start + (len - ss));
      if (end - sp.start >= 0.05) broll.push({ clipId: c.id, start: sp.start, end: r3(end), sourceStart: ss, videoId: c.videoId });
    }
  }
  const graphics: OverlayOp[] = [];
  for (const c of tl.tracks.v3 as (V3Clip & Attached)[]) {
    if (c.kind !== "graphic" || !c.graphicId || (input.graphicsReady && !input.graphicsReady[c.id])) continue;
    const sp = placed(c);
    if (sp) graphics.push({ clipId: c.id, ...sp, sourceStart: 0, graphicId: c.graphicId });
  }
  const audio: AudioOp[] = [];
  // Keys come from the catalog only (see catalogMusic), whatever the stored clip says.
  for (const c of tl.tracks.a2 as (A2Clip & Attached)[]) {
    const track = catalogMusic(c);
    if (!track) continue;
    const sp = placed(c);
    if (!sp) continue;
    // A music clip without fades of its own fades in and out by itself (as before Phase 3).
    const x = c as A2Clip & { fadeIn?: number; fadeOut?: number }, auto = autoMusicFades(sp.end - sp.start);
    audio.push({ clipId: c.id, ...sp, gainDb: c.gainDb ?? -18, assetKey: track.key, kind: "music", fadeIn: r3(x.fadeIn ?? auto.fadeIn), fadeOut: r3(x.fadeOut ?? auto.fadeOut) });
  }
  for (const c of tl.tracks.a3 as (A3Clip & Attached)[]) {
    const sfx = catalogSfx(c);
    if (!sfx || !c.anchorId || !view.clip(c.anchorId)) continue;
    const start = r3(view.editAt(c.anchorId, Number(c.anchorAt ?? 0))!);
    if (start >= total) continue;
    const x = c as A3Clip & { fadeIn?: number; fadeOut?: number };
    audio.push({ clipId: c.id, start, end: r3(Math.min(total, start + Math.max(0.1, Number(c.length ?? c.end - c.start)))), gainDb: c.gainDb ?? -6, assetKey: sfx.key, kind: "sfx", fadeIn: x.fadeIn ?? 0, fadeOut: x.fadeOut ?? 0 });
  }
  // The sound: settings, where music ducks (speech), and dialogue clips with their own gain or fades.
  const settings = audioSettings(tl);
  const cutSet = new Set(tl.cut);
  const speech = speechRanges(view, (vid) => (vid === main ? words : input.transcripts?.[vid] ? allWords(input.transcripts[vid]) : null), cutSet);
  const dialogue: DialogueSpan[] = [];
  for (const p of view.clips) {
    const c = (tl.tracks.v1 as unknown as { id: string; audioGain?: number; audioFadeIn?: number; audioFadeOut?: number; audioMuted?: boolean }[]).find((x) => x.id === p.id);
    if (!c || c.audioMuted || !p.pieces.length || p.soundEnd - p.soundStart < 0.01) continue;
    if (!c.audioGain && !c.audioFadeIn && !c.audioFadeOut) continue;
    dialogue.push({ start: r3(p.soundStart), end: r3(p.soundEnd), gainDb: c.audioGain ?? 0, fadeIn: c.audioFadeIn ?? 0, fadeOut: c.audioFadeOut ?? 0 });
  }
  const audioMix: AudioMix = { ...settings, fadeIn: Math.min(settings.fadeIn, total / 2), fadeOut: Math.min(settings.fadeOut, total / 2), speech, dialogue };
  // Muted clips: their dialogue is silent.
  const dialogueMutes = mergeRanges(view.sound.filter((x) => x.muted).map((x) => ({ start: r3(x.start), end: r3(x.end) })).filter((g) => g.end > g.start));

  const look = tl.captionLook;
  // Captions and text layers (Phase 4): laid out once here, drawn by libass and by the editor from the same layout.
  const captionStyle = captionStyleOf(tl as { captionLook: CaptionLook; captionStyle?: CaptionStyle }, snapshot.aspect, input.captionRules);
  const styledCaptions = layoutCaptions(sequenceCaptionGroups(input, view), captionStyle, width, height, total);
  const captions: CaptionEvent[] = styledCaptions.map((c) => ({ start: c.start, end: c.end, text: c.lines.map((l) => l.map((w) => w.text).join(" ")).join(" ") })); // lines: styledCaptions
  const texts: TextLayer[] = [];
  for (const c of tl.tracks.v3 as (V3Clip & Attached & { text?: string; style?: TextStyle; card?: Card | null; anim?: TextAnim })[]) {
    if (c.kind !== "text" || !c.text?.trim()) continue;
    const sp = placed(c);
    if (!sp) continue;
    const def = textPreset("plain");
    texts.push({ clipId: c.id, start: Math.round(sp.start * 100) / 100, end: Math.round(sp.end * 100) / 100, lines: c.text.split("\n"), style: c.style ?? def.style, card: c.card ?? null, anim: c.anim ?? def.anim });
  }
  const ass = buildStyledAss({ captions: styledCaptions, captionStyle, texts, width, height });

  const parts = view.picture.map((p) => ({ ...p, start: r3(p.start), end: r3(p.end) }));
  const sound = view.sound.map((x) => ({ ...x, start: r3(x.start), end: r3(x.end) }));
  const sources = Array.from(new Set([main, ...parts.map((p) => p.videoId), ...sound.map((x) => x.videoId)])).filter((v) => parts.some((p) => p.videoId === v) || sound.some((x) => x.videoId === v));
  const videos = Object.fromEntries(sources.map((v) => [v, { hasAudio: infoOf(v)!.hasAudio, hdr: !!infoOf(v)!.hdr }]));
  const cutCount = cutRegions(words, new Set(tl.cut)).length;
  const live = view.clips.filter((c) => c.pieces.length);
  const jl = { j: live.filter((c, i) => i > 0 && c.soundStart < c.start - 1e-6).length, l: live.filter((c, i) => i > 0 && c.soundStart > c.start + 1e-6).length, muted: (tl.tracks.v1 as unknown as { audioMuted?: boolean }[]).filter((c) => c.audioMuted).length };
  const turned = new Set(parts.map((p) => p.rotate)), framings = parts.filter((p) => p.framing);
  const lookText = parts.every((p) => p.rotate === parts[0].rotate && sameFraming(p.framing, parts[0].framing))
    ? `${parts[0].rotate ? `Turn the footage ${parts[0].rotate}° clockwise, then fit` : "Fit"} to ${snapshot.aspect} at ${width}x${height}, 30 fps${parts[0].framing ? `; frame it: scale ${parts[0].framing.scale}, offset ${parts[0].framing.x}, ${parts[0].framing.y}` : ""}`
    : `Fit each part to ${snapshot.aspect} at ${width}x${height}, 30 fps (turned ${Array.from(turned).join("/")}°, ${framings.length} framed parts)`;
  const operations = [
    `Play ${parts.length} ${parts.length === 1 ? "part" : "parts"} from ${sources.length} ${sources.length === 1 ? "video" : "videos"} (${live.length} clips, ${cutCount} word cuts): ${total.toFixed(2)}s`,
    lookText,
    zooms.length ? `Zoom: ${zooms.length} (${zooms.filter((z) => z.mode === "punch").length} punch, ${zooms.filter((z) => z.mode === "push").length} slow push)` : "Zoom: none",
    broll.length ? `B-roll overlays: ${broll.length}` : "B-roll overlays: none",
    graphics.length ? `Graphics overlays: ${graphics.length}` : "Graphics overlays: none",
    captions.length ? `Captions: ${captions.length} word-timed events, ${tl.captionStyle ? "own style" : `look ${look}`}: ${styleText(captionStyle)}` : "Captions: off",
    texts.length ? `Text layers: ${texts.length}` : "Text layers: none",
    `Audio: dialogue${jl.j || jl.l ? ` (${jl.j} J cuts, ${jl.l} L cuts)` : ""}${jl.muted ? ` (${jl.muted} muted clips)` : ""}${dialogue.length ? ` (${dialogue.length} clips with their own gain or fades)` : ""}${cleanupText(settings) !== "none" ? `, cleanup ${cleanupText(settings)}` : ""}${settings.declick ? `, ${Math.round(settings.declick * 1000)} ms fade at every cut` : ""}${audio.some((a) => a.kind === "music") ? ` + music${settings.duck ? `, ${settings.duck} dB down under speech` : ""}` : ""}${audio.some((a) => a.kind === "sfx") ? ` + ${audio.filter((a) => a.kind === "sfx").length} sound effects` : ""}${settings.fadeIn || settings.fadeOut ? `; mix fades in ${settings.fadeIn}s, out ${settings.fadeOut}s` : ""}`,
    settings.loudness != null ? `Loudness: measured first, then set to ${settings.loudness} LUFS with a ${settings.peak} dBTP true-peak ceiling` : "Loudness: not normalized (limiter only)",
    kind === "preview" ? `Encode preview: H.264 ultrafast, ${width}x${height}` : `Encode final: H.264, ${width}x${height}`,
  ];
  return {
    model: "B", kind, width, height, fps: 30, aspect: snapshot.aspect, kept: parts.map((p) => ({ start: p.srcIn, end: p.srcOut })), parts, sound, sources, videos,
    outputSeconds: total, rotate: parts[0].rotate, framing: parts[0].framing, zooms, broll, graphics, audio, dialogueMutes, captions, captionLook: look, captionStyle, styledCaptions, texts, ass, operations, audioMix,
  };
}

// ---------------------------------------------------------------------------------------------
// ffmpegArgs: plan + local files -> one command. The filter graph goes in a script file.
// ---------------------------------------------------------------------------------------------
export type PlanFiles = {
  /** The main footage. */
  source: string;
  /** The other videos on V1, by video id. */
  videos?: Record<string, string>;
  output: string;
  assPath?: string;
  fontsDir?: string;
  broll?: Record<string, string>; // by clip id
  graphics?: Record<string, string>; // by clip id
  audio?: Record<string, string>; // by clip id
};

const q = (s: string) => `'${s.replace(/\\/g, "\\\\").replace(/'/g, "'\\''").replace(/:/g, "\\:")}'`;
const n3 = (x: number) => x.toFixed(3);
const n6 = (x: number) => x.toFixed(6);

export function zoomExpr(zooms: ZoomOp[]): string {
  if (!zooms.length) return "1";
  const terms = zooms.map((z) => {
    const s = (z.scale - 1).toFixed(4);
    if (z.mode === "push") return `if(between(t,${n3(z.start)},${n3(z.end)}),${s}*(t-${n3(z.start)})/${n3(Math.max(0.1, z.end - z.start))},0)`;
    const ramp = Math.min(0.12, (z.end - z.start) / 3).toFixed(3);
    return `if(between(t,${n3(z.start)},${n3(z.end)}),${s}*min(1,(t-${n3(z.start)})/${ramp})*min(1,(${n3(z.end)}-t)/${ramp}),0)`;
  });
  return `min(2,1+${terms.join("+")})`;
}

export type FfmpegOpts = {
  threads?: number;
  /** The loudness gain the measuring pass found (dB). Needed when the plan normalizes loudness. */
  loudnessGainDb?: number;
  /** Audio only, up to the mix, through ebur128: the measuring pass (its stderr has the loudness summary). */
  measure?: boolean;
};

export function ffmpegArgs(plan: RenderPlan, files: PlanFiles, source: SourceInfo, opts: FfmpegOpts = {}): { args: string[]; filterGraph: string } {
  if (plan.model === "A") return ffmpegArgsA(plan, files, source, opts);
  const mix = plan.audioMix;
  if (mix && mix.loudness != null && !opts.measure && opts.loudnessGainDb == null) throw new RenderPlanError("This render sets the loudness: measure the mix first (ffmpegArgs with measure: true), then pass loudnessGainDb.");
  const inputs: string[] = [];
  const g: string[] = [];
  let idx = 0;
  const W = plan.width, H = plan.height;
  const main = plan.sources[0];
  const info = (vid: string) => plan.videos?.[vid] ?? { hasAudio: vid === main ? source.hasAudio : true, hdr: vid === main ? !!source.hdr : false };

  // One input per video.
  const inOf: Record<string, number> = {};
  for (const vid of plan.sources) {
    const path = vid === main ? files.source : files.videos?.[vid];
    if (!path) throw new RenderPlanError(`The file of a video on V1 is missing (${vid}).`);
    inputs.push("-i", path);
    inOf[vid] = idx++;
  }
  const splitOf = (kind: "v" | "a", vid: string, n: number, name: (i: number) => string) => {
    if (kind === "v") g.push(`[${inOf[vid]}:v]fps=${FPS}${n > 1 ? `,split=${n}${Array.from({ length: n }, (_, i) => `[${name(i)}]`).join("")}` : `[${name(0)}]`}`);
    else g.push(`[${inOf[vid]}:a]aresample=48000${n > 1 ? `,asplit=${n}${Array.from({ length: n }, (_, i) => `[${name(i)}]`).join("")}` : `[${name(0)}]`}`);
  };

  // 1. Picture (not in the measuring pass): put each video on a 30 fps grid, take its parts and join them in edit
  // order. Parts start and end on frames (planRender), so each is a whole number of frames.
  let v = "";
  if (!opts.measure) {
    const vt = (k: { srcIn: number; srcOut: number }) => `trim=start=${n6(k.srcIn)}:end=${n6(k.srcOut)},setpts=PTS-STARTPTS`;
    const turnOf = (r: number) => (r === 90 ? "transpose=1," : r === 270 ? "transpose=2," : r === 180 ? "hflip,vflip," : "");
    // HDR originals are tone-mapped to SDR BT.709 exactly like the preview copy, so the final looks like the preview.
    const toneOf = (vid: string) => (info(vid).hdr ? "zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p," : "");
    const fit = `fps=${FPS},scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H}:(iw-ow)/2:(ih-oh)*0.4,setsar=1`;
    const frame = (from: string, f: Framing, to: string, tag: string) => {
      // The fitted picture is scaled about its centre and moved over a black frame.
      const sw = even(W * f.scale), sh = even(H * f.scale);
      const ox = Math.round((W - sw) / 2 + f.x * W), oy = Math.round((H - sh) / 2 + f.y * H);
      g.push(`color=c=black:s=${W}x${H}:r=${FPS}[fcanvas${tag}]`);
      g.push(`[${from}]scale=${sw}:${sh},setsar=1[fscaled${tag}]`);
      g.push(`[fcanvas${tag}][fscaled${tag}]overlay=x=${ox}:y=${oy}:shortest=1,format=yuv420p[${to}]`);
    };
    const N = plan.parts.length;
    // One video, one look: cut, join, then fit once (the same graph model A used). Otherwise each part is fitted first.
    const uniform = plan.sources.length === 1 && plan.parts.every((p) => p.rotate === plan.parts[0].rotate && sameFraming(p.framing, plan.parts[0].framing));
    for (const vid of plan.sources) {
      const mine = plan.parts.map((p, i) => ({ p, i })).filter((x) => x.p.videoId === vid);
      if (!mine.length) continue;
      splitOf("v", vid, mine.length, (k) => `sv${mine[k].i}`);
      for (const { p, i } of mine) {
        if (uniform) g.push(`[sv${i}]${vt(p)}[v${i}]`);
        else {
          g.push(`[sv${i}]${vt(p)},${turnOf(p.rotate)}${toneOf(vid)}${fit},format=yuv420p[${p.framing ? `pf${i}` : `v${i}`}]`);
          if (p.framing) frame(`pf${i}`, p.framing, `v${i}`, String(i));
        }
      }
    }
    g.push(`${plan.parts.map((_, i) => `[v${i}]`).join("")}concat=n=${N}:v=1:a=0[vcat]`);
    v = "vcat";
    if (uniform) {
      const p0 = plan.parts[0];
      g.push(`[vcat]${turnOf(p0.rotate)}${toneOf(p0.videoId)}${fit}[vfit]`);
      v = "vfit";
      if (p0.framing) { frame(v, p0.framing, "vframed", ""); v = "vframed"; }
    }
  }

  // 2. Dialogue: each sound part from its video (sample-exact), silence for muted parts, joined in edit order. Every
  // part fades in and out over the declick time (20 ms by default), so no cut clicks.
  const S = plan.sound.length;
  const live = (x: SoundPart) => !x.muted && info(x.videoId).hasAudio && inOf[x.videoId] != null;
  const declick = (x: SoundPart) => {
    if (!mix || !(mix.declick > 0)) return "";
    const len = x.srcOut - x.srcIn, d = Math.min(mix.declick, len / 4);
    return `,afade=t=in:d=${n6(d)},afade=t=out:st=${n6(len - d)}:d=${n6(d)}`;
  };
  const at = (k: SoundPart) => `atrim=start=${n6(k.srcIn)}:end=${n6(k.srcOut)},asetpts=PTS-STARTPTS${declick(k)}`;
  for (const vid of plan.sources) {
    const mine = plan.sound.map((x, i) => ({ x, i })).filter((y) => y.x.videoId === vid && live(y.x));
    if (!mine.length) continue;
    splitOf("a", vid, mine.length, (k) => `sa${mine[k].i}`);
    for (const { x, i } of mine) g.push(`[sa${i}]${at(x)}[a${i}]`);
  }
  plan.sound.forEach((x, i) => { if (!live(x)) g.push(`anullsrc=r=48000:cl=stereo,atrim=end_sample=${Math.max(1, Math.round((x.srcOut - x.srcIn) * 48000))},asetpts=PTS-STARTPTS[a${i}]`); });
  g.push(`${plan.sound.map((_, i) => `[a${i}]`).join("")}concat=n=${S}:v=0:a=1[acat]`);

  if (!opts.measure) v = overlays(plan, files, g, inputs, () => idx++, v);
  mixAudio(plan, files, g, inputs, () => idx++, opts);
  return { args: encodeArgs(plan, inputs, files, opts), filterGraph: g.join(";\n") };
}

/** Zooms, b-roll, graphics, captions on [v]; returns the label of the finished picture ([vout]). */
function overlays(plan: RenderPlan, files: PlanFiles, g: string[], inputs: string[], next: () => number, v0: string): string {
  const W = plan.width, H = plan.height;
  let v = v0;
  // 3. Zooms: scale per frame, crop back to size.
  if (plan.zooms.length) {
    const z = zoomExpr(plan.zooms);
    // crop's iw/ih are fixed when the filter starts, so the offsets are computed from the zoom itself
    // (centred across, 40% down, the same framing as the fit step).
    g.push(`[${v}]scale=w='2*trunc(${W}*(${z})/2)':h='2*trunc(${H}*(${z})/2)':eval=frame,crop=${W}:${H}:x='(2*trunc(${W}*(${z})/2)-${W})/2':y='(2*trunc(${H}*(${z})/2)-${H})*0.4'[vzoom]`);
    v = "vzoom";
  }
  // 4. B-roll overlays (video only; the dialogue keeps playing underneath).
  plan.broll.forEach((b, i) => {
    const path = files.broll?.[b.clipId];
    if (!path) return;
    inputs.push("-ss", n3(b.sourceStart), "-t", n3(b.end - b.start), "-i", path);
    const bi = next();
    g.push(`[${bi}:v]fps=30,scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1,setpts=PTS-STARTPTS+${n3(b.start)}/TB[br${i}]`);
    g.push(`[${v}][br${i}]overlay=0:0:enable='between(t,${n3(b.start)},${n3(b.end)})':eof_action=pass[vb${i}]`);
    v = `vb${i}`;
  });
  // 5. Graphics: transparent WebM, decoded with libvpx to keep the alpha channel.
  plan.graphics.forEach((gr, i) => {
    const path = files.graphics?.[gr.clipId];
    if (!path) return;
    inputs.push("-c:v", "libvpx-vp9", "-i", path);
    const gi = next();
    g.push(`[${gi}:v]format=yuva420p,scale=${W}:${H}:force_original_aspect_ratio=decrease,setpts=PTS-STARTPTS+${n3(gr.start)}/TB[gr${i}]`);
    g.push(`[${v}][gr${i}]overlay=(W-w)/2:(H-h)/2:enable='between(t,${n3(gr.start)},${n3(gr.end)})':eof_action=pass[vg${i}]`);
    v = `vg${i}`;
  });
  // 6. Captions on top of everything.
  if (plan.ass && files.assPath) {
    g.push(`[${v}]ass=filename=${q(files.assPath)}${files.fontsDir ? `:fontsdir=${q(files.fontsDir)}` : ""}[vcap]`);
    v = "vcap";
  }
  g.push(`[${v}]format=yuv420p[vout]`);
  return "vout";
}

const lin = (db: number) => Math.pow(10, db / 20);
/** The limiter's ceiling sits this far under the true-peak target: AAC encoding adds up to ~0.8 dB to sharp peaks (measured at 96k). */
const PEAK_MARGIN = 1.0;

/**
 * 7. Sound: the dialogue (cleanup, its clips' gains and fades), music ducked under speech, sound effects, the mix's
 * fades, then the loudness gain with a 4x oversampled limiter (true peak), or the old limiter when loudness is off.
 * The measuring pass stops before the loudness step and measures the mix with ebur128.
 */
function mixAudio(plan: RenderPlan, files: PlanFiles, g: string[], inputs: string[], next: () => number, opts: FfmpegOpts) {
  const mix = plan.audioMix;
  const cleanup = mix ? cleanupChain(cleanupParams(mix)) : "";
  const dlgExpr = mix ? dialogueExpr(mix.dialogue) : null;
  g.push(`[acat]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo${cleanup ? "," + cleanup : ""}${dlgExpr ? `,asetnsamples=n=480,volume='${dlgExpr}':eval=frame` : ""}[dlg]`);
  const music = plan.audio.filter((a) => a.kind === "music" && files.audio?.[a.clipId]);
  const sfx = plan.audio.filter((a) => a.kind === "sfx" && files.audio?.[a.clipId]);
  const fades = (d: number, fi: number, fo: number) => `${fi > 0 ? `,afade=t=in:d=${n3(Math.min(fi, d))}` : ""}${fo > 0 ? `,afade=t=out:st=${n3(Math.max(0, d - fo))}:d=${n3(Math.min(fo, d))}` : ""}`;
  const mixIn: string[] = [];
  if (music.length && !mix) {
    // A plan without mix settings (never made by planRender today): music ducked by a sidechain compressor, as before.
    g.push(`[dlg]asplit=2[dlgmix][dlgsc]`);
    mixIn.push("[dlgmix]");
  } else mixIn.push("[dlg]");
  music.forEach((m, i) => {
    inputs.push("-stream_loop", "-1", "-i", files.audio![m.clipId]);
    const mi = next();
    const d = Math.max(0.1, m.end - m.start);
    const auto = autoMusicFades(d);
    // Music goes down under speech: a fixed envelope (the live player follows the same curve).
    const duck = mix && mix.duck > 0 ? duckExpr(mix.speech, m.start, m.end) : "0";
    const ducking = duck !== "0" ? `,asetnsamples=n=480,volume='pow(10,-${mix!.duck}*(${duck})/20)':eval=frame` : "";
    g.push(`[${mi}:a]atrim=0:${n3(d)},asetpts=PTS-STARTPTS,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo${fades(d, m.fadeIn ?? auto.fadeIn, m.fadeOut ?? auto.fadeOut)},volume=${m.gainDb}dB,adelay=delays=${Math.round(m.start * 1000)}:all=1${ducking}[mu${i}]`);
  });
  if (music.length) {
    let bus = "[mu0]";
    if (music.length > 1) { g.push(`${music.map((_, i) => `[mu${i}]`).join("")}amix=inputs=${music.length}:normalize=0[mubus]`); bus = "[mubus]"; }
    if (!mix) { g.push(`${bus}[dlgsc]sidechaincompress=threshold=0.04:ratio=8:attack=15:release=350[muduck]`); mixIn.push("[muduck]"); }
    else mixIn.push(bus);
  }
  sfx.forEach((s, i) => {
    inputs.push("-i", files.audio![s.clipId]);
    const si = next();
    const d = Math.max(0.1, s.end - s.start);
    g.push(`[${si}:a]atrim=0:${n3(d)},asetpts=PTS-STARTPTS,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo${fades(d, s.fadeIn ?? 0, s.fadeOut ?? 0)},volume=${s.gainDb}dB,adelay=delays=${Math.round(s.start * 1000)}:all=1[fx${i}]`);
    mixIn.push(`[fx${i}]`);
  });
  const T = plan.outputSeconds;
  const mixFades = mix ? `${mix.fadeIn > 0 ? `,afade=t=in:d=${n3(mix.fadeIn)}` : ""}${mix.fadeOut > 0 ? `,afade=t=out:st=${n3(Math.max(0, T - mix.fadeOut))}:d=${n3(mix.fadeOut)}` : ""}` : "";
  const sum = mixIn.length > 1 ? `${mixIn.join("")}amix=inputs=${mixIn.length}:normalize=0:duration=first${mixFades}` : `${mixIn[0]}${mixFades ? "anull" + mixFades : "anull"}`;
  if (opts.measure) { g.push(`${sum},ebur128=peak=true:framelog=quiet[aout]`); return; }
  if (mix && mix.loudness != null) {
    // The measured gain, then a limiter at 4x the sample rate so the peaks between samples stay under the ceiling.
    g.push(`${sum},volume=${(opts.loudnessGainDb ?? 0).toFixed(2)}dB,aresample=192000,alimiter=limit=${lin(mix.peak - PEAK_MARGIN).toFixed(4)}:attack=5:release=50:level=disabled,aresample=48000[aout]`);
  } else {
    // Loudness off: a safety limiter only. (The old one had FFmpeg's auto-level on: it raised everything to the limit
    // and then rode loud sound wave by wave, which distorts it; model A plans keep it, unchanged.)
    g.push(`${sum},alimiter=limit=0.95:level=disabled[aout]`);
  }
}

function encodeArgs(plan: RenderPlan, inputs: string[], files: PlanFiles, opts: FfmpegOpts): string[] {
  if (opts.measure) {
    return ["-hide_banner", "-nostdin", "-y", "-nostats", ...inputs, "-filter_complex_script", "__FILTER_SCRIPT__", "-map", "[aout]", "-t", n3(plan.outputSeconds), "-progress", "pipe:1", "-f", "null", "-"];
  }
  const preview = plan.kind === "preview";
  return [
    "-hide_banner", "-nostdin", "-y", "-loglevel", "error",
    ...inputs,
    "-filter_complex_script", "__FILTER_SCRIPT__",
    "-map", "[vout]", "-map", "[aout]",
    "-c:v", "libx264", "-preset", preview ? "ultrafast" : "veryfast", "-crf", preview ? "28" : "20",
    "-pix_fmt", "yuv420p", "-r", "30", "-g", "60",
    "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709",
    "-c:a", "aac", "-b:a", preview ? "96k" : "192k", "-ar", "48000",
    "-t", n3(plan.outputSeconds),
    "-movflags", "+faststart",
    ...(opts.threads ? ["-threads", String(opts.threads)] : []),
    "-progress", "pipe:1", "-nostats",
    files.output,
  ];
}

/** Reads the measuring pass's ebur128 summary: integrated loudness (LUFS) and true peak (dBTP). */
export function readMixLoudness(stderr: string): { lufs: number | null; peakDb: number | null } {
  const summary = stderr.slice(stderr.lastIndexOf("Summary:"));
  if (!summary.startsWith("Summary:")) return { lufs: null, peakDb: null };
  const num = (re: RegExp) => { const m = re.exec(summary); const n = m ? Number(m[1]) : NaN; return Number.isFinite(n) ? n : null; };
  return { lufs: num(/I:\s+(-?[\d.]+) LUFS/), peakDb: num(/Peak:\s+(-?[\d.]+) dBFS/) };
}

/** The loudness step's gain: what brings the measured mix to the target, within -30..+24 dB (a silent mix gets none). */
export function loudnessGain(target: number, measuredLufs: number | null): number {
  if (measuredLufs == null || measuredLufs < -70) return 0;
  return Math.round(Math.min(24, Math.max(-30, target - measuredLufs)) * 100) / 100;
}
