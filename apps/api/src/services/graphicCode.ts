// create_graphic without sending the whole code each time: start from another graphic's code (codeFrom), change it
// with find-and-replace edits, read it from a link (codeUrl) or have the AI's code workspace upload the file. replace:
// the graphic codeFrom names takes the new code itself (same id), so its placements are recorded again with it.
import { randomBytes } from "node:crypto";
import { prisma, Prisma } from "@rendrr/db";
import { AppError, dropVariant, dropVariants, enqueue, env, notFound, recordGraphicAgain, redis, rerecordGraphic, type GraphicJob } from "@rendrr/core";
import { CreateGraphicInput, customParamsSchema, graphicDefaults, type EditOp } from "@rendrr/shared";
import { fetchPublic } from "./fetchPublic";

export type CodeEdit = { find: string; replace: string; all?: boolean };
export type GraphicSource = {
  code?: string; codeFrom?: string; code_from?: string; codeUrl?: string; edits?: CodeEdit[]; replace?: boolean;
  durationSec?: number; width?: number; height?: number; transparent?: boolean; params?: Record<string, unknown>; name?: string;
};

const short = (s: string) => JSON.stringify(s.length > 60 ? s.slice(0, 57) + "..." : s);

/** The edits in order, each on the code as the ones before left it. A find that is not there, or there more than once
 *  without all: true, stops it (nothing is made) and says which edit. */
export function applyCodeEdits(code: string, edits: CodeEdit[]): string {
  edits.forEach((e, i) => {
    if (!e.find) throw new AppError(`Edit ${i + 1}: find is empty.`, 400, "bad-graphic");
    const n = code.split(e.find).length - 1;
    if (!n) throw new AppError(`Edit ${i + 1}: ${short(e.find)} is not in the code${i ? " (as the edits before it left it)" : ""}. Nothing was made.`, 400, "bad-graphic");
    if (n > 1 && !e.all) throw new AppError(`Edit ${i + 1}: ${short(e.find)} is in the code ${n} times. Make find longer so it is there once, or send all: true to change every one. Nothing was made.`, 400, "bad-graphic");
    code = e.all ? code.split(e.find).join(e.replace) : code.replace(e.find, () => e.replace);
  });
  return code;
}

