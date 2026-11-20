// The dialogue cleanup (voice presets like Premiere's Essential Sound, hand-set values, the FFmpeg chain) and the
// studio voice's blocks (the AI steps made before the render). Imports nothing that imports it back: look.ts reads it
// for the render's limits.
import { PREFIX } from "./constants";
import type { Cleanup } from "./timeline";

/**
 * The dialogue cleanup as numbers. A preset fills them all; set_audio can change the main ones by hand (highpass,
 * denoise, presence, deess, compress, enhance, dereverb, level, crisp). Compression evens the voice out; the loudness
 * step afterwards sets the level, so no make-up gain here.
 */
export type CleanupParams = {
  /** High-pass cut-off in Hz (0 = off): removes rumble. Low-pass in Hz (0 = off): phone and radio voices. */
  highpass: number; lowpass: number;
  /** Noise reduction in dB (0 = off), and the noise floor it assumes (dBFS): FFmpeg's FFT denoiser, in the render. */
  denoise: number; noiseFloor: number;
  /** A soft gate between words (noisy rooms, roomy voices). */
  gate: boolean;
  /** dB at 180 Hz (warmth), at 250 Hz (mud), at presenceHz (presence, the 1.5-5 kHz lift; default 3.5 kHz) and a high
   *  shelf from 10 kHz (air). */
  warmth: number; mud: number; presence: number; presenceHz: number; air: number;
  /** De-esser intensity 0-1 (0 = off). */
  deess: number;
  /** Compression ratio (1 = off), threshold (dBFS), attack and release (ms). */
  compress: number; threshold: number; attack: number; release: number;
  /** Studio voice, made before the render (python/voice.py, once per block of footage, kept): AI noise and room
   *  removal 0-100 (DeepFilterNet3; 0 = off) and echo removal 0-100 (WPE dereverberation; 0 = off). */
  enhance: number; dereverb: number;
  /** Leveling 0-100 (0 = off): quiet and loud sentences brought together (dynaudnorm, a slow gain over seconds, up to
   *  +12 dB on the quietest), before the compressor. */
  level: number;
  /** Crispness 0-100 (0 = off): harmonics made above 6 kHz (aexciter), the sparkle a dull voice or a cheap microphone
   *  lacks. */
  crisp: number;
};
const OFF: CleanupParams = { highpass: 0, lowpass: 0, denoise: 0, noiseFloor: -40, gate: false, warmth: 0, mud: 0, presence: 0, presenceHz: 3500, air: 0, deess: 0, compress: 1, threshold: -18, attack: 8, release: 120, enhance: 0, dereverb: 0, level: 0, crisp: 0 };
/** Each preset as numbers. The voice presets follow Premiere's Essential Sound ones (Balanced Voice, Podcast Voice,
 *  Dry Up a Roomy Voice, Phone Call, Radio Announcer, ...) with FFmpeg's filters. Studio voice, Podcast voice, Clean
 *  voice, Clean up noisy dialogue and Dry up a roomy voice take the noise, room and echo out with the AI first
 *  (enhance, dereverb), like Adobe Podcast's Enhance Speech, then shape the tone. */
