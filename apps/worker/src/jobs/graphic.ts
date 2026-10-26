import { graphicVariant, publishGraphic, setVariantError, uploadFile, type GraphicJob } from "@rendrr/core";
import { prisma } from "@rendrr/db";
import { graphicDefaults, PREFIX, withParams } from "@rendrr/shared";
import { recordHtml } from "../lib/graphics";
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
  const g = await prisma.graphic.findUnique({ where: { id: graphicId } });
  if (!g || g.kind !== "custom" || !g.code) return;
  if (params) return variantJob(ctx, g as typeof g & { code: string }, params);
  await prisma.graphic.update({ where: { id: g.id }, data: { status: "rendering", attempts: { increment: 1 }, error: null } });
  const t0 = Date.now();
  await publishGraphic(g.id, { percent: 0, etaSec: null }).catch(() => {});
  const r = await recordHtml(withParams(g.code, graphicDefaults(g.paramsSchema)), { width: g.width, height: g.height, durationSec: g.durationSec, transparent: g.transparent, dir: ctx.dir, signal: ctx.signal, onProgress: progressTo(g.id) });
  console.log(`[graphic] ${g.id}: ${g.durationSec}s at ${g.width}x${g.height} recorded in ${((Date.now() - t0) / 1000).toFixed(1)}s (${r.pictures} pictures, ${r.dense} frames one by one)`);
  const base = `${PREFIX.graphics}${g.ownerId}/${g.id}`;
  await uploadFile(`${base}.webm`, r.path, "video/webm");
  const checks: string[] = [];
  for (const [i, f] of r.checkFrames.entries()) { await uploadFile(`${base}-check${i}.png`, f, "image/png"); checks.push(`${base}-check${i}.png`); }
  await prisma.graphic.update({ where: { id: g.id }, data: { status: "ready", renderedKey: `${base}.webm`, checkFrames: checks, durationSec: r.seconds, error: null } });
}

async function variantJob(ctx: Ctx, g: { id: string; ownerId: string | null; code: string; paramsSchema: unknown; width: number; height: number; durationSec: number; transparent: boolean }, params: Record<string, unknown>) {
  const v = graphicVariant(g, params);
  if (!v) return;
  const t0 = Date.now();
  await publishGraphic(v.progressId, { percent: 0, etaSec: null }).catch(() => {});
  const r = await recordHtml(withParams(g.code, v.params), { width: g.width, height: g.height, durationSec: g.durationSec, transparent: g.transparent, dir: ctx.dir, signal: ctx.signal, onProgress: progressTo(v.progressId) });
  await uploadFile(v.key, r.path, "video/webm");
  console.log(`[graphic] ${g.id} variant ${v.hash}: recorded in ${((Date.now() - t0) / 1000).toFixed(1)}s (${r.pictures} pictures)`);
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
