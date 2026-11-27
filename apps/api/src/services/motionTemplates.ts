// Motion templates (packages/shared/src/motionTemplate.ts): Rendrr's own and the user's, saved as custom graphics whose
// params schema carries the template. Recreate fills the slots (words, pictures, colours, a video for a full-screen
// picture), makes the graphic that plays it and a blank edit around it (the graphic, b-roll for videos, the template's
// music and sound effects), ready to render.
import { prisma, Prisma } from "@rendrr/db";
import { AppError, applyTimelineChange, enqueue, getBytes, notFound, type GraphicJob } from "@rendrr/core";
import {
  aspectSize, builtinMotionTemplate, checkMotionTemplate, customParamsSchema, deriveMotionTemplate, MOTION_HTML_MAX, MOTION_TEMPLATES,
  MOTION_VIDEO_PREFIX, motionSlotValues, motionTemplateHtml, motionTemplateLite, motionTemplateText, type Aspect, type MotionTemplate, type Op,
  allWords, asSequence, layoutTimeline, sequenceView, type Timeline, type Transcript,
} from "@rendrr/shared";
import { createCanvas } from "./canvas";
import { createProject } from "./projects";
import { fetchPublic } from "./fetchPublic";

export type TemplateRef = { id: string; name: string; builtin: boolean; spec: MotionTemplate; graphicId: string | null; status?: string };
const IMAGE_MAX = 1_500_000;

/** Is this graphic's params schema a template's? */
export function templateOf(paramsSchema: unknown): MotionTemplate | null {
  const t = (paramsSchema as { motionTemplate?: unknown } | null)?.motionTemplate;
  if (!t) return null;
  const r = checkMotionTemplate(t);
  return r.ok ? r.spec : null;
}

/** Rendrr's templates and the user's own (newest first). */
export async function listMotionTemplates(userId?: string): Promise<TemplateRef[]> {
  const own = userId ? await prisma.graphic.findMany({
    where: { ownerId: userId, kind: "custom", deletedAt: null, paramsSchema: { path: ["motionTemplate", "v"], equals: 1 } },
    orderBy: { createdAt: "desc" }, take: 100, select: { id: true, name: true, paramsSchema: true, status: true },
  }) : [];
  const mine = own.flatMap((g) => { const spec = templateOf(g.paramsSchema); return spec ? [{ id: g.id, name: g.name, builtin: false, spec, graphicId: g.id, status: g.status }] : []; });
  return [...MOTION_TEMPLATES.map((t) => ({ id: t.id, name: t.spec.name, builtin: true, spec: t.spec, graphicId: null })), ...mine];
}

export async function getMotionTemplate(userId: string | undefined, id: string): Promise<TemplateRef> {
  const b = builtinMotionTemplate(id);
  if (b) return { id: b.id, name: b.spec.name, builtin: true, spec: b.spec, graphicId: null };
  const g = userId ? await prisma.graphic.findFirst({ where: { id, ownerId: userId, kind: "custom", deletedAt: null }, select: { id: true, name: true, paramsSchema: true, status: true } }) : null;
  const spec = g && templateOf(g.paramsSchema);
  if (!g || !spec) throw notFound(`There is no template "${id}". GET /templates lists them (Rendrr's start with mt_).`);
  return { id: g.id, name: g.name, builtin: false, spec, graphicId: g.id, status: g.status };
}

/** What the template page and the AI see: everything but the slot pictures, plus the plain-words breakdown. */
export const templateOut = (t: TemplateRef) => ({
  id: t.id, name: t.name, builtin: t.builtin, status: t.status ?? "ready", seconds: t.spec.duration, width: t.spec.w, height: t.spec.h,
  description: t.spec.description ?? "", spec: motionTemplateLite(t.spec), text: motionTemplateText(t.spec),
  // Templates carry their code, open to anyone to read and copy (any AI can recreate the video from it): Rendrr's
  // own, reference breakdowns and published videos. Raw uploads never get code; they stay frames only.
  source: t.spec.source ?? (t.builtin ? "rendrr" : "published"), codeUrl: `/templates/${t.id}/code`,
});

