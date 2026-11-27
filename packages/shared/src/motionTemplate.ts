// Motion templates: a motion-graphic video kept as a design system (colours, type, element styles), a motion system
// (word timing, easings, pops, morphs between elements), a camera (zooms, pans, caret follow, reveals) and layers on a
// timeline, with slots for every word, picture and colour. Two ways to use one:
//  - swap: fill the slots with new words, pictures and colours (Recreate) and render;
//  - new video: write new scenes and layers that keep the template's design and motion (templateFrom).
// One player (motionTemplate/runtime.js) draws a template as a pure function of time, recorded like any custom graphic.
import { z } from "zod";
import { MOTION_RUNTIME } from "./motionTemplate/runtimeCode";
import { LAUNCH_STORY } from "./motionTemplate/launchStory";
import { TALKING_HEAD_AD } from "./motionTemplate/talkingHeadAd";

export const MOTION_LAYER_KINDS = ["text", "wordpill", "media", "backdrop", "frametitle", "card", "node", "grid", "box", "toasts", "cta", "burst", "cursor", "halftone", "chip", "captions", "titlebox", "disc", "bug", "endcard", "flash"] as const;
export const MOTION_VIEW_KINDS = ["blank", "image", "dialog", "prompt", "mosaic", "scene", "post"] as const;
export const MOTION_SLOT_TYPES = ["text", "image", "color"] as const;
export const MOTION_SFX = ["sfx_whoosh", "sfx_pop", "sfx_hit"] as const;
/** A video picked for an image slot marked video: true (a full-screen backdrop): it plays as b-roll under the graphic. */
export const MOTION_VIDEO_PREFIX = "video:";
/** The most the template's HTML (player, layers and every slot picture) may weigh: a custom graphic's code limit. */
export const MOTION_HTML_MAX = 1_000_000;

const time = z.number().min(0).max(600);
const Key = z.object({ t: time }).passthrough();
const SlotId = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,39}$/, "A slot id is letters, digits and _ (starting with a letter), up to 40 characters.");
export const MotionSlotSchema = z.object({
  id: SlotId,
  type: z.enum(MOTION_SLOT_TYPES),
  label: z.string().min(1).max(80),
  default: z.string().max(MOTION_HTML_MAX).optional(),
  maxChars: z.number().int().min(1).max(1000).optional(),
  video: z.boolean().optional(),
});
const ViewSchema = z.object({ at: time, kind: z.enum(MOTION_VIEW_KINDS) }).passthrough();
export const MotionLayerSchema = z.object({
  id: z.string().max(60).optional(),
  kind: z.enum(MOTION_LAYER_KINDS),
  t0: time.optional(), t1: time.optional(),
  keys: z.array(Key).max(300).optional(),
  views: z.array(ViewSchema).max(12).optional(),
}).passthrough();
/**
 * Where a template's code came from. Only these get code: Rendrr's own templates, a reference video broken down into
 * code, and a video a user published as a template (Claude wrote its code while editing). Raw uploads never get code:
 * they stay frames only.
 */
export const MOTION_SOURCES = ["rendrr", "reference", "published"] as const;
/**
 * The footage edit around the graphic (talking-head and b-roll templates): each shot is a video slot played at
 * [t0, t1] (from: the second of that video it starts at; a talking head defaults to t0 so the speech runs on across
 * cuts), with its entrance (a whip: the shot pushes the last one out, motion blurred), keys (scale and x/y as shares
 * of the frame, seconds from the shot's start) and a blur. Recreate builds these as b-roll clips with keyframes.
 */
