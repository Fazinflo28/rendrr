// Show only the fix (audit #23): when a preview follows comments on the preview before it, the moments it changed,
// kept with the render (Render.plan.fix) for the Rendrr app's player: it plays them first, then the whole preview.
import { prisma } from "@rendrr/db";
import { changedMoments, mapMoment, withExportFormat, type Moment } from "@rendrr/shared";
import { planRender, type RenderPlan } from "@rendrr/shared/renderPlan";
import type { Snapshot } from "@rendrr/shared";

/** What a preview keeps: the version it is compared with, the moments to watch, and the comments it follows (each
 *  comment's moment in this preview, null when its footage is gone). The app shows the moments once one of those
 *  comments is resolved. */
export type FixView = { of: number; moments: Moment[]; comments: { id: string; at: number | null }[] };

/** The view from the two plans (pure): null when there is nothing worth showing apart from the whole preview. */
export function fixView(old: RenderPlan, plan: RenderPlan, of: number, comments: { id: string; time: number }[]): FixView | null {
  if (!comments.length) return null;
  const at = comments.map((c) => ({ id: c.id, at: mapMoment(old, plan, c.time) }));
  const moments = changedMoments(old, plan, at.map((c) => c.at).filter((t): t is number => t != null));
  return moments && moments.length ? { of, moments, comments: at } : null;
}

type PlanInput = Parameters<typeof planRender>[0];

/**
 * The moments this preview changed since the last preview before it, when comments were made on that one. Best
 * effort: anything missing (no earlier preview, its version gone, a plan that cannot be made) is just no view.
 */
export async function previewFix(r: { id: string; projectId: string; version: number; createdAt: Date }, plan: RenderPlan, input: PlanInput): Promise<FixView | null> {
  try {
    const prev = await prisma.render.findFirst({ where: { projectId: r.projectId, kind: "preview", status: "done", version: { lt: r.version }, createdAt: { lt: r.createdAt } }, orderBy: { createdAt: "desc" }, select: { id: true, version: true, createdAt: true } });
    if (!prev) return null;
    const window = { gte: prev.createdAt, lt: r.createdAt };
    const [notes, client, pv] = await Promise.all([
      prisma.projectComment.findMany({ where: { projectId: r.projectId, OR: [{ renderId: prev.id }, { renderId: null, createdAt: window }] }, select: { id: true, time: true }, take: 200 }),
      prisma.reviewComment.findMany({ where: { createdAt: window, OR: [{ projectId: r.projectId }, { projectId: null, review: { projectId: r.projectId } }] }, select: { id: true, time: true }, take: 200 }),
      prisma.projectVersion.findUnique({ where: { projectId_v: { projectId: r.projectId, v: prev.version } }, select: { timeline: true } }),
    ]);
    const comments = [...notes, ...client];
    if (!comments.length || !pv) return null;
    const old = planRender({ ...input, snapshot: withExportFormat(pv.timeline as unknown as Snapshot, null) });
    return fixView(old, plan, prev.version, comments);
  } catch (e) {
    console.error(`[render] ${r.id}: the changed moments were not worked out:`, (e as Error).message.slice(0, 200));
    return null;
  }
}
