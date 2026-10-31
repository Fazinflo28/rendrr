// Samples (render_samples): a few frames and short clips of an edit, rendered on their own (the worker's sample kind)
// and shown in the chat's Rendrr app as a storyboard. The user asks for changes on each one: those are comments on the
// sample render at the sample's edit time, so get_comments and get_samples read them.
import { AppError, enqueue, publishRender, signGet, type RenderJob } from "@rendrr/core";
import { prisma, type Render } from "@rendrr/db";
import { SAMPLE_STEPS, SampleError, sampleClock, sampleItems, samplesText, type AppComment, type AppSamples, type SampleDone, type SamplePlan, type SampleRequest } from "@rendrr/shared";
import { renderTimeoutMs } from "@rendrr/shared";
import { getOwnedProject } from "./projects";
import { renderStatus } from "./render";
import { commentMedia } from "./commentMedia";

const WEB = () => (process.env.PUBLIC_WEB_URL || "").replace(/\/$/, "") || null;
const LINK_SECONDS = 6 * 3600;
const same = (a: SamplePlan["items"], b: SamplePlan["items"]) => JSON.stringify(a.map(({ kind, at, end }) => [kind, at, end ?? null])) === JSON.stringify(b.map(({ kind, at, end }) => [kind, at, end ?? null]));

/**
 * Starts a set of samples of the edit's latest version. The same samples of the same version already rendering are
 * joined, and already rendered are returned (with the new notes), instead of rendering again.
 */
export async function startSamples(userId: string, projectId: string, req: SampleRequest): Promise<Render> {
  const p = await getOwnedProject(userId, projectId);
  const video = await prisma.video.findUniqueOrThrow({ where: { id: p.videoId } });
  if (!video.proxyKey || video.status === "expired") throw new AppError("The preview copy of this footage expired. Rebuild it from your Library, then render again.", 409, "expired");
  let items;
  // (An edit whose length was never measured is checked by the worker against its plan.)
  try { items = sampleItems(req, p.outputSeconds || 24 * 3600); } catch (e) { if (e instanceof SampleError) throw new AppError(e.message, 400, "samples"); throw e; }
  // Samples are not versions: they do not close the version (the AI's change to it goes on in the same version), so
  // ones of an earlier state of it are not reused.
  const latest = await prisma.projectVersion.findFirst({ where: { projectId }, orderBy: { v: "desc" }, select: { v: true, updatedAt: true } });
  const version = latest?.v ?? p.currentVersion;
  const since = latest?.updatedAt ?? new Date(0);
  const recent = await prisma.render.findMany({ where: { projectId, kind: "sample", version, status: { in: ["queued", "running", "done"] }, createdAt: { gt: new Date(Math.max(since.getTime(), Date.now() - renderTimeoutMs("preview", video.seconds) - 60_000)) } }, orderBy: { createdAt: "desc" }, take: 10 });
  const done = await prisma.render.findMany({ where: { projectId, kind: "sample", version, status: "done", createdAt: { gt: since } }, orderBy: { createdAt: "desc" }, take: 10 });
  for (const r of [...recent, ...done]) {
    const sp = (r.plan as { samples?: SamplePlan } | null)?.samples;
    if (!sp || !same(sp.items, items)) continue;
    if (r.status === "done" && !((r.framesKeys as string[]) || []).length) continue; // its files were cleaned up
    // The notes may be new: keep the latest words.
    if (items.some((x, k) => (x.note ?? null) !== (sp.items[k]?.note ?? null))) {
      const notes = (xs: SamplePlan["items"]) => xs.map((x, k) => ({ ...x, note: items[k].note }));
      await prisma.render.update({ where: { id: r.id }, data: { plan: { ...(r.plan as object), samples: { ...sp, items: notes(sp.items), ...(sp.done ? { done: notes(sp.done) as SampleDone[] } : {}) } } as never } });
    }
    return prisma.render.findUniqueOrThrow({ where: { id: r.id } });
  }
  const steps = [...SAMPLE_STEPS];
  const r = await prisma.render.create({ data: { projectId, userId, kind: "sample", version, status: "queued", steps, quality: "540p", plan: { samples: { items } } as never } });
  await publishRender(r.id, { status: "queued", step: 0, steps, percent: 0 });
  await enqueue<RenderJob>("render", { renderId: r.id }, { jobId: r.id });
  return r;
}

