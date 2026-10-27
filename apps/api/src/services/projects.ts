import { abortMultipart, AppError, deleteObjects, notFound, placementMedia, signGet } from "@rendrr/core";
import { prisma, type Prisma, type Project } from "@rendrr/db";
import { allWords, asSequence, aspectFor, buildRawSequence, catalogMusic, catalogSfx, GRAPHIC_TEMPLATES, outputDuration, refreshFillers, type ReferenceRef, type Snapshot, type Transcript, type V3Clip } from "@rendrr/shared";
import { playerVideos } from "./sequence";
import { activityOut, commentOut, folderOut, noteOut, projectOut, styleOut, videoOut } from "../serialize";

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

/** Checks a reference the user may attach (theirs, built in, or a gallery video that allows recreating) and names it. */
export async function resolveReference(userId: string, ref: { kind: ReferenceRef["kind"]; id: string }): Promise<ReferenceRef> {
  if (ref.kind === "style") {
    const s = await prisma.style.findFirst({ where: { id: ref.id, OR: [{ ownerId: null }, { ownerId: userId }] } });
    if (s) return { kind: "style", id: s.id, name: s.name };
  } else if (ref.kind === "video") {
    const v = await prisma.video.findUnique({ where: { id: ref.id } });
    if (v && v.userId === userId) return { kind: "video", id: v.id, name: v.name };
  } else {
    const g = await prisma.galleryItem.findUnique({ where: { id: ref.id } });
    if (g && (g.userId === userId || g.allowRecreate)) return { kind: "recipe", id: g.id, name: g.title };
    const r = await prisma.reference.findUnique({ where: { id: ref.id } });
    if (r && r.userId === userId) return { kind: "recipe", id: r.id, name: r.name };
  }
  throw new AppError("That reference is not available any more. Pick another one.", 400, "no-reference");
}

/**
 * Creates an edit. Version 1 is the footage as recorded and nothing else: no style, no captions, no cuts (only words
 * the user removed on the footage page). A reference (a style, a gallery recipe or a reference video; `styleId` from
 * the connector is a style reference) is attached for the user's AI to read. Rendrr never applies it. Several videos
 * (videoIds, in order): the first is the edit's footage, the others follow it whole on V1.
 */
export async function createProject(userId: string, input: { videoId?: string; videoIds?: string[]; styleId?: string | null; reference?: { kind: ReferenceRef["kind"]; id: string } | null; name?: string | null; folderId?: string | null; cut?: string[]; aspect?: string }, opts: { actorKind?: "user" | "claude" | "chatgpt" } = {}) {
  // One video, or several in order (a video filmed in parts): the first is the edit's footage.
  const ids = Array.from(new Set(input.videoIds?.length ? input.videoIds : input.videoId ? [input.videoId] : []));
  if (!ids.length) throw new AppError("Pick footage first.", 400, "no-footage");
  const found = await prisma.video.findMany({ where: { id: { in: ids }, userId }, include: { analysis: true } });
  const vids = ids.map((id) => found.find((v) => v.id === id));
  if (vids.some((v) => !v)) throw new AppError(ids.length > 1 ? "One of those videos is not in your library any more. Pick them again." : "Pick footage first.", 400, "no-footage");
  const waiting = vids.filter((v) => v!.status !== "ready" || !v!.analysis);
  if (waiting.length) throw new AppError(`${waiting.map((v) => `"${v!.name}"`).join(", ")} ${waiting.length === 1 ? "is" : "are"} not ready yet. Wait until ${waiting.length === 1 ? "it finishes" : "they finish"} processing.`, 409, "not-ready");
  const refs = vids.filter((v) => v!.kind === "reference" && ids.length > 1);
  if (refs.length) throw new AppError(`${refs.map((v) => `"${v!.name}"`).join(", ")} ${refs.length === 1 ? "is a reference" : "are references"}: an edit is made of footage. Leave ${refs.length === 1 ? "it" : "them"} out, or attach one as the reference.`, 400, "reference-as-footage");
  const [v, ...more] = vids as NonNullable<(typeof vids)[number]>[];
  const asked = input.reference ?? (input.styleId ? { kind: "style" as const, id: input.styleId } : null);
  const reference = asked ? await resolveReference(userId, asked) : null;
  let folderId = input.folderId || null;
  if (folderId) {
    const f = await prisma.folder.findUnique({ where: { id: folderId } });
    if (!f || f.userId !== userId) folderId = null;
  }
  folderId ||= await defaultFolderId(userId);
  const transcript = v.analysis!.transcript as unknown as Transcript;
  const timeline = buildRawSequence(transcript, v.seconds, Array.isArray(input.cut) ? input.cut : [], v.id, more.map((m) => ({ id: m.id, name: m.name, seconds: m.seconds, ready: true })));
  const aspect = input.aspect || aspectFor(v.orientation);
  const name = (input.name || "").trim() || (more.length ? `${v.name} + ${more.length} more` : v.name + " edit");
  const snap: Snapshot = { timeline, name, aspect: aspect as Snapshot["aspect"], styleId: null };
  const note = more.length ? `${vids.length} videos as recorded, back to back` : input.cut?.length ? `First cut (${input.cut.length} words removed)` : "Footage as recorded";
  const p = await prisma.project.create({
    data: {
      userId, folderId, videoId: v.id, styleId: null, ...(reference ? { reference } : {}), name, aspect, status: "Draft", art: v.art,
      timeline: timeline as unknown as Prisma.InputJsonValue, currentVersion: 1, outputSeconds: Math.round(outputDuration(timeline, allWords(transcript)) * 100) / 100,
      versions: { create: { v: 1, note, timeline: snap as unknown as Prisma.InputJsonValue, createdBy: opts.actorKind || "user", sealed: true } },
    },
  });
  await prisma.folder.update({ where: { id: folderId }, data: { updatedAt: new Date() } });
  return p;
}