export const CLEANUP_PRESETS: Record<Cleanup, CleanupParams> = {
  none: OFF,
  light: { ...OFF, highpass: 80, compress: 2, threshold: -20, attack: 10, release: 150 },
  voice: { ...OFF, highpass: 80, enhance: 80, mud: -2, presence: 3, deess: 0.4, level: 30, compress: 3, threshold: -18, attack: 8, release: 120 },
  noisy: { ...OFF, highpass: 100, enhance: 100, presence: 3, deess: 0.5, level: 40, compress: 4, threshold: -18, attack: 5, release: 100 },
  balanced: { ...OFF, highpass: 80, mud: -2, presence: 3, presenceHz: 3000, air: 2, deess: 0.3, compress: 3, threshold: -20, attack: 8, release: 120 },
  podcast: { ...OFF, highpass: 90, enhance: 100, dereverb: 40, mud: -3, presence: 4, presenceHz: 4000, air: 3, crisp: 15, deess: 0.5, level: 60, compress: 4, threshold: -22, attack: 5, release: 100 },
  roomy: { ...OFF, highpass: 100, enhance: 100, dereverb: 100, mud: -4, presence: 2, deess: 0.3, level: 30, compress: 2.5, threshold: -20, attack: 8, release: 120 },
  warm: { ...OFF, highpass: 70, warmth: 3, presence: 1.5, air: -2, deess: 0.3, compress: 3, threshold: -20, attack: 10, release: 150 },
  bright: { ...OFF, highpass: 90, mud: -2, presence: 4, air: 5, deess: 0.5, compress: 3, threshold: -20, attack: 8, release: 120 },
  radio: { ...OFF, highpass: 150, mud: -4, presence: 6, presenceHz: 2500, air: -4, deess: 0.5, compress: 6, threshold: -24, attack: 4, release: 90 },
  phone: { ...OFF, highpass: 400, lowpass: 3400, presence: 6, presenceHz: 1500, compress: 4, threshold: -20, attack: 5, release: 100 },
  soft: { ...OFF, highpass: 80, presence: -4, presenceHz: 3200, air: -2, deess: 0.6, compress: 2, threshold: -20, attack: 10, release: 150 },
  punchy: { ...OFF, highpass: 90, mud: -2, presence: 4, air: 2, deess: 0.4, compress: 6, threshold: -26, attack: 3, release: 80 },
  studio: { ...OFF, highpass: 80, enhance: 100, dereverb: 60, warmth: 1.5, mud: -2.5, presence: 2.5, presenceHz: 4500, air: 3, crisp: 25, deess: 0.4, level: 50, compress: 3, threshold: -21, attack: 5, release: 90 },
};
/** The presets as the editor and the AI see them: a name and what it does. */
export const VOICE_PRESETS: { id: Cleanup; name: string; what: string }[] = [
  { id: "none", name: "Off", what: "the voice as recorded" },
  { id: "studio", name: "Studio voice", what: "AI noise and echo removal, a full close-mic tone, even level: like a good studio microphone" },
  { id: "light", name: "Light touch", what: "rumble out, gentle compression" },
  { id: "balanced", name: "Balanced voice", what: "even and clear: less mud, a little presence and air" },
  { id: "podcast", name: "Podcast voice", what: "close and present: AI noise removal, less echo, presence, air, de-esser, even level" },
  { id: "voice", name: "Clean voice", what: "AI noise removal, de-esser, presence, compression" },
  { id: "noisy", name: "Clean up noisy dialogue", what: "strong AI noise removal (fans, traffic, hum, keyboards)" },
  { id: "roomy", name: "Dry up a roomy voice", what: "AI echo and room removal, mud cut" },
  { id: "warm", name: "Warm voice", what: "fuller lows, softer highs" },
  { id: "bright", name: "Bright and crisp", what: "more presence and air, de-essed" },
  { id: "soft", name: "Soften a harsh voice", what: "harsh 3 kHz down, strong de-esser" },
  { id: "punchy", name: "Loud and punchy", what: "heavy compression for social video" },
  { id: "radio", name: "Radio announcer", what: "thin lows, forward mids, heavy compression" },
  { id: "phone", name: "Phone call", what: "a voice through a phone (300-3400 Hz)" },
];
/** The values set_audio can change by hand, on top of the preset. */
export const CLEANUP_KNOBS = ["highpass", "denoise", "presence", "deess", "compress", "enhance", "dereverb", "level", "crisp"] as const;
export type CleanupKnob = (typeof CLEANUP_KNOBS)[number];

/** The cleanup's numbers: the preset's, with the hand-set values on top. */
export function cleanupParams(a: { cleanup: Cleanup } & Partial<Record<CleanupKnob, number | undefined>>): CleanupParams {
  const p = { ...CLEANUP_PRESETS[a.cleanup] };
  for (const k of CLEANUP_KNOBS) if (a[k] != null) (p as Record<string, unknown>)[k] = a[k];
  return p;
}
/** Leveling as dynaudnorm: 250 ms frames, a gain smoothed over 31 of them (about 8 s, so it rides sentences, not
 *  words), at most +12 dB at level 100. (Its threshold option is left off: on speech with pauses it turned the whole
 *  voice down by 10 dB, measured.) */