/** A template's code: the HTML that plays it (player and template, slot pictures left out). */
export const templateCode = (t: TemplateRef) => motionTemplateHtml(motionTemplateLite(t.spec));

async function newGraphic(userId: string, name: string, spec: MotionTemplate, code: string, o: { template: boolean; transparent: boolean; from?: string }) {
  if (code.length > MOTION_HTML_MAX) throw new AppError(`This template with its pictures is ${(code.length / 1e6).toFixed(2)} MB; the most is 1 MB. Use smaller pictures (about 1280 px wide JPEGs are plenty).`, 400, "template-too-big");
  const paramsSchema = { ...customParamsSchema({}), ...(o.template ? { motionTemplate: motionTemplateLite(spec) } : { recreateOf: o.from ?? null }) };
  const g = await prisma.graphic.create({ data: {
    ownerId: userId, kind: "custom", status: "queued", name: name.slice(0, 120), code, paramsSchema: paramsSchema as Prisma.InputJsonValue,
    durationSec: spec.duration, width: spec.w, height: spec.h, transparent: o.transparent,
  } });
  await enqueue<GraphicJob>("graphic", { graphicId: g.id }, { jobId: g.id });
  return g.id;
}

/**
 * A template saved for the user: a new one, or (templateFrom) a new video in another template's design and motion:
 * its design, motion and sound are kept and the new scenes, layers, camera and slots come from the input.
 */
export async function saveMotionTemplate(userId: string, input: unknown, o: { templateFrom?: string; name?: string } = {}) {
  let raw = input;
  if (o.templateFrom) {
    const base = await getMotionTemplate(userId, o.templateFrom);
    raw = deriveMotionTemplate(base.spec, { v: 1, ...(input as Record<string, unknown>) } as Partial<MotionTemplate>);
  }
  const r = checkMotionTemplate(raw);
  if (!r.ok) throw new AppError(r.error, 400, "bad-template");
  const spec = o.name ? { ...r.spec, name: o.name.slice(0, 80) } : r.spec;
  const id = await newGraphic(userId, spec.name, spec, motionTemplateHtml(spec), { template: true, transparent: false });
  return { id, spec };
}

const dataUrl = (buf: Buffer, type: string) => `data:${type};base64,${buf.toString("base64")}`;
const imageType = (type: string, buf: Buffer) => (/^image\/(png|jpe?g|webp|gif)/i.test(type) ? type.split(";")[0] : buf[0] === 0x89 ? "image/png" : buf[0] === 0xff ? "image/jpeg" : buf.slice(8, 12).toString() === "WEBP" ? "image/webp" : null);

/**
 * Each picture slot's value made into what the player draws: a data:image URL as it is; an https link fetched; a
 * library picture (its id) as its still; one of the user's elements; a library video for a slot that takes video
 * (it plays as b-roll under the graphic). Anything else is refused with the slot's name.
 */