const ShotSchema = z.object({
  id: z.string().max(40),
  slot: SlotId,
  t0: time, t1: time,
  from: z.number().min(0).max(36000).optional(),
  in: z.object({ type: z.enum(["cut", "whip"]), dur: z.number().min(0.04).max(1).optional(), dir: z.enum(["left", "right", "up", "down"]).optional() }).optional(),
  keys: z.array(z.object({ t: z.number().min(0).max(600), scale: z.number().min(0.05).max(4).optional(), x: z.number().min(-3).max(3).optional(), y: z.number().min(-3).max(3).optional(), ease: z.enum(["linear", "in", "out", "in-out"]).optional() })).max(20).optional(),
  blur: z.number().min(1).max(100).optional(),
  what: z.string().max(300).optional(),
});
export const MotionTemplateSchema = z.object({
  v: z.literal(1),
  name: z.string().min(1).max(80),
  description: z.string().max(1200).optional(),
  w: z.number().int().min(64).max(1920),
  h: z.number().int().min(64).max(1920),
  duration: z.number().min(0.5).max(600),
  fps: z.number().int().min(1).max(60).optional(),
  design: z.record(z.unknown()).optional(),
  motion: z.object({
    word: z.object({ ms: z.number().min(10).max(2000), stagger: z.number().min(0).max(2), blur: z.number().min(0).max(60), rise: z.number().min(-200).max(200) }).partial().optional(),
    eases: z.record(z.tuple([z.number(), z.number(), z.number(), z.number()])).optional(),
    notes: z.array(z.string().max(500)).max(30).optional(),
  }).passthrough().optional(),
  scenes: z.array(z.object({ id: z.string().max(60), start: time, end: time, what: z.string().max(500) })).max(60).optional(),
  /** The reference's elements, one line each (what it is and how the template carries it). */
  elements: z.array(z.string().max(500)).max(200).optional(),
  slots: z.array(MotionSlotSchema).max(90).default([]),
  audio: z.object({ music: z.string().max(80).optional(), musicDb: z.number().min(-40).max(6).optional(), musicStart: time.optional(), sfx: z.array(z.object({ t: time, id: z.enum(MOTION_SFX) })).max(120).optional() }).optional(),
  camera: z.array(Key).max(300).optional(),
  layers: z.array(MotionLayerSchema).min(1).max(240),
  transparentBg: z.boolean().optional(),
  source: z.enum(MOTION_SOURCES).optional(),
  /** The reference video this template was broken down from (its Rendrr id), when source is reference. */
  fromVideo: z.string().max(80).optional(),
  edit: z.object({ shots: z.array(ShotSchema).max(80) }).optional(),
});
export type MotionTemplate = z.infer<typeof MotionTemplateSchema>;
export type MotionSlot = z.infer<typeof MotionSlotSchema>;

/** Every {{slot}} the template uses. */
export function motionSlotRefs(spec: unknown): Set<string> {
  const out = new Set<string>();
  const walk = (v: unknown) => {
    if (typeof v === "string") { for (const m of v.matchAll(/\{\{([a-zA-Z0-9_]+)\}\}/g)) out.add(m[1]); }
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { if (k !== "slots") walk(x); }
  };
  walk(spec);
  return out;
}

/** A template checked: its shape, unique slot ids, every {{slot}} declared, times inside its length. */
export function checkMotionTemplate(input: unknown): { ok: true; spec: MotionTemplate } | { ok: false; error: string } {
  const r = MotionTemplateSchema.safeParse(input);
  if (!r.success) { const i = r.error.issues[0]; return { ok: false, error: `Template ${i.path.join(".") || "spec"}: ${i.message}` }; }
  const s = r.data;
  const ids = new Set<string>();
  for (const sl of s.slots) { if (ids.has(sl.id)) return { ok: false, error: `Slot "${sl.id}" is declared twice.` }; ids.add(sl.id); }
  const missing = [...motionSlotRefs(s)].filter((k) => !ids.has(k));
  if (missing.length) return { ok: false, error: `The template uses ${missing.map((k) => `{{${k}}}`).join(", ")} but declares no slot for ${missing.length === 1 ? "it" : "them"}.` };
  for (const sh of s.edit?.shots ?? []) {
    const sl = s.slots.find((x) => x.id === sh.slot);
    if (!sl || sl.type !== "image" || !sl.video) return { ok: false, error: `Shot ${sh.id} plays slot "${sh.slot}", which must be a declared picture slot that takes video (video: true).` };
    if (!(sh.t1 > sh.t0) || sh.t0 > s.duration) return { ok: false, error: `Shot ${sh.id} must end after it starts, inside the template (${s.duration}s).` };
  }
  const late = s.layers.find((l) => (l.t0 ?? 0) > s.duration);
  if (late) return { ok: false, error: `Layer ${late.id || late.kind} starts at ${late.t0}s, after the template ends (${s.duration}s).` };
  return { ok: true, spec: s };
}

