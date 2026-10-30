import { codeHash, graphicVariant, publishGraphic, setVariantError, setVariantWarnings, uploadFile, type GraphicJob } from "@rendrr/core";
import { prisma } from "@rendrr/db";
import { graphicDefaults, PREFIX } from "@rendrr/shared";
import { customGraphicHtml, fontWarning, GRAPHIC_FIELDS, recordHtml } from "../lib/graphics";
import type { Ctx } from "../lib/job";

// Progress (and a time left from the pace so far) for list_graphics, at most every 2 s.
function progressTo(id: string) {
  const t0 = Date.now();
  let sent = 0;
  return (p: number) => {
    if (Date.now() - sent < 2000 && p < 1) return;
    sent = Date.now();
    const el = (Date.now() - t0) / 1000;
    publishGraphic(id, { percent: Math.round(p * 100), etaSec: p > 0.03 ? Math.round((el / p) * (1 - p)) : null }).catch(() => {});
  };
}

// A custom graphic from the AI: record it once, keep the transparent WebM and four check frames. With params, a
// variant for a placement: the same code with other window.params, recorded once and kept by its values.
export async function graphicJob(ctx: Ctx) {
  const { graphicId, params } = ctx.job.data as GraphicJob;
  const g = await prisma.graphic.findUnique({ where: { id: graphicId }, select: GRAPHIC_FIELDS });
  if (!g || g.kind !== "custom" || !g.code) return;
  if (params) return variantJob(ctx, g as typeof g & { code: string }, params);
  await prisma.graphic.update({ where: { id: g.id }, data: { status: "rendering", attempts: { increment: 1 }, error: null }, select: { id: true } });
  const t0 = Date.now();
  await publishGraphic(g.id, { percent: 0, etaSec: null }).catch(() => {});
  const r = await recordHtml(await customGraphicHtml(g.code, graphicDefaults(g.paramsSchema), g.ownerId), { width: g.width, height: g.height, durationSec: g.durationSec, transparent: g.transparent, dir: ctx.dir, signal: ctx.signal, onProgress: progressTo(g.id) });
  console.log(`[graphic] ${g.id}: ${g.durationSec}s at ${g.width}x${g.height} recorded in ${((Date.now() - t0) / 1000).toFixed(1)}s (${r.pictures} pictures, ${r.dense} frames one by one)`);
  if (await codeChanged(g.id, g.code)) return;
  const base = `${PREFIX.graphics}${g.ownerId}/${g.id}`;
  await uploadFile(`${base}.webm`, r.path, "video/webm");
  const checks: string[] = [];
  for (const [i, f] of r.checkFrames.entries()) { await uploadFile(`${base}-check${i}.png`, f, "image/png"); checks.push(`${base}-check${i}.png`); }
  await prisma.graphic.update({ where: { id: g.id }, data: { status: "ready", renderedKey: `${base}.webm`, checkFrames: checks, durationSec: r.seconds, error: null }, select: { id: true } });
  if (r.missingFonts.length) console.log(`[graphic] ${g.id}: fonts drawn with a fallback: ${r.missingFonts.join(", ")}`);
  // Apart, so a database the deploy has not migrated yet costs the warning only, never the graphic.
  await prisma.graphic.update({ where: { id: g.id }, data: { warnings: fontWarning(r.missingFonts) }, select: { id: true } }).catch((e) => console.error(`[graphic] ${g.id}: warnings not saved: ${(e as Error).message.slice(0, 200)}`));
}

async function variantJob(ctx: Ctx, g: { id: string; ownerId: string | null; code: string; paramsSchema: unknown; width: number; height: number; durationSec: number; transparent: boolean }, params: Record<string, unknown>) {
  const v = graphicVariant(g, params);
  if (!v) return;
  const t0 = Date.now();
  await publishGraphic(v.progressId, { percent: 0, etaSec: null }).catch(() => {});
  const r = await recordHtml(await customGraphicHtml(g.code, v.params, g.ownerId), { width: g.width, height: g.height, durationSec: g.durationSec, transparent: g.transparent, dir: ctx.dir, signal: ctx.signal, onProgress: progressTo(v.progressId) });
  if (await codeChanged(g.id, g.code)) return;
  await uploadFile(v.key, r.path, "video/webm");
  await setVariantWarnings(v.progressId, fontWarning(r.missingFonts)).catch(() => {});
  console.log(`[graphic] ${g.id} variant ${v.hash}: recorded in ${((Date.now() - t0) / 1000).toFixed(1)}s (${r.pictures} pictures)`);
}

/** The graphic's code changed while it recorded (create_graphic replace): this recording is dropped (the new code's own
 *  recording was queued with the change). */
async function codeChanged(id: string, code: string) {
  const now = await prisma.graphic.findUnique({ where: { id }, select: { code: true } });
  if (now?.code && codeHash(now.code) === codeHash(code)) return false;
  console.log(`[graphic] ${id}: its code changed while it recorded; this recording is dropped`);
  return true;
}

/** A failed variant is noted for its placements (get_project, the editor); the graphic itself stays as it is. */
export async function graphicFailed(job: GraphicJob, message: string) {
  if (job.params) {
    const g = await prisma.graphic.findUnique({ where: { id: job.graphicId }, select: { id: true, ownerId: true, paramsSchema: true } });
    const v = g && graphicVariant(g, job.params);
    if (v) await setVariantError(v.progressId, message);
    return;
  }
  await prisma.graphic.updateMany({ where: { id: job.graphicId }, data: { status: "failed", error: message.slice(0, 500) } });
}
