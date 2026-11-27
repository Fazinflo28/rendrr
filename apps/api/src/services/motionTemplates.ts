// Motion templates (packages/shared/src/motionTemplate.ts): Rendrr's own and the user's, saved as custom graphics whose
// params schema carries the template. Recreate fills the slots (words, pictures, colours, a video for a full-screen
// picture), makes the graphic that plays it and a blank edit around it (the graphic, b-roll for videos, the template's
// music and sound effects), ready to render.
import { prisma, Prisma } from "@rendrr/db";
import { AppError, applyTimelineChange, enqueue, getBytes, notFound, type GraphicJob } from "@rendrr/core";
import {
  aspectSize, builtinMotionTemplate, checkMotionTemplate, customParamsSchema, deriveMotionTemplate, MOTION_HTML_MAX, MOTION_TEMPLATES,
  MOTION_VIDEO_PREFIX, motionSlotValues, motionTemplateHtml, motionTemplateLite, motionTemplateText, type Aspect, type MotionTemplate, type Op,
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
});

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
  const videos: { slot: string; videoId: string }[] = [];
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
    const video = await prisma.video.findFirst({ where: { id: v, userId }, select: { id: true, still: true, thumbKey: true, status: true, name: true } });
    if (video) {
      if (!video.still && s.video) { videos.push({ slot: s.id, videoId: video.id }); out[s.id] = MOTION_VIDEO_PREFIX + video.id; continue; }
      if (!video.thumbKey) throw new AppError(`"${video.name}" has no picture yet (still processing). Try again in a moment.`, 409, "bad-template");
      if (!video.still) throw new AppError(`"${s.label}" takes a picture; "${video.name}" is a video. Pick a picture, or a slot marked video.`, 400, "bad-template");
      out[s.id] = dataUrl(await getBytes(video.thumbKey), "image/jpeg");
      continue;
    }
    const el = await prisma.graphic.findFirst({ where: { id: v, ownerId: userId, kind: "element" }, select: { sourceKey: true, thumbKey: true } });
    const key = el?.sourceKey ?? el?.thumbKey;
    if (key) { const buf = await getBytes(key); out[s.id] = dataUrl(buf, imageType("", buf) ?? "image/png"); continue; }
    throw new AppError(`"${s.label}" takes a picture: a data:image URL, an https link to a picture, or the id of a picture or element in your library.`, 400, "bad-template");
  }
  return { values: out, videos };
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
  const graphicId = await newGraphic(userId, `${spec.name} (recreated)`, spec, motionTemplateHtml(spec, checked.values), { template: false, transparent: pics.videos.length > 0, from: t.id });
  const aspect = aspectOf(spec.w, spec.h);
  const bg = typeof spec.design?.bg === "string" && /^#[0-9a-fA-F]{6}$/.test(spec.design.bg) ? spec.design.bg : "#000000";
  const canvas = await createCanvas(userId, { seconds: spec.duration, aspect, color: bg, name });
  const p = await createProject(userId, { videoId: canvas.id, name, folderId: o.folderId ?? null, aspect, length: spec.duration }, { actorKind: o.actorKind ?? "user" });
  const ops: Record<string, unknown>[] = [];
  for (const v of pics.videos) {
    for (const l of spec.layers.filter((x) => x.kind === "backdrop" && (x as { src?: string }).src === `{{${v.slot}}}`)) {
      ops.push({ op: "add_broll", videoId: v.videoId, start: l.t0 ?? 0, end: Math.min(spec.duration, l.t1 ?? spec.duration), sourceStart: 0 });
    }
  }
  ops.push({ op: "add_graphic", graphicId, start: 0, end: spec.duration });
  if (spec.audio?.music) ops.push({ op: "add_music", trackId: spec.audio.music, gainDb: spec.audio.musicDb ?? -8 });
  const sfxLen = { sfx_whoosh: 0.8, sfx_pop: 0.3, sfx_hit: 0.6 } as const;
  const sfx = (spec.audio?.sfx ?? []).filter((x) => x.t < spec.duration).map((x) => ({ start: x.t, end: Math.min(spec.duration, x.t + sfxLen[x.id]), sfxId: x.id }));
  if (sfx.length) ops.push({ op: "set_clips", track: "a3", clips: sfx });
  const kind = o.actorKind ?? "user";
  await applyTimelineChange(p.id, { op: "batch", ops } as unknown as Op, { kind, userId, ai: kind === "claude" ? "Claude" : kind === "chatgpt" ? "ChatGPT" : undefined, toolName: "recreate_template" });
  const { width, height } = aspectSize(aspect, 1080);
  return { projectId: p.id, graphicId, name, aspect, width, height, seconds: spec.duration, videos: pics.videos.length };
}
