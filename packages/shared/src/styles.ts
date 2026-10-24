import { z } from "zod";
import { CaptionStyleSchema, styleText } from "./captions";
import { CAPTION_LOOKS } from "./constants";

// Machine-readable style rules. The text fields (cutPace, captionRule, ...) are what people read;
// `rules` is what applyStyle() actually does. Keep both in step.
export const StyleRulesSchema = z.object({
  cutSilencesOver: z.number().min(0.1).max(10).nullable(), // seconds; null = leave pauses alone
  removeFillers: z.boolean(),
  trimEdges: z.boolean().default(false), // trim dead air before the first and after the last word
  captions: z.object({
    on: z.boolean(),
    look: z.enum(CAPTION_LOOKS),
    wordsAtOnce: z.number().int().min(1).max(20), // words shown together on screen
    upper: z.boolean().default(false),
    maxLines: z.number().int().min(1).max(3).default(1),
    /** A full caption style (Phase 4): any video that gets this style gets exactly these captions. */
    style: CaptionStyleSchema.optional(),
  }),
  zoom: z.object({
    mode: z.enum(["none", "newSentence", "interval", "slowPush", "count"]), // count: exactly `count` zooms, spread over the edit
    scale: z.number().min(1).max(2),
    everySec: z.number().min(0.3).max(30).optional(),
    holdSec: z.number().min(0.3).max(30).optional(),
    count: z.number().int().min(1).max(50).optional(),
  }),
  music: z.object({ mood: z.string().nullable(), gainDb: z.number().min(-40).max(0) }),
  sfxOnZoom: z.string().nullable().default(null),
});
export type StyleRules = z.infer<typeof StyleRulesSchema>;

/** Some rules to change on top of a style ("zoom: count 2"); anything left out keeps the style's value. */
export const StyleRulesPatchSchema = z.object({
  cutSilencesOver: z.number().min(0.1).max(10).nullable().optional(),
  removeFillers: z.boolean().optional(),
  trimEdges: z.boolean().optional(),
  captions: StyleRulesSchema.shape.captions.partial().optional(),
  zoom: StyleRulesSchema.shape.zoom.partial().optional(),
  music: StyleRulesSchema.shape.music.partial().optional(),
  sfxOnZoom: z.string().nullable().optional(),
});
export type StyleRulesPatch = z.infer<typeof StyleRulesPatchSchema>;

export function mergeRules(base: StyleRules, patch?: StyleRulesPatch | null): StyleRules {
  if (!patch) return base;
  const zoom = { ...base.zoom, ...patch.zoom };
  if (patch.zoom?.mode === "count" && zoom.count == null) zoom.count = 3;
  if (zoom.mode === "count" && zoom.scale <= 1) zoom.scale = 1.15;
  return StyleRulesSchema.parse({
    ...base, ...patch,
    captions: { ...base.captions, ...patch.captions },
    zoom,
    music: { ...base.music, ...patch.music },
  });
}

/** The people-readable lines of a style, written from its rules (for styles saved by an AI). */
export function describeRules(r: StyleRules): { cutPace: string; captionRule: string; zoomRules: string; musicVibe: string } {
  const z = r.zoom;
  return {
    cutPace: [r.cutSilencesOver != null ? `Cut every pause over ${r.cutSilencesOver}s` : "Keep the pauses", r.removeFillers ? "remove filler words" : "", r.trimEdges ? "trim the start and end" : ""].filter(Boolean).join(", "),
    captionRule: !r.captions.on ? "No captions" : r.captions.style ? `Captions: ${styleText(r.captions.style)}` : `${r.captions.look} captions, ${r.captions.wordsAtOnce} words at a time${r.captions.upper ? ", upper case" : ""}`,
    zoomRules: z.mode === "none" ? "No zooms" : z.mode === "count" ? `${z.count ?? 3} zooms at ${Math.round(z.scale * 100)}%, spread over the edit`
      : z.mode === "interval" ? `Zoom to ${Math.round(z.scale * 100)}% every ${z.everySec ?? 3}s` : z.mode === "slowPush" ? `Slow push to ${Math.round(z.scale * 100)}% on each part` : `Zoom to ${Math.round(z.scale * 100)}% on every new sentence`,
    musicVibe: r.music.mood ? `${r.music.mood} music at ${r.music.gainDb}dB` : "No music",
  };
}

export type StyleSeed = {
  id: string; name: string; type: string; vibe: string; ori: string[]; platforms: string[];
  captionLook: "clean" | "bold" | "outline"; cutPace: string; captionRule: string; zoomRules: string; musicVibe: string; art: string;
  rules: StyleRules;
};