export const levelFilter = (level: number) => `dynaudnorm=f=250:g=31:p=0.9:m=${Math.pow(10, (level / 100) * 12 / 20).toFixed(3)}`;
/** Crispness as aexciter: harmonics from 6 kHz up to 16 kHz, amount 0.6-4 (measured on speech: about +2 dB from 6 to
 *  11 kHz at crisp 25, +4.5 dB at 50, +9.5 dB at 100). */
export const crispFilter = (crisp: number) => `aexciter=amount=${(0.6 + (crisp / 100) * 3.4).toFixed(2)}:drive=8.5:blend=0:freq=6000:ceil=16000`;
/** The FFmpeg chain for the cleanup's numbers ("" = nothing to do). The AI steps (enhance, dereverb) are not in it:
 *  the render reads the voice they made in place of the footage's own sound. */
export function cleanupChain(p: CleanupParams): string {
  const f: string[] = [];
  if (p.highpass > 0) f.push(`highpass=f=${p.highpass}`);
  if (p.lowpass > 0) f.push(`lowpass=f=${p.lowpass}`);
  if (p.denoise > 0) f.push(`afftdn=nr=${p.denoise}:nf=${p.noiseFloor}:tn=1`);
  if (p.gate) f.push("agate=threshold=0.01:ratio=2:attack=5:release=200");
  if (p.warmth) f.push(`equalizer=f=180:t=q:w=0.9:g=${p.warmth}`);
  if (p.mud) f.push(`equalizer=f=250:t=q:w=1:g=${p.mud}`);
  if (p.presence) f.push(`equalizer=f=${p.presenceHz}:t=q:w=1:g=${p.presence}`);
  if (p.air) f.push(`treble=g=${p.air}:f=10000:t=q:w=0.7`);
  if (p.crisp > 0) f.push(crispFilter(p.crisp));
  if (p.deess > 0) f.push(`deesser=i=${p.deess}`);
  if (p.level > 0) f.push(levelFilter(p.level));
  if (p.compress > 1) f.push(`acompressor=threshold=${p.threshold}dB:ratio=${p.compress}:attack=${p.attack}:release=${p.release}`);
  return f.join(",");
}
/** The preset chains (what each preset alone does). */
export const CLEANUP_CHAINS: Record<Cleanup, string> = Object.fromEntries(Object.entries(CLEANUP_PRESETS).map(([k, p]) => [k, cleanupChain(p)])) as Record<Cleanup, string>;
export const CLEANUP_TEXT: Record<Cleanup, string> = Object.fromEntries(VOICE_PRESETS.map((v) => [v.id, v.id === "none" ? "none" : `${v.id} (${v.what})`])) as Record<Cleanup, string>;

/** "voice (high-pass, ...)" or, with hand-set values, "voice, denoise 15 dB, presence +4 dB"; "none" when nothing runs. */
export function cleanupText(a: { cleanup: Cleanup } & Partial<Record<CleanupKnob, number | undefined>>): string {
  const hand = CLEANUP_KNOBS.filter((k) => a[k] != null);
  if (!hand.length) return a.cleanup === "none" ? "none" : CLEANUP_TEXT[a.cleanup].split(" (")[0];
  const p = cleanupParams(a);
  const say: Record<CleanupKnob, string> = { highpass: p.highpass ? `high-pass ${p.highpass} Hz` : "no high-pass", denoise: p.denoise ? `denoise ${p.denoise} dB` : "no denoise", presence: p.presence ? `presence +${p.presence} dB` : "no presence lift", deess: p.deess ? `de-ess ${p.deess}` : "no de-esser", compress: p.compress > 1 ? `compression ${p.compress}:1` : "no compression",
    enhance: p.enhance ? `AI noise removal ${p.enhance}` : "no AI noise removal", dereverb: p.dereverb ? `echo removal ${p.dereverb}` : "no echo removal", level: p.level ? `leveling ${p.level}` : "no leveling", crisp: p.crisp ? `crispness ${p.crisp}` : "no added crispness" };
  return `${a.cleanup}, ${hand.map((k) => say[k]).join(", ")}`;
}