export async function listProjects(userId: string) {
  const ps = await prisma.project.findMany({ where: { userId, deletedAt: null }, orderBy: { updatedAt: "desc" }, include: { video: true, folder: true } });
  const styles = new Map((await prisma.style.findMany()).map((s) => [s.id, s]));
  return Promise.all(ps.map(async (p) => ({ ...projectOut(p), style: p.styleId && styles.get(p.styleId) ? styleOut(styles.get(p.styleId)!) : undefined, video: await videoOut(p.video), folder: folderOut(p.folder) })));
}

/** Latest finished render of each kind for a project version (or any version). */
export async function latestRender(projectId: string, kind: "preview" | "final", version?: number) {
  return prisma.render.findFirst({ where: { projectId, kind, status: "done", outputKey: { not: null }, ...(version ? { version } : {}) }, orderBy: { createdAt: "desc" } });
}

export async function projectFull(userId: string, id: string) {
  const p = await getOwnedProject(userId, id);
  const [video, style, versions, reviews, activity, notes, owner] = await Promise.all([
    prisma.video.findUniqueOrThrow({ where: { id: p.videoId }, include: { analysis: true } }),
    p.styleId ? prisma.style.findUnique({ where: { id: p.styleId } }) : null,
    prisma.projectVersion.findMany({ where: { projectId: p.id }, orderBy: { v: "asc" }, select: { v: true, note: true, createdAt: true, updatedAt: true, createdBy: true } }),
    prisma.review.findMany({ where: { OR: [{ projectId: p.id }, { folderId: p.folderId }] }, include: { comments: true } }),
    prisma.aiAction.findMany({ where: { projectId: p.id, undone: false }, orderBy: { createdAt: "desc" }, take: 50 }),
    prisma.projectComment.findMany({ where: { projectId: p.id }, orderBy: { createdAt: "asc" } }),
    prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { name: true } }),
  ]);
  // Client comments and the user's own notes, in video order.
  const comments = [
    ...reviews.flatMap((r) => r.comments.filter((c) => !c.projectId || c.projectId === p.id)).map(commentOut),
    ...notes.map((n) => noteOut(n, owner.name)),
  ].sort((a, b) => a.time - b.time || a.at - b.at);
  const preview = await latestRender(p.id, "preview");
  const final = await latestRender(p.id, "final");
  // The editor always works on a sequence: a project still stored in model A is shown converted (it is stored
  // converted at its next save).
  const transcript = (video.analysis?.transcript as unknown as Transcript) || [];
  const timeline = asSequence(p.timeline as unknown as Snapshot["timeline"], allWords(transcript), p.videoId, video.seconds);
  return {
    ...(await playerMedia(userId, timeline)),
    videos: await playerVideos(userId, timeline, p.videoId), // the other videos on V1
    ...projectOut(p),
    style: style ? styleOut(style) : undefined,
    video: { ...(await videoOut(video)), proxyUrl: video.proxyKey && video.status !== "expired" ? await signGet(video.proxyKey, 6 * 3600) : null },
    transcript,
    silences: (video.analysis?.silences as unknown as { start: number; end: number }[]) || [], // for Cut silences in the editor
    timeline,
    versions: versions.map((x) => ({ v: x.v, note: x.note, at: x.updatedAt.getTime(), by: x.createdBy })),
    comments,
    activity: activity.map((a) => activityOut(a)),
    previewUrl: preview?.outputKey ? await signGet(preview.outputKey, 6 * 3600) : null,
    previewVersion: preview?.version ?? null,
    finalUrl: final?.outputKey ? await signGet(final.outputKey, 6 * 3600) : null,
  };
}

