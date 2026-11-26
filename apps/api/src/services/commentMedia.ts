// What a comment can carry besides its words (the Rendrr app in the chat): a drawing on the picture and pictures.
// Files live under comments/<user>/<edit>/<comment>/, so deleting the comment or the edit takes them too.
import { randomBytes } from "node:crypto";
import { AppError, deleteObjects, deletePrefix, notFound, putObject, signGet } from "@rendrr/core";
import { prisma, type ProjectComment } from "@rendrr/db";
import { COMMENT_IMAGES_MAX, PREFIX, type CommentDrawing, type CommentImage, type Stroke } from "@rendrr/shared";

export type DrawingIn = CommentDrawing & { png?: string };
export type ImageIn = { name?: string; type: "image/jpeg" | "image/png" | "image/webp"; data: string; w?: number; h?: number };
type StoredDrawing = CommentDrawing & { key?: string };
type StoredImage = { key: string; w: number | null; h: number | null; name: string | null };

const IMAGE_BYTES = 1_100_000, DRAWING_BYTES = 600_000;
const EXT = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" } as const;

export const commentPrefix = (userId: string, projectId: string, commentId?: string) => `${PREFIX.comments}${userId}/${projectId}/${commentId ? commentId + "/" : ""}`;

/** The file a picture says it is, by its first bytes (a name or a type field can say anything). */
function kindOf(b: Buffer): keyof typeof EXT | null {
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (b.length > 12 && b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  return null;
}
function decode(data: string, max: number, what: string): Buffer {
  const b = Buffer.from(data.replace(/^data:[^,]*,/, ""), "base64");
  if (!b.length) throw new AppError(`That ${what} is empty.`, 400, "comment-media");
  if (b.length > max) throw new AppError(`That ${what} is too big (${(b.length / 1e6).toFixed(1)} MB, up to ${(max / 1e6).toFixed(1)} MB).`, 400, "comment-media");
  return b;
}
/** Strokes kept to 4 decimals (a tenth of a pixel on a 4K picture), so a drawing stays small. */
const tidy = (strokes: Stroke[]): Stroke[] => strokes.map((s) => ({ c: s.c.toLowerCase(), w: Math.round(s.w * 1e4) / 1e4, p: s.p.map((v) => Math.round(v * 1e4) / 1e4) }));

export async function saveDrawing(userId: string, projectId: string, commentId: string, d: DrawingIn): Promise<StoredDrawing> {
  const out: StoredDrawing = { w: d.w, h: d.h, strokes: tidy(d.strokes) };
  if (d.png) {
    const b = decode(d.png, DRAWING_BYTES, "drawing");
    if (kindOf(b) !== "image/png") throw new AppError("The drawing must be a PNG.", 400, "comment-media");
    out.key = `${commentPrefix(userId, projectId, commentId)}drawing-${randomBytes(4).toString("hex")}.png`;
    await putObject(out.key, b, "image/png");
  }
  return out;
}

export async function saveImages(userId: string, projectId: string, commentId: string, imgs: ImageIn[]): Promise<StoredImage[]> {
  const out: StoredImage[] = [];
  for (const im of imgs) {
    const b = decode(im.data, IMAGE_BYTES, "picture");
    const kind = kindOf(b);
    if (!kind) throw new AppError("A picture must be a JPEG, PNG or WebP file.", 400, "comment-media");
    const key = `${commentPrefix(userId, projectId, commentId)}${randomBytes(6).toString("hex")}.${EXT[kind]}`;
    await putObject(key, b, kind);
    out.push({ key, w: im.w ?? null, h: im.h ?? null, name: im.name?.slice(0, 200) || null });
  }
  return out;
}

export const storedImages = (c: Pick<ProjectComment, "images">): StoredImage[] => (Array.isArray(c.images) ? (c.images as unknown as StoredImage[]) : []);
export const storedDrawing = (c: Pick<ProjectComment, "drawing">): StoredDrawing | null => (c.drawing && typeof c.drawing === "object" ? (c.drawing as unknown as StoredDrawing) : null);
/** A picture's id: the last part of its file name. */
export const imageId = (key: string) => key.slice(key.lastIndexOf("/") + 1);

/** The drawing and pictures as the app and the editor show them (pictures as links for 6 hours). */
export async function commentMedia(c: Pick<ProjectComment, "drawing" | "images">): Promise<{ drawing: CommentDrawing | null; images: CommentImage[] }> {
  const d = storedDrawing(c);
  return {
    drawing: d ? { w: d.w, h: d.h, strokes: d.strokes } : null,
    images: await Promise.all(storedImages(c).map(async (im) => ({ id: imageId(im.key), url: await signGet(im.key, 6 * 3600), w: im.w, h: im.h, name: im.name }))),
  };
}

/** Every file of a comment. */
export const commentKeys = (c: Pick<ProjectComment, "drawing" | "images">) => [storedDrawing(c)?.key, ...storedImages(c).map((i) => i.key)].filter((k): k is string => !!k);
export const deleteCommentFiles = (c: Pick<ProjectComment, "drawing" | "images">) => deleteObjects(commentKeys(c));
export const deleteEditCommentFiles = (userId: string, projectId: string) => deletePrefix(commentPrefix(userId, projectId));

// ---------------- the user's notes: add, edit, delete (the app in the chat and the editor) ----------------

const empty = (text: string, d: unknown, imgs: number) => { if (!text.trim() && !d && !imgs) throw new AppError("Write a comment, draw on the picture or add a picture first.", 400, "empty-comment"); };

/** A note at a moment of the edited video, with its drawing and pictures (the preview it was made on, when known). */
/** A pin's spot (x, y in 0-1 of the frame), only when both are there. */
export const pinOf = (i: { x?: number | null; y?: number | null }) => (i.x != null && i.y != null && Number.isFinite(i.x) && Number.isFinite(i.y) ? { x: Math.round(Math.min(1, Math.max(0, i.x)) * 1e4) / 1e4, y: Math.round(Math.min(1, Math.max(0, i.y)) * 1e4) / 1e4 } : null);
/** A comment's pin as it goes out (nothing for a plain comment). */
export const pinOut = (c: { x?: number | null; y?: number | null }) => { const p = pinOf(c); return p ? { x: p.x, y: p.y } : {}; };

export async function addNote(userId: string, projectId: string, i: { time: number; text: string; renderId?: string; drawing?: DrawingIn; images?: ImageIn[]; x?: number; y?: number }) {
  empty(i.text, i.drawing, i.images?.length ?? 0);
  if ((i.images?.length ?? 0) > COMMENT_IMAGES_MAX) throw new AppError(`Up to ${COMMENT_IMAGES_MAX} pictures on a comment.`, 400, "comment-media");
  const render = i.renderId ? await prisma.render.findFirst({ where: { id: i.renderId, projectId }, select: { id: true } }) : null;
  const n = await prisma.projectComment.create({ data: { projectId, userId, time: i.time, text: i.text.trim(), renderId: render?.id ?? null, ...(pinOf(i) ?? {}) } });
  try {
    const drawing = i.drawing ? await saveDrawing(userId, projectId, n.id, i.drawing) : null;
    const images = i.images?.length ? await saveImages(userId, projectId, n.id, i.images) : [];
    if (!drawing && !images.length) return n;
    return await prisma.projectComment.update({ where: { id: n.id }, data: { ...(drawing ? { drawing: drawing as never } : {}), ...(images.length ? { images: images as never } : {}) } });
  } catch (e) {
    // Nothing half made: the note and any file it got go.
    await deletePrefix(commentPrefix(userId, projectId, n.id)).catch(() => {});
    await prisma.projectComment.delete({ where: { id: n.id } }).catch(() => {});
    throw e;
  }
}

/** Change the user's own note: text, drawing (null takes it off), pictures off (by id) and on. */
export async function editNote(userId: string, commentId: string, i: { text?: string; drawing?: DrawingIn | null; removeImages?: string[]; images?: ImageIn[] }) {
  const n = await prisma.projectComment.findUnique({ where: { id: commentId } });
  if (!n || n.userId !== userId) throw notFound("That comment is gone, or it is not yours to change.");
  const text = i.text !== undefined ? i.text.trim() : n.text;
  const old = storedDrawing(n);
  const drop = new Set(i.removeImages ?? []);
  const kept = storedImages(n).filter((im) => !drop.has(imageId(im.key)));
  if (kept.length + (i.images?.length ?? 0) > COMMENT_IMAGES_MAX) throw new AppError(`Up to ${COMMENT_IMAGES_MAX} pictures on a comment.`, 400, "comment-media");
  const drawing = i.drawing === undefined ? old : i.drawing === null ? null : await saveDrawing(userId, n.projectId, n.id, i.drawing);
  const added = i.images?.length ? await saveImages(userId, n.projectId, n.id, i.images) : [];
  try { empty(text, drawing, kept.length + added.length); } catch (e) { await deleteObjects([...(drawing !== old ? [drawing?.key] : []), ...added.map((a) => a.key)]); throw e; }
  const out = await prisma.projectComment.update({ where: { id: n.id }, data: {
    text, editedAt: text !== n.text || drawing !== old || drop.size || added.length ? new Date() : n.editedAt,
    drawing: (drawing ?? null) as never, images: [...kept, ...added] as never,
  } });
  // The files nothing points to any more.
  await deleteObjects([...(drawing !== old ? [old?.key] : []), ...storedImages(n).filter((im) => drop.has(imageId(im.key))).map((im) => im.key)]);
  return out;
}

/** Delete a comment on one of the user's edits: their own note (and its files), or a client's comment. Returns the edit. */
export async function deleteComment(userId: string, commentId: string): Promise<string | null> {
  const c = await prisma.reviewComment.findUnique({ where: { id: commentId }, include: { review: true } });
  if (c && c.review.userId === userId) { await prisma.reviewComment.delete({ where: { id: c.id } }); return c.projectId ?? c.review.projectId ?? null; }
  const n = await prisma.projectComment.findUnique({ where: { id: commentId } });
  if (!n || n.userId !== userId) throw notFound("That comment is gone.");
  await prisma.projectComment.delete({ where: { id: n.id } });
  await deletePrefix(commentPrefix(userId, n.projectId, n.id)).catch(() => {});
  return n.projectId;
}

const COLOUR_NAMES: [string, [number, number, number]][] = [["red", [255, 59, 48]], ["yellow", [255, 214, 10]], ["green", [52, 199, 89]], ["blue", [10, 132, 255]], ["white", [255, 255, 255]], ["black", [0, 0, 0]], ["orange", [255, 149, 0]], ["pink", [255, 55, 95]], ["purple", [175, 82, 222]]];
const colourName = (hex: string) => {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return COLOUR_NAMES.reduce((a, b) => (b[1].reduce((s, v, i) => s + (v - c[i]) ** 2, 0) < a[1].reduce((s, v, i) => s + (v - c[i]) ** 2, 0) ? b : a))[0];
};
/** A drawing in words for the AI: "a drawing in red: 2 strokes over x 40-62%, y 18-35% of the picture". */
export function drawingText(d: CommentDrawing): string {
  const xs: number[] = [], ys: number[] = [];
  for (const s of d.strokes) for (let k = 0; k + 1 < s.p.length; k += 2) { xs.push(s.p[k]); ys.push(s.p[k + 1]); }
  const pc = (v: number) => Math.round(v * 100);
  const colours = Array.from(new Set(d.strokes.map((s) => colourName(s.c))));
  return `a drawing in ${colours.join(" and ")}: ${d.strokes.length} ${d.strokes.length === 1 ? "stroke" : "strokes"} over x ${pc(Math.min(...xs))}-${pc(Math.max(...xs))}%, y ${pc(Math.min(...ys))}-${pc(Math.max(...ys))}% of the picture`;
}