/**
 * Studio voice (enhance, dereverb): the AI steps run before the render on the footage's own sound, in blocks of
 * VOICE_BLOCK seconds from the video's start, each made once per strength and kept with the video (deleted with it):
 * a clip trimmed or moved reuses the blocks it already had. VOICE_VERSION changes when the voice does.
 */
export const VOICE_BLOCK = 30;
export const VOICE_VERSION = 1;
/** The strengths the voice is made at: steps of 10 (nearby values share the made blocks). */
export const voiceStrengths = (p: { enhance: number; dereverb: number }) => ({ enhance: Math.round(p.enhance / 10) * 10, dereverb: Math.round(p.dereverb / 10) * 10 });
export const voiceTag = (p: { enhance: number; dereverb: number }) => { const s = voiceStrengths(p); return `e${s.enhance}-d${s.dereverb}`; };
/** Where a block of a video's studio voice is kept (with the video's frames: deleted with it). */
export const voiceKey = (userId: string, videoId: string, tag: string, k: number) => `${PREFIX.frames}${userId}/${videoId}/voice-v${VOICE_VERSION}-${tag}-${k}.flac`;
/** The blocks footage srcIn..srcOut needs, with `margin` seconds each side (crossfades read footage past a cut). */
export function voiceBlocks(srcIn: number, srcOut: number, seconds = Infinity, margin = 1): number[] {
  const a = Math.max(0, Math.min(srcIn, srcOut) - margin), b = Math.min(seconds, Math.max(srcIn, srcOut) + margin);
  const last = Math.max(0, Math.ceil(b / VOICE_BLOCK) - 1);
  const k0 = Math.min(last, Math.floor(a / VOICE_BLOCK));
  return Array.from({ length: last - k0 + 1 }, (_, i) => k0 + i);
}
/** A video whose sound the render reads as the studio voice: the strengths and the blocks it needs. */
export type VoiceOp = { videoId: string; enhance: number; dereverb: number; blocks: number[] };
/** "AI noise removal 100 (DeepFilterNet3), echo removal 60 (WPE)" */
export const voiceText = (v: { enhance: number; dereverb: number }) => [v.enhance ? `AI noise and room removal ${v.enhance} (DeepFilterNet3)` : "", v.dereverb ? `echo removal ${v.dereverb} (WPE)` : ""].filter(Boolean).join(", ");
/**
 * The extra time a render may spend making the studio voice (every block of every V1 clip's footage, as if none were
 * made yet, at 3x real time on the worker's CPUs): added to the render's own limits. 0 when the edit's cleanup has no
 * AI step.
 */
export function voiceAllowanceMs(timeline: unknown): number {
  const tl = timeline as { audio?: Record<string, unknown>; tracks?: { v1?: unknown } } | null;
  const a = (tl?.audio ?? {}) as { cleanup?: Cleanup } & Partial<Record<CleanupKnob, number>>;
  const p = cleanupParams({ ...a, cleanup: a.cleanup && a.cleanup in CLEANUP_PRESETS ? a.cleanup : "none" });
  const s = voiceStrengths(p);
  if (!s.enhance && !s.dereverb) return 0;
  const v1 = (Array.isArray(tl?.tracks?.v1) ? tl!.tracks!.v1 : []) as { sourceVideoId?: string; sourceIn?: number; sourceOut?: number }[];
  const blocks = new Set<string>();
  for (const c of v1) for (const k of voiceBlocks(c?.sourceIn ?? 0, c?.sourceOut ?? 0)) blocks.add(`${c?.sourceVideoId ?? ""}:${k}`);
  return blocks.size ? 20_000 + Math.ceil((blocks.size * VOICE_BLOCK * 1000) / 3) : 0;
}
