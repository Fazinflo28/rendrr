// Captions and text layers (Phase 4): the style as numbers and names, and one layout both the renderer and the
// editor draw from. Every caption and text layer is laid out here in output pixels (the lines, the font size, the
// position, the box, stroke and shadow, the active word, the animation at each moment); libass draws it from the ASS
// file buildStyledAss() writes, and the editor draws the same layout with the same font files (see fontFaceCss()).
// Lines are broken here, never by libass (WrapStyle 2), so both break in the same places.
import { z } from "zod";
import type { Aspect, CaptionLook } from "./constants";
import { FONT_METRICS, type FontMetrics } from "./fontMetrics";
import { keyTracks, motionAt, type Key, type Motion } from "./motion";

// ---------------------------------------------------------------------------------------------
// Fonts: the bundled files (apps/web/public/fonts), one face per family name.
// ---------------------------------------------------------------------------------------------
export const CAPTION_FONTS = Array.from(new Set(Object.keys(FONT_METRICS).map((k) => k.split(":")[0]))) as [string, ...string[]];
/** The weights each font has. */
export const FONT_WEIGHTS: Record<string, number[]> = Object.fromEntries(CAPTION_FONTS.map((f) => [f, Object.keys(FONT_METRICS).filter((k) => k.startsWith(f + ":")).map((k) => Number(k.split(":")[1])).sort((a, b) => a - b)]));
export type Face = FontMetrics & { font: string; weight: number };
/** The face of a font nearest to a weight (fonts come in a few weights). */
export function faceOf(font: string, weight: number): Face {
  const ws = FONT_WEIGHTS[font] ?? FONT_WEIGHTS.Inter;
  const f = FONT_WEIGHTS[font] ? font : "Inter";
  const w = ws.reduce((b, x) => (Math.abs(x - weight) < Math.abs(b - weight) ? x : b), ws[0]);
  return { ...FONT_METRICS[`${f}:${w}`], font: f, weight: w };
}
/** Width in pixels of a text at an ASS font size (libass sizes a font so winAscent + winDescent = the size). */
export function textWidth(text: string, face: Face, size: number): number {
  let u = 0;
  for (const ch of text) { const c = ch.codePointAt(0)!; u += c >= 32 && c <= 255 ? face.widths[c - 32] || face.avg : face.avg; }
  return (u * size) / (face.winAscent + face.winDescent);
}
/** The @font-face rules the editor uses: the same files, with the ascent and descent libass uses, so a CSS line of
 *  height `size` px with font-size cssSize() puts the glyphs where libass does. */
export function fontFaceCss(base = "/fonts/"): string {
  return Object.values(FONT_METRICS).map((m) => `@font-face{font-family:"${m.family}";src:url(${base}${m.file}) format("truetype");font-display:block;ascent-override:${((m.winAscent / m.upm) * 100).toFixed(3)}%;descent-override:${((m.winDescent / m.upm) * 100).toFixed(3)}%;line-gap-override:0%}`).join("\n");
}
/** CSS font-size for an ASS font size. */
export const cssSize = (face: Face, size: number) => (size * face.upm) / (face.winAscent + face.winDescent);

