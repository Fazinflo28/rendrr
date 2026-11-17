import { abortMultipart, AppError, deleteObjects, notFound, placementMedia, renderFileKeys, signGet } from "@rendrr/core";
import { deleteEditCommentFiles } from "./commentMedia";
import { prisma, type Folder, type Prisma, type Project } from "@rendrr/db";
import { allWords, applyOp, asSequence, aspectFor, buildRawSequence, type EditContext, type Op, catalogMusic, catalogSfx, findTemplate, isCaptionMarker, libraryVideoIds, outputDuration, refreshFillers, type ReferenceRef, type Snapshot, type Transcript, type V3Clip, ASPECTS, aspectSize, orientationOf, type Aspect } from "@rendrr/shared";
import { otherVideoIds, playerVideos } from "./sequence";
import { activityOut, commentOut, folderOut, noteOut, projectOut, styleOut, videoOut } from "../serialize";
import { sentByComment } from "./handoff";

export async function defaultFolderId(userId: string, name?: string): Promise<string> {
  const f = await prisma.folder.findFirst({ where: { userId }, orderBy: { updatedAt: "desc" } });
  if (f) return f.id;
  const u = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  const created = await prisma.folder.create({ data: { userId, name: "My edits", workspace: `${(name || u.name).split(" ")[0]}'s Workspace` } });
  return created.id;
}

/** A new folder (a project: a client, a series) for the user's edits. */
export async function createFolder(userId: string, name: string) {
  const [count, u] = await Promise.all([prisma.folder.count({ where: { userId } }), prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { name: true } })]);
  return prisma.folder.create({ data: { userId, name: name.trim().slice(0, 80) || "New project", workspace: `${(u.name || "My").split(" ")[0]}'s Workspace`, cover: 1 + (count % 6) } });
}

/**
 * The user's project folder named by its id or its name (case and spaces at the ends ignored). Two of theirs with that
 * name are refused (never a guess); a name that is not there yet makes the project when `make` is set.
 */
export async function findOrMakeFolder(userId: string, ref: string, make = true): Promise<{ folder: Folder; made: boolean }> {
  const want = ref.trim();
  const byId = want ? await prisma.folder.findUnique({ where: { id: want } }) : null;
  if (byId && byId.userId === userId) return { folder: byId, made: false };
  const all = await prisma.folder.findMany({ where: { userId }, orderBy: { updatedAt: "desc" } });
  const same = all.filter((f) => f.name.trim().toLowerCase() === want.toLowerCase());
  if (same.length === 1) return { folder: same[0], made: false };
  if (same.length > 1) throw new AppError(`${same.length} projects are called "${same[0].name}": ${same.map((f) => f.id).join(", ")}. Send the id of the one meant.`, 409, "ambiguous-project");
  if (!want || !make || /^c[a-z0-9]{20,}$/.test(want)) throw notFound(`There is no project "${want}". ${all.length ? `Projects: ${all.slice(0, 30).map((f) => `"${f.name}" (${f.id})`).join(", ")}.` : "There are none yet."}`);
  return { folder: await createFolder(userId, want), made: true };
}

export type MoveItem = { kind: "edit" | "video"; id: string };
export type MoveLine = { id: string; ok: boolean; text: string; projectId?: string; from?: string };

/**
 * Videos into a project (a folder of edits). An edit moves with everything in it (versions, renders, comments, its own
 * share links); footage from the Library becomes a new edit there (version 1 is the raw footage) and stays in the
 * Library. Each item is answered on its own: another user's things are "not found", a deleted edit is left alone.
 */
