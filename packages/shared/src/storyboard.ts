// Storyboard mode (optional, before the whole render): a board of numbered panels, each a frame or a short clip of the
// edit drawn exactly as the export draws it (the samples' render), with a title, the words said or shown, what we see,
// and a note; and the edit's style sheet: the caption font, size, colours and how captions move, the text fonts, the
// colours, the look, the music, and the visual rules the board keeps. The user reviews it, comments on a panel or
// draws on it; Claude reads that (get_samples), changes the edit and makes the board again; once the user approves it,
// the whole video is rendered. A storyboard is a set of samples (kind "sample") with a board in its plan.
import { z } from "zod";
import { ANIM_IN, type CaptionStyle, type StyledCaption, type TextLayer } from "./captions";
import { SAMPLE_CLIP_DEFAULT, SAMPLE_MAX_CLIP, SampleError, sampleClock, type SampleItem } from "./samples";

/** A board's most panels, and of them the most that are short clips. */
export const STORYBOARD_MAX_PANELS = 24;
export const STORYBOARD_MAX_CLIPS = 8;
/** Panels Rendrr picks by itself (the editor's "Make storyboard"): at most this many. */
export const STORYBOARD_AUTO_PANELS = 12;
export const STORYBOARD_MAX_RULES = 12;
export const STORYBOARD_MAX_COLORS = 10;
export const STORYBOARD_STEPS = ["Reading timeline", "Measuring loudness", "Drawing the storyboard", "Packing the board"] as const;
/** What the frames are: "images" only pictures (stills, quick to look over first); "video" pictures plus short video
 *  frames where something moves (the default). */
export const STORYBOARD_FRAMES = ["images", "video"] as const;
export type StoryboardFrames = (typeof STORYBOARD_FRAMES)[number];

const text = (max: number, what: string) => z.string().trim().max(max).optional().describe(what);
const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/, "a colour like #34C759");
/** One panel as Claude (or the editor) asks for it: edit seconds; end makes it a short clip. */
export const StoryboardPanelSchema = z.object({
  at: z.number().min(0).describe("Edit seconds: the frame shown, or where the clip starts"),
  end: z.number().min(0).optional().describe(`A short clip to here (edit seconds, at most ${SAMPLE_MAX_CLIP} s; true-motion moments: an animation, a transition, a zoom)`),
  clip: z.boolean().optional().describe(`A ${SAMPLE_CLIP_DEFAULT} s clip from at (when end is not given)`),
  title: text(80, "The beat, short: \"Hook\", \"Problem\", \"Product reveal\""),
  caption: text(300, "The words said or shown in this beat (the script line)"),
  shot: text(300, "What we see: framing, b-roll, graphic, movement"),
  note: text(300, "Anything to look at or decide here"),
});
export type StoryboardPanel = z.infer<typeof StoryboardPanelSchema>;
/** create_storyboard's input (besides the project). */
export const StoryboardRequestShape = {
  title: z.string().trim().max(120).optional().describe("The board's title (default: the edit's name)"),
  panels: z.array(StoryboardPanelSchema).max(STORYBOARD_MAX_PANELS).optional().describe(`The beats in order, up to ${STORYBOARD_MAX_PANELS} (${STORYBOARD_MAX_CLIPS} of them clips). Left out: Rendrr picks the scenes, titles and graphics itself`),
  rules: z.array(z.string().trim().min(1).max(200)).max(STORYBOARD_MAX_RULES).optional().describe("The visual rules the video keeps, one per line: \"Captions centred, 3 words at a time\", \"Green #34C759 for highlights only\", \"Cut on every sentence\""),
  palette: z.array(z.object({ hex, name: z.string().trim().max(40).optional() })).max(STORYBOARD_MAX_COLORS).optional().describe("The colours, with what each is for (\"brand green\", \"background\")"),
  frames: z.enum(STORYBOARD_FRAMES).optional().describe("\"images\": picture frames only (no video frames; clip panels become pictures), for when the user wants the image frames first. \"video\" (default): pictures plus short video frames where something moves"),
};
export const StoryboardRequestSchema = z.object(StoryboardRequestShape);
export type StoryboardRequest = z.infer<typeof StoryboardRequestSchema>;

/** A panel as the board keeps it: a sample with its words. onScreen: the captions and text on screen at that moment
 *  (Rendrr reads them from the edit when it draws the panel). */
export type BoardPanel = SampleItem & { title?: string; caption?: string; shot?: string; onScreen?: string;
  /** On a board of picture frames: the clip this panel was asked as ([start, end], edit seconds), for video frames later. */
  video?: [number, number] };
