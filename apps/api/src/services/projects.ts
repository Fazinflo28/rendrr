import { abortMultipart, AppError, applyTimelineChange, deleteObjects, notFound, signGet } from "@rendrr/core";
import { prisma, type Prisma, type Project } from "@rendrr/db";
import { allWords, aspectFor, buildInitialTimeline, DEFAULT_STYLE_ID, outputDuration, type Snapshot, type Transcript } from "@rendrr/shared";
import { activityOut, commentOut, folderOut, projectOut, styleOut, videoOut } from "../serialize";

export async function defaultFolderId(userId: string, name?: string): Promise<string> {
  const f = await prisma.folder.findFirst({ where: { userId }, orderBy: { updatedAt: "desc" } });
  if (f) return f.id;
  const u = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  const created = await prisma.folder.create({ data: { userId, name: "My edits", workspace: `${(name || u.name).split(" ")[0]}'s Workspace` } });
  return created.id;
}

export async function getOwnedProject(userId: string, id: string): Promise<Project> {
  const p = await prisma.project.findUnique({ where: { id } });
  if (!p || p.userId !== userId || p.deletedAt) throw notFound("We could not find that project.");
  return p;
}

/**
 * Creates an edit. Version 1 is the footage as recorded. When `autoStyle` is on (edits made in the app),
 * the style's rules run straight away as version 2, logged as a Rendrr action so it can be undone.
 */
export async function createProject(userId: string, input: { videoId: string; styleId?: string | null; name?: string | null; folderId?: string | null; cut?: string[]; aspect?: string }, opts: { autoStyle: boolean; actorKind?: "user" | "claude" | "chatgpt" }) {
  const v = await prisma.video.findUnique({ where: { id: input.videoId }, include: { analysis: true } });
  if (!v || v.userId !== userId) throw new AppError("Pick footage first.", 400, "no-footage");
  if (v.status !== "ready" || !v.analysis) throw new AppError(`"${v.name}" is not ready yet. Wait until it finishes processing.`, 409, "not-ready");
  const styleId = input.styleId || DEFAULT_STYLE_ID;
  const style = await prisma.style.findFirst({ where: { id: styleId, OR: [{ ownerId: null }, { ownerId: userId }] } });
  if (!style) throw new AppError("That style does not exist.", 400, "no-style");
  let folderId = input.folderId || null;
  if (folderId) {
    const f = await prisma.folder.findUnique({ where: { id: folderId } });
    if (!f || f.userId !== userId) folderId = null;
  }
  folderId ||= await defaultFolderId(userId);
  const transcript = v.analysis.transcript as unknown as Transcript;
  const timeline = buildInitialTimeline(transcript, v.seconds, style.captionLook as "clean" | "bold" | "outline", Array.isArray(input.cut) ? input.cut : []);
  const aspect = input.aspect || aspectFor(v.orientation);
  const name = (input.name || "").trim() || v.name + " edit";
  const snap: Snapshot = { timeline, name, aspect: aspect as Snapshot["aspect"], styleId };
  const p = await prisma.project.create({
    data: {
      userId, folderId, videoId: v.id, styleId, name, aspect, status: "Draft", art: v.art,
      timeline: timeline as unknown as Prisma.InputJsonValue, currentVersion: 1, outputSeconds: Math.round(outputDuration(timeline, allWords(transcript)) * 100) / 100,
      versions: { create: { v: 1, note: input.cut?.length ? `First cut (${input.cut.length} words removed)` : "Footage as recorded", timeline: snap as unknown as Prisma.InputJsonValue, createdBy: opts.actorKind || "user", sealed: true } },
    },
  });
  await prisma.folder.update({ where: { id: folderId }, data: { updatedAt: new Date() } });
  if (opts.autoStyle) await applyTimelineChange(p.id, { op: "apply_style", styleId }, { kind: "rendrr", userId, toolName: "apply_style", input: { styleId } });
  return prisma.project.findUniqueOrThrow({ where: { id: p.id } });
}