export async function resolveSlotPictures(userId: string, spec: MotionTemplate, values: Record<string, unknown>) {
  const out: Record<string, unknown> = { ...values };
  const videos: SlotVideo[] = [];
  for (const s of spec.slots.filter((x) => x.type === "image")) {
    const v = values[s.id];
    if (typeof v !== "string" || !v || v.startsWith("data:image/")) {
      if (typeof v === "string" && v.length > IMAGE_MAX * 1.4) throw new AppError(`The picture for "${s.label}" is too big (1.5 MB at most).`, 400, "template-too-big");
      continue;
    }
    if (/^https:\/\//i.test(v)) {
      const r = await fetchPublic(v, { max: IMAGE_MAX, what: "picture", code: "bad-template" });
      const type = imageType(r.type, r.buf);
      if (!type) throw new AppError(`The link for "${s.label}" is not a picture (PNG, JPEG, WebP).`, 400, "bad-template");
      out[s.id] = dataUrl(r.buf, type);
      continue;
    }
    const video = await prisma.video.findFirst({ where: { id: v, userId }, select: { id: true, still: true, thumbKey: true, status: true, name: true, seconds: true } });
    if (video) {
      if (!video.still && s.video) { videos.push({ slot: s.id, videoId: video.id, seconds: video.seconds }); out[s.id] = MOTION_VIDEO_PREFIX + video.id; continue; }
      if (!video.thumbKey) throw new AppError(`"${video.name}" has no picture yet (still processing). Try again in a moment.`, 409, "bad-template");
      if (!video.still) throw new AppError(`"${s.label}" takes a picture; "${video.name}" is a video. Pick a picture, or a slot marked video.`, 400, "bad-template");
      out[s.id] = dataUrl(await getBytes(video.thumbKey), "image/jpeg");
      continue;
    }
    // An edit for a slot that takes video: its V1 as it is cut (the talking head, takes and pauses already cut).
    if (s.video) {
      const edit = await editPieces(userId, v);
      if (edit) { videos.push({ slot: s.id, videoId: edit.pieces[0].videoId, seconds: edit.seconds, pieces: edit.pieces }); out[s.id] = MOTION_VIDEO_PREFIX + edit.pieces[0].videoId; continue; }
    }
    const el = await prisma.graphic.findFirst({ where: { id: v, ownerId: userId, kind: "element" }, select: { sourceKey: true, thumbKey: true } });
    const key = el?.sourceKey ?? el?.thumbKey;
    if (key) { const buf = await getBytes(key); out[s.id] = dataUrl(buf, imageType("", buf) ?? "image/png"); continue; }
    throw new AppError(`"${s.label}" takes a picture: a data:image URL, an https link to a picture, or the id of a picture or element in your library (a slot that takes video: a library video or an edit).`, 400, "bad-template");
  }
  return { values: out, videos };
}

type ShotKey = { t: number; x?: number; y?: number; scale?: number; ease?: "linear" | "in" | "out" | "in-out" };
/** A stretch of an edit's V1: the footage (video, seconds) that plays from start to end of the edit. */
export type SlotPiece = { videoId: string; srcIn: number; srcOut: number; start: number; end: number };
/** A video picked for a slot: a library video, or an edit (its V1 pieces; seconds are then the edit's). */
export type SlotVideo = { slot: string; videoId: string; seconds: number; pieces?: SlotPiece[] };
type Videos = Map<string, SlotVideo>;
const r3 = (n: number) => Math.round(n * 1000) / 1000;

/**
 * An edit of the user's as the pieces its V1 plays (cuts kept, speed 1 only): what a slot that takes video plays when
 * it is given an edit (a talking head already cut to its best takes). Null when the id is not one of their edits.
 */
async function editPieces(userId: string, id: string): Promise<{ pieces: SlotPiece[]; seconds: number } | null> {
  const p = await prisma.project.findFirst({ where: { id, userId, deletedAt: null }, select: { name: true, videoId: true, timeline: true } });
  if (!p) return null;
  const video = await prisma.video.findUnique({ where: { id: p.videoId }, select: { analysis: { select: { transcript: true } } } });
  const words = allWords(((video?.analysis?.transcript as unknown) as Transcript) || []);
  const tl = layoutTimeline(asSequence(p.timeline as unknown as Timeline, words, p.videoId), words);
  const view = sequenceView(tl, words);
  if (view.pieces.some((x) => (x.rate ?? 1) !== 1)) throw new AppError(`"${p.name}" has clips at another speed. Recreate plays an edit's cuts at normal speed: set those clips back to 1x, or pick another edit.`, 400, "bad-template");
  const pieces = view.pieces.filter((x) => x.end - x.start > 0.01).map((x) => ({ videoId: x.videoId, srcIn: r3(x.srcIn), srcOut: r3(x.srcOut), start: r3(x.start), end: r3(x.end) }));
  if (!pieces.length) throw new AppError(`"${p.name}" has nothing on V1 yet.`, 400, "bad-template");
  return { pieces, seconds: r3(view.total) };
}

