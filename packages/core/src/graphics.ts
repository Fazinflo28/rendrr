import { createHash } from "node:crypto";
import { prisma } from "@rendrr/db";
import { canonicalJson, findTemplate, graphicDefaults, PREFIX, type Timeline, type V3Clip } from "@rendrr/shared";
import { enqueue, queue, redis, type GraphicJob } from "./queue";
import { deleteObject, deletePrefix, headObject } from "./storage";

/**
 * One placement of a custom graphic plays its own recording when its params differ from the graphic's: a variant,
 * recorded once per set of values (the graphic's defaults with the placement's values on top) and kept in storage.
 */
export type GraphicVariant = { hash: string; key: string; params: Record<string, unknown>; progressId: string; jobId: string };
type GraphicRow = { id: string; ownerId: string | null; paramsSchema: unknown };

/** null: the placement plays the graphic's own recording (no params, or the same values as its defaults). */
export function graphicVariant(g: GraphicRow, clipParams?: Record<string, unknown> | null): GraphicVariant | null {
  const defaults = graphicDefaults(g.paramsSchema);
  // Only the names the graphic declared (add_graphic refuses others; set_clips does not check), and data (any JSON).
  const own = Object.fromEntries(Object.entries(clipParams ?? {}).filter(([k]) => k in defaults || k === "data"));
  const params = { ...defaults, ...own };
  if (canonicalJson(params) === canonicalJson(defaults)) return null;
  const hash = createHash("sha256").update(`${g.id}\n${canonicalJson(params)}`).digest("hex").slice(0, 20);
  return { hash, params, key: `${PREFIX.graphics}${g.ownerId}/${g.id}-v-${hash}.webm`, progressId: `${g.id}-v-${hash}`, jobId: `gv-${hash}` };
}

/** Why a variant could not be recorded (kept a day, so the same failing values are not queued again on every edit). */
const errorKey = (progressId: string) => `graphic:${progressId}:error`;
export async function setVariantError(progressId: string, message: string) {
  await redis().set(errorKey(progressId), message.slice(0, 500), "EX", 86400);
}
export async function clearVariantError(progressId: string) {
  await redis().del(errorKey(progressId));
}
export async function readVariantError(progressId: string): Promise<string | null> {
  return redis().get(errorKey(progressId)).catch(() => null);
}

/** What recording a variant noticed (a font that was not there), kept 30 days for get_project. */
const warningsKey = (progressId: string) => `graphic:${progressId}:warnings`;
export async function setVariantWarnings(progressId: string, warnings: string[]) {
  if (warnings.length) await redis().set(warningsKey(progressId), JSON.stringify(warnings), "EX", 30 * 86400);
  else await redis().del(warningsKey(progressId));
}
export async function readVariantWarnings(progressId: string): Promise<string[]> {
  const s = await redis().get(warningsKey(progressId)).catch(() => null);
  return s ? (JSON.parse(s) as string[]) : [];
}

const isCustomPlacement = (c: V3Clip) => c.kind === "graphic" && !!c.graphicId && !findTemplate(c.graphicId);

/**
 * After an edit is saved: queues a recording for each set of params a custom graphic is placed with that has none
 * yet, so the editor can show it and renders find it ready. One job per set (the job id dedupes).
 */
export async function prewarmGraphics(userId: string, timeline: Timeline) {
  const clips = (timeline.tracks.v3 as V3Clip[]).filter((c) => isCustomPlacement(c) && c.params && Object.keys(c.params).length);
  if (!clips.length) return 0;
  const gs = await prisma.graphic.findMany({ where: { id: { in: Array.from(new Set(clips.map((c) => c.graphicId!))) }, ownerId: userId, kind: "custom", status: { not: "failed" } }, select: { id: true, ownerId: true, paramsSchema: true } });
  const seen = new Set<string>();
  let queued = 0;
  for (const c of clips) {
    const g = gs.find((x) => x.id === c.graphicId);
    const v = g && graphicVariant(g, c.params);
    if (!g || !v || seen.has(v.hash)) continue;
    seen.add(v.hash);
    if ((await headObject(v.key)) || (await readVariantError(v.progressId))) continue;
    await enqueue<GraphicJob>("graphic", { graphicId: g.id, params: v.params }, { jobId: v.jobId, removeOnComplete: true, removeOnFail: true });
    queued++;
  }
  return queued;
}