/** New video mode: the base's design and motion, with the new template's scenes, layers, camera and slots. */
export function deriveMotionTemplate(base: MotionTemplate, patch: Partial<MotionTemplate> & Record<string, unknown>): unknown {
  const out: Record<string, unknown> = {
    ...base, ...patch,
    design: { ...(base.design ?? {}), ...(patch.design ?? {}) },
    motion: { ...(base.motion ?? {}), ...(patch.motion ?? {}), eases: { ...(base.motion?.eases ?? {}), ...(patch.motion?.eases ?? {}) }, word: { ...(base.motion?.word ?? {}), ...(patch.motion?.word ?? {}) } },
    audio: patch.audio ?? base.audio,
  };
  // the base's design and motion keep their own slots (its colours, say) when the new layers bring other slots
  if (patch.slots) {
    const have = new Set((patch.slots as MotionSlot[]).map((x) => x.id)), refs = motionSlotRefs(out);
    out.slots = [...(patch.slots as MotionSlot[]), ...base.slots.filter((x) => refs.has(x.id) && !have.has(x.id))];
  }
  return out;
}

const HEX = /^#[0-9a-fA-F]{6}$/;
/**
 * Slot values checked against the template: known slots only, text within maxChars, colours #RRGGBB, pictures as
 * data:image URLs (or "" for none; a video: ref only where the slot takes video). Returns every slot's value, the
 * defaults filled in.
 */
export function motionSlotValues(spec: MotionTemplate, values: Record<string, unknown> = {}): { values: Record<string, string> } | { error: string } {
  const byId = new Map(spec.slots.map((s) => [s.id, s]));
  const out: Record<string, string> = Object.fromEntries(spec.slots.map((s) => [s.id, s.default ?? ""]));
  for (const [k, raw] of Object.entries(values)) {
    const s = byId.get(k);
    if (!s) return { error: `The template has no slot "${k}". Its slots: ${spec.slots.map((x) => x.id).join(", ")}.` };
    if (raw == null) continue;
    if (typeof raw !== "string") return { error: `Slot "${k}" takes text.` };
    if (s.type === "text" && s.maxChars && raw.length > s.maxChars) return { error: `Slot "${k}" (${s.label}) is ${s.maxChars} characters at most; it got ${raw.length}.` };
    if (s.type === "color" && !HEX.test(raw)) return { error: `Slot "${k}" (${s.label}) is a colour like #EE4F8C.` };
    if (s.type === "image" && raw && !raw.startsWith("data:image/") && !(s.video && raw.startsWith(MOTION_VIDEO_PREFIX))) return { error: `Slot "${k}" (${s.label}) takes a picture${s.video ? " or a video" : ""}.` };
    out[k] = raw;
  }
  return { values: out };
}

const scriptJson = (o: unknown) => JSON.stringify(o).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
/** The graphic HTML that plays a template: the player and the template with these slot values as its defaults. */
export function motionTemplateHtml(spec: MotionTemplate, values: Record<string, string> = {}): string {
  const filled = { ...spec, slots: spec.slots.map((s) => (values[s.id] != null ? { ...s, default: values[s.id] } : s)) };
  return `<!doctype html><html><head><meta charset="utf-8"></head><body><script>window.__MOTION_SPEC__=${scriptJson(filled)};</script><script>${MOTION_RUNTIME}</script></body></html>`;
}

/** The template without its slot pictures (what is shown and kept as its description). */
export function motionTemplateLite(spec: MotionTemplate): MotionTemplate {
  return { ...spec, slots: spec.slots.map((s) => (s.type === "image" && s.default && s.default.length > 200 ? { ...s, default: "(a picture)" } : s)) };
}