export type BoardFont = { font: string; weight: number; use: string };
export type BoardColor = { hex: string; name: string };
/** The edit's style sheet, read from the edit when the board is drawn. */
export type BoardStyle = {
  aspect: string; seconds: number; width: number; height: number;
  /** The captions: font, size (% of the short side), colours, how they move. null: captions off. */
  captions: null | { font: string; weight: number; size: number; color: string; highlight: string | null; stroke: string | null; box: string | null; case: string; wordsAtOnce: number; lines: number; position: string; animation: string };
  /** Every font the video shows (captions, then text layers), with what it is used for. */
  fonts: BoardFont[];
  /** Text layers: how many, and how they come on. */
  texts: { count: number; animations: string[] };
  /** Colours used on screen (captions, text, cards, background) and the ones asked for (palette), each with its use. */
  colors: BoardColor[];
  /** One line each, as the editor says them: the look, the background, transitions, music, sound, pacing. */
  look: string; background: string | null; transitions: string[]; music: string; sound: string; pacing: string;
};
export type BoardStatus = "review" | "approved";
/** What a storyboard keeps besides its samples: its title, rules and palette as asked, the style sheet (once drawn),
 *  whether Rendrr picks the panels, and whether the user approved it. */
export type Board = {
  title: string; rules: string[]; palette: BoardColor[]; auto?: boolean; style?: BoardStyle;
  status: BoardStatus; approvedAt?: number | null;
  /** "images": picture frames only. Left out: pictures and video frames. */
  frames?: StoryboardFrames;
};

/** The panels asked for, checked and put on the edit's frames, in edit order. */
export function storyboardItems(panels: StoryboardPanel[], outputSeconds: number, fps = 30, frames: StoryboardFrames = "video"): BoardPanel[] {
  const grid = (t: number) => Math.round(t * fps) / fps;
  const last = Math.max(0, grid(outputSeconds) - 1 / fps);
  const out: BoardPanel[] = [];
  for (const [k, p] of panels.entries()) {
    const words = { ...(p.title ? { title: p.title } : {}), ...(p.caption ? { caption: p.caption } : {}), ...(p.shot ? { shot: p.shot } : {}), ...(p.note ? { note: p.note } : {}) };
    if (p.at > outputSeconds + 1e-6) throw new SampleError(`Panel ${k + 1} at ${sampleClock(p.at)} is past the end of the edit (${sampleClock(outputSeconds)}).`);
    if (p.end == null && !p.clip) { out.push({ kind: "frame", at: Math.min(last, grid(p.at)), ...words }); continue; }
    const at = grid(p.at);
    if (at >= outputSeconds - 1e-6) throw new SampleError(`Panel ${k + 1}'s clip at ${sampleClock(p.at)} starts past the end of the edit (${sampleClock(outputSeconds)}).`);
    const want = p.end ?? p.at + SAMPLE_CLIP_DEFAULT;
    if (want <= p.at) throw new SampleError(`Panel ${k + 1}'s clip at ${sampleClock(p.at)}: its end must be after its start.`);
    if (want - p.at > SAMPLE_MAX_CLIP + 1e-6) throw new SampleError(`Panel ${k + 1}'s clip is ${Math.round((want - p.at) * 10) / 10} s: a panel's clip is at most ${SAMPLE_MAX_CLIP} s.`);
    const end = Math.min(grid(outputSeconds), Math.max(at + 1 / fps, grid(want)));
    // Picture frames only: a clip panel is drawn as one picture (moved past its motion when the board is drawn); the
    // clip it was is kept (video), so video frames can be made later.
    if (frames === "images") { out.push({ kind: "frame", at: Math.min(last, at), video: [at, end], ...words }); continue; }
    out.push({ kind: "clip", at, end, ...words });
  }
  if (out.filter((x) => x.kind === "clip").length > STORYBOARD_MAX_CLIPS) throw new SampleError(`A storyboard has at most ${STORYBOARD_MAX_CLIPS} clip panels (${out.filter((x) => x.kind === "clip").length} asked).`);
  return out.sort((a, b) => a.at - b.at || (a.kind === "frame" ? -1 : 1));
}

/** What the auto panels read from a plan. */
export type PlanBeats = {
  outputSeconds: number; fps?: number;
  parts: { start: number; end: number; clipIds: string[] }[];
  texts?: Pick<TextLayer, "clipId" | "start" | "end" | "lines">[];
  graphics: { clipId: string; start: number; end: number; graphicId?: string }[];
  broll: { clipId: string; start: number; end: number }[];
  styledCaptions?: StyledCaption[];
};

