// The marks an AI reads (mark_silences, mark_fillers, list_marks, get_retakes): Rendrr's, worked out from each
// video's stored analysis, and the AI's own from the edit. Read only: nothing here changes a video or an edit.
import { AppError, notFound } from "@rendrr/core";
import { prisma } from "@rendrr/db";
import { allWords, asSequence, findRetakes, footageInputOf, layoutTimeline, marksOf, sequenceView, type FootageInput, type MarkRow, type RetakeGroup, type SequenceView, type Timeline, type Transcript } from "@rendrr/shared";
import { getOwnedProject } from "./projects";

export type MarkScope = {
  /** What the marks are on, for the text ("Talk" or edit "My edit"). */
  title: string;
  inputs: FootageInput[];
  names: Record<string, string>;
  timeline: Timeline | null;
  view: SequenceView | null;
};

const notReady = (name: string, status: string) => new AppError(`"${name}" is ${status}: its marks come from the analysis, ready once the video is.`, 409, "not-ready");

/** The videos of an edit (its footage and every other video on V1), or one video. videoId with projectId: that one. */
export async function markScope(userId: string, i: { projectId?: string; videoId?: string }): Promise<MarkScope> {
  if (i.projectId) {
    const p = await getOwnedProject(userId, i.projectId);
    const main = await prisma.video.findUniqueOrThrow({ where: { id: p.videoId }, include: { analysis: true } });
    if (!main.analysis) throw notReady(main.name, main.status);
    const words = allWords((main.analysis.transcript as unknown as Transcript) || []);
    const tl = layoutTimeline(asSequence(p.timeline as unknown as Timeline, words, p.videoId), words);
    const ids = Array.from(new Set((tl.tracks.v1 as { sourceVideoId?: string }[]).map((c) => c.sourceVideoId).filter((v): v is string => !!v && v !== main.id)));
    const others = ids.length ? await prisma.video.findMany({ where: { id: { in: ids }, userId }, include: { analysis: true } }) : [];
    let vids = [main, ...others.filter((o) => o.analysis)];
    if (i.videoId) {
      vids = vids.filter((v) => v.id === i.videoId);
      if (!vids.length) throw notFound(`Video ${i.videoId} is not in this edit (its footage and the videos on V1 are). Leave videoId out for all of them.`);
    }
    return { title: `edit "${p.name}"`, inputs: vids.map((v) => footageInputOf(v.id, v.analysis, v.seconds)), names: Object.fromEntries(vids.map((v) => [v.id, v.name])), timeline: tl, view: sequenceView(tl, words) };
  }
  if (!i.videoId) throw new AppError("Send projectId (an edit) or videoId (a video).", 400, "invalid-input");
  const v = await prisma.video.findUnique({ where: { id: i.videoId }, include: { analysis: true } });
  if (!v || v.userId !== userId) throw notFound("That video is not in the library. Use list_footage for the ids.");
  if (!v.analysis) throw notReady(v.name, v.status);
  return { title: `"${v.name}"`, inputs: [footageInputOf(v.id, v.analysis, v.seconds)], names: { [v.id]: v.name }, timeline: null, view: null };
}

/** The marks in from/to: footage seconds, or edit seconds with edit true (only for an edit). */
export function inRange(rows: MarkRow[], i: { from?: number; to?: number; edit?: boolean }, scope: MarkScope): MarkRow[] {
  if (i.from == null && i.to == null) return rows;
  if (i.edit && !scope.view) throw new AppError("edit true needs projectId (edit seconds belong to an edit).", 400, "invalid-input");
  const a = i.from ?? 0, b = i.to ?? Infinity;
  return rows.filter((r) => {
    const s = i.edit ? r.edit?.start : r.start, e = i.edit ? r.edit?.end : r.end;
    return s != null && e != null && e >= a && s <= b;
  });
}

export function allMarks(scope: MarkScope): MarkRow[] {
  return marksOf(scope.inputs, scope.timeline, scope.view);
}

/** Retakes of each video, with where each take plays in the edit. */
export function retakesOf(scope: MarkScope): (RetakeGroup & { videoId: string })[] {
  return scope.inputs.flatMap((f) => findRetakes(f).map((g) => ({ ...g, videoId: f.videoId })));
}

/** Engine Part 6: the marks on an edit's videos where they play in the edit, for the timeline's lines (hidden ones and
 *  beats left out). */
export async function editorMarks(userId: string, projectId: string) {
  const scope = await markScope(userId, { projectId });
  return allMarks(scope).filter((m) => !m.hidden && m.edit && m.kind !== "music_beat").slice(0, 3000)
    .map((m) => ({ id: m.id, kind: m.kind, source: m.source, label: m.label ?? null, note: m.note ?? null, start: m.edit!.start, end: m.edit!.end }));
}