/** Where second t of a slot's video (or of the edit given for it) is: the footage's video and second. */
export function footageAt(v: SlotVideo, t: number) {
  if (!v.pieces?.length) return { videoId: v.videoId, src: t };
  const p = v.pieces.find((x) => t >= x.start - 1e-6 && t < x.end - 1e-6) ?? v.pieces[v.pieces.length - 1];
  return { videoId: p.videoId, src: r3(Math.min(p.srcOut, Math.max(p.srcIn, p.srcIn + (t - p.start)))) };
}
/** The footage that plays from a to b of a slot's video or edit, split where the edit cuts (from, to: slot seconds). */
export function footageSpans(v: SlotVideo, a: number, b: number): { from: number; to: number; videoId: string; srcIn: number }[] {
  if (!v.pieces?.length) return [{ from: a, to: b, videoId: v.videoId, srcIn: a }];
  return v.pieces.filter((p) => p.end > a + 1e-6 && p.start < b - 1e-6).map((p) => {
    const from = Math.max(a, p.start), to = Math.min(b, p.end);
    return { from, to, videoId: p.videoId, srcIn: r3(p.srcIn + (from - p.start)) };
  });
}

/** Keys of a move (seconds from its start) for the part of it from off to off + len: the keys inside, and the values
 *  at the part's ends where keys lie outside it (linear between keys, held past the last), so a split move stays. */
export function keysWithin(keys: ShotKey[], off: number, len: number): ShotKey[] {
  if (!keys.length) return [];
  const sh = keys.map((k) => ({ ...k, t: k.t - off })).sort((x, y) => x.t - y.t);
  const valAt = (t: number, f: "x" | "y" | "scale") => {
    const ks = sh.filter((k) => k[f] != null);
    if (!ks.length) return undefined;
    if (t <= ks[0].t) return ks[0][f];
    for (let i = 1; i < ks.length; i++) if (t <= ks[i].t) { const a = ks[i - 1], b = ks[i], u = b.t > a.t ? (t - a.t) / (b.t - a.t) : 1; return r3(a[f]! + (b[f]! - a[f]!) * u); }
    return ks[ks.length - 1][f];
  };
  const at = (t: number): ShotKey => { const k: ShotKey = { t: r3(t) }; for (const f of ["x", "y", "scale"] as const) { const v = valAt(t, f); if (v != null) k[f] = v; } return k; };
  const inside = sh.filter((k) => k.t >= -1e-6 && k.t <= len + 1e-6).map((k) => ({ ...k, t: r3(Math.min(len, Math.max(0, k.t))) }));
  const out = [...(sh[0].t < -1e-6 && !inside.some((k) => k.t === 0) ? [at(0)] : []), ...inside, ...(sh[sh.length - 1].t > len + 1e-6 && !inside.some((k) => k.t === r3(len)) ? [at(len)] : [])];
  // A part that does not move needs no keys (a clip with keys is one the person matte skips); a held zoom keeps one.
  const still = (["x", "y", "scale"] as const).every((f) => out.every((k) => (k[f] ?? null) === (out[0][f] ?? null)));
  if (still) return (out[0].x ?? 0) === 0 && (out[0].y ?? 0) === 0 && (out[0].scale ?? 1) === 1 ? [] : [{ ...out[0], t: 0 }];
  return out;
}

/**
 * A shot's moves as keys from its start: a whip is a hard cut with a whip pan either side of it: the outgoing shot
 * shoots off over its last `dur` seconds and the incoming one lands over its first (scaled up so no edge shows,
 * heavily motion blurred), as the reference's 2-frame whips; nothing slides over anything. The shot's own keys (a
 * zoom) carry on around the whip.
 */