// ---------------------------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------------------------
const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/, "a colour like #FFD400");
const unit = z.number().min(0).max(1);
export const StrokeSchema = z.object({ color: hex, width: z.number().min(0).max(30) });   // width: % of the font size
export const ShadowSchema = z.object({ color: hex, opacity: unit, x: z.number().min(-30).max(30), y: z.number().min(-30).max(30) }); // offsets: % of the font size
export const BoxSchema = z.object({ color: hex, opacity: unit, padding: z.number().min(0).max(100) }); // padding: % of the font size
export const CASES = ["none", "upper", "lower"] as const;
const look = {
  font: z.enum(CAPTION_FONTS),
  weight: z.number().int().min(100).max(900),
  /** Font size as a share of the frame's short side, in % (the ASS font size). */
  size: z.number().min(1).max(25),
  color: hex,
  /** With a box there is no stroke (libass draws the box with the stroke's settings). */
  stroke: StrokeSchema.nullable(),
  shadow: ShadowSchema.nullable(),
  box: BoxSchema.nullable(),
  x: unit, y: unit,
  case: z.enum(CASES),
};
/** A caption style. x, y: the bottom centre of the caption, as shares of the frame. */
export const CaptionStyleSchema = z.object({
  ...look,
  /** The colour of the word being spoken (null = no highlight). */
  highlight: hex.nullable(),
  wordsAtOnce: z.number().int().min(1).max(20),
  wordsPerLine: z.number().int().min(1).max(20),
  lines: z.number().int().min(1).max(3),
  /** Drop trailing commas and full stops. */
  tidy: z.boolean(),
});
export type CaptionStyle = z.infer<typeof CaptionStyleSchema>;
export const TEXT_ALIGNS = ["left", "center", "right"] as const;
/** A text layer's style. x, y: the point the text hangs on (its middle, its left or right end by `align`). */
export const TextStyleSchema = z.object({ ...look, align: z.enum(TEXT_ALIGNS) });
export type TextStyle = z.infer<typeof TextStyleSchema>;
export const TEXT_ANIMS = ["none", "fade", "pop", "slide"] as const;
export type TextAnim = (typeof TEXT_ANIMS)[number];
export const CardSchema = z.object({ color: hex, opacity: unit });
export type Card = z.infer<typeof CardSchema>;
/** A partial style: what set_caption_style, add_text and set_text take. Nested parts replace as a whole; null removes. */
export const CaptionStylePatchSchema = CaptionStyleSchema.partial();
export const TextStylePatchSchema = TextStyleSchema.partial();

const shapeOf = (aspect: Aspect) => (aspect === "9:16" ? 0 : aspect === "1:1" ? 1 : 2);
/** The three looks as caption styles (the sizes depend on the frame's shape, as before Phase 4). */
export function presetStyle(lookName: CaptionLook, aspect: Aspect): CaptionStyle {
  const sh = shapeOf(aspect);
  const base = { x: 0.5, y: 0.87, highlight: null, shadow: null, case: "none" as const };
  if (lookName === "bold") return { ...base, font: "Inter", weight: 700, size: [8.5, 7.5, 6.2][sh], color: "#0A0A0C", stroke: null, box: { color: "#FCFDFF", opacity: 1, padding: 30 }, wordsAtOnce: 3, wordsPerLine: 3, lines: 1, case: "upper", tidy: true };
  if (lookName === "outline") return { ...base, font: "Inter", weight: 700, size: [7.4, 6.6, 5.6][sh], color: "#FFFFFF", stroke: { color: "#000000", width: 9 }, box: null, wordsAtOnce: 5, wordsPerLine: 5, lines: 1, tidy: true };
  return { ...base, font: "Inter", weight: 400, size: [5.8, 5.4, 4.6][sh], color: "#FFFFFF", stroke: null, box: { color: "#000000", opacity: 0.55, padding: 28 }, wordsAtOnce: 7, wordsPerLine: 4, lines: 2, tidy: false };
}
/** The caption style of an edit: its own style, else its look's preset with the style rules' word counts and case. */
export function captionStyleOf(tl: { captionLook: CaptionLook; captionStyle?: CaptionStyle }, aspect: Aspect, rules?: { wordsAtOnce?: number; upper?: boolean; maxLines?: number } | null): CaptionStyle {
  if (tl.captionStyle) return tl.captionStyle;
  const p = presetStyle(tl.captionLook, aspect);
  if (!rules) return p;
  const lines = rules.maxLines ?? p.lines;
  const wordsAtOnce = rules.wordsAtOnce ?? p.wordsAtOnce;
  return { ...p, wordsAtOnce, lines, wordsPerLine: lines > 1 ? Math.ceil(wordsAtOnce / lines) : wordsAtOnce, case: rules.upper ? "upper" : p.case };
}
export const TEXT_PRESETS = ["title", "callout", "lower-third", "plain"] as const;
export type TextPreset = (typeof TEXT_PRESETS)[number];
export function textPreset(name: TextPreset): { style: TextStyle; anim: TextAnim } {
  const base = { shadow: null, stroke: null, box: null, case: "none" as const, align: "center" as const };
  if (name === "title") return { style: { ...base, font: "Montserrat", weight: 900, size: 9, color: "#FFFFFF", shadow: { color: "#000000", opacity: 0.6, x: 0, y: 6 }, x: 0.5, y: 0.45, case: "upper" }, anim: "pop" };
  if (name === "callout") return { style: { ...base, font: "Inter", weight: 800, size: 5, color: "#0A0A0C", box: { color: "#FFD400", opacity: 1, padding: 30 }, x: 0.5, y: 0.22 }, anim: "pop" };
  if (name === "lower-third") return { style: { ...base, font: "Inter", weight: 700, size: 4.5, color: "#FFFFFF", box: { color: "#000000", opacity: 0.6, padding: 30 }, x: 0.06, y: 0.78, align: "left" }, anim: "slide" };
  return { style: { ...base, font: "Inter", weight: 700, size: 6, color: "#FFFFFF", stroke: { color: "#000000", width: 8 }, x: 0.5, y: 0.5 }, anim: "fade" };
}

