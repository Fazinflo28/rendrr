import { createHash } from "node:crypto";
import { prisma } from "@rendrr/db";
import { canonicalJson, graphicDefaults, GRAPHIC_TEMPLATES, PREFIX, type Timeline, type V3Clip } from "@rendrr/shared";
import { enqueue, redis, type GraphicJob } from "./queue";
import { headObject } from "./storage";

/**
 * One placement of a custom graphic plays its own recording when its params differ from the graphic's: a variant,
 * recorded once per set of values (the graphic's defaults with the placement's values on top) and kept in storage.
 */
export type GraphicVariant = { hash: string; key: string; params: Record<string, unknown>; progressId: string; jobId: string };
type GraphicRow = { id: string; ownerId: string | null; paramsSchema: unknown };

/** null: the placement plays the graphic's own recording (no params, or the same values as its defaults). */
export function graphicVariant(g: GraphicRow, clipParams?: Record<string, unknown> | null): GraphicVariant | null {
  const defaults = graphicDefaults(g.paramsSchema);
  // Only the names the graphic declared (add_graphic refuses others; set_clips does not check).
  const own = Object.fromEntries(Object.entries(clipParams ?? {}).filter(([k]) => k in defaults));
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

const isCustomPlacement = (c: V3Clip) => c.kind === "graphic" && !!c.graphicId && !GRAPHIC_TEMPLATES.some((t) => t.id === c.graphicId);

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