function shotMoves(spec: MotionTemplate, i: number, videos: Videos) {
  const shots = spec.edit?.shots ?? [], s = shots[i], next = shots[i + 1];
  const push = 0.18, cover = 1.4; // how far a whip throws the frame (share of the width), and the scale that hides the edge
  const vec = (dir?: string) => (dir === "right" ? [1, 0] : dir === "up" ? [0, -1] : dir === "down" ? [0, 1] : [-1, 0]);
  const d = s.in?.type === "whip" ? s.in.dur ?? 0.083 : 0, nd = next?.in?.type === "whip" && videos.has(next.slot) ? next.in.dur ?? 0.083 : 0;
  const len = Math.min(spec.duration, s.t1) - s.t0;
  const keys: ShotKey[] = [];
  const own = (s.keys ?? []).filter((k) => k.scale != null).sort((a, b) => a.t - b.t);
  const scaleAt = (t: number) => { let v = own.length ? own[0].scale! : 1; for (const k of own) if (k.t <= t) v = k.scale!; return v; };
  if (d) { const [dx, dy] = vec(s.in?.dir); keys.push({ t: 0, x: -dx * push, y: -dy * push, scale: cover }, { t: r3(d), x: 0, y: 0, scale: cover, ease: "out" }, { t: r3(Math.min(len, d + 0.001)), scale: scaleAt(d) }); }
  for (const k of s.keys ?? []) keys.push({ ...k, t: r3(k.t) });
  if (nd) { const [dx, dy] = vec(next?.in?.dir); keys.push({ t: r3(Math.max(0, len - nd - 0.001)), scale: scaleAt(len - nd) }, { t: r3(len - nd), x: 0, y: 0, scale: cover }, { t: r3(len), x: dx * push, y: dy * push, scale: cover, ease: "in" }); }
  keys.sort((a, b) => a.t - b.t);
  return { d, nd, len, keys, whip: !!(d || nd) };
}

/**
 * The template's shots whose slot got a video, as b-roll clips, cut end to end, with their moves (shotMoves). The
 * source second: the shot's from, or (a talking head) its start, so the speech runs on across cuts; kept inside the
 * video (a short video starts earlier). An edit given for the slot is followed through its cuts: a shot over one of
 * them becomes a clip each side ("s4", "s4.2"). Shots of the talking head on V1 (voiceSlot, no `from`) are left out:
 * V1 plays them (v1Plan).
 */
export function shotPlan(spec: MotionTemplate, videos: Videos, voiceSlot?: string) {
  const shots = spec.edit?.shots ?? [];
  return shots.flatMap((s, i) => {
    const v = videos.get(s.slot);
    if (!v || (voiceSlot && s.slot === voiceSlot && s.from == null)) return [];
    const m = shotMoves(spec, i, videos);
    const start = s.t0, len = m.len;
    let from = s.from ?? s.t0;
    if (v.seconds > 0 && from + len > v.seconds) from = Math.max(0, v.seconds - len);
    from = Math.max(0, from);
    return footageSpans(v, from, from + len).map((sp, k) => {
      const off = sp.from - from, plen = sp.to - sp.from;
      return { id: k ? `${s.id}.${k + 1}` : s.id, videoId: sp.videoId, start: r3(start + off), end: r3(start + off + plen), sourceStart: r3(sp.srcIn), keys: keysWithin(m.keys, off, plen), whip: m.whip, blur: s.blur };
    });
  });
}

/** The template's silhouette flashes whose slot got a video: short b-roll clips of that video, cut out and made white. */
const SIL_MIN = 0.055; // add_broll refuses under 0.05 s; a little over, so rounding never drops under it
export function silhouettePlan(spec: MotionTemplate, videos: Videos) {
  return (spec.edit?.silhouettes ?? []).flatMap((x, i) => {
    const v = videos.get(x.slot);
    if (!v) return [];
    // A b-roll clip is at least 0.05 s (one frame at 24 fps is 0.042), so a one-frame strobe is held just past it.
    const end = Math.min(spec.duration, x.t + Math.max(x.dur, SIL_MIN));
    if (end - x.t < SIL_MIN - 1e-6) return [];
    let from = x.from ?? x.t;
    if (v.seconds > 0 && from + (end - x.t) > v.seconds) from = Math.max(0, v.seconds - (end - x.t));
    const f = footageAt(v, Math.max(0, from));
    return [{ id: `f${i + 1}`, videoId: f.videoId, start: r3(x.t), end: r3(end), sourceStart: f.src }];
  });
}