export async function moveToFolder(userId: string, items: MoveItem[], folder: Folder, opts: { actorKind?: "user" | "claude" | "chatgpt" } = {}): Promise<MoveLine[]> {
  if (folder.userId !== userId) throw notFound("That project is gone.");
  const ids = items.map((x) => x.id);
  const [edits, videos] = await Promise.all([
    prisma.project.findMany({ where: { userId, id: { in: ids } }, select: { id: true, name: true, folderId: true, deletedAt: true, videoId: true, folder: { select: { name: true } } } }),
    prisma.video.findMany({ where: { userId, id: { in: ids } }, select: { id: true, name: true, projects: { where: { deletedAt: null }, select: { id: true, name: true, folder: { select: { name: true } } }, take: 5 } } }),
  ]);
  const editOf = new Map(edits.map((e) => [e.id, e])), videoOf = new Map(videos.map((v) => [v.id, v]));
  const where = (ps: { id: string; name: string; folder: { name: string } }[]) => ps.map((p) => `"${p.name}" (${p.id}) in "${p.folder.name}"`).join(", ");
  const out: MoveLine[] = [], touched = new Set<string>(), seen = new Set<string>();
  for (const it of items) {
    // The same id twice with the same kind is one item; sent once as each kind, the right one still counts.
    if (seen.has(`${it.kind}:${it.id}`)) continue;
    seen.add(`${it.kind}:${it.id}`);
    const e = editOf.get(it.id), v = videoOf.get(it.id);
    if (it.kind === "edit") {
      if (!e) {
        out.push({ id: it.id, ok: false, text: v ? `${it.id} is footage ("${v.name}"), not an edit: kind video puts it in the project as a new edit.${v.projects.length ? ` Its edits: ${where(v.projects)}; send one of their ids as kind edit to move it.` : ""}` : `edit ${it.id}: not found.` });
        continue;
      }
      if (e.deletedAt) { out.push({ id: e.id, ok: false, text: `Edit "${e.name}" is deleted: restore it first (delete_items restore: true).` }); continue; }
      if (e.folderId === folder.id) { out.push({ id: e.id, ok: false, text: `Edit "${e.name}" is already in "${folder.name}".` }); continue; }
      await prisma.project.update({ where: { id: e.id }, data: { folderId: folder.id } });
      touched.add(e.folderId);
      out.push({ id: e.id, ok: true, projectId: e.id, from: e.folderId, text: `Edit "${e.name}" moved from "${e.folder.name}" to "${folder.name}".` });
      continue;
    }
    if (!v) {
      out.push({ id: it.id, ok: false, text: e ? `${it.id} is an edit ("${e.name}"), not footage: kind edit moves it.` : `video ${it.id}: not found.` });
      continue;
    }
    try {
      const p = await createProject(userId, { videoId: v.id, folderId: folder.id }, opts);
      out.push({ id: v.id, ok: true, projectId: p.id, text: `Video "${v.name}" is in "${folder.name}" as a new edit "${p.name}" (${p.id}), version 1 = the raw footage; the Library keeps the video.${v.projects.length ? ` Its other edits stay where they are: ${where(v.projects)}.` : ""}` });
    } catch (err) {
      const msg = (err as Error).message;
      out.push({ id: v.id, ok: false, text: msg.includes(`"${v.name}"`) ? msg : `"${v.name}": ${msg}` });
    }
  }
  if (out.some((l) => l.ok)) {
    touched.add(folder.id);
    await prisma.folder.updateMany({ where: { id: { in: [...touched] }, userId }, data: { updatedAt: new Date() } });
  }
  return out;
}

/** The user's own folder, or null when that id is not theirs. */
async function ownFolder(userId: string, id?: string | null): Promise<string | null> {
  if (!id) return null;
  const f = await prisma.folder.findUnique({ where: { id } });
  return f && f.userId === userId ? f.id : null;
}

/**
 * A new edit that starts as another edit is now (its current version, every change kept), for another version of it
 * (another shape, a cut-down, shorts). `bare`: only the sequence and its whole-edit settings come along (captions and
 * their style, sound, export, background, the words it cut): b-roll, text, graphics, music and sound effects hang on
 * clips the new edit replaces, so they stay with the first edit.
 */