/**
 * Rendrr's own panels when none were asked for: the opening, each new scene (a V1 clip), each text layer once it is in,
 * each graphic (a short clip, so its animation shows) and each b-roll, closer than 1.5 s joined, at most `max`, spread
 * over the edit when there are more. Titled by what they show.
 */
export function storyboardAutoPanels(plan: PlanBeats, max = STORYBOARD_AUTO_PANELS, frames: StoryboardFrames = "video"): BoardPanel[] {
  const fps = plan.fps || 30, T = plan.outputSeconds;
  const grid = (t: number) => Math.min(Math.max(0, Math.round(T * fps) / fps - 1 / fps), Math.max(0, Math.round(t * fps) / fps));
  type Beat = { at: number; rank: number; title: string; clip?: number };
  const beats: Beat[] = [{ at: Math.min(0.5, T / 2), rank: 3, title: "Opening" }];
  let scene = 0, lastClip = "";
  for (const p of plan.parts) {
    if (p.clipIds[0] === lastClip) continue;
    lastClip = p.clipIds[0]; scene++;
    if (p.start > 0.05) beats.push({ at: p.start + Math.min(0.3, (p.end - p.start) / 2), rank: 1, title: `Scene ${scene}` });
  }
  for (const t of plan.texts ?? []) {
    const words = t.lines.join(" ").replace(/\s+/g, " ").trim();
    beats.push({ at: t.start + Math.min(0.5, (t.end - t.start) / 2), rank: 2, title: words.length > 40 ? words.slice(0, 39) + "…" : words || "Text" });
  }
  for (const g of plan.graphics) beats.push({ at: g.start, rank: 2, title: "Graphic", clip: Math.min(SAMPLE_CLIP_DEFAULT, Math.max(1, g.end - g.start)) });
  for (const b of plan.broll) beats.push({ at: b.start + Math.min(0.4, (b.end - b.start) / 2), rank: 1, title: "B-roll" });
  // Joined: a beat within 1.5 s of a kept one goes, unless it outranks it (then it takes its place).
  const kept: Beat[] = [];
  for (const b of beats.filter((x) => x.at < T - 1e-6).sort((x, y) => x.at - y.at)) {
    const near = kept.findIndex((k) => Math.abs(k.at - b.at) < 1.5);
    if (near < 0) kept.push(b);
    else if (b.rank > kept[near].rank) kept[near] = b;
  }
  // More than max: the first, the last and evenly between (graphics and text kept first among equals).
  let pick = kept;
  if (kept.length > max) {
    pick = Array.from({ length: max }, (_, i) => kept[Math.round((i * (kept.length - 1)) / Math.max(1, max - 1))]);
    pick = Array.from(new Set(pick));
  }
  let clips = 0;
  return pick.map((b) => {
    if (frames !== "images" && b.clip && clips < Math.min(4, STORYBOARD_MAX_CLIPS) && b.at + 0.2 < T) {
      clips++;
      const at = grid(b.at);
      return { kind: "clip" as const, at, end: Math.min(Math.round(T * fps) / fps, Math.max(at + 1 / fps, grid(b.at + b.clip))), title: b.title };
    }
    return { kind: "frame" as const, at: grid(b.at), title: b.title };
  });
}

/** What moves onto the screen, for where a panel's picture is taken: text layers (how they come on, their keys),
 *  graphics (their animation) and transitions. */
export type PlanMotion = {
  outputSeconds: number; fps?: number;
  texts?: Pick<TextLayer, "start" | "end" | "anim" | "keys">[];
  graphics?: { start: number; end: number }[];
  transitions?: { start: number; end: number }[];
};
/** The longest a picture is moved to wait for motion to land. */
export const SETTLE_MAX = 1.2;
/** Where each thing on screen has landed: its start plus how it comes on (text), its first keys, or part of a graphic. */
function landings(m: PlanMotion): { start: number; end: number; land: number }[] {
  const out: { start: number; end: number; land: number }[] = [];
  for (const t of m.texts ?? []) {
    const keysEnd = Math.max(0, ...(t.keys ?? []).map((k) => k.t).filter((x) => x <= SETTLE_MAX));
    const anim = ANIM_IN[t.anim] ?? 0;
    const wait = Math.min(SETTLE_MAX, Math.max(anim > 0 ? anim + 0.1 : 0, keysEnd));
    if (wait > 0) out.push({ start: t.start, end: t.end, land: t.start + wait });
  }
  for (const g of m.graphics ?? []) out.push({ start: g.start, end: g.end, land: g.start + Math.min(1, Math.max(0, (g.end - g.start) * 0.4)) });
  for (const x of m.transitions ?? []) if (x.end > x.start) out.push({ start: x.start, end: x.end + 1, land: x.end + 1 / 30 });
  return out;
}
/**
 * The moment at or after t where whatever is coming on at t has landed (a title popped in, a card slid in, a
 * transition done), at most SETTLE_MAX later and before `until`. A blank picture taken as a card starts is the miss.
 */
