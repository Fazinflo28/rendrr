import { PREFIX } from "./constants";

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