const R = (r: Omit<StyleRules, "trimEdges" | "sfxOnZoom"> & Partial<Pick<StyleRules, "trimEdges" | "sfxOnZoom">>): StyleRules => StyleRulesSchema.parse(r);

// Ids s1..s17 and every text field are copied from the UI's fake db so existing screens keep working.
export const STYLES: StyleSeed[] = [
  { id: "s1", name: "Bold Talking Head", type: "talking-head", vibe: "Punchy cuts and big pill captions", ori: ["9:16", "1:1"], platforms: ["instagram", "tiktok", "linkedin"], captionLook: "bold", cutPace: "Fast. Cut every pause over 0.4s", captionRule: "Big pill captions, one line, upper case", zoomRules: "Punch in 15% on every new sentence", musicVibe: "Upbeat, low in the mix", art: "c",
    rules: R({ cutSilencesOver: 0.4, removeFillers: true, captions: { on: true, look: "bold", wordsAtOnce: 3, upper: true, maxLines: 1 }, zoom: { mode: "newSentence", scale: 1.15, holdSec: 1.6 }, music: { mood: "upbeat", gainDb: -20 } }) },
  { id: "s2", name: "Clean Podcast Clip", type: "podcast-clip", vibe: "Calm pace, two cams, clean lower thirds", ori: ["16:9", "1:1", "9:16"], platforms: ["youtube", "linkedin", "instagram"], captionLook: "clean", cutPace: "Relaxed. Cut pauses over 1s only", captionRule: "Small clean captions, two lines max", zoomRules: "Cut to the active speaker, slow push in", musicVibe: "None, or soft lo-fi under 10%", art: "a",
    rules: R({ cutSilencesOver: 1.0, removeFillers: true, captions: { on: true, look: "clean", wordsAtOnce: 8, upper: false, maxLines: 2 }, zoom: { mode: "slowPush", scale: 1.06 }, music: { mood: null, gainDb: -24 } }) },
  { id: "s3", name: "Luxury Reel", type: "cinematic", vibe: "Slow, cinematic, letterboxed", ori: ["9:16", "16:9"], platforms: ["instagram", "youtube"], captionLook: "outline", cutPace: "Slow. Hold shots 3s or more", captionRule: "Light outlined captions, lots of air", zoomRules: "No zooms. Let the shot breathe", musicVibe: "Cinematic strings or deep ambient", art: "f",
    rules: R({ cutSilencesOver: 2.0, removeFillers: true, captions: { on: true, look: "outline", wordsAtOnce: 5, upper: false, maxLines: 1 }, zoom: { mode: "none", scale: 1 }, music: { mood: "cinematic", gainDb: -16 } }) },
  { id: "s4", name: "Fast UGC Ad", type: "ugc-ad", vibe: "Hooks, zoom punches, no dead air", ori: ["9:16"], platforms: ["tiktok", "instagram"], captionLook: "bold", cutPace: "Very fast. Cut every pause over 0.3s", captionRule: "Word by word pop captions", zoomRules: "Zoom in or out every 3 seconds", musicVibe: "Trending, loud, with a drop at 0:03", art: "d",
    rules: R({ cutSilencesOver: 0.3, removeFillers: true, trimEdges: true, captions: { on: true, look: "bold", wordsAtOnce: 1, upper: true, maxLines: 1 }, zoom: { mode: "interval", scale: 1.12, everySec: 3, holdSec: 1.5 }, music: { mood: "trending", gainDb: -14 }, sfxOnZoom: "sfx_whoosh" }) },
  { id: "s5", name: "Raw Clip", type: "clipping", vibe: "Just the best moment, no effects", ori: ["9:16", "16:9", "1:1"], platforms: ["youtube", "tiktok", "linkedin", "instagram"], captionLook: "clean", cutPace: "One clip. Trim the start and end only", captionRule: "Plain captions, or none", zoomRules: "None", musicVibe: "None. Original audio", art: "b",
    rules: R({ cutSilencesOver: null, removeFillers: false, trimEdges: true, captions: { on: true, look: "clean", wordsAtOnce: 6, upper: false, maxLines: 2 }, zoom: { mode: "none", scale: 1 }, music: { mood: null, gainDb: -24 } }) },
  { id: "s6", name: "Kinetic Type", type: "motion-graphics", vibe: "Words fly in, shapes move, no face needed", ori: ["9:16", "1:1", "16:9"], platforms: ["instagram", "linkedin", "tiktok"], captionLook: "bold", cutPace: "Cut on every beat", captionRule: "The text IS the video. One phrase per screen", zoomRules: "Slides and scale, not zooms", musicVibe: "Beat driven, loud", art: "e",
    rules: R({ cutSilencesOver: 0.3, removeFillers: true, captions: { on: true, look: "bold", wordsAtOnce: 2, upper: true, maxLines: 1 }, zoom: { mode: "none", scale: 1 }, music: { mood: "trending", gainDb: -12 } }) },
  { id: "s7", name: "Tier Ranking", type: "tier-ranking", vibe: "S to F rows, items drop in one by one", ori: ["9:16", "16:9"], platforms: ["tiktok", "youtube"], captionLook: "bold", cutPace: "Cut as each item lands in its tier", captionRule: "Captions under the board, short", zoomRules: "Zoom to the row being filled", musicVibe: "Game show energy", art: "c",
    rules: R({ cutSilencesOver: 0.5, removeFillers: true, captions: { on: true, look: "bold", wordsAtOnce: 3, upper: false, maxLines: 1 }, zoom: { mode: "newSentence", scale: 1.08, holdSec: 1.2 }, music: { mood: "gameshow", gainDb: -18 } }) },
  { id: "s8", name: "Top 5 Countdown", type: "listicle", vibe: "Big numbers, 5 to 1, one point each", ori: ["9:16", "1:1"], platforms: ["tiktok", "instagram", "youtube"], captionLook: "bold", cutPace: "Hard cut on every number", captionRule: "Number card, then one line caption", zoomRules: "Punch in on the reveal", musicVibe: "Rising, with a hit on each number", art: "d",
    rules: R({ cutSilencesOver: 0.4, removeFillers: true, captions: { on: true, look: "bold", wordsAtOnce: 4, upper: false, maxLines: 1 }, zoom: { mode: "newSentence", scale: 1.12, holdSec: 1.2 }, music: { mood: "upbeat", gainDb: -16 }, sfxOnZoom: "sfx_hit" }) },
  { id: "s9", name: "Documentary B-roll", type: "documentary", vibe: "Slow zooms, b-roll every 5s, one grade", ori: ["16:9", "9:16"], platforms: ["youtube", "linkedin"], captionLook: "outline", cutPace: "Medium. B-roll over every second sentence", captionRule: "Captions only when needed", zoomRules: "Slow push in, 24fps feel", musicVibe: "Low cinematic bed", art: "a",
    rules: R({ cutSilencesOver: 0.8, removeFillers: true, captions: { on: true, look: "outline", wordsAtOnce: 6, upper: false, maxLines: 2 }, zoom: { mode: "slowPush", scale: 1.08 }, music: { mood: "cinematic", gainDb: -22 } }) },
  { id: "s10", name: "Screen Tutorial", type: "tutorial", vibe: "Screen recording, cursor zooms, step labels", ori: ["16:9", "1:1"], platforms: ["linkedin", "youtube"], captionLook: "clean", cutPace: "Cut the loading and the mouse wandering", captionRule: "Step labels top left, captions bottom", zoomRules: "Zoom to the cursor on every click", musicVibe: "Soft, or none", art: "b",
    rules: R({ cutSilencesOver: 0.6, removeFillers: true, captions: { on: true, look: "clean", wordsAtOnce: 7, upper: false, maxLines: 2 }, zoom: { mode: "none", scale: 1 }, music: { mood: "ambient", gainDb: -26 } }) },
  { id: "s11", name: "Split Screen", type: "split-screen", vibe: "You on top, satisfying footage below", ori: ["9:16"], platforms: ["tiktok", "instagram"], captionLook: "bold", cutPace: "Fast. Cut every pause over 0.4s", captionRule: "Captions on the split line", zoomRules: "None on the bottom, punches on top", musicVibe: "Lo-fi or trending, low", art: "f",
    rules: R({ cutSilencesOver: 0.4, removeFillers: true, captions: { on: true, look: "bold", wordsAtOnce: 3, upper: true, maxLines: 1 }, zoom: { mode: "newSentence", scale: 1.1, holdSec: 1.4 }, music: { mood: "lofi", gainDb: -20 } }) },
  { id: "s12", name: "Green Screen Explain", type: "greenscreen", vibe: "You in a third, visuals swap every 5s", ori: ["9:16"], platforms: ["tiktok", "instagram", "linkedin"], captionLook: "clean", cutPace: "Medium. Swap the visual every 4 to 6s", captionRule: "Captions under the presenter", zoomRules: "None. The visual does the work", musicVibe: "Minimal", art: "e",
    rules: R({ cutSilencesOver: 0.6, removeFillers: true, captions: { on: true, look: "clean", wordsAtOnce: 5, upper: false, maxLines: 2 }, zoom: { mode: "none", scale: 1 }, music: { mood: "ambient", gainDb: -24 } }) },
  { id: "s13", name: "Before and After", type: "before-after", vibe: "Wipe from old to new, one big reveal", ori: ["9:16", "1:1"], platforms: ["instagram", "tiktok"], captionLook: "bold", cutPace: "Two shots. One wipe", captionRule: "BEFORE and AFTER labels only", zoomRules: "Slow push on the after", musicVibe: "Build, then a drop on the reveal", art: "c",
    rules: R({ cutSilencesOver: null, removeFillers: false, trimEdges: true, captions: { on: false, look: "bold", wordsAtOnce: 2, upper: true, maxLines: 1 }, zoom: { mode: "slowPush", scale: 1.06 }, music: { mood: "trending", gainDb: -14 } }) },
  { id: "s14", name: "Text Story", type: "text-story", vibe: "Chat bubbles pop in like a real convo", ori: ["9:16"], platforms: ["tiktok", "instagram"], captionLook: "clean", cutPace: "A bubble every 1.2s", captionRule: "The bubbles are the captions", zoomRules: "None", musicVibe: "Suspense bed, low", art: "d",
    rules: R({ cutSilencesOver: null, removeFillers: false, captions: { on: true, look: "clean", wordsAtOnce: 6, upper: false, maxLines: 2 }, zoom: { mode: "none", scale: 1 }, music: { mood: "suspense", gainDb: -20 } }) },
  { id: "s15", name: "Photo Slideshow", type: "slideshow", vibe: "Photos slide on the beat, light text", ori: ["9:16", "1:1"], platforms: ["instagram", "tiktok"], captionLook: "outline", cutPace: "One photo per beat", captionRule: "One short line per photo", zoomRules: "Gentle ken burns on each", musicVibe: "Trending audio", art: "a",
    rules: R({ cutSilencesOver: null, removeFillers: false, captions: { on: true, look: "outline", wordsAtOnce: 5, upper: false, maxLines: 1 }, zoom: { mode: "slowPush", scale: 1.06 }, music: { mood: "trending", gainDb: -14 } }) },
  { id: "s16", name: "Newsroom", type: "news", vibe: "Lower third, ticker, authority look", ori: ["16:9", "1:1"], platforms: ["linkedin", "youtube"], captionLook: "clean", cutPace: "Medium. Cut pauses over 0.8s", captionRule: "Lower third name, ticker with the key point", zoomRules: "None", musicVibe: "News bed, very low", art: "b",
    rules: R({ cutSilencesOver: 0.8, removeFillers: true, captions: { on: true, look: "clean", wordsAtOnce: 8, upper: false, maxLines: 2 }, zoom: { mode: "none", scale: 1 }, music: { mood: "news", gainDb: -26 } }) },
  { id: "s17", name: "Brainrot Stack", type: "brainrot", vibe: "Cuts every 0.7s, colour captions, dense", ori: ["9:16"], platforms: ["tiktok"], captionLook: "bold", cutPace: "Cut every 0.6 to 0.8s, no exceptions", captionRule: "Phrase by phrase, colour pops", zoomRules: "Punch on every cut", musicVibe: "Loud and layered", art: "f",
    rules: R({ cutSilencesOver: 0.25, removeFillers: true, trimEdges: true, captions: { on: true, look: "bold", wordsAtOnce: 2, upper: true, maxLines: 1 }, zoom: { mode: "interval", scale: 1.1, everySec: 0.7, holdSec: 0.35 }, music: { mood: "trending", gainDb: -12 } }) },
];

export const STYLE_TYPES: [string, string][] = [["talking-head", "Talking head"], ["podcast-clip", "Podcast clip"], ["clipping", "Clipping only"], ["motion-graphics", "Motion graphics"], ["tier-ranking", "Tier ranking"], ["listicle", "Listicle"], ["ugc-ad", "UGC ad"], ["cinematic", "Cinematic"], ["documentary", "Documentary"], ["tutorial", "Screen tutorial"], ["split-screen", "Split screen"], ["greenscreen", "Green screen"], ["before-after", "Before / after"], ["text-story", "Text story"], ["slideshow", "Slideshow"], ["news", "Newsroom"], ["brainrot", "Brainrot"], ["custom", "Saved"]];
export const PLATFORMS: [string, string][] = [["instagram", "Instagram"], ["tiktok", "TikTok"], ["youtube", "YouTube"], ["linkedin", "LinkedIn"]];
export const DEFAULT_STYLE_ID = "s2";