export function settledAt(m: PlanMotion, t: number, until = m.outputSeconds): number {
  const fps = m.fps || 30;
  const cap = Math.floor(Math.min(t + SETTLE_MAX, until - 1 / fps) * fps + 1e-6) / fps;
  if (cap <= t) return t;
  const ls = landings(m);
  let at = t;
  for (let n = 0; n < 8; n++) {
    let next = at;
    for (const l of ls) if (l.start <= at + 1e-6 && at < l.land - 1e-6 && l.land < l.end) next = Math.max(next, l.land);
    if (next === at) break;
    at = next;
  }
  return Math.min(cap, Math.max(t, Math.ceil(at * fps - 1e-6) / fps));
}
/**
 * Panels whose picture would be taken mid-motion: a frame moves to where the motion lands (its at changes, so the
 * picture and its comments agree), a clip keeps its window and gets stillAt, the second its picture is taken.
 */
export function settlePanels<T extends Pick<BoardPanel, "kind" | "at" | "end">>(items: T[], m: PlanMotion): (T & { stillAt?: number })[] {
  return items.map((x) => {
    if (x.kind === "frame") { const at = settledAt(m, x.at); return at > x.at + 1e-6 ? { ...x, at } : x; }
    const at = settledAt(m, x.at, x.end ?? x.at);
    return at > x.at + 1e-6 ? { ...x, stillAt: at } : x;
  });
}

/** The captions and text on screen at t (edit seconds): what a viewer reads in that panel. */
export function onScreenAt(plan: Pick<PlanBeats, "styledCaptions" | "texts">, t: number): string {
  const said = (plan.styledCaptions ?? []).filter((c) => c.start <= t + 1e-6 && t < c.end - 1e-6).map((c) => c.lines.map((l) => l.map((w) => w.text).join(" ")).join(" "));
  const shown = (plan.texts ?? []).filter((x) => x.start <= t + 1e-6 && t < x.end - 1e-6).map((x) => x.lines.join(" "));
  return [...shown, ...said].map((s) => s.replace(/\s+/g, " ").trim()).filter(Boolean).join(" / ").slice(0, 300);
}

const posOf = (y: number) => (y > 0.66 ? "bottom" : y < 0.34 ? "top" : "middle");
/** How the captions come on, in words. */
export function captionAnimation(c: CaptionStyle): string {
  const run = c.wordsAtOnce <= 1 ? "one word at a time" : `${c.wordsAtOnce} words at a time`;
  return c.highlight ? `${run}, the spoken word lit in ${c.highlight.toUpperCase()}` : `${run}, as they are said`;
}

