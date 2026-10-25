import { publishGraphic, uploadFile, type GraphicJob } from "@rendrr/core";
import { prisma } from "@rendrr/db";
import { PREFIX } from "@rendrr/shared";
import { recordHtml } from "../lib/graphics";
import type { Ctx } from "../lib/job";

// A custom graphic from the AI: record it once, keep the transparent WebM and four check frames.
export async function graphicJob(ctx: Ctx) {
  const { graphicId } = ctx.job.data as GraphicJob;
  const g = await prisma.graphic.findUnique({ where: { id: graphicId } });
  if (!g || g.kind !== "custom" || !g.code) return;
  await prisma.graphic.update({ where: { id: g.id }, data: { status: "rendering", attempts: { increment: 1 }, error: null } });
  // Progress (and a time left from the pace so far) for list_graphics, at most every 2 s.
  const t0 = Date.now();
  let sent = 0;
  const onProgress = (p: number) => {
    if (Date.now() - sent < 2000 && p < 1) return;
    sent = Date.now();
    const el = (Date.now() - t0) / 1000;
    publishGraphic(g.id, { percent: Math.round(p * 100), etaSec: p > 0.03 ? Math.round((el / p) * (1 - p)) : null }).catch(() => {});
  };
  await publishGraphic(g.id, { percent: 0, etaSec: null }).catch(() => {});
  const r = await recordHtml(g.code, { width: g.width, height: g.height, durationSec: g.durationSec, transparent: g.transparent, dir: ctx.dir, signal: ctx.signal, onProgress });
  console.log(`[graphic] ${g.id}: ${g.durationSec}s at ${g.width}x${g.height} recorded in ${((Date.now() - t0) / 1000).toFixed(1)}s (${r.pictures} pictures, ${r.dense} frames one by one)`);
  const base = `${PREFIX.graphics}${g.ownerId}/${g.id}`;
  await uploadFile(`${base}.webm`, r.path, "video/webm");
  const checks: string[] = [];
  for (const [i, f] of r.checkFrames.entries()) { await uploadFile(`${base}-check${i}.png`, f, "image/png"); checks.push(`${base}-check${i}.png`); }
  await prisma.graphic.update({ where: { id: g.id }, data: { status: "ready", renderedKey: `${base}.webm`, checkFrames: checks, durationSec: r.seconds, error: null } });
}

export async function graphicFailed(graphicId: string, message: string) {
  await prisma.graphic.updateMany({ where: { id: graphicId }, data: { status: "failed", error: message.slice(0, 500) } });
}