/** What a placement of a custom graphic plays now: its file's storage key, or why there is none yet. */
export async function placementMedia(g: GraphicRow & { status: string; renderedKey: string | null; error: string | null }, clipParams?: Record<string, unknown> | null): Promise<{ key: string; warnings?: string[] } | { state: "recording" | "queued" | "failed"; percent?: number; error?: string }> {
  if (g.status === "failed") return { state: "failed", error: g.error ?? undefined };
  const v = graphicVariant(g, clipParams);
  if (!v) return g.status === "ready" && g.renderedKey ? { key: g.renderedKey } : { state: g.status === "rendering" ? "recording" : "queued" };
  if (await headObject(v.key)) return { key: v.key, warnings: await readVariantWarnings(v.progressId) };
  const err = await readVariantError(v.progressId);
  if (err) return { state: "failed", error: err };
  const p = await redis().get(`graphic:${v.progressId}:progress`).catch(() => null);
  return p ? { state: "recording", percent: (JSON.parse(p) as { percent: number }).percent } : { state: "queued" };
}

/** A failure on Rendrr's side (the browser or the server gave out), not in the graphic's code: recording it again can work. */
export const graphicFailedOnServer = (error: string | null | undefined) => /crashed while recording|too busy|not installed|ran out of threads/i.test(error || "");

/** The code a recording is made from, short: a recording whose code changed meanwhile (create_graphic replace) is dropped. */
export const codeHash = (code: string) => createHash("sha256").update(code).digest("hex").slice(0, 16);

/**
 * A custom graphic recorded again from its own code: after a failure (retry_graphic), when asked (rerecord), or after
 * its code changed (create_graphic replace). A job of its own (a finished or running job keeps its id and would stop a
 * new one with the same id); its status back to queued.
 */
export async function rerecordGraphic(graphicId: string) {
  await queue("graphic").remove(graphicId).catch(() => {});
  await prisma.graphic.update({ where: { id: graphicId }, data: { status: "queued", error: null, attempts: 0, changedAt: new Date() }, select: { id: true } });
  await enqueue<GraphicJob>("graphic", { graphicId }, { jobId: `${graphicId}-r${Date.now().toString(36)}` });
}

/**
 * A failed custom graphic recorded again from its own code (nothing to send again): queued as it was first. force: a
 * graphic that did not fail too (rerecord).
 */
export async function recordGraphicAgain(userId: string, graphicId: string, force = false) {
  const g = await prisma.graphic.findFirst({ where: { id: graphicId, ownerId: userId, kind: "custom" }, select: { id: true, status: true, code: true } });
  if (!g || !g.code) return null;
  if (g.status !== "failed" && !force) return { id: g.id, status: g.status, queued: false };
  await rerecordGraphic(g.id);
  return { id: g.id, status: "queued", queued: true };
}

/** Every placement recording (variant) of a graphic dropped (its code changed): files, notes, queued jobs. */
export async function dropVariants(ownerId: string, graphicId: string) {
  await deletePrefix(`${PREFIX.graphics}${ownerId}/${graphicId}-v-`);
  const r = redis();
  let cursor = "0";
  do {
    const [next, keys] = await r.scan(cursor, "MATCH", `graphic:${graphicId}-v-*`, "COUNT", 200);
    cursor = next;
    if (keys.length) await r.del(...keys);
  } while (cursor !== "0");
  for (const j of await queue("graphic").getJobs(["waiting", "delayed", "prioritized", "paused"]).catch(() => [])) {
    if (j?.data?.graphicId === graphicId && j.data.params) await j.remove().catch(() => {});
  }
}

/** The failures noted for a graphic's placements forgotten, so they are recorded again (retry_graphic). How many. */
export async function clearVariantErrors(graphicId: string) {
  const r = redis();
  let cursor = "0", n = 0;
  do {
    const [next, keys] = await r.scan(cursor, "MATCH", `graphic:${graphicId}-v-*:error`, "COUNT", 200);
    cursor = next;
    if (keys.length) { n += keys.length; await r.del(...keys); }
  } while (cursor !== "0");
  return n;
}

/** One placement's recording dropped so it is recorded again (add_graphic rerecord). Null: it plays the graphic's own. */
export async function dropVariant(g: GraphicRow, params?: Record<string, unknown> | null) {
  const v = graphicVariant(g, params);
  if (!v) return null;
  await deleteObject(v.key).catch(() => {});
  await redis().del(errorKey(v.progressId), warningsKey(v.progressId), `graphic:${v.progressId}:progress`).catch(() => {});
  await queue("graphic").remove(v.jobId).catch(() => {});
  await prisma.graphic.update({ where: { id: g.id }, data: { changedAt: new Date() }, select: { id: true } }).catch(() => {});
  return v;
}