const caseOf = (s: string, c: (typeof CASES)[number]) => (c === "upper" ? s.toUpperCase() : c === "lower" ? s.toLowerCase() : s);
const pct = (n: number) => `${Math.round(n * 10) / 10}`;
/** "Montserrat 900, 7% size, white, black stroke 8%, box #000000 55%, yellow active word, 4 words a line, 2 lines" */
export function styleText(s: CaptionStyle | TextStyle): string {
  const c = s as CaptionStyle;
  return [
    `${s.font} ${faceOf(s.font, s.weight).weight}, ${pct(s.size)}% size, ${s.color}`,
    s.box ? `box ${s.box.color} ${Math.round(s.box.opacity * 100)}%` : s.stroke && s.stroke.width > 0 ? `stroke ${s.stroke.color} ${pct(s.stroke.width)}%` : "",
    s.shadow ? `shadow ${s.shadow.color}` : "",
    s.case !== "none" ? s.case + " case" : "",
    c.highlight ? `active word ${c.highlight}` : "",
    c.wordsAtOnce ? `${c.wordsAtOnce} words at once, ${c.wordsPerLine} a line, up to ${c.lines} ${c.lines === 1 ? "line" : "lines"}` : "",
    `at ${Math.round(s.x * 100)}%, ${Math.round(s.y * 100)}%`,
  ].filter(Boolean).join(", ");
}

// ---------------------------------------------------------------------------------------------
// Layout in output pixels
// ---------------------------------------------------------------------------------------------
/** Everything about how a style draws, in output pixels. */
export type Drawn = {
  face: Face;
  /** The ASS font size: line height in pixels. */
  size: number;
  color: string;
  stroke: { color: string; px: number } | null;
  shadow: { color: string; opacity: number; x: number; y: number } | null;
  box: { color: string; opacity: number; pad: number } | null;
};
export function drawnOf(s: CaptionStyle | TextStyle, W: number, H: number): Drawn {
  const size = Math.round(((Math.min(W, H) * s.size) / 100) * 10) / 10;
  const px = (p: number) => Math.round(((size * p) / 100) * 10) / 10;
  return {
    face: faceOf(s.font, s.weight), size, color: s.color,
    stroke: !s.box && s.stroke && s.stroke.width > 0 ? { color: s.stroke.color, px: px(s.stroke.width) } : null,
    shadow: s.shadow && s.shadow.opacity > 0 ? { color: s.shadow.color, opacity: s.shadow.opacity, x: px(s.shadow.x), y: px(s.shadow.y) } : null,
    box: s.box ? { color: s.box.color, opacity: s.box.opacity, pad: px(s.box.padding) } : null,
  };
}

export type CaptionWord = { text: string; start: number };
/** A caption on screen: its lines of words; each word is active from its start to the next word's (the last to the end). */
export type StyledCaption = { start: number; end: number; lines: CaptionWord[][] };

/**
 * Lines for the words of one caption: wordsPerLine a line, and a line wider than the room splits again by width.
 * Null when that needs more lines than the style allows (the caller then shows the words in two captions).
 */