const f2 = (n: number) => (Math.round(n * 100) / 100).toString();
/** A template in plain words: design, motion, camera, scenes and slots (for the AI and the template page). */
/** A key's ease in words: a preset, or its After Effects handles. */
function easeWords(k: Record<string, unknown>): string {
  if (typeof k.e === "string") return k.e;
  if (Array.isArray(k.e)) return `bezier ${k.e.join(",")}`;
  const h = (k.in ?? (k as { out?: unknown }).out) as { infl?: number } | undefined;
  if (h) return `After Effects ease, ${Math.round((h.infl ?? 1 / 3) * 100)}% influence`;
  return k.auto ? "auto bezier" : "inOut";
}
export function motionTemplateText(spec: MotionTemplate): string {
  const d = (spec.design ?? {}) as Record<string, unknown>;
  const accent = Array.isArray(d.accent) ? (d.accent as string[]).join(" to ") : "";
  const lines = [`"${spec.name}": ${f2(spec.duration)} s, ${spec.w}x${spec.h}, ${spec.layers.length} layers, ${spec.slots.length} slots.`];
  if (spec.description) lines.push(spec.description);
  lines.push(`DESIGN: background ${d.bg ?? "#F7F6F4"}, ink ${d.ink ?? "#141214"}, muted ${d.muted ?? "#A3A0A2"}${accent ? `, accent gradient ${accent}` : ""}${d.brand ? `, brand ${d.brand}` : ""}; type ${d.font ?? "Inter"} ${d.headWeight ?? 700} at ${d.headSize ?? 56}px, tracking ${d.tracking ?? -0.025}em${d.mono ? `, mono ${d.mono}` : ""}; cards radius ${d.radius ?? 22}px with a soft deep shadow.`);
  const w = spec.motion?.word;
  if (w) lines.push(`WORDS: each word blurs in over ${w.ms ?? 110} ms, ${Math.round((w.stagger ?? 0.11) * 1000)} ms apart (blur ${w.blur ?? 14}px, rise ${w.rise ?? 8}px).`);
  for (const n of spec.motion?.notes ?? []) lines.push(`MOTION: ${n}`);
  const cam = (spec.camera ?? []) as { t: number; z?: number; x?: number; y?: number; e?: string; track?: unknown }[];
  const moves = cam.filter((k, i) => i > 0 && k.z != null && cam.slice(0, i).reverse().find((p) => p.z != null)?.z !== k.z);
  if (moves.length) lines.push(`CAMERA: ${moves.map((k) => { const prev = cam.slice(0, cam.indexOf(k)).reverse().find((p) => p.z != null)!; return `${f2(prev.t)}-${f2(k.t)}s zoom ${f2(prev.z!)}x to ${f2(k.z!)}x (${easeWords(k)})`; }).join("; ")}${cam.some((k) => k.track) ? "; follows the typing caret while zoomed in" : ""}.`);
  for (const s of spec.scenes ?? []) lines.push(`SCENE ${f2(s.start)}-${f2(s.end)}s ${s.id}: ${s.what}`);
  const shots = spec.edit?.shots ?? [];
  if (shots.length) lines.push(`SHOTS: ${shots.map((x) => `${f2(x.t0)}-${f2(x.t1)}s ${x.slot}${x.in?.type === "whip" ? ` (whip ${x.in.dir ?? "left"} in)` : ""}${x.keys?.some((k) => k.scale != null && k.scale !== 1) ? " (zoom)" : ""}${x.blur ? ` (blur ${x.blur})` : ""}`).join("; ")}.`);
  for (const e of spec.elements ?? []) lines.push(`ELEMENT: ${e}`);
  lines.push(`SLOTS: ${spec.slots.map((s) => `${s.id} (${s.type}${s.video ? ", or a video" : ""}${s.maxChars ? `, ${s.maxChars} chars` : ""}: ${s.label}${s.type !== "image" && s.default ? ` = ${JSON.stringify(s.default)}` : ""})`).join("; ")}.`);
  if (spec.audio?.music || spec.audio?.sfx?.length) lines.push(`SOUND: ${spec.audio.music ? `music ${spec.audio.music} at ${spec.audio.musicDb ?? -8} dB` : "no music"}${spec.audio.sfx?.length ? `, ${spec.audio.sfx.length} sound effects on transitions and pops` : ""}.`);
  return lines.join("\n");
}

/** Rendrr's own templates: anyone can use them (Explore, Rendrr presets). */
export const MOTION_TEMPLATES: { id: string; spec: MotionTemplate }[] = [
  { id: "mt_launch_story", spec: MotionTemplateSchema.parse(LAUNCH_STORY) },
  { id: "mt_talking_head_ad", spec: MotionTemplateSchema.parse(TALKING_HEAD_AD) },
];
export const builtinMotionTemplate = (id: string) => MOTION_TEMPLATES.find((t) => t.id === id) ?? null;