/**
 * The talking head for V1: the video (or edit) in the first shot slot that runs on its own seconds (no `from`), from
 * its start for the template's length (or its own, if shorter). None when no such slot got a video.
 */
export function voiceClip(spec: MotionTemplate, videos: Videos) {
  const slot = (spec.edit?.shots ?? []).find((x) => x.from == null && videos.has(x.slot))?.slot;
  const v = slot ? videos.get(slot) : undefined;
  if (!v) return null;
  return { slot: slot as string, videoId: v.videoId, end: r3(Math.min(spec.duration, v.seconds > 0 ? v.seconds : spec.duration)) };
}

export type V1Clip = { videoId: string; srcIn: number; srcOut: number; start: number; end: number; label: string; keys: ShotKey[]; whip: boolean; blur?: number };
/**
 * V1 of a recreate with a talking head: its footage (a video, or an edit's cut pieces) for the template's length, then
 * the blank canvas, silent, for the rest. It is split at the talking head's shots and at the ends of their whips, so
 * each shot's moves (whips, zooms, blur) go on the V1 clips under it and the person matte (a title behind the person)
 * works on the clips that do not move.
 */
export function v1Plan(spec: MotionTemplate, videos: Videos, canvasId: string): V1Clip[] | null {
  const voice = voiceClip(spec, videos);
  if (!voice) return null;
  const v = videos.get(voice.slot)!;
  const shots = spec.edit?.shots ?? [];
  const mine = shots.map((s, i) => ({ s, i })).filter(({ s }) => s.slot === voice.slot && s.from == null).map(({ s, i }) => ({ s, m: shotMoves(spec, i, videos) }));
  const cuts = new Set<number>();
  // Cuts at the shots and just past each whip's snap back, so the clips between whips do not move.
  for (const { s, m } of mine) { cuts.add(r3(s.t0)); cuts.add(r3(s.t0 + m.len)); if (m.d) cuts.add(r3(s.t0 + m.d + 0.001)); if (m.nd) cuts.add(r3(s.t0 + m.len - m.nd - 0.001)); }
  const spans = footageSpans(v, 0, voice.end);
  const out: V1Clip[] = [];
  for (const sp of spans) {
    const inner = [...cuts].filter((c) => c > sp.from + 0.05 && c < sp.to - 0.05).sort((a, b) => a - b);
    const edges = [sp.from, ...inner, sp.to];
    for (let k = 0; k + 1 < edges.length; k++) {
      const a = edges[k], b = edges[k + 1], mid = (a + b) / 2;
      const hit = mine.find(({ s, m }) => mid >= s.t0 && mid < s.t0 + m.len);
      out.push({ videoId: sp.videoId, srcIn: r3(sp.srcIn + (a - sp.from)), srcOut: r3(sp.srcIn + (b - sp.from)), start: r3(a), end: r3(b), label: hit ? `talking head ${hit.s.id}` : "talking head", keys: hit ? keysWithin(hit.m.keys, a - hit.s.t0, b - a) : [], whip: !!hit?.m.whip, ...(hit?.s.blur ? { blur: hit.s.blur } : {}) });
    }
  }
  const total = out.length ? out[out.length - 1].end : 0;
  if (spec.duration - total > 0.05) out.push({ videoId: canvasId, srcIn: r3(total), srcOut: r3(spec.duration), start: r3(total), end: r3(spec.duration), label: "end (silent)", keys: [], whip: false });
  return out;
}

const aspectOf = (w: number, h: number): Aspect => { const r = w / h; return r > 1.4 ? "16:9" : r < 0.65 ? "9:16" : r < 0.9 ? "4:5" : "1:1"; };

/**
 * Recreate: the template with these slot values, as a new edit (a blank canvas, the graphic that plays it, b-roll for
 * the videos picked, the template's music and sound effects). Nothing is rendered: the editor or render_preview does.
 */