export function breakLines(words: string[], s: CaptionStyle, d: Drawn, room: number, anyLines = false): string[][] | null {
  const lines: string[][] = [];
  for (let i = 0; i < words.length; i += s.wordsPerLine) lines.push(words.slice(i, i + s.wordsPerLine));
  const out: string[][] = [];
  for (const line of lines) {
    let cur: string[] = [];
    for (const w of line) {
      const next = [...cur, w];
      if (cur.length && textWidth(next.join(" "), d.face, d.size) > room) { out.push(cur); cur = [w]; } else cur = next;
    }
    if (cur.length) out.push(cur);
  }
  return out.length > s.lines && !anyLines ? null : out;
}
/** The room a caption line has: 84% of the frame's width, minus the box padding on both sides. */
export const captionRoom = (d: Drawn, W: number) => W * 0.84 - 2 * (d.box?.pad ?? 0) - 2 * (d.stroke?.px ?? 0);

/**
 * Captions from timed words (edit seconds, in order, already grouped by transcript line): `wordsAtOnce` at a time
 * (more when words are faster than 0.3 s each), cased and tidied, broken into lines; a group that needs more lines
 * than allowed is shown as two captions (when each still stays 0.3 s on screen; else as one with more lines). `end` of a group: the next group's start, or its last word's end + 0.25 s.
 */
export function layoutCaptions(groups: { text: string; start: number; end: number }[][], s: CaptionStyle, W: number, H: number, total: number): StyledCaption[] {
  const d = drawnOf(s, W, H), room = captionRoom(d, W);
  const tidy = (w: string) => (s.tidy ? w.replace(/[,.;:]+$/, "") : w);
  const out: StyledCaption[] = [];
  const emit = (toks: { text: string; start: number; end: number }[], end: number) => {
    const words = toks.map((x) => caseOf(tidy(x.text), s.case));
    const lines = breakLines(words, s, d, room);
    const mid = Math.ceil(toks.length / 2);
    // Too many lines: two captions, when each still stays 0.3 s on screen; else one caption with more lines.
    if (!lines && toks.length > 1 && toks[mid].start - toks[0].start >= 0.3 && end - toks[mid].start >= 0.3) {
      emit(toks.slice(0, mid), toks[mid].start);
      emit(toks.slice(mid), end);
      return;
    }
    const ls = lines ?? breakLines(words, s, d, room, true)!;
    let k = 0;
    const timed = ls.map((l) => l.map((w) => ({ text: w, start: r2(toks[k++].start) })));
    const a = r2(toks[0].start), b = r2(Math.min(end, total));
    if (b - a >= 0.08) out.push({ start: a, end: b, lines: timed });
  };
  for (const toks of groups) {
    if (!toks.length) continue;
    const perWord = Math.max(0.001, toks[toks.length - 1].end - toks[0].start) / toks.length;
    const step = Math.max(Math.min(s.wordsAtOnce, s.wordsPerLine * s.lines), Math.ceil(0.3 / perWord));
    for (let i = 0; i < toks.length; i += step) {
      const chunk = toks.slice(i, i + step), next = toks[i + step];
      emit(chunk, next ? next.start : chunk[chunk.length - 1].end + 0.25);
    }
  }
  // One caption on screen at a time: a caption ends when the next one starts.
  out.sort((a, b) => a.start - b.start);
  for (let i = 0; i + 1 < out.length; i++) if (out[i].end > out[i + 1].start) out[i].end = out[i + 1].start;
  return out.filter((c) => c.end - c.start >= 0.05);
}
const r2 = (n: number) => Math.round(n * 100) / 100;

/** The word being spoken in a caption at time t: [line, word] (null before the first word). */
export function activeWord(c: StyledCaption, t: number): [number, number] | null {
  let hit: [number, number] | null = null;
  c.lines.forEach((l, i) => l.forEach((w, j) => { if (w.start <= t + 1e-6) hit = [i, j]; }));
  return hit;
}