export async function listProjects(userId: string) {
  const ps = await prisma.project.findMany({ where: { userId, deletedAt: null }, orderBy: { updatedAt: "desc" }, include: { video: true, folder: true } });
  const styles = new Map((await prisma.style.findMany()).map((s) => [s.id, s]));
  return Promise.all(ps.map(async (p) => ({ ...projectOut(p), style: styles.get(p.styleId) ? styleOut(styles.get(p.styleId)!) : undefined, video: await videoOut(p.video), folder: folderOut(p.folder) })));
}

/** Latest finished render of each kind for a project version (or any version). */
export async function latestRender(projectId: string, kind: "preview" | "final", version?: number) {
  return prisma.render.findFirst({ where: { projectId, kind, status: "done", outputKey: { not: null }, ...(version ? { version } : {}) }, orderBy: { createdAt: "desc" } });
}

export async function projectFull(userId: string, id: string) {
  const p = await getOwnedProject(userId, id);
  const [video, style, versions, reviews, activity] = await Promise.all([
    prisma.video.findUniqueOrThrow({ where: { id: p.videoId }, include: { analysis: true } }),
    prisma.style.findUnique({ where: { id: p.styleId } }),
    prisma.projectVersion.findMany({ where: { projectId: p.id }, orderBy: { v: "asc" }, select: { v: true, note: true, createdAt: true, updatedAt: true, createdBy: true } }),
    prisma.review.findMany({ where: { OR: [{ projectId: p.id }, { folderId: p.folderId }] }, include: { comments: true } }),
    prisma.aiAction.findMany({ where: { projectId: p.id, undone: false }, orderBy: { createdAt: "desc" }, take: 50 }),
  ]);
  const comments = reviews.flatMap((r) => r.comments.filter((c) => !c.projectId || c.projectId === p.id)).map(commentOut).sort((a, b) => a.at - b.at);
  const preview = await latestRender(p.id, "preview");
  const final = await latestRender(p.id, "final");
  return {
    ...projectOut(p),
    style: style ? styleOut(style) : undefined,
    video: { ...(await videoOut(video)), proxyUrl: video.proxyKey && video.status !== "expired" ? await signGet(video.proxyKey, 6 * 3600) : null },
    transcript: (video.analysis?.transcript as unknown as Transcript) || [],
    timeline: p.timeline,
    versions: versions.map((x) => ({ v: x.v, note: x.note, at: x.updatedAt.getTime(), by: x.createdBy })),
    comments,
    activity: activity.map((a) => activityOut(a)),
    previewUrl: preview?.outputKey ? await signGet(preview.outputKey, 6 * 3600) : null,
    previewVersion: preview?.version ?? null,
    finalUrl: final?.outputKey ? await signGet(final.outputKey, 6 * 3600) : null,
  };
}

/** Deletes the stored files of these edits (renders, frames, raw originals) before their rows are removed. */
export async function purgeProjectFiles(where: Prisma.ProjectWhereInput) {
  const ids = (await prisma.project.findMany({ where, select: { id: true } })).map((p) => p.id);
  if (!ids.length) return;
  const renders = await prisma.render.findMany({ where: { projectId: { in: ids } }, select: { outputKey: true, framesKeys: true } });
  await deleteObjects(renders.flatMap((r) => [r.outputKey, ...((r.framesKeys as string[]) || [])]));
  const originals = await prisma.tempOriginal.findMany({ where: { projectId: { in: ids } } });
  for (const o of originals) if (!o.completed && o.uploadId) await abortMultipart(o.key, o.uploadId);
  await deleteObjects(originals.map((o) => o.key));
}

/** Edits made before the output length was stored show no length; fill it in once (best effort, at start). */
export async function backfillOutputSeconds() {
  const ps = await prisma.project.findMany({ where: { outputSeconds: 0, deletedAt: null }, take: 500, include: { video: { include: { analysis: true } } } });
  for (const p of ps) {
    try {
      const tr = (p.video.analysis?.transcript as unknown as Transcript) || [];
      const secs = Math.round(outputDuration(p.timeline as unknown as Snapshot["timeline"], allWords(tr)) * 100) / 100;
      if (secs > 0) await prisma.project.update({ where: { id: p.id }, data: { outputSeconds: secs } });
    } catch { /* a broken old timeline keeps showing no length */ }
  }
  return ps.length;
}