export async function recreateMotionTemplate(userId: string, id: string, slots: Record<string, unknown> = {}, o: { name?: string; folderId?: string | null; actorKind?: "user" | "claude" | "chatgpt" } = {}) {
  const t = await getMotionTemplate(userId, id);
  const spec = t.spec;
  const pics = await resolveSlotPictures(userId, spec, slots);
  const checked = motionSlotValues(spec, pics.values);
  if ("error" in checked) throw new AppError(checked.error, 400, "bad-template");
  const name = (o.name || `${spec.name}: ${checked.values.brand || "recreated"}`).slice(0, 200);
  const videoOf = new Map(pics.videos.map((v) => [v.slot, v]));
  // Layers marked behind (a disc the speaker walks in front of) go in a second graphic behind the person while the
  // talking head plays; the main graphic shows them from `until` on. With no talking-head video, one graphic.
  const shots = spec.edit?.shots ?? [];
  const behindOn = shots.some((x) => videoOf.has(x.slot)) && spec.layers.some((l) => (l as { behind?: unknown }).behind);
  const until = (l: MotionTemplate["layers"][number]) => ((l as { behind?: { until?: number } }).behind?.until ?? spec.duration);
  const mainSpec: MotionTemplate = behindOn ? { ...spec, layers: spec.layers.map((l) => ((l as { behind?: unknown }).behind ? { ...l, showFrom: until(l) } : l)) } : spec;
  const graphicId = await newGraphic(userId, `${spec.name} (recreated)`, mainSpec, motionTemplateHtml(mainSpec, checked.values), { template: false, transparent: pics.videos.length > 0, from: t.id });
  const behindId = behindOn ? await newGraphic(userId, `${spec.name} (behind the person)`, { ...spec, transparentBg: true, layers: spec.layers.filter((l) => (l as { behind?: unknown }).behind).map((l) => ({ ...l, showUntil: until(l) })) }, motionTemplateHtml({ ...spec, transparentBg: true, layers: spec.layers.filter((l) => (l as { behind?: unknown }).behind).map((l) => ({ ...l, showUntil: until(l) })) }, checked.values), { template: false, transparent: true, from: t.id }) : null;
  const aspect = aspectOf(spec.w, spec.h);
  const bg = typeof spec.design?.bg === "string" && /^#[0-9a-fA-F]{6}$/.test(spec.design.bg) ? spec.design.bg : "#000000";
  const canvas = await createCanvas(userId, { seconds: spec.duration, aspect, color: bg, name });
  const p = await createProject(userId, { videoId: canvas.id, name, folderId: o.folderId ?? null, aspect, length: spec.duration }, { actorKind: o.actorKind ?? "user" });
  const ops: Record<string, unknown>[] = [];
  // The talking head (the slot whose shots run on its own seconds, no `from`; a video or a cut edit) goes on V1 in
  // place of the canvas, first, so its speech plays the whole way through (b-roll has no sound), the person matte is
  // made from it, and everything after is placed at edit seconds over it. Its shots' moves go on its V1 clips.
  const v1 = v1Plan(spec, videoOf, canvas.id);
  const voice = voiceClip(spec, videoOf);
  if (v1) ops.push({ op: "set_clips", track: "v1", clips: v1.map((c) => ({ videoId: c.videoId, start: c.srcIn, end: c.srcOut, label: c.label })) });
  const at = { edit: true };
  const shotSlots = new Set(shots.map((x) => x.slot));
  for (const v of pics.videos) {
    if (shotSlots.has(v.slot)) continue; // the shots build these
    for (const l of spec.layers.filter((x) => x.kind === "backdrop" && (x as { src?: string }).src === `{{${v.slot}}}`)) {
      const start = l.t0 ?? 0, end = Math.min(spec.duration, l.t1 ?? spec.duration);
      for (const sp of footageSpans(v, 0, end - start)) ops.push({ op: "add_broll", videoId: sp.videoId, start: r3(start + sp.from), end: r3(start + sp.to), sourceStart: sp.srcIn, ...at });
    }
  }
  const plan = shotPlan(spec, videoOf, v1 ? voice?.slot : undefined);
  for (const p of plan) ops.push({ op: "add_broll", videoId: p.videoId, start: p.start, end: p.end, sourceStart: p.sourceStart, label: `shot ${p.id}`, ...at });
  const sils = silhouettePlan(spec, videoOf);
  for (const f of sils) ops.push({ op: "add_broll", videoId: f.videoId, start: f.start, end: f.end, sourceStart: f.sourceStart, label: `silhouette ${f.id}`, ...at });
  if (behindId) ops.push({ op: "add_graphic", graphicId: behindId, start: 0, end: spec.duration, behind: true, label: "behind the person", ...at });
  ops.push({ op: "add_graphic", graphicId, start: 0, end: spec.duration, ...at });
  if (spec.audio?.music) ops.push({ op: "add_music", trackId: spec.audio.music, gainDb: spec.audio.musicDb ?? -8, ...(spec.audio.musicStart != null ? { start: spec.audio.musicStart, ...at } : {}) });
  const sfxLen = { sfx_whoosh: 0.8, sfx_pop: 0.3, sfx_hit: 0.6 } as const;
  const sfx = (spec.audio?.sfx ?? []).filter((x) => x.t < spec.duration).map((x) => ({ start: x.t, end: Math.min(spec.duration, x.t + sfxLen[x.id]), sfxId: x.id }));
  if (sfx.length) ops.push({ op: "set_clips", track: "a3", clips: sfx, ...at });
  const kind = o.actorKind ?? "user";
  const actor = { kind, userId, ai: kind === "claude" ? "Claude" : kind === "chatgpt" ? "ChatGPT" : undefined, toolName: "recreate_template" } as const;
  const res = await applyTimelineChange(p.id, { op: "batch", ops } as unknown as Op, actor);
  // The shots' moves: whips (a push with motion blur), zooms and pans as keyframes, and the blur, on the clips made.
  const tracks = (res.snapshot as { timeline?: { tracks?: { v1?: { id: string }[]; v2?: { id: string; label?: string }[] } } }).timeline?.tracks;
  const v2 = tracks?.v2 ?? [], v1Ids = (tracks?.v1 ?? []).map((c) => c.id);
  const more: Record<string, unknown>[] = [];
  if (v1 && v1Ids.length === v1.length) {
    v1.forEach((c, i) => {
      if (c.keys.length) more.push({ op: "set_keyframes", track: "v1", clipId: v1Ids[i], keys: c.keys, motionBlur: c.whip ? 80 : 50 });
      if (c.blur) more.push({ op: "set_effects", clipIds: [v1Ids[i]], effects: [{ type: "blur", amount: c.blur }] });
    });
  }
  for (const sp of plan) {
    const c = v2.find((x) => x.label === `shot ${sp.id}`);
    if (!c) continue;
    if (sp.keys.length) more.push({ op: "set_keyframes", track: "v2", clipId: c.id, keys: sp.keys, motionBlur: sp.whip ? 80 : 50 });
    if (sp.blur) more.push({ op: "set_effects", clipIds: [c.id], effects: [{ type: "blur", amount: sp.blur }] });
  }
  // Silhouette flashes: the person cut out (an AI matte) and every pixel left pushed to white.
  const silIds = sils.map((f) => v2.find((x) => x.label === `silhouette ${f.id}`)?.id).filter((x): x is string => !!x);
  if (silIds.length) more.push({ op: "remove_background", clipIds: silIds, soft: 25 }, { op: "set_grade", clipIds: silIds, saturation: 0, curves: { master: [[0, 1], [1, 1]] } });
  if (more.length) await applyTimelineChange(p.id, { op: "batch", ops: more } as unknown as Op, actor);
  const { width, height } = aspectSize(aspect, 1080);
  return { projectId: p.id, graphicId, name, aspect, width, height, seconds: spec.duration, videos: pics.videos.length, shots: plan.length, silhouettes: silIds.length, ...(voice ? { voiceVideoId: voice.videoId } : {}), ...(behindId ? { behindGraphicId: behindId } : {}) };
}
