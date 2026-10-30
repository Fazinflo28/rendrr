import { PREFIX } from "./constants";
import { LIBRARY_ITEMS } from "./library";

// Royalty free by construction: these tracks are synthesised by scripts/make-assets.ts with FFmpeg.
export type MusicTrack = { id: string; name: string; mood: string; bpm: number; seconds: number; key: string };
export const MUSIC_TRACKS: MusicTrack[] = [
  { id: "m_lofi", name: "Soft lo-fi 01", mood: "lofi", bpm: 80, seconds: 64 },
  { id: "m_upbeat", name: "Upbeat Pop 01", mood: "upbeat", bpm: 118, seconds: 64 },
  { id: "m_cinematic", name: "Cinematic Strings 01", mood: "cinematic", bpm: 70, seconds: 64 },
  { id: "m_ambient", name: "Deep Ambient 02", mood: "ambient", bpm: 60, seconds: 64 },
  { id: "m_trending", name: "Trending Drop 01", mood: "trending", bpm: 128, seconds: 64 },
  { id: "m_news", name: "News Bed 01", mood: "news", bpm: 100, seconds: 64 },
  { id: "m_suspense", name: "Suspense Bed 01", mood: "suspense", bpm: 90, seconds: 64 },
  { id: "m_gameshow", name: "Game Show 01", mood: "gameshow", bpm: 136, seconds: 64 },
].map((t) => ({ ...t, key: PREFIX.assets + "music/" + t.id + ".m4a" }));
export const MUSIC_MOODS = Array.from(new Set(MUSIC_TRACKS.map((t) => t.mood)));

export type Sfx = { id: string; name: string; seconds: number; key: string };
export const SFX: Sfx[] = [
  { id: "sfx_whoosh", name: "Whoosh", seconds: 0.8 },
  { id: "sfx_pop", name: "Pop", seconds: 0.3 },
  { id: "sfx_hit", name: "Hit", seconds: 0.6 },
].map((s) => ({ ...s, key: PREFIX.assets + "sfx/" + s.id + ".m4a" }));

/**
 * Audio clips may only play built-in tracks. The storage key always comes from this catalog (by trackId / sfxId),
 * never from what a client or an AI sent, so nobody can point a clip at another user's files.
 */
export function catalogMusic(c: { trackId?: string; assetKey?: string }): MusicTrack | undefined {
  return MUSIC_TRACKS.find((m) => m.id === c.trackId) || MUSIC_TRACKS.find((m) => m.key === c.assetKey);
}
export function catalogSfx(c: { sfxId?: string; assetKey?: string }): Sfx | undefined {
  return SFX.find((x) => x.id === c.sfxId) || SFX.find((x) => x.key === c.assetKey);
}

export function findMusic(trackIdOrMood: string): MusicTrack | undefined {
  const s = trackIdOrMood.toLowerCase().trim();
  return MUSIC_TRACKS.find((t) => t.id === s || t.name.toLowerCase() === s) || MUSIC_TRACKS.find((t) => t.mood === s) ||
    MUSIC_TRACKS.find((t) => s.includes(t.mood) || t.name.toLowerCase().includes(s));
}

// Graphic templates. Rendered by the worker's locked Chromium recorder, same as custom graphics.
export type GraphicTemplate = { id: string; name: string; durationSec: number; transparent: boolean; paramsSchema: Record<string, unknown> };
const str = (description: string, def: string, maxLength = 80) => ({ type: "string", description, default: def, maxLength });
const color = (description: string, def: string) => ({ type: "string", description, default: def, pattern: "^#[0-9a-fA-F]{6}$" });
const num = (description: string, def: number, minimum: number, maximum: number) => ({ type: "number", description, default: def, minimum, maximum });
const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties, required, additionalProperties: false });

