// The Transcript tab of the Rendrr app in the chat: the edit's footage word by word, each word in the edit, cut or out
// of it, and where it plays in the render being watched (a tap jumps there). The user cuts words and brings cut ones
// back there; Apply sends them as one change (cut_words and restore_words, the ops the editor and the AI use), a new
// version of the edit made by the user, as a cut in the editor's Transcript tab is.
import { AppError, applyTimelineChange, notFound } from "@rendrr/core";
import { prisma } from "@rendrr/db";
import { allWords, asSequence, editOf, layoutTimeline, sequenceView, type AppTranscript, type AppTranscriptChange, type AppWord, type Op, type SequenceView, type Timeline, type Transcript, type Word } from "@rendrr/shared";
import { appProject } from "./claudeApp";
import { getOwnedProject } from "./projects";

/** More words than this (about five hours of talk) are cut short, said in the note. */
const WORDS_MAX = 40_000;
const r3 = (x: number) => Math.round(x * 1000) / 1000;

/** The view of a timeline: where each footage moment plays. */
function viewOf(timeline: unknown, words: Word[], videoId: string): { tl: Timeline; view: SequenceView } {
  const tl = layoutTimeline(asSequence(timeline as Timeline, words, videoId), words);
  return { tl, view: sequenceView(tl, words) };
}
/** Where a word of the main footage starts playing in an edit (its first moment), or null where it does not play. */
function startsAt(view: SequenceView, main: string, w: Word): number | null {
  const hit = view.pieces.find((p) => p.videoId === main && w.t >= p.srcIn - 1e-6 && w.t < p.srcOut - 1e-6);
  return hit ? r3(editOf(hit, w.t)) : null;
}

/** The transcript as the app shows it, of the edit now; times of the render watched (renderId: one of this edit's). */
export async function appTranscript(userId: string, projectId: string, renderId?: string): Promise<AppTranscript> {
  const p = await getOwnedProject(userId, projectId);
  const video = await prisma.video.findUnique({ where: { id: p.videoId }, select: { name: true, status: true, analysis: { select: { transcript: true } } } });
  const base = { projectId: p.id, name: p.name, version: p.currentVersion, timesOf: { version: p.currentVersion, renderId: null as string | null } };
  if (!video?.analysis) return { ...base, lines: [], counts: { words: 0, cut: 0, out: 0 }, note: `"${video?.name ?? "The footage"}" is still being transcribed: its words show here once it is ready.` };
  const transcript = (video.analysis.transcript as unknown as Transcript) || [];
  const words = allWords(transcript);
  const now = viewOf(p.timeline, words, p.videoId);
  const cut = new Set(now.tl.cut);
  // The times are those of the render watched: its version's edit (a preview of an older version plays that one).
  let times = now.view, timesOf = base.timesOf;
  const r = renderId ? await prisma.render.findFirst({ where: { id: renderId, projectId: p.id }, select: { id: true, version: true } }) : null;
  if (r) {
    timesOf = { version: r.version, renderId: r.id };
    if (r.version !== p.currentVersion) {
      const old = await prisma.projectVersion.findUnique({ where: { projectId_v: { projectId: p.id, v: r.version } }, select: { timeline: true } });
      const tl = (old?.timeline as { timeline?: unknown } | null)?.timeline;
      if (tl) times = viewOf(tl, words, p.videoId).view;
      else timesOf = base.timesOf;
    }
  }
  let n = 0, nCut = 0, nOut = 0;
  const lines = [];
  for (const l of transcript) {
    if (n >= WORDS_MAX) break;
    const ws: AppWord[] = [];
    for (const w of l.words) {
      if (n >= WORDS_MAX) break;
      n++;
      const state = cut.has(w.id) ? "cut" : startsAt(now.view, p.videoId, w) == null ? "out" : "in";
      if (state === "cut") nCut++; else if (state === "out") nOut++;
      ws.push([w.id, w.text, r3(w.t), r3(w.end), state, startsAt(times, p.videoId, w), w.filler ? 1 : 0]);
    }
    if (ws.length) lines.push({ id: l.id, start: r3(l.start), gap: r3(l.gapBefore || 0), words: ws });
  }
  return { ...base, timesOf, lines, counts: { words: n, cut: nCut, out: nOut }, note: words.length > WORDS_MAX ? `The first ${WORDS_MAX} words of ${words.length} show here: the editor's Transcript tab has them all.` : null };
}

/** The user's cuts and words brought back from the app's transcript: one change, a new version of the edit. */
export async function cutFromTranscript(userId: string, i: { projectId: string; cut?: string[]; restore?: string[]; renderId?: string }): Promise<AppTranscriptChange> {
  const p = await getOwnedProject(userId, i.projectId);
  const back = new Set(i.restore ?? []);
  // A word in both lists is brought back (the last thing the user did with it wins in the app; both is an error there).
  const cut = Array.from(new Set((i.cut ?? []).filter((x) => !back.has(x))));
  const restore = Array.from(back);
  if (!cut.length && !restore.length) throw new AppError("Pick words to cut or bring back first.", 400, "invalid-input");
  const video = await prisma.video.findUnique({ where: { id: p.videoId }, select: { analysis: { select: { transcript: true } } } });
  if (!video?.analysis) throw notFound("This edit's footage has no transcript yet.");
  const known = new Set(allWords((video.analysis.transcript as unknown as Transcript) || []).map((w) => w.id));
  const gone = [...cut, ...restore].filter((x) => !known.has(x));
  if (gone.length === cut.length + restore.length) throw new AppError("Those words are not in this edit's transcript. Load it again.", 400, "invalid-input");
  const ops: Op[] = [];
  const toCut = cut.filter((x) => known.has(x)), toRestore = restore.filter((x) => known.has(x));
  if (toCut.length) ops.push({ op: "cut_words", wordIds: toCut } as Op);
  if (toRestore.length) ops.push({ op: "restore_words", wordIds: toRestore } as Op);
  const res = await applyTimelineChange(p.id, ops.length === 1 ? ops[0] : ({ op: "batch", ops } as Op), { kind: "user", userId });
  const [transcript, view] = await Promise.all([appTranscript(userId, p.id, i.renderId), appProject(userId, p.id, i.renderId)]);
  return { transcript, view, summary: res.summary, version: res.version, changed: !res.unchanged, cut: toCut.length, restored: toRestore.length };
}