export async function copyProject(userId: string, srcId: string, input: { name?: string | null; folderId?: string | null; bare?: boolean }, opts: { actorKind?: "user" | "claude" | "chatgpt" } = {}) {
  const src = await getOwnedProject(userId, srcId);
  const ver = await prisma.projectVersion.findUnique({ where: { projectId_v: { projectId: src.id, v: src.currentVersion } } });
  const snap0 = (ver?.timeline ?? { timeline: src.timeline, name: src.name, aspect: src.aspect, styleId: src.styleId }) as unknown as Snapshot;
  let timeline = snap0.timeline;
  if (input.bare) timeline = { ...timeline, tracks: { ...timeline.tracks, v2: [], v3: (timeline.tracks.v3 as V3Clip[]).filter((c) => isCaptionMarker("v3", c)), a2: [], a3: [] } } as typeof timeline;
  const name = (input.name || "").trim() || `${src.name} copy`;
  const folderId = (await ownFolder(userId, input.folderId)) ?? src.folderId;
  const v = await prisma.video.findUniqueOrThrow({ where: { id: src.videoId }, include: { analysis: true } });
  const words = allWords((v.analysis?.transcript as unknown as Transcript) || []);
  const p = await prisma.project.create({
    data: {
      userId, folderId, videoId: src.videoId, styleId: snap0.styleId ?? null, ...(src.reference ? { reference: src.reference as Prisma.InputJsonValue } : {}), name, aspect: snap0.aspect, status: "Draft", art: src.art,
      timeline: timeline as unknown as Prisma.InputJsonValue, currentVersion: 1, outputSeconds: Math.round(outputDuration(timeline, words) * 100) / 100,
      versions: { create: { v: 1, note: `Copy of "${src.name}" v${src.currentVersion}`, timeline: { ...snap0, timeline, name } as unknown as Prisma.InputJsonValue, createdBy: opts.actorKind || "user", sealed: true } },
    },
  });
  await prisma.folder.update({ where: { id: folderId }, data: { updatedAt: new Date() } });
  return p;
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

type FirstCutInput = { videoId?: string; videoIds?: string[]; name?: string | null; cut?: string[]; aspect?: string; length?: number };

/** The footage of a new edit and its first timeline (version 1: the footage as recorded). Checks the videos are the
 *  user's and ready. Shared by a new edit and by an edit that was waiting for its footage (useFootage). */
async function firstCut(userId: string, input: FirstCutInput) {
  // One video, or several in order (a video filmed in parts): the first is the edit's footage.
  const ids = Array.from(new Set(input.videoIds?.length ? input.videoIds : input.videoId ? [input.videoId] : []));
  if (!ids.length) throw new AppError("Pick footage first.", 400, "no-footage");
  const found = await prisma.video.findMany({ where: { id: { in: ids }, userId }, include: { analysis: true } });
  const vids = ids.map((id) => found.find((v) => v.id === id));
  if (vids.some((v) => !v)) throw new AppError(ids.length > 1 ? "One of those videos is not in your library any more. Pick them again." : "Pick footage first.", 400, "no-footage");
  const trashed = vids.filter((v) => v!.deletedAt);
  if (trashed.length) throw new AppError(`${trashed.map((v) => `"${v!.name}"`).join(", ")} ${trashed.length === 1 ? "is" : "are"} in the Trash. Restore ${trashed.length === 1 ? "it" : "them"} first (Assets > Trash).`, 409, "in-trash");
  const waiting = vids.filter((v) => v!.status !== "ready" || !v!.analysis);
  if (waiting.length) throw new AppError(`${waiting.map((v) => `"${v!.name}"`).join(", ")} ${waiting.length === 1 ? "is" : "are"} not ready yet. Wait until ${waiting.length === 1 ? "it finishes" : "they finish"} processing.`, 409, "not-ready");
  const refs = vids.filter((v) => v!.kind === "reference" && ids.length > 1);
  if (refs.length) throw new AppError(`${refs.map((v) => `"${v!.name}"`).join(", ")} ${refs.length === 1 ? "is a reference" : "are references"}: an edit is made of footage. Leave ${refs.length === 1 ? "it" : "them"} out, or attach one as the reference.`, 400, "reference-as-footage");
  const [v, ...more] = vids as NonNullable<(typeof vids)[number]>[];
  const transcript = v.analysis!.transcript as unknown as Transcript;
  let timeline = buildRawSequence(transcript, v.seconds, Array.isArray(input.cut) ? input.cut : [], v.id, more.map((m) => ({ id: m.id, name: m.name, seconds: m.seconds, ready: true })));
  // A blank canvas (an edit from scratch) is longer than the edit asked for, so the edit can grow: V1 plays the length.
  if (input.length && input.length < v.seconds) {
    const ctx: EditContext = { videoId: v.id, transcript, silences: [], sceneCuts: [], duration: v.seconds, getStyle: () => undefined };
    timeline = applyOp({ timeline, name: "", aspect: "16:9", styleId: null }, { op: "set_clips", track: "v1", clips: [{ start: 0, end: input.length, label: "Canvas" }] } as Op, ctx).snap.timeline;
  }
  const aspect = input.aspect || aspectFor(v.orientation);
  const name = (input.name || "").trim() || (more.length ? `${v.name} + ${more.length} more` : v.name + " edit");
  const snap: Snapshot = { timeline, name, aspect: aspect as Snapshot["aspect"], styleId: null };
  const note = v.kind === "canvas" ? `Blank canvas, ${Math.round((input.length ?? v.seconds) * 10) / 10} s` : more.length ? `${vids.length} videos as recorded, back to back` : input.cut?.length ? `First cut (${input.cut.length} words removed)` : "Footage as recorded";
  return { v, more, vids: vids as NonNullable<(typeof vids)[number]>[], timeline, aspect, name, snap, note, transcript };
}

/**
 * Creates an edit. Version 1 is the footage as recorded and nothing else: no style, no captions, no cuts (only words
 * the user removed on the footage page). A reference (a style, a gallery recipe or a reference video; `styleId` from
 * the connector is a style reference) is attached for the user's AI to read. Rendrr never applies it. Several videos
 * (videoIds, in order): the first is the edit's footage, the others follow it whole on V1.
 */
export async function createProject(userId: string, input: { videoId?: string; videoIds?: string[]; styleId?: string | null; reference?: { kind: ReferenceRef["kind"]; id: string } | null; name?: string | null; folderId?: string | null; cut?: string[]; aspect?: string; length?: number }, opts: { actorKind?: "user" | "claude" | "chatgpt" } = {}) {
  const asked = input.reference ?? (input.styleId ? { kind: "style" as const, id: input.styleId } : null);
  const reference = asked ? await resolveReference(userId, asked) : null;
  const folderId = (await ownFolder(userId, input.folderId)) ?? (await defaultFolderId(userId));
  const { v, timeline, aspect, name, snap, note, transcript } = await firstCut(userId, input);
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

/**
 * An edit waiting for its footage (Recreate opens the editor at once): a hidden placeholder stands in for the footage
 * until the user adds theirs (useFootage). The reference is attached and the edit has the shape asked for (the gallery
 * video's), so the footage is framed to it when it comes.
 */
export async function createWaitingEdit(userId: string, input: { reference?: { kind: ReferenceRef["kind"]; id: string } | null; name?: string | null; folderId?: string | null; aspect?: string }) {
  const aspect = (ASPECTS as readonly string[]).includes(input.aspect || "") ? (input.aspect as Aspect) : "9:16";
  const { width, height } = aspectSize(aspect, 1080);
  const name = (input.name || "").trim().slice(0, 200) || "New edit";
  const v = await prisma.video.create({ data: {
    userId, name: `${name} (waiting for footage)`.slice(0, 200), kind: "canvas", source: "placeholder", status: "ready", seconds: 30, width, height, fps: 30,
    orientation: orientationOf(width, height), hasAudio: false, art: "a",
    analysis: { create: { transcriber: "none", transcript: [], silences: [], sceneCuts: [] } },
  } });
  return createProject(userId, { videoId: v.id, name, folderId: input.folderId, aspect, reference: input.reference });
}

/** True for an edit still waiting for its footage (its footage is the placeholder createWaitingEdit made). */
export const isWaitingFootage = (v: { source: string; kind: string } | null | undefined) => v?.kind === "canvas" && v?.source === "placeholder";

/**
 * The footage of an edit that was waiting for it: the videos the user picked become the edit's footage, version 1 is
 * made again from them (as a new edit's), and the placeholder goes. The edit keeps its name, folder, shape and reference.
 */
export async function useFootage(userId: string, projectId: string, videoIds: string[]) {
  const p = await getOwnedProject(userId, projectId);
  const old = await prisma.video.findUnique({ where: { id: p.videoId } });
  if (!isWaitingFootage(old)) throw new AppError("This edit has its footage already. Add more with Add clips.", 409, "has-footage");
  const { v, timeline, snap, note, transcript } = await firstCut(userId, { videoIds, name: p.name, aspect: p.aspect });
  const keep = { ...snap, name: p.name, aspect: p.aspect as Snapshot["aspect"] };
  await prisma.$transaction([
    prisma.projectVersion.deleteMany({ where: { projectId: p.id } }),
    prisma.project.update({ where: { id: p.id }, data: {
      videoId: v.id, art: v.art, status: "Draft", currentVersion: 1, timeline: timeline as unknown as Prisma.InputJsonValue,
      outputSeconds: Math.round(outputDuration(timeline, allWords(transcript)) * 100) / 100,
      versions: { create: { v: 1, note, timeline: keep as unknown as Prisma.InputJsonValue, createdBy: "user", sealed: true } },
    } }),
  ]);
  await prisma.video.delete({ where: { id: old!.id } }).catch(() => {});
  return prisma.project.findUniqueOrThrow({ where: { id: p.id } });
}

/** The styles these ids name, by id (only those: never every user's styles). */
export async function stylesById(ids: (string | null | undefined)[]) {
  const want = [...new Set(ids.filter((x): x is string => !!x))];
  return new Map((want.length ? await prisma.style.findMany({ where: { id: { in: want } } }) : []).map((s) => [s.id, s]));
}

export async function listProjects(userId: string) {
  const ps = await prisma.project.findMany({ where: { userId, deletedAt: null }, orderBy: { updatedAt: "desc" }, include: { video: true, folder: true } });
  const styles = await stylesById(ps.map((p) => p.styleId));
  return Promise.all(ps.map(async (p) => ({ ...projectOut(p), style: p.styleId && styles.get(p.styleId) ? styleOut(styles.get(p.styleId)!) : undefined, video: await videoOut(p.video), folder: folderOut(p.folder) })));
}

/** Latest finished render of each kind for a project version (or any version). */
export async function latestRender(projectId: string, kind: "preview" | "final", version?: number) {
  return prisma.render.findFirst({ where: { projectId, kind, status: "done", outputKey: { not: null }, ...(version ? { version } : {}) }, orderBy: { createdAt: "desc" } });
}

/** The videos measured as filmed sideways, with the clockwise turn that makes them upright (the editor offers it). */
async function sidewaysOf(ids: string[]): Promise<Record<string, number>> {
  const rows = await prisma.footageAnalysis.findMany({ where: { videoId: { in: ids } }, select: { videoId: true, vision: true } });
  return Object.fromEntries(rows.map((r) => [r.videoId, (r.vision as { turned?: number } | null)?.turned ?? 0]).filter(([, t]) => t));
}

/** Engine Part 6: a link to each video's 10 ms sound peaks (the deep measurements' audio.bin: 4 bytes per 10 ms), for
 *  the timeline's waveform. Videos not measured yet have none. */
async function peaksOf(videoIds: string[]): Promise<Record<string, string>> {
  const rows = await prisma.footageAnalysis.findMany({ where: { videoId: { in: videoIds } }, select: { videoId: true, audio: true } });
  const out: Record<string, string> = {};
  for (const r of rows) { const key = (r.audio as { key?: string } | null)?.key; if (key) out[r.videoId] = await signGet(key, 6 * 3600); }
  return out;
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
  // "Send to Claude": each comment says when it was last sent and to which AI.
  const sent = await sentByComment(p.id);
  const comments = [
    ...reviews.flatMap((r) => r.comments.filter((c) => !c.projectId || c.projectId === p.id)).map(commentOut),
    ...(await Promise.all(notes.map((n) => noteOut(n, owner.name)))),
  ].map((c) => (sent[c.id] ? { ...c, sent: sent[c.id] } : c)).sort((a, b) => a.time - b.time || a.at - b.at);
  const preview = await latestRender(p.id, "preview");
  const final = await latestRender(p.id, "final");
  // The editor always works on a sequence: a project still stored in model A is shown converted (it is stored
  // converted at its next save).
  const transcript = (video.analysis?.transcript as unknown as Transcript) || [];
  const timeline = asSequence(p.timeline as unknown as Snapshot["timeline"], allWords(transcript), p.videoId, video.seconds);
  return {
    ...(await playerMedia(userId, timeline)),
    videos: await playerVideos(userId, timeline, p.videoId), // the other videos on V1
    sideways: await sidewaysOf([p.videoId, ...otherVideoIds(timeline, p.videoId)]), // footage measured as filmed sideways
    peaks: await peaksOf([p.videoId, ...otherVideoIds(timeline, p.videoId)]), // each video's 10 ms sound peaks, for the waveform
    ...projectOut(p),
    style: style ? styleOut(style) : undefined,
    video: { ...(await videoOut(video)), proxyUrl: video.proxyKey && video.status !== "expired" ? await signGet(video.proxyKey, 6 * 3600) : null },
    waiting: isWaitingFootage(video), // Recreate: no footage yet; the first video the user adds becomes it
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
  // b-roll, the library video behind V1 (set_background videoId) and videos inside text (Phase 2b).
  const brollIds = libraryVideoIds(tl);
  const vids = brollIds.length ? await prisma.video.findMany({ where: { id: { in: brollIds }, userId, proxyKey: { not: null } } }) : [];
  // The user's own audio files the edit uses (own music, the voice): the plan needs their keys and lengths, the
  // player their links.
  const soundIds = Array.from(new Set([...tl.tracks.a2.map((c) => (c as { soundId?: string }).soundId), (tl as { voice?: { soundId?: string } | null }).voice?.soundId].filter((x): x is string => !!x)));
  const own = soundIds.length ? await prisma.sound.findMany({ where: { id: { in: soundIds }, userId, status: "ready" } }) : [];
  return {
    sounds: Object.fromEntries(own.map((s) => [s.id, { key: s.key, seconds: s.seconds, name: s.name }])),
    brollMedia: Object.fromEntries(await Promise.all(vids.map(async (v) => [v.id, { url: await signGet(v.proxyKey!, 6 * 3600), seconds: v.seconds }] as const))),
    graphicClipMedia: Object.fromEntries(await Promise.all((await graphicPlacements(userId, tl)).filter((x) => "key" in x).map(async (x) => [x.clipId, { url: await signGet((x as { key: string }).key, 6 * 3600), width: x.width, height: x.height, seconds: x.seconds }] as const))),
    audioMedia: Object.fromEntries(await Promise.all(Array.from(new Set([
      ...tl.tracks.a2.map((c) => catalogMusic(c as { trackId?: string; assetKey?: string })?.key),
      ...tl.tracks.a3.map((c) => catalogSfx(c as { sfxId?: string; assetKey?: string })?.key),
      ...own.map((s) => s.key),
    ].filter((k): k is string => !!k))).map(async (k) => [k, await signGet(k, 6 * 3600)] as const))),
  };
}

/** Each custom graphic placement: the storage key of the file it plays, or why there is none yet (state). */
export async function graphicPlacements(userId: string, tl: Snapshot["timeline"]) {
  const clips = (tl.tracks.v3 as V3Clip[]).filter((c) => c.kind === "graphic" && c.graphicId && !findTemplate(c.graphicId));
  if (!clips.length) return [];
  const gs = await prisma.graphic.findMany({ where: { id: { in: Array.from(new Set(clips.map((c) => c.graphicId!))) }, ownerId: userId, kind: { in: ["custom", "element"] } },
    select: { id: true, ownerId: true, paramsSchema: true, status: true, renderedKey: true, error: true, durationSec: true, width: true, height: true } });
  const out = await Promise.all(clips.map(async (c) => {
    const g = gs.find((x) => x.id === c.graphicId);
    return g ? { clipId: c.id, own: !!c.params && Object.keys(c.params).length > 0, width: g.width, height: g.height, seconds: g.durationSec, ...(await placementMedia(g, c.params)) } : null;
  }));
  return out.filter((x): x is NonNullable<typeof x> => !!x);
}

/** Deletes the stored files of these edits (renders, frames, raw originals) before their rows are removed. */
export async function purgeProjectFiles(where: Prisma.ProjectWhereInput) {
  const ps = await prisma.project.findMany({ where, select: { id: true, userId: true } });
  const ids = ps.map((p) => p.id);
  if (!ids.length) return;
  // Comments' drawings and pictures (the app in the chat).
  for (const p of ps) await deleteEditCommentFiles(p.userId, p.id).catch(() => {});
  const renders = await prisma.render.findMany({ where: { projectId: { in: ids } }, select: { outputKey: true, framesKeys: true, plan: true } });
  await deleteObjects(renders.flatMap(renderFileKeys));
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