/** A text layer as the render draws it (edit seconds). */
/** keys (Phase 5): keyframes in seconds from the layer's start; they move, scale, turn and fade the text (not its card). */
export type TextLayer = { clipId: string; start: number; end: number; lines: string[]; style: TextStyle; card: Card | null; anim: TextAnim; keys?: Key[] };
/** Seconds an animation takes in and out. */
export const ANIM_IN: Record<TextAnim, number> = { none: 0, fade: 0.25, pop: 0.15, slide: 0.25 };
export const ANIM_OUT: Record<TextAnim, number> = { none: 0, fade: 0.25, pop: 0.25, slide: 0.25 };
/** A text layer's look at time u after it starts (of `len` seconds): opacity, scale and how far down it is (px). The
 *  same linear curves the ASS tags draw (\fad, \t, \move). */
export function textAnimAt(anim: TextAnim, u: number, len: number, H: number): { opacity: number; scale: number; dy: number } {
  if (anim === "none") return { opacity: 1, scale: 1, dy: 0 };
  const ms = (x: number) => Math.round(x * 1000) / 1000;
  const fin = anim === "pop" ? 0.1 : ANIM_IN[anim], fout = ANIM_OUT[anim];
  let opacity = 1;
  if (u < fin) opacity = Math.max(0, u / fin);
  if (len - u < fout) opacity = Math.min(opacity, Math.max(0, (len - u) / fout));
  const scale = anim === "pop" ? (u < 0.15 ? 0.8 + (0.2 * u) / 0.15 : 1) : 1;
  const dy = anim === "slide" ? (u < 0.25 ? Math.round(H * 0.04 * (1 - u / 0.25) * 10) / 10 : 0) : 0;
  return { opacity: ms(opacity), scale: ms(scale), dy };
}
/** A keyframed text layer's look at u seconds in: its anchor point (px), scale, turn (degrees clockwise) and opacity,
 *  its animation and its keyframes together. The editor draws this; the ASS file draws it piece by piece. */
export function textLookAt(t: Pick<TextLayer, "start" | "end" | "anim" | "style" | "keys">, u: number, W: number, H: number): { x: number; y: number; scale: number; rotation: number; opacity: number } {
  const a = textAnimAt(t.anim, u, t.end - t.start, H);
  const m: Motion = motionAt(keyTracks(t.keys), u);
  return { x: t.style.x * W + m.x * W, y: t.style.y * H + a.dy + m.y * H, scale: a.scale * m.scale, rotation: m.rotation, opacity: a.opacity * m.opacity };
}
/** Where a keyframed text layer's curves bend (seconds in, to 1/100 s): the ASS pieces start and end there. */
export function textPieces(t: Pick<TextLayer, "start" | "end" | "anim" | "keys">): number[] {
  const len = t.end - t.start;
  const fin = t.anim === "pop" ? 0.1 : ANIM_IN[t.anim];
  const at = new Set<number>([0, len, fin, len - ANIM_OUT[t.anim], ...(t.anim === "pop" ? [0.15] : []), ...(t.anim === "slide" ? [0.25] : [])]);
  const tr = keyTracks(t.keys);
  for (const p of Object.values(tr ?? {})) for (const x of p!) at.add(x.t);
  const cs = Array.from(at).map((x) => Math.round(x * 100) / 100).filter((x) => x >= 0 && x <= len + 1e-9).sort((a, b) => a - b);
  return cs.filter((x, i) => i === 0 || x - cs[i - 1] >= 0.01);
}
/** A text layer's block size (px): its widest line and its lines' height, padding included. */
export function textBlock(l: Pick<TextLayer, "lines" | "style">, W: number, H: number): { w: number; h: number } {
  const d = drawnOf(l.style, W, H);
  const pad = (d.box?.pad ?? 0) + (d.stroke?.px ?? 0);
  const lines = l.lines.map((x) => caseOf(x, l.style.case));
  return { w: Math.max(0, ...lines.map((x) => textWidth(x, d.face, d.size))) + 2 * pad, h: lines.length * d.size + 2 * pad };
}
/** A text layer's box on screen (px), at rest. */
export function textRect(l: Pick<TextLayer, "lines" | "style">, W: number, H: number): { x: number; y: number; w: number; h: number } {
  const b = textBlock(l, W, H), ax = l.style.x * W, ay = l.style.y * H;
  const x = l.style.align === "left" ? ax : l.style.align === "right" ? ax - b.w : ax - b.w / 2;
  return { x, y: ay - b.h / 2, w: b.w, h: b.h };
}
/** A caption's box on screen (px). */
export function captionRect(c: StyledCaption, s: CaptionStyle, W: number, H: number): { x: number; y: number; w: number; h: number } {
  const d = drawnOf(s, W, H), pad = (d.box?.pad ?? 0) + (d.stroke?.px ?? 0);
  const w = Math.max(0, ...c.lines.map((l) => textWidth(l.map((x) => x.text).join(" "), d.face, d.size))) + 2 * pad, h = c.lines.length * d.size + 2 * pad;
  // libass puts the text's bottom on y; the box's padding reaches past it on every side.
  return { x: s.x * W - w / 2, y: s.y * H - c.lines.length * d.size - pad, w, h };
}