/** A Google Drive or Dropbox share link as the file itself; anything else as it is. */
function directLink(url: string) {
  const d = /drive\.google\.com\/(?:file\/d\/|open\?id=)([\w-]{20,})/.exec(url);
  if (d) return `https://drive.google.com/uc?export=download&id=${d[1]}`;
  if (/^https:\/\/(www\.)?dropbox\.com\//.test(url)) return url.replace(/[?&]dl=0/, "").replace(/(\?|$)/, (m) => (m === "?" ? "?dl=1&" : "?dl=1"));
  return url;
}

/** The graphic's code and settings from what create_graphic was sent: the code, or codeFrom's / codeUrl's with the edits. */
export async function resolveGraphic(userId: string, i: GraphicSource) {
  const fromId = i.codeFrom ?? i.code_from;
  const from = fromId ? await prisma.graphic.findFirst({ where: { id: fromId, ownerId: userId, kind: "custom" } }) : null;
  if (fromId && (!from || !from.code)) throw notFound(`There is no graphic of yours "${fromId}" to take the code from. list_graphics shows yours.`);
  if (i.replace && !from) throw new AppError("replace: true changes the graphic codeFrom names: send codeFrom too.", 400, "bad-graphic");
  if ([i.code != null, !!i.codeUrl].filter(Boolean).length > 1) throw new AppError("Send the code one way: code, or codeUrl.", 400, "bad-graphic");
  let code = i.code;
  if (i.codeUrl) {
    const r = await fetchPublic(directLink(i.codeUrl), { max: 1_000_000, what: "graphic code", code: "bad-graphic" });
    code = r.buf.toString("utf8");
    if (/^\s*<!doctype html>[\s\S]*accounts\.google\.com/i.test(code)) throw new AppError("That link opens a sign-in page, not the code: share it so anyone with the link can view it.", 400, "bad-graphic");
  }
  code ??= from?.code ?? undefined;
  if (!code) throw new AppError("create_graphic needs the code: code, codeFrom (a graphic of yours to start from, with edits), codeUrl (a link to the file) or upload: true.", 400, "bad-graphic");
  if (i.edits?.length) code = applyCodeEdits(code, i.edits);
  const g = CreateGraphicInput.safeParse({
    code, name: i.name ?? (from && !i.replace ? `${from.name} (edited)`.slice(0, 120) : from?.name),
    durationSec: i.durationSec ?? from?.durationSec, width: i.width ?? from?.width, height: i.height ?? from?.height,
    transparent: i.transparent ?? from?.transparent ?? true, params: i.params ?? (from ? graphicDefaults(from.paramsSchema) : {}),
  });
  if (!g.success) {
    const miss = ["durationSec", "width", "height"].filter((k) => (i as Record<string, unknown>)[k] == null && !from);
    throw new AppError(miss.length ? `create_graphic needs ${miss.join(", ")} (or codeFrom: they are taken from that graphic).` : g.error.issues[0].message, 400, "bad-graphic");
  }
  return { g: g.data, from, edits: i.edits?.length ?? 0 };
}

/**
 * The graphic made (or, with replace, the one codeFrom names changed in place: its placements' recordings dropped and
 * everything recorded again with the new code), queued for recording.
 */
export async function saveGraphic(userId: string, r: Awaited<ReturnType<typeof resolveGraphic>>, replace = false) {
  const data = { name: (r.g.name || "Custom graphic").slice(0, 120), code: r.g.code, paramsSchema: customParamsSchema(r.g.params) as Prisma.InputJsonValue, durationSec: r.g.durationSec, width: r.g.width, height: r.g.height, transparent: r.g.transparent };
  if (replace && r.from) {
    await prisma.graphic.update({ where: { id: r.from.id }, data: { ...data, warnings: [] }, select: { id: true } });
    await dropVariants(userId, r.from.id);
    await rerecordGraphic(r.from.id);
    return { id: r.from.id, replaced: true };
  }
  const g = await prisma.graphic.create({ data: { ownerId: userId, kind: "custom", status: "queued", ...data } });
  await enqueue<GraphicJob>("graphic", { graphicId: g.id }, { jobId: g.id });
  return { id: g.id, replaced: false };
}

// The one-time upload link (create_graphic upload: true): what was asked is kept with it; the file is the code.
const UPLOAD_SECONDS = 30 * 60;
const uploadKey = (token: string) => `graphic-upload:${token}`;
export async function graphicUploadLink(userId: string, i: GraphicSource) {
  const token = randomBytes(24).toString("base64url");
  const { code: _c, codeUrl: _u, ...rest } = i;
  await redis().set(uploadKey(token), JSON.stringify({ userId, i: rest }), "EX", UPLOAD_SECONDS);
  const url = `${env().PUBLIC_API_URL.replace(/\/$/, "")}/graphics/upload/${token}`;
  return { url, host: new URL(url).host };
}
export async function graphicUploadFor(token: string) {
  const raw = await redis().get(uploadKey(token));
  if (!raw) throw new AppError("This upload link has expired or was used already. Call create_graphic with upload: true for a new one.", 404, "graphic-upload");
  return JSON.parse(raw) as { userId: string; i: GraphicSource };
}
export const usedGraphicUpload = (token: string) => redis().del(uploadKey(token));

/**
 * add_graphic rerecord: before the edit is saved, the kept recording for those params is dropped (or, for the
 * graphic's own values, the graphic is recorded again), so saving the edit queues a new one.
 */
export async function rerecordFirst(userId: string, edits: EditOp[]) {
  for (const e of edits) {
    if (e.op !== "add_graphic" || !e.rerecord) continue;
    const g = await prisma.graphic.findFirst({ where: { id: e.graphicId, ownerId: userId, kind: "custom" }, select: { id: true, ownerId: true, paramsSchema: true } });
    if (!g) continue; // a template or library item is drawn for each placement: nothing kept to drop
    const params = e.data !== undefined ? { ...(e.params ?? {}), data: e.data } : e.params;
    if (!(await dropVariant(g, params))) await recordGraphicAgain(userId, g.id, true);
  }
  return edits;
}