export const GRAPHIC_TEMPLATES: GraphicTemplate[] = [
  { id: "gt_title_card", name: "Title card", durationSec: 3, transparent: true,
    paramsSchema: obj({ title: str("Big title", "Your title"), subtitle: str("Small line under the title", ""), color: color("Text colour", "#ffffff"), accent: color("Bar colour", "#ffcc00") }, ["title"]) },
  { id: "gt_lower_third", name: "Lower third", durationSec: 4, transparent: true,
    paramsSchema: obj({ name: str("Person's name", "Ronnii K", 60), role: str("Their role", "Founder", 80), color: color("Text colour", "#ffffff"), accent: color("Panel colour", "#0a0a0c") }, ["name"]) },
  { id: "gt_number_counter", name: "Number counter", durationSec: 3, transparent: true,
    paramsSchema: obj({ from: num("Start number", 0, -1e9, 1e9), to: num("End number", 100, -1e9, 1e9), prefix: str("Text before, like $", "", 10), suffix: str("Text after, like %", "", 10), label: str("Line under the number", "", 60), color: color("Text colour", "#ffffff") }, ["to"]) },
  { id: "gt_kinetic_text", name: "Kinetic text", durationSec: 3, transparent: true,
    paramsSchema: obj({ text: str("Words that fly in, one by one", "COLD OUTREACH WORKS", 120), color: color("Text colour", "#ffffff"), accent: color("Highlight colour", "#ffcc00") }, ["text"]) },
  { id: "gt_progress_bar", name: "Progress bar", durationSec: 5, transparent: true,
    paramsSchema: obj({ label: str("Label above the bar", "", 60), from: num("Start percent", 0, 0, 100), to: num("End percent", 100, 0, 100), color: color("Bar colour", "#ffffff"), position: { type: "string", enum: ["top", "bottom"], default: "bottom" } }) },
  { id: "gt_logo_reveal", name: "Logo reveal", durationSec: 3, transparent: true,
    paramsSchema: obj({ text: str("Brand name shown with the logo", "Rendrr", 40), logo: { type: "string", description: "Use \"brand\" for the logo saved in Settings, or leave empty", default: "brand", maxLength: 20 }, color: color("Text colour", "#ffffff") }) },
];

/** A built-in graphic drawn for each placement from its params: one of the six templates, or a graphic of the hidden
 *  library (Engine Part 4.1). Everything that treats templates differently from custom graphics asks this. */
export function findTemplate(id: string | null | undefined): GraphicTemplate | undefined {
  if (!id) return undefined;
  return GRAPHIC_TEMPLATES.find((t) => t.id === id) ?? LIBRARY_ITEMS.find((x) => x.id === id && x.place === "graphic");
}

// ---- custom graphic params (window.params) ----
const jsonType = (v: unknown) => (Array.isArray(v) ? "array" : v === null ? "null" : typeof v);
/** Each param's default value, from a graphic's params schema (a template's or a custom graphic's). */
export function graphicDefaults(schema: unknown): Record<string, unknown> {
  const props = (schema as { properties?: Record<string, { default?: unknown }> } | null)?.properties || {};
  return Object.fromEntries(Object.entries(props).map(([k, p]) => [k, p?.default ?? null]));
}
/** The params schema kept for a custom graphic: each name it declared, with its type and default value. */
export function customParamsSchema(defaults: Record<string, unknown>) {
  return { type: "object", properties: Object.fromEntries(Object.entries(defaults).map(([k, v]) => [k, { type: jsonType(v), default: v }])), additionalProperties: false };
}
/**
 * What one placement of a custom graphic draws with: its defaults, each replaced by the placement's value. A name the
 * graphic did not declare, or a value of another type than the default (null defaults take anything), is refused;
 * data takes any JSON (declared or not).
 */
export function placementParams(name: string, defaults: Record<string, unknown>, params: Record<string, unknown> = {}): { params: Record<string, unknown> } | { error: string } {
  const keys = Object.keys(defaults);
  for (const [k, v] of Object.entries(params)) {
    // data: any JSON for the graphic to read (window.params.data: a video's words, a scene list), declared or not.
    if (k === "data") { if (JSON.stringify(v ?? null).length > 256_000) return { error: `${name}: data is 256 KB of JSON at most.` }; continue; }
    if (!(k in defaults)) return { error: keys.length ? `${name} has no param "${k}". Its params: ${keys.join(", ")}.` : `${name} has no params. Declare them in create_graphic params (default values the code reads from window.params).` };
    if (defaults[k] !== null && jsonType(v) !== jsonType(defaults[k])) return { error: `Param "${k}" of ${name} takes a ${jsonType(defaults[k])} (default ${JSON.stringify(defaults[k])}), not a ${jsonType(v)}.` };
  }
  return { params: { ...defaults, ...params } };
}
/** JSON with object keys sorted at every level: the same values always give the same text (cache keys). */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson((v as Record<string, unknown>)[k])}`).join(",")}}`;
  return JSON.stringify(v ?? null);
}