/** What the style sheet reads from a plan, and the lines the worker says about the rest of the edit. */
export type StyleSource = {
  aspect: string; outputSeconds: number; width: number; height: number;
  captionStyle?: CaptionStyle; captionsOn: boolean; texts?: TextLayer[];
  cards?: { color: string }[]; background?: { color?: string; text: string } | null;
  transitions?: { type: string }[]; cuts: number;
  look: string; music: string; sound: string;
};
const up = (h: string) => h.toUpperCase();
/** The edit's style sheet, plus the board's own palette (named colours win). */
export function boardStyle(s: StyleSource, palette: BoardColor[] = []): BoardStyle {
  const c = s.captionsOn && s.captionStyle ? s.captionStyle : null;
  const fonts: BoardFont[] = [];
  const addFont = (font: string, weight: number, use: string) => { const f = fonts.find((x) => x.font === font && x.weight === weight); if (f) { if (!f.use.includes(use)) f.use += `, ${use}`; } else fonts.push({ font, weight, use }); };
  if (c) addFont(c.font, c.weight, "captions");
  for (const t of s.texts ?? []) addFont(t.style.font, t.style.weight, "titles and text");
  const colors: BoardColor[] = [];
  const addColor = (hex: string | null | undefined, name: string) => { if (!hex) return; const h = up(hex); const f = colors.find((x) => x.hex === h); if (!f) colors.push({ hex: h, name }); else if (!f.name.split(", ").includes(name)) f.name += `, ${name}`; };
  for (const p of palette) addColor(p.hex, p.name || "palette");
  if (c) { addColor(c.color, "caption text"); addColor(c.highlight, "spoken word"); addColor(c.stroke?.color, "caption outline"); addColor(c.box?.color, "caption box"); }
  for (const t of s.texts ?? []) { addColor(t.style.color, "title text"); addColor(t.card?.color, "title card"); addColor(t.style.box?.color, "title box"); }
  for (const k of s.cards ?? []) addColor(k.color, "card");
  addColor(s.background?.color, "background");
  const anims = Array.from(new Set((s.texts ?? []).map((t) => (t.keys?.length ? `${t.anim === "none" ? "keyframed" : t.anim} with motion` : t.anim === "none" ? "cut on" : t.anim))));
  const perMin = s.outputSeconds > 0 ? (s.cuts / s.outputSeconds) * 60 : 0;
  return {
    aspect: s.aspect, seconds: Math.round(s.outputSeconds * 100) / 100, width: s.width, height: s.height,
    captions: c ? { font: c.font, weight: c.weight, size: c.size, color: up(c.color), highlight: c.highlight ? up(c.highlight) : null, stroke: c.stroke ? up(c.stroke.color) : null, box: c.box ? up(c.box.color) : null, case: c.case, wordsAtOnce: c.wordsAtOnce, lines: c.lines, position: posOf(c.y), animation: captionAnimation(c) } : null,
    fonts: fonts.slice(0, 8), texts: { count: s.texts?.length ?? 0, animations: anims }, colors: colors.slice(0, 16),
    look: s.look, background: s.background?.text ?? null, transitions: Array.from(new Set((s.transitions ?? []).map((t) => t.type))), music: s.music, sound: s.sound,
    pacing: `${s.cuts} ${s.cuts === 1 ? "cut" : "cuts"} in ${sampleClock(s.outputSeconds).replace(/\.\d$/, "")} (${perMin.toFixed(1)} a minute)`,
  };
}

/** The style sheet in words, for Claude and the check. */
export function boardStyleText(st: BoardStyle): string[] {
  const c = st.captions;
  return [
    `Format: ${st.aspect}, ${st.width}x${st.height}, ${sampleClock(st.seconds)}`,
    c ? `Captions: ${c.font} ${c.weight}, ${c.size}% of the short side, ${c.color}${c.stroke ? ` outlined ${c.stroke}` : ""}${c.box ? ` on a ${c.box} box` : ""}${c.case !== "none" ? `, ${c.case} case` : ""}, ${c.lines} ${c.lines === 1 ? "line" : "lines"} at the ${c.position}; ${c.animation}` : "Captions: off",
    `Fonts: ${st.fonts.length ? st.fonts.map((f) => `${f.font} ${f.weight} (${f.use})`).join("; ") : "none on screen"}`,
    `Text layers: ${st.texts.count}${st.texts.animations.length ? ` (${st.texts.animations.join(", ")})` : ""}`,
    `Colours: ${st.colors.length ? st.colors.map((x) => `${x.hex} ${x.name}`).join("; ") : "none set"}`,
    `Look: ${st.look}`, ...(st.background ? [`Behind the footage: ${st.background}`] : []),
    `Transitions: ${st.transitions.length ? st.transitions.join(", ") : "cuts only"}`, `Music: ${st.music}`, `Sound: ${st.sound}`, `Pacing: ${st.pacing}`,
  ];
}

/** One line per panel, as Claude reads them ("3. frame 0:04.2 \"Problem\" - says: ... - shows: ... - note: ..."). */
export function boardPanelsText(items: BoardPanel[]): string {
  return items.map((s, i) => [
    `${i + 1}. ${s.kind === "frame" ? `frame ${sampleClock(s.at)}` : `clip ${sampleClock(s.at)}-${sampleClock(s.end!)}`}${s.title ? ` "${s.title}"` : ""}`,
    s.caption ? `says: ${s.caption}` : "", s.onScreen ? `on screen: ${s.onScreen}` : "", s.shot ? `shows: ${s.shot}` : "", s.note ? `note: ${s.note}` : "",
  ].filter(Boolean).join(" - ")).join("\n");
}

/** The panel a comment at edit time t belongs to (its frame, or inside its clip), else the nearest within 0.5 s. */
export function panelOf(items: Pick<BoardPanel, "kind" | "at" | "end">[], t: number): number {
  const k = items.findIndex((x) => (x.kind === "clip" ? t >= x.at - 0.05 && t <= (x.end ?? x.at) + 0.05 : Math.abs(t - x.at) < 0.05));
  if (k >= 0) return k;
  let best = -1, d = 0.5;
  items.forEach((x, i) => { const e = Math.abs(t - x.at); if (e < d) { d = e; best = i; } });
  return best;
}