/** One set of samples for the app: progress, each sample's picture and clip, and the user's changes on them. */
export async function samplesView(userId: string, renderId: string): Promise<AppSamples> {
  const r = await prisma.render.findUnique({ where: { id: renderId } });
  if (!r || r.userId !== userId || r.kind !== "sample") throw new AppError("Those samples do not exist.", 404, "not-found");
  const p = await getOwnedProject(userId, r.projectId);
  const sp = (r.plan as { samples?: SamplePlan } | null)?.samples ?? { items: [] };
  const st = r.status === "done" || r.status === "failed" ? null : await renderStatus(r);
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { name: true } });
  const notes = await prisma.projectComment.findMany({ where: { projectId: p.id, renderId: r.id }, orderBy: { createdAt: "asc" }, take: 200 });
  const comments: AppComment[] = await Promise.all(notes.map(async (n) => ({ id: n.id, time: n.time, text: n.text, author: user?.name || "You", mine: true, resolved: n.resolved, at: n.createdAt.getTime(), edited: !!n.editedAt, renderId: n.renderId, ...(await commentMedia(n)) })));
  const src = sp.done?.length ? sp.done : sp.items;
  const items = await Promise.all(src.map(async (x) => {
    const d = x as Partial<SampleDone>;
    return {
      kind: x.kind, at: x.at, end: x.end ?? null, note: x.note ?? null,
      still: d.still ? await signGet(d.still, LINK_SECONDS, { contentType: "image/jpeg" }) : null,
      clip: d.clip ? await signGet(d.clip, LINK_SECONDS, { contentType: "video/mp4" }) : null,
    };
  }));
  const status = r.status === "done" || r.status === "failed" ? r.status : (st?.status === "running" ? "running" : "queued");
  return {
    renderId: r.id, project: { id: p.id, name: p.name, aspect: p.aspect, version: p.currentVersion, editorUrl: WEB() ? `${WEB()}/editor/${p.id}` : null },
    version: r.version, status, percent: r.status === "done" ? 100 : Math.round(st?.percent ?? 0), step: st ? st.steps[st.step] ?? null : null, etaSec: st?.etaSec ?? null,
    error: r.status === "failed" ? r.error || "The samples did not render." : null,
    width: sp.width ?? null, height: sp.height ?? null, items, comments,
  };
}

/** The samples as Claude reads them: what each shows, and the user's changes on each one. */
export function samplesOut(v: AppSamples): string {
  const items = v.items.map((x) => ({ kind: x.kind, at: x.at, ...(x.end != null ? { end: x.end } : {}), ...(x.note ? { note: x.note } : {}) }));
  const list = samplesText(items);
  if (v.status === "failed") return `The samples of v${v.version} failed: ${v.error}\n${list}`;
  if (v.status !== "done") return `Samples of v${v.version} are ${v.status === "queued" ? "queued" : `at ${v.percent}% (${v.step ?? "starting"})`} (render id ${v.renderId}). get_samples {renderId: "${v.renderId}", wait_seconds: 60} waits for them.\n${list}`;
  const open = v.comments.filter((c) => !c.resolved);
  const near = (c: AppComment) => {
    const k = v.items.findIndex((x) => (x.kind === "clip" ? c.time >= x.at - 0.05 && c.time <= (x.end ?? x.at) + 0.05 : Math.abs(c.time - x.at) < 0.05));
    return k >= 0 ? `sample ${k + 1}` : sampleClock(c.time);
  };
  const changes = open.length ? `\nThe user's changes on them (comment id | where | text):\n${open.map((c) => `${c.id} | ${near(c)} at ${sampleClock(c.time)} | ${c.text.replace(/\s+/g, " ").slice(0, 600) || "(no words)"}`).join("\n")}\nMake them in one apply_edits, then render_samples again (or render_preview when the look is agreed), and resolve_comment each.` : "\nNo changes asked on them yet.";
  return `Samples of v${v.version} (edit seconds, ${v.width}x${v.height}), shown to the user in the Rendrr app:\n${list}${changes}`;
}