// ---------------------------------------------------------------------------------------------
// ASS
// ---------------------------------------------------------------------------------------------
const assTime = (s: number) => {
  const cs = Math.max(0, Math.round(s * 100));
  const h = Math.floor(cs / 360000), m = Math.floor((cs % 360000) / 6000), sec = Math.floor((cs % 6000) / 100), c = cs % 100;
  return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}.${String(c).padStart(2, "0")}`;
};
// libass's own escapes: "\{" "\}" for braces, and a word joiner after a backslash so it never starts a tag.
const esc = (s: string) => s.replace(/\\/g, "\\⁠").replace(/\{/g, "\\{").replace(/\}/g, "\\}");
/** #RRGGBB + opacity -> &HAABBGGRR (alpha 00 = solid). */
export function assColor(hexColor: string, opacity = 1): string {
  const a = Math.round((1 - opacity) * 255 + 1e-9).toString(16).padStart(2, "0").toUpperCase();
  const h = hexColor.replace("#", "").toUpperCase();
  return `&H${a}${h.slice(4, 6)}${h.slice(2, 4)}${h.slice(0, 2)}`;
}
const bgr = (hexColor: string) => "&H" + assColor(hexColor).slice(4); // &HBBGGRR (no alpha), for \1c tags
const n1 = (x: number) => String(Math.round(x * 10) / 10);
function styleLine(name: string, d: Drawn, alignment: number): string {
  const boxed = !!d.box;
  const outlineColour = boxed ? assColor(d.box!.color, d.box!.opacity) : assColor(d.stroke?.color ?? "#000000");
  const back = d.shadow ? assColor(d.shadow.color, d.shadow.opacity) : "&H00000000";
  const outline = boxed ? d.box!.pad : d.stroke?.px ?? 0;
  return `Style: ${name},${d.face.family},${n1(d.size)},${assColor(d.color)},${assColor(d.color)},${outlineColour},${back},0,0,0,0,100,100,0,0,${boxed ? 3 : 1},${n1(outline)},0,${alignment},0,0,0,1`;
}
const shadowTags = (d: Drawn) => (d.shadow ? `\\xshad${n1(d.shadow.x)}\\yshad${n1(d.shadow.y)}` : "");

/**
 * One ASS file for the captions and the text layers. Text layers are drawn in V3 order under the captions; a card is a
 * full-frame rectangle under its text. WrapStyle 2: lines break only where this file says.
 */
export function buildStyledAss(o: { captions: StyledCaption[]; captionStyle: CaptionStyle | null; texts: TextLayer[]; width: number; height: number }): string | null {
  const { width: W, height: H } = o;
  if (!o.captions.length && !o.texts.length) return null;
  const styles: string[] = [], events: string[] = [];
  const ev = (layer: number, a: number, b: number, style: string, text: string) => events.push(`Dialogue: ${layer},${assTime(a)},${assTime(b)},${style},,0,0,0,,${text}`);
  o.texts.forEach((t, i) => {
    const d = drawnOf(t.style, W, H);
    const an = t.style.align === "left" ? 4 : t.style.align === "right" ? 6 : 5;
    styles.push(styleLine(`T${i}`, d, an));
    const X = n1(t.style.x * W), Y = n1(t.style.y * H);
    const fin = Math.round((t.anim === "pop" ? 0.1 : ANIM_IN[t.anim]) * 1000), fout = Math.round(ANIM_OUT[t.anim] * 1000);
    const fad = t.anim === "none" ? "" : `\\fad(${fin},${fout})`;
    if (t.card) ev(i * 2, t.start, t.end, "Card", `{\\an7\\pos(0,0)\\p1\\bord0\\shad0\\1c${bgr(t.card.color)}&\\1a&H${Math.round((1 - t.card.opacity) * 255 + 1e-9).toString(16).padStart(2, "0").toUpperCase()}&${fad}}m 0 0 l ${W} 0 ${W} ${H} 0 ${H}{\\p0}`);
    const body = t.lines.map((l) => esc(caseOf(l, t.style.case))).join("\\N");
    if (t.keys?.length) {
      // Keyframed (Phase 5): one event per piece of the curve table, each a straight line from its start to its end
      // (position, scale, turn, fade), with the layer's animation folded in. ASS turns counter-clockwise: \frz is minus.
      const cuts = textPieces(t);
      for (let k = 0; k + 1 < cuts.length; k++) {
        const u0 = cuts[k], u1 = cuts[k + 1], ms = Math.round((u1 - u0) * 1000);
        const a = textLookAt(t, u0, W, H), b = textLookAt(t, u1, W, H);
        const al = (o: number) => Math.round((1 - Math.min(1, Math.max(0, o))) * 255);
        ev(i * 2 + 1, t.start + u0, t.start + u1, `T${i}`, `{\\move(${n1(a.x)},${n1(a.y)},${n1(b.x)},${n1(b.y)},0,${ms})\\fscx${n1(a.scale * 100)}\\fscy${n1(a.scale * 100)}\\frz${n1(-a.rotation)}\\fade(${al(a.opacity)},${al(b.opacity)},${al(b.opacity)},0,${ms},${ms},${ms})\\t(0,${ms},\\fscx${n1(b.scale * 100)}\\fscy${n1(b.scale * 100)}\\frz${n1(-b.rotation)})${shadowTags(d)}}${body}`);
      }
      return;
    }
    const motion = t.anim === "slide" ? `\\move(${X},${n1(t.style.y * H + H * 0.04)},${X},${Y},0,250)` : `\\pos(${X},${Y})`;
    const pop = t.anim === "pop" ? "\\fscx80\\fscy80\\t(0,150,\\fscx100\\fscy100)" : "";
    ev(i * 2 + 1, t.start, t.end, `T${i}`, `{${motion}${fad}${pop}${shadowTags(d)}}${body}`);
  });
  // Cards: full-frame rectangles, drawn with a plain style (a box style would paint a box around them).
  if (o.texts.some((t) => t.card)) styles.unshift("Style: Card,Arial,20,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,7,0,0,0,1");
  if (o.captions.length && o.captionStyle) {
    const s = o.captionStyle, d = drawnOf(s, W, H);
    styles.push(styleLine("Cap", d, 2));
    const head = `{\\pos(${n1(s.x * W)},${n1(s.y * H)})${shadowTags(d)}}`;
    const layer = 1000;
    for (const c of o.captions) {
      const text = (active: [number, number] | null) => c.lines.map((l, i) => l.map((w, j) => (active && active[0] === i && active[1] === j ? `{\\1c${bgr(s.highlight!)}&}${esc(w.text)}{\\1c${bgr(s.color)}&}` : esc(w.text))).join(" ")).join("\\N");
      if (!s.highlight) { ev(layer, c.start, c.end, "Cap", head + text(null)); continue; }
      // One event per spoken word, the word coloured.
      const flat = c.lines.flatMap((l, i) => l.map((w, j) => ({ w, i, j })));
      flat.forEach((x, k) => {
        const a = k === 0 ? c.start : x.w.start, b = k + 1 < flat.length ? flat[k + 1].w.start : c.end;
        if (b - a >= 0.01) ev(layer, a, b, "Cap", head + text([x.i, x.j]));
      });
    }
  }
  return [
    "[Script Info]", "ScriptType: v4.00+", `PlayResX: ${W}`, `PlayResY: ${H}`, "WrapStyle: 2", "ScaledBorderAndShadow: yes", "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    ...styles, "",
    "[Events]", "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ...events, "",
  ].join("\n");
}