/**
 * The files the editor's live player overlays, so it shows what the render will: b-roll videos (their preview
 * copies), custom graphics by clip (the recorded transparent WebM each placement plays: its own params' recording
 * when it has one), and the built-in music and sound effects the edit uses, by storage key (from the catalog only).
 * Templates are drawn live from their HTML.
 */
async function playerMedia(userId: string, tl: Snapshot["timeline"]) {
  const brollIds = Array.from(new Set(tl.tracks.v2.map((c) => (c as { videoId?: string }).videoId).filter(Boolean) as string[]));
  const vids = brollIds.length ? await prisma.video.findMany({ where: { id: { in: brollIds }, userId, proxyKey: { not: null } } }) : [];
  return {
    brollMedia: Object.fromEntries(await Promise.all(vids.map(async (v) => [v.id, { url: await signGet(v.proxyKey!, 6 * 3600), seconds: v.seconds }] as const))),
    graphicClipMedia: Object.fromEntries(await Promise.all((await graphicPlacements(userId, tl)).filter((x) => "key" in x).map(async (x) => [x.clipId, { url: await signGet((x as { key: string }).key, 6 * 3600), width: x.width, height: x.height, seconds: x.seconds }] as const))),
    audioMedia: Object.fromEntries(await Promise.all(Array.from(new Set([
      ...tl.tracks.a2.map((c) => catalogMusic(c as { trackId?: string; assetKey?: string })?.key),
      ...tl.tracks.a3.map((c) => catalogSfx(c as { sfxId?: string; assetKey?: string })?.key),
    ].filter((k): k is string => !!k))).map(async (k) => [k, await signGet(k, 6 * 3600)] as const))),
  };
}

/** Each custom graphic placement: the storage key of the file it plays, or why there is none yet (state). */
export async function graphicPlacements(userId: string, tl: Snapshot["timeline"]) {
  const clips = (tl.tracks.v3 as V3Clip[]).filter((c) => c.kind === "graphic" && c.graphicId && !GRAPHIC_TEMPLATES.some((t) => t.id === c.graphicId));
  if (!clips.length) return [];
  const gs = await prisma.graphic.findMany({ where: { id: { in: Array.from(new Set(clips.map((c) => c.graphicId!))) }, ownerId: userId, kind: "custom" },
    select: { id: true, ownerId: true, paramsSchema: true, status: true, renderedKey: true, error: true, durationSec: true, width: true, height: true } });
  const out = await Promise.all(clips.map(async (c) => {
    const g = gs.find((x) => x.id === c.graphicId);
    return g ? { clipId: c.id, own: !!c.params && Object.keys(c.params).length > 0, width: g.width, height: g.height, seconds: g.durationSec, ...(await placementMedia(g, c.params)) } : null;
  }));
  return out.filter((x): x is NonNullable<typeof x> => !!x);
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

/** Transcripts made before a filler rule changed (for example "umm") get their filler marks again (at start). */
export async function refreshFillerFlags() {
  const as = await prisma.footageAnalysis.findMany({ select: { videoId: true, transcript: true }, take: 2000 });
  let n = 0;
  for (const a of as) {
    const next = refreshFillers((a.transcript as unknown as Transcript) || []);
    if (next) { await prisma.footageAnalysis.update({ where: { videoId: a.videoId }, data: { transcript: next as unknown as Prisma.InputJsonValue } }); n++; }
  }
  return n;
}
