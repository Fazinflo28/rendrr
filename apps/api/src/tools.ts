// The AI tools, implemented on the API server. The MCP server forwards each call here with the user it verified.
// Every response is small text; images only when asked for (images: true, get_frames, get_preview_frames).
// Every write goes through applyTimelineChange.
import { AppError, applyTimelineChange, clearVariantErrors, enqueue, graphicFailedOnServer, notFound, prewarmGraphics, putObject, readGraphic, recordGraphicAgain, restoreVersion, signGet, type BreakdownJob, type ChangeActor, type GraphicJob, type HeardJob } from "@rendrr/core";
import { prisma, Prisma } from "@rendrr/db";
import {
  AddFontInput, AddLutInput, allWords, asSequence, breakdownAsText, CreateGraphicInput, customParamsSchema, describeRules, graphicDefaults, editCheck, editOf, EditOpSchema, StyleRulesPatchSchema, fmtClock, fmtT, srcAt, GRAPHIC_TEMPLATES, mergeRules, MUSIC_TRACKS, outputDuration, sequenceView, SFX,
  heardDiff, heardDiffLine, wordsAsPlayed, type HeardTranscript, EDITING_SKILL,
  ASPECT_RATIO, aspectSize, type Aspect, type CaptionLook, MARK_KINDS, MCP_TOOLS, EDIT_OP_NAMES, RETIRED_OPS, styleGuidance, alignedMap, alignmentDiffs, clipEdges, deepAudioText, visionText, sidewaysText, PREFIX, type Alignment, marksText, markInEdit, footageInputOf, footageMarks, sheetsIn, StyleRulesSchema, summarizeTimeline, transcriptAsText, unknownEditFields, type Breakdown, type ReferenceRef, type EditOp, type FileLoudness, type FileMeasure, type Sheet, type Silence, type Snapshot, type StyleRules, type Timeline, type Transcript, type VideoKind, type V3Clip,
} from "@rendrr/shared";
import { otherSources, otherVideoIds } from "./services/sequence";
import { copyProject, createFolder, createProject, getOwnedProject, graphicPlacements, resolveReference } from "./services/projects";
import { samplesOut, samplesView, startSamples } from "./services/samples";
import type { AppOpen } from "@rendrr/shared";
import { createCanvas } from "./services/canvas";
import { addFont, fetchFont, fontsText, listFonts } from "./services/fonts";
import { lutSource, lutsText, lutUploadLink, resolveLutRefs, saveLut } from "./services/luts";
import { renderResult, renderStatus, startRender } from "./services/render";
import { redeemLinkCode } from "./services/logins";
import { createReviewLink } from "./routes/reviews";
import { framesFor, videoFramesFor } from "./services/frames";
import { lutsFor, speakerCentres, withMeasurements } from "./services/color";
import { allMarks, inRange, markScope, retakesOf } from "./services/marks";
import { audioFramesOf, deepOf, visionDetailsOf } from "./services/deep";
import { waveformPng } from "./services/waveform";
import { testGraphic } from "./services/testGraphic";
import { graphicUploadLink, rerecordFirst, resolveGraphic, saveGraphic } from "./services/graphicCode";
import { addLibraryItem, getLibraryItem, listLibrary, searchIcons, withIcons } from "./services/library";
import { analyzeReference, styleFileLines, styleFileOut } from "./services/styleFiles";
import { openProjects } from "./services/claudeApp";
import { allowSavingText, askDriveSave, driveLine, driveTarget, fileNameFor, latestFinal } from "./services/driveSave";
import { resolveMulticam, resolveMulticamAuto } from "./services/multicam";
import { ensureLibraryFolderPath, findLibraryFolder, folderFootage, listLibraryFolders, moveVideos, projectFromLibraryFolder } from "./services/libraryFolders";
import { syncDriveFolder, syncText } from "./services/driveLibrary";
import { footageFromSource, footageText, footageUploadLink, intoEdit, resolveFootageRefs, waitForFootage } from "./services/footage";
import { resolveSoundRefs, soundFromSource, soundLine, soundOut, soundsText, soundUploadLink } from "./services/sounds";
import { drawingText, storedDrawing, storedImages } from "./services/commentMedia";

export type ToolOut = { text: string; images?: string[]; data?: unknown };
/** loginId: the Clerk user who called (a linked login opens its account's userId). */
export type ToolCtx = { userId: string; loginId?: string; ai: "claude" | "chatgpt" | null; aiName?: string };
type Ctx = ToolCtx;

const MAX_CHARS = 24_000; // ~6k tokens
export const clip = (s: string) => (s.length > MAX_CHARS ? s.slice(0, MAX_CHARS) + "\n…(cut to stay short; ask for a narrower range)" : s);
const actorFor = (c: Ctx, toolName: string, input: unknown): ChangeActor => ({ kind: c.ai === "chatgpt" ? "chatgpt" : "claude", userId: c.userId, ai: c.aiName, toolName, input });
const aiName = (c: Ctx) => (c.ai === "chatgpt" ? "ChatGPT" : "Claude");
const WEB = () => (process.env.PUBLIC_WEB_URL || "").replace(/\/$/, "");

async function ownedVideo(userId: string, id: string) {
  const v = await prisma.video.findUnique({ where: { id }, include: { analysis: true } });
  if (!v || v.userId !== userId) throw notFound("That video is not in the library. Use list_footage for the ids.");
  return v;
}
type OwnedVideo = Awaited<ReturnType<typeof ownedVideo>>;

/** Which Rendrr account this connection uses, so a user with two logins can tell. */
/** get_footage: the deeper measurements in a few lines (get_audio and get_vision have the rest), or when they are
 *  not there yet, that they are being made and how long it takes. words: each word whose edges in the sound differ. */
async function deepLines(userId: string, videoId: string, words: ReturnType<typeof allWords>, wordsDetail: boolean, range: { from?: number; to?: number } = {}): Promise<string[]> {
  const d = await deepOf(userId, videoId).catch(() => null);
  if (!d) return [];
  if (!d.ready) return [`DEEPER MEASUREMENTS: ${d.note}`];
  const out: string[] = [];
  const a = d.audio, v = d.vision, al = d.alignment;
  if (a) out.push(`SOUND (get_audio): ${a.lufs != null ? `${a.lufs} LUFS, ` : ""}true peak ${a.truePeakDb ?? "?"} dBTP, room ${a.roomDb} dBFS, voice ${a.speechDb} dBFS, speech ${Math.round(a.speechShare * 100)}%; ${a.breaths.length} breaths, ${a.clicks.length} clicks, ${a.clipping.length} clipped stretches.`);
  if (al) {
    const diffs = alignmentDiffs(al, words);
    out.push(`ALIGNMENT (${al.model ? "wav2vec2, then moved onto the sound" : "edges moved onto the sound"}${al.error ? `; ${al.error}` : ""}): ${al.words.length} of ${words.length} words placed in the sound; ${diffs.length} differ from the transcriber's times by more than 60 ms.${diffs.length && !wordsDetail ? ' detail "words" lists them.' : ""} Cut on the sound's times.`);
    const a0 = range.from ?? 0, b0 = range.to ?? Infinity;
    const shown = diffs.filter((w) => w.e >= a0 && w.s <= b0);
    if (wordsDetail && shown.length) out.push(`WORDS IN THE SOUND${range.from != null || range.to != null ? ` in ${a0}-${range.to ?? "end"}s` : ""} (id text start-end, transcriber's a-b): ${shown.slice(0, 400).map((w) => `${w.id} ${w.text} ${w.s.toFixed(3)}-${w.e.toFixed(3)} (${w.t.toFixed(3)}-${w.end.toFixed(3)})`).join(", ")}${shown.length > 400 ? `, …${shown.length - 400} more: narrow from/to` : ""}`);
  }
  if (v?.turned) out.push(`SIDEWAYS: ${sidewaysText(v)}`);
  if (v) out.push(`PICTURE (get_vision): face on screen ${Math.round(v.faces.present * 100)}%, lost ${v.faces.lost.length}x, looking away ${v.faces.offCamera.length}x, soft ${v.sharpness.soft.length}x, shaky ${v.shake.shaky.length}x, dark ${v.light.dark.length}x, blown out ${v.light.blown.length}x.`);
  return out;
}

async function accountLine(userId: string) {
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { email: true } });
  return `Account ${u?.email || "unknown"}.`;
}
const EMPTY_HINT = "If the user has videos on the Rendrr website, this login opens another account: ask them for a code from Rendrr > Connect AI > Link another login, then call link_account.";
const pageOf = <T,>(rows: T[], i: { offset?: number; limit?: number }) => {
  const offset = i.offset ?? 0, limit = i.limit ?? 20;
  const shown = rows.slice(offset, offset + limit);
  const more = rows.length - offset - shown.length;
  return { shown, offset, more, tail: more > 0 ? `\n${more} more: offset ${offset + shown.length}.` : "" };
};

/** The stored breakdown with the video's current name, kind and filler count (all can change after it was made). */
export function breakdownOf(v: OwnedVideo): Breakdown | null {
  const b = v.analysis?.breakdown as unknown as Breakdown | null;
  const fillers = allWords((v.analysis?.transcript as unknown as Transcript) || []).filter((w) => w.filler).length;
  return b?.v ? { ...b, video: { ...b.video, name: v.name, kind: (v.kind as VideoKind) || "footage" }, pacing: { ...b.pacing, fillers } } : null;
}

/**
 * The breakdown text, and pictures only when asked for: images true attaches the overview sheet (16 frames across
 * the whole video), or with from/to the frame sheets of that range. What an AI reads instead of watching.
 */
async function videoAsCode(v: OwnedVideo, o: { from?: number; to?: number; images?: boolean } = {}): Promise<{ text: string; images: string[] }> {
  const b = breakdownOf(v);
  if (!b) {
    const kf = !o.images ? [] : ((v.analysis?.keyFrames as { t: number; key: string }[]) || []).slice(0, 3);
    return { text: `BREAKDOWN not ready yet for "${v.name}" (Rendrr makes it right after the transcript; ask again in a minute).${kf.length ? ` Key frames at ${kf.map((k) => k.t.toFixed(1) + "s").join(", ")} attached.` : ""}`, images: await Promise.all(kf.map((k) => signGet(k.key, 900))) };
  }
  const all = b.frames.sheets;
  const more = "More: images true with from/to, or get_frames.";
  let pics: Sheet[] = [];
  let note: string;
  if (!all.length) note = "PICTURES none: the frame sheets went with the expired preview copy; the text still holds.";
  else if (!o.images) note = "IMAGES none (images true attaches the overview sheet, or the frame sheets of from/to).";
  else if (o.from != null || o.to != null) {
    pics = sheetsIn(b, o.from ?? 0, o.to ?? 1e9, 4);
    const left = all.filter((s) => s.to >= (o.from ?? 0) && s.from <= (o.to ?? 1e9)).length - pics.length;
    note = `ATTACHED ${pics.map((s) => `sheet ${all.indexOf(s) + 1} ${fmtT(s.from)}-${fmtT(s.to)}`).join(", ")}${left > 0 ? `; ${left} more in this range: narrow from/to` : ""}.`;
  } else {
    const ov = b.frames.overview ?? (all.length === 1 ? all[0] : null);
    if (ov) { pics = [ov]; note = `ATTACHED overview: ${ov.times.length} frames across the whole video. ${more}`; }
    else {
      // A breakdown made before overview sheets existed: show the first sheet now and make the overview.
      pics = [all[0]];
      note = `ATTACHED sheet 1 (${fmtT(all[0].from)}-${fmtT(all[0].to)}); the overview is being made. ${more}`;
      if (v.status === "ready" && v.proxyKey) await enqueue<BreakdownJob>("breakdown", { videoId: v.id }, { jobId: `breakdown-${v.id}-overview` }).catch(() => {});
    }
  }
  return { text: `${breakdownAsText(b, { from: o.from, to: o.to })}\n${note}`, images: await Promise.all(pics.map((s) => signGet(s.key, 900))) };
}

/** A saved recipe (a gallery video the user recreated, or one whose author allows it): its rhythm, as JSON, and up to 3 frames. */
async function recipeOut(c: Ctx, refId: string): Promise<ToolOut | null> {
  const g0 = await prisma.galleryItem.findUnique({ where: { id: refId } });
  const shared = !!g0 && (g0.userId === c.userId || g0.allowRecreate);
  const r0 = await prisma.reference.findUnique({ where: { id: refId } });
  const r = r0 && (r0.userId === c.userId || shared) ? r0 : null;
  const g = r ? null : shared ? g0 : null;
  if (!r && !g) return null;
  const frames: string[] = [];
  const projectId = g?.projectId ?? g0?.projectId;
  if (projectId) {
    const rr = await prisma.render.findFirst({ where: { projectId, status: "done", outputKey: { not: null } }, orderBy: { createdAt: "desc" } });
    for (const k of ((rr?.framesKeys as string[]) || []).slice(0, 3)) frames.push(await signGet(k, 900));
  }
  return { text: `RECIPE "${r?.name ?? g!.title}" (match the rhythm, not the footage): ${JSON.stringify(r?.recipe ?? g!.recipe)}`, images: frames };
}

/** The reference the user attached to an edit, for the AI to read (Rendrr never applies it). */
/** The project bin (the editor's Media panel): library videos kept with the edit to use (add_media). */
async function binLine(userId: string, tl: Timeline): Promise<string[]> {
  if (!tl.media?.length) return [];
  const vs = await prisma.video.findMany({ where: { id: { in: tl.media }, userId }, select: { id: true, name: true, seconds: true, kind: true } });
  return [`Project bin (add_media / remove_media; add_clip videoId puts one in the edit): ${tl.media.map((id) => { const v = vs.find((x) => x.id === id); return v ? `${v.id} "${v.name}" ${v.seconds.toFixed(1)}s${v.kind === "reference" ? " (reference)" : ""}` : `${id} (gone)`; }).join("; ")}`];
}

function referenceLine(ref: ReferenceRef | null): string | null {
  if (!ref) return null;
  const how = ref.kind === "style" ? `style ${ref.id} "${ref.name}" (get_style)` : `${ref.kind === "recipe" ? "recipe" : "reference video"} ${ref.id} "${ref.name}" (get_footage)`;
  return `Reference the user attached, not applied: ${how}. Read it and make your own edits.`;
}

/** Rules a style saved by an AI starts from: nothing cut, clean captions, no zooms, no music. */
const PLAIN_RULES: StyleRules = StyleRulesSchema.parse({ cutSilencesOver: null, removeFillers: false, captions: { on: true, look: "clean", wordsAtOnce: 6 }, zoom: { mode: "none", scale: 1 }, music: { mood: null, gainDb: -20 } });

/** The edit list checked one by one, with the first problem said plainly ("Edit 3 (add_zoom): end is required"). */
function parseEdits(raw: unknown[]): EditOp[] {
  return raw.map((e, n) => {
    // The op is free text in the tool (an app's old copy of the tool must not hide newer ops): checked here.
    const op0 = (e as { op?: unknown })?.op;
    if (typeof op0 !== "string" || !(EDIT_OP_NAMES as readonly string[]).includes(op0) && !(RETIRED_OPS as readonly string[]).includes(op0))
      throw new AppError(`Edit ${n + 1}: no op "${String(op0)}". The ops are: ${EDIT_OP_NAMES.join(", ")} (their fields: the apply_edits description or rendrr://how-to-edit). Nothing was changed.`, 400, "invalid-edit");
    const extra = unknownEditFields(e);
    if (extra.unknown.length) throw new AppError(`Edit ${n + 1} (${(e as { op: string }).op}): unknown field${extra.unknown.length > 1 ? "s" : ""} ${extra.unknown.join(", ")}; it takes ${extra.known.join(", ")}. Nothing was changed.`, 400, "invalid-edit");
    const r = EditOpSchema.safeParse(e);
    if (r.success) return r.data;
    const op = (e as { op?: string })?.op;
    const iss = r.error.issues[0];
    throw new AppError(`Edit ${n + 1}${op ? ` (${op})` : ""}: ${iss.path.length ? iss.path.join(".") + " " : ""}${iss.message.charAt(0).toLowerCase() + iss.message.slice(1)}. Nothing was changed.`, 400, "invalid-edit");
  });
}

/** Runs a list of edits as one version and leaves a message with the steps (and the AI's note) in the editor's AI tab. */
async function applyEdits(c: Ctx, projectId: string, edits: EditOp[], note: string | undefined, input: unknown): Promise<ToolOut> {
  const p0 = await getOwnedProject(c.userId, projectId);
  if (!edits.length) {
    if (!note?.trim()) throw new AppError("Send at least one edit, or a note for the user.");
    await prisma.aiChatMessage.create({ data: { projectId, userId: c.userId, role: "ai", ai: aiName(c), text: note.trim().slice(0, 600) } });
    return { text: "Note posted in Rendrr's AI tab.", data: { version: p0.currentVersion } };
  }
  // set_reference is kept on the project (the editor's Reference monitor), not in the edit.
  const refs = edits.filter((e) => e.op === "set_reference") as Extract<EditOp, { op: "set_reference" }>[];
  let refText = "";
  for (const r of refs) {
    const ref = r.videoId ? await resolveReference(c.userId, { kind: "video", id: r.videoId }) : r.styleId ? await resolveReference(c.userId, { kind: "style", id: r.styleId }) : null;
    await prisma.project.update({ where: { id: projectId }, data: { reference: ref ? (ref as unknown as Prisma.InputJsonValue) : Prisma.DbNull } });
    refText = ref ? `Reference set: ${ref.kind === "video" ? "video" : "style"} "${ref.name}" (shown in the editor's Reference monitor, never applied).` : "Reference taken off.";
  }
  edits = edits.filter((e) => e.op !== "set_reference");
  if (refs.length && !edits.length) return { text: refText, data: { version: p0.currentVersion } };
  // The activity log keeps the edits, but long lists (clips, word ids) only as counts.
  const logged = { ...(input as object), edits: edits.map((e) => (e.op === "set_clips" ? { ...e, clips: e.clips.length } : "wordIds" in e && (e.wordIds?.length ?? 0) > 50 ? { ...e, wordIds: e.wordIds!.length } : e.op === "set_grade" && e.lut?.cube ? { ...e, lut: { ...e.lut, cube: `${e.lut.cube.length} characters` } } : e)) };
  // Phase 6: match_color gets the clips' measured frames (the worker reads them; a failure stops here, loudly).
  // Phase 10: multicam angles sent without an offset are synced (phase 22: by timecode, else by their sound).
  const mainVid = (p0.timeline as unknown as Timeline).mainVideoId || p0.videoId;
  // Footage named by a Google Drive file or a link (not yet in the library) is brought in first.
  const withFootage = await resolveFootageRefs(c.userId, edits, { projectId, ai: c.ai === "chatgpt" ? "chatgpt" : "claude" });
  const synced = await resolveMulticam(c.userId, mainVid, await resolveSoundRefs(c.userId, await resolveLutRefs(c.userId, await rerecordFirst(c.userId, withFootage)), c.ai ?? undefined));
  const ready = await withMeasurements(projectId, withIcons(await resolveMulticamAuto(c.userId, mainVid, p0.timeline as unknown as Timeline, synced)));
  const luts = ready.some((e) => e.op === "match_color") ? await lutsFor(c.userId, p0.timeline as unknown as Timeline) : undefined;
  const r = await applyTimelineChange(projectId, ready.length === 1 ? ready[0] : { op: "batch", ops: ready }, actorFor(c, "apply_edits", logged), { luts });
  const v = await prisma.video.findUniqueOrThrow({ where: { id: p0.videoId }, include: { analysis: true } });
  const out = outputDuration(r.snapshot.timeline, allWords((v.analysis?.transcript as unknown as Transcript) || []));
  if (r.unchanged) return { text: `Nothing changed (still v${r.version}): ${r.summary}.`, data: { version: r.version } };
  const steps = r.summary.split("; ");
  await prisma.aiChatMessage.create({ data: { projectId, userId: c.userId, role: "ai", ai: aiName(c), text: (note?.trim() || `Made ${steps.length === 1 ? "a change" : steps.length + " changes"}.`).slice(0, 600), workflow: steps.map((x) => x.charAt(0).toUpperCase() + x.slice(1)) as unknown as Prisma.InputJsonValue, changed: true } });
  // The edit's own check (no render) rides along, so the AI fixes what it shows before it renders anything.
  const flags = (await checkOf(projectId, r.version, null, null).catch(() => "")).split("\n").find((l) => l.startsWith("Flags:"));
  // Graphics placed: each placement's recording (ready, waiting its turn, recording N%, failed).
  const places = edits.some((e) => e.op === "add_graphic" || e.op === "set_clips") ? (await placementStatus(c.userId, r.snapshot.timeline).catch(() => ({ line: "" }))).line : "";
  return { text: `${refText ? refText + "\n" : ""}Done (v${r.version}, ${out.toFixed(1)}s of ${r.snapshot.timeline.duration.toFixed(1)}s): ${r.summary}.${flags ? `\nEdit check (nothing rendered): ${flags}${flags === "Flags: none" ? "" : " (check_edit lists where)"}.` : ""}${places ? `\n${places}` : ""}`, data: { version: r.version } };
}

type Stretch = { from: number; to: number; videoId?: string };
type V1Row = { id: string; sourceVideoId?: string; sourceIn: number; sourceOut: number; freeze?: number; rotate?: 0 | 90 | 180 | 270; framing?: { scale: number; x: number; y: number; focus?: { x: number; y: number } }; grade?: unknown; effects?: { area?: unknown }[] };

/** Stretches of footage checked before anything is made: each in its video (the user's, ready), at least 0.1 s long. */
async function checkStretches(userId: string, mainId: string, mainSeconds: number, clips: Stretch[], what = "Stretch"): Promise<void> {
  const others = new Map<string, number>();
  for (const vid of new Set(clips.map((c) => c.videoId).filter((v): v is string => !!v && v !== mainId))) {
    const v = await ownedVideo(userId, vid);
    if (v.status !== "ready" || !v.analysis) throw new AppError(`"${v.name}" is not ready yet. Wait until it finishes processing.`, 409, "not-ready");
    others.set(vid, v.seconds);
  }
  clips.forEach((c, k) => {
    const len = !c.videoId || c.videoId === mainId ? mainSeconds : others.get(c.videoId)!;
    if (c.to <= c.from + 0.1) throw new AppError(`${what} ${k + 1} (${fmtClock(c.from)}-${fmtClock(c.to)}) ends before it starts: from and to are seconds in the original footage, to after from.`, 400, "invalid-input");
    if (c.from >= len - 0.05 || c.to > len + 0.05) throw new AppError(`${what} ${k + 1} (${fmtClock(c.from)}-${fmtClock(c.to)}) runs past the end of the footage (${fmtClock(len)}).`, 400, "invalid-input");
  });
}

/**
 * The edits that start an edit (create_project clips/reframe, create_shorts): V1 made of the stretches in order, each
 * carrying the look of the first edit's clip it comes from (turn, grade, whole-picture effects); the shape; reframed on
 * the speaker where the footage's shape is not the frame's (from the faces measured at 10 fps); captions.
 */
async function startEdits(p: { videoId: string; aspect: string; timeline: unknown }, o: { clips?: Stretch[]; aspect?: Aspect; reframe?: boolean; captions?: CaptionLook | "off" }): Promise<{ edits: EditOp[]; reframed: number; of: number; seconds: number }> {
  const tl = p.timeline as Timeline, main = p.videoId;
  const seq = tl.tracks.v1 as unknown as V1Row[];
  const aspect = (o.aspect ?? p.aspect) as Aspect;
  const edits: EditOp[] = [];
  if (aspect !== p.aspect) edits.push({ op: "set_aspect", aspect } as EditOp);
  const tag = Math.random().toString(36).slice(2, 6);
  const rows: { id: string; videoId: string; srcIn: number; srcOut: number; rotate: 0 | 90 | 180 | 270; fresh?: Record<string, unknown> }[] = o.clips?.length
    ? o.clips.map((c, k) => {
      const vid = c.videoId || main;
      const near = seq.find((x) => (x.sourceVideoId || main) === vid && x.sourceIn <= c.from + 1e-3 && c.from < x.sourceOut) ?? seq.find((x) => (x.sourceVideoId || main) === vid);
      const fx = (near?.effects ?? []).filter((e) => !e.area);
      const rotate = near?.rotate ?? 0;
      return { id: `sc${tag}${k + 1}`, videoId: vid, srcIn: c.from, srcOut: c.to, rotate, fresh: { start: c.from, end: c.to, ...(vid !== main ? { videoId: vid } : {}), ...(rotate ? { rotate } : {}), ...(near?.grade ? { grade: near.grade } : {}), ...(fx.length ? { effects: fx } : {}) } };
    })
    : seq.map((x) => ({ id: x.id, videoId: x.sourceVideoId || main, srcIn: x.sourceIn, srcOut: x.freeze ? x.sourceIn + 0.04 : x.sourceOut, rotate: x.rotate ?? 0 }));
  // Reframe only where the footage (as turned) is another shape than the frame.
  let centers: Record<string, { x: number; y: number } | null> = {};
  if (o.reframe) {
    const vids = await prisma.video.findMany({ where: { id: { in: Array.from(new Set(rows.map((r) => r.videoId))) } }, select: { id: true, width: true, height: true } });
    const dims = new Map(vids.map((v) => [v.id, [v.width || 0, v.height || 0]]));
    const other = rows.filter((r) => {
      const [w, h] = dims.get(r.videoId) ?? [0, 0];
      const side = r.rotate === 90 || r.rotate === 270;
      return w > 0 && h > 0 && Math.abs(Math.log((side ? h / w : w / h) / ASPECT_RATIO[aspect])) > 0.05;
    });
    if (other.length) centers = await speakerCentres(other);
  }
  const reframed = Object.values(centers).filter(Boolean).length;
  if (o.clips?.length) {
    edits.push({ op: "set_clips", track: "v1", clips: rows.map((r) => ({ id: r.id, ...r.fresh, ...(centers[r.id] ? { framing: { scale: 1, x: 0, y: 0, focus: centers[r.id] } } : {}) })) } as unknown as EditOp);
  } else if (reframed) {
    edits.push({ op: "set_framing", focus: "face", centers, clipIds: Object.keys(centers).filter((id) => centers[id]) } as EditOp);
  }
  if (o.captions === "off") edits.push({ op: "set_captions", on: false } as EditOp);
  else if (o.captions) edits.push({ op: "set_captions", on: true, look: o.captions } as EditOp);
  const seconds = o.clips?.reduce((a, c) => a + c.to - c.from, 0) ?? 0;
  return { edits, reframed, of: Object.keys(centers).length, seconds };
}
const flagsOf = (text: string) => text.match(/Edit check \(nothing rendered\): (Flags: [^\n]*)/)?.[1] ?? "";

/** The longest a tool call waits for a job: clients drop calls after about a minute (some sooner), so a longer
 *  recording or render answers with its id and is polled (get_graphic, get_render). */
export const TOOL_WAIT_MS = 8_000;
async function waitFor<T>(fn: () => Promise<T | null>, ms: number, every = 1000): Promise<T | null> {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, every)); }
  return null;
}

/** A finished render as text: a preview comes with the check of the edit; nothing to download into the chat. */
/** The edit's voice file (set_voice) and the user's own audio files, for get_project. */
async function soundLines(userId: string, tl: Timeline): Promise<string[]> {
  const out: string[] = [];
  const vo = (tl as { voice?: { soundId: string; start: number; editSeconds?: number } | null }).voice;
  const ss = await prisma.sound.findMany({ where: { userId }, orderBy: { createdAt: "desc" }, take: 10, select: { id: true, name: true, seconds: true, status: true, error: true } });
  if (vo) {
    const s = ss.find((x) => x.id === vo.soundId) ?? (await prisma.sound.findFirst({ where: { id: vo.soundId, userId } }));
    out.push(s ? `Voice: "${s.name}" (${s.seconds.toFixed(3)}s) plays in place of every clip's own sound, from ${vo.start}s of the edit${vo.editSeconds != null ? ` (set when the edit was ${vo.editSeconds}s)` : ""}. set_voice null brings the clips' sound back.` : "Voice: its audio file is gone; the clips' own sound plays. set_voice null clears it.");
  }
  if (ss.length) out.push(`Your audio files (set_voice / add_music soundId): ${ss.map(soundLine).join("; ")}`);
  return out;
}

/** The Drive folder to save into, or what to tell the user instead (not connected, not found, refused). */
async function driveTargetOrText(userId: string, folder: string | undefined, create: boolean | undefined) {
  try { return await driveTarget(userId, folder, create); } catch (e) {
    const err = e as AppError;
    if (err.code === "drive-write") return `${err.message} Nothing was rendered or saved.\n${allowSavingText()}`;
    if (err.code === "drive-folder" || err.code === "drive" || err.code === "drive-off") return `${err.message} Nothing was rendered or saved.`;
    throw e;
  }
}

async function renderOut(renderId: string): Promise<ToolOut> {
  const r = await prisma.render.findUniqueOrThrow({ where: { id: renderId } });
  if (r.kind === "sample") return samplesAnswer(r.userId, r.id, false);
  if (r.status === "failed") return { text: `The ${r.kind} render failed: ${r.error || "unknown error"}${r.errorCode === "need-original" ? "\nAsk the user to open the edit in Rendrr and press Render final; the app will ask for the original file." : ""}${driveLine(r) ? `\n${driveLine(r)}` : ""}` };
  if (r.status !== "done") {
    // Phase 7: where it is and the time left (the worker's estimate), so the AI can say when to look again.
    const st = await renderStatus(r);
    const left = st.etaSec != null ? `, about ${fmtLeft(st.etaSec)} left` : ", estimating the time left";
    const dl = driveLine(r);
    return { text: `The ${r.kind} render is ${st.status === "queued" ? "queued" : `at ${st.percent}% (${st.steps[st.step] ?? "starting"})${left}`} (render id ${r.id}, ${r.quality ?? ""}). get_render {renderId: "${r.id}", wait_seconds: 120} waits for it.${dl ? `\n${dl}` : ""}` };
  }
  const res = await renderResult(r);
  const took = res.renderSeconds != null ? `, rendered in ${res.renderSeconds < 60 ? `${Math.round(res.renderSeconds)} s` : `${Math.floor(res.renderSeconds / 60)} min ${Math.round(res.renderSeconds % 60)} s`}` : "";
  const head = `${r.kind === "final" ? "Final" : "Preview"} v${r.version} ready: ${res.quality}, ${res.size}, ${res.seconds.toFixed(1)}s${took}. ${r.kind === "final" ? "The user downloads it" : "Watch"} in Rendrr: ${WEB()}/editor/${r.projectId}`;
  const dl = driveLine(r);
  // Phase 12: the captions files and YouTube chapters made with a final.
  const extra = [res.files.srt ? `Captions: SRT ${res.files.srt} , WebVTT ${res.files.vtt}` : "", res.chapters ? `YouTube chapters (paste into the description${res.chapterNote.length ? `; YouTube shows none until there are: ${res.chapterNote.join("; ")}` : ""}):\n${res.chapters}` : ""].filter(Boolean).join("\n");
  if (r.kind === "final") return { text: [head, extra, dl].filter(Boolean).join("\n"), data: { renderId: r.id } };
  const plan = r.plan as { loudness?: FileLoudness; measured?: FileMeasure; outputSeconds?: number; operations?: string[]; heard?: HeardTranscript } | null;
  // Phase 6: what the render itself said about HDR and missing LUTs goes into the check.
  const notes = (plan?.operations ?? []).filter((l) => l.startsWith("HDR:") || /^Color: LUT .* left out/.test(l) || /^Graphic \S+ left out/.test(l));
  return { text: `${head}\n${await checkOf(r.projectId, r.version, plan?.loudness ?? null, plan?.measured ?? null, plan?.outputSeconds ?? null, notes, plan?.heard ?? null)}`, data: { renderId: r.id } };
}

/** Samples as Claude reads them, with their pictures (a frame's, a clip's first) once done; the app's data with them. */
async function samplesAnswer(userId: string, renderId: string, images: boolean, lead = ""): Promise<ToolOut> {
  const v = await samplesView(userId, renderId);
  const urls = images && v.status === "done" ? v.items.map((x) => x.still).filter((u): u is string => !!u) : [];
  const said = urls.length ? `\nImages, in order: ${v.items.map((x, k) => `${k + 1}. ${x.kind === "frame" ? "the frame" : "the clip's first frame"}`).join("; ")}` : "";
  const data: AppOpen = { open: null, webUrl: WEB(), samples: v };
  return { text: `${lead}${samplesOut(v)}${said}`, images: urls, data };
}

/** The footage facts the Export line needs (Phase 7). */
// A blank canvas has no picture to scale up: its size is not the final's limit.
const footageOf = (v: { fps: number | null; width: number | null; height: number | null; hdr: string | null; kind?: string }) => ({ fps: v.fps, width: v.kind === "canvas" ? null : v.width, height: v.kind === "canvas" ? null : v.height, hdr: !!v.hdr });
/** 40 s, 3 min, 1 h 05 min. */
/** Custom graphic placements that have no file to play yet (renders leave them out until they do). */
async function placementLine(userId: string, tl: Timeline): Promise<string[]> {
  const all = await graphicPlacements(userId, tl);
  const warned = all.filter((x) => "key" in x && x.warnings?.length);
  const out = warned.length ? [`Graphic placements with warnings: ${warned.map((x) => `${x.clipId}: ${("warnings" in x && x.warnings?.join(" ")) || ""}`).join("; ")}`] : [];
  const waiting = all.filter((x) => !("key" in x));
  if (!waiting.length) return out;
  const why = (x: (typeof waiting)[number]) => ("state" in x ? (x.state === "failed" ? `failed: ${x.error ?? "unknown error"}` : x.state === "recording" ? `recording${x.percent != null ? ` ${x.percent}%` : ""}` : "queued") : "");
  return [...out, `Graphic placements with no file yet: ${waiting.map((x) => `${x.clipId} ${why(x)}${x.own ? " (its params)" : ""}`).join(", ")}. A render records a placement's own params if it has to; a graphic still recording is left out until it is ready.`];
}
/** Each placement of custom graphics in an edit (of one graphic, or all): ready, waiting, recording N%, or failed. */
async function placementStatus(userId: string, tl: Timeline, graphicId?: string): Promise<{ line: string; pending: number; failed: number }> {
  const ids = new Set((tl.tracks.v3 as V3Clip[]).filter((c) => c.kind === "graphic" && (!graphicId || c.graphicId === graphicId)).map((c) => c.id));
  const all = (await graphicPlacements(userId, tl)).filter((x) => ids.has(x.clipId));
  if (!all.length) return { line: "", pending: 0, failed: 0 };
  const st = (x: (typeof all)[number]) => ("key" in x ? "ready" : x.state === "failed" ? `failed: ${(x.error ?? "unknown error").replace(/\.$/, "").slice(0, 160)}` : x.state === "recording" ? `recording${x.percent != null ? ` ${x.percent}%` : ""}` : "waiting");
  const failed = all.filter((x) => !("key" in x) && x.state === "failed").length, pending = all.filter((x) => !("key" in x) && x.state !== "failed").length;
  return { line: `Placements: ${all.map((x) => `${x.clipId} ${st(x)}`).join(", ")}${failed ? ". retry_graphic records failed ones again; a render records them before it starts" : ""}.`, pending, failed };
}
/** What a graphic's recording noticed (a font that was not there), as one sentence ("" when nothing). */
/** How many marks the edit's footage has, by kind, and the AI's own (list_marks lists them). */
function marksLine(v: { id: string; seconds: number; analysis: unknown }, tl: Timeline): string {
  const counts: Record<string, number> = {};
  for (const m of footageMarks(footageInputOf(v.id, v.analysis as never, v.seconds))) if (m.kind !== "music_beat" && !tl.markEdits?.[m.id]?.hidden) counts[m.kind] = (counts[m.kind] || 0) + 1;
  const byKind = Object.entries(counts).sort((a, b) => MARK_KINDS.indexOf(a[0] as never) - MARK_KINDS.indexOf(b[0] as never));
  const mine = tl.marks?.length ?? 0, notes = Object.keys(tl.markEdits ?? {}).length;
  return `Marks on the footage (list_marks, mark_silences, mark_fillers, get_retakes): ${byKind.map(([k, n]) => `${k} ${n}`).join(", ") || "none"}${mine ? `; ${mine} of yours` : ""}${notes ? `; your notes on ${notes} of Rendrr's` : ""}.`;
}
/** What to do after a graphic failed: record it again when Rendrr's side gave out, else fix the code. */
function failedNext(id: string, error: string | null) {
  return graphicFailedOnServer(error)
    ? `That was a problem on Rendrr's side, not in the code: retry_graphic {graphicId: "${id}"} records it again (nothing to send again).`
    : `Fix the code: create_graphic {codeFrom: "${id}", edits: [{find, replace}], replace: true} changes just what is wrong (same id; nothing else to send).`;
}
const warningsText = (w: unknown) => (Array.isArray(w) && w.length ? ` Warning: ${w.join(" ")}` : "");
/** A custom graphic's params and their default values, for list_graphics ("" when it has none). */
/** A graphic just queued (create_graphic, retry_graphic): its answer if it is done within the wait, else that it is
 *  recording and how to follow it. */
async function graphicAnswer(id: string, withImages: boolean, lead = "", waitMs = TOOL_WAIT_MS) {
  const done = await waitFor(async () => { const x = await prisma.graphic.findUnique({ where: { id } }); return x && (x.status === "ready" || x.status === "failed") ? x : null; }, waitMs, 500);
  if (!done) {
    const p = await readGraphic(id);
    return { text: `${lead}Graphic ${id} is recording${p ? `: ${p.percent}% done${p.etaSec != null ? `, about ${fmtLeft(p.etaSec)} left` : ""}` : " (queued)"}. It keeps going: get_graphic {graphicId, wait_seconds} waits for it${p?.etaSec ? ` (about ${fmtLeft(Math.min(p.etaSec, 300))})` : ""}. You can place it with apply_edits add_graphic now; renders include it once it is ready.`, data: { graphicId: id, status: "rendering" } };
  }
  if (done.status === "failed") return { text: `${lead}The graphic did not render: ${(done.error || "unknown error").replace(/\.$/, "")}. ${failedNext(done.id, done.error)}`, data: { graphicId: id, status: "failed" } };
  const images = withImages ? await Promise.all(((done.checkFrames as string[]) || []).slice(0, 4).map((k) => signGet(k, 900))) : [];
  return { text: `${lead}Graphic ready: ${done.id} (${done.width}x${done.height}, ${done.durationSec.toFixed(1)}s${done.transparent ? ", transparent" : ""}).${images.length ? " 4 check frames attached." : ""}${warningsText(done.warnings)} Place it with apply_edits add_graphic.`, images, data: { graphicId: done.id } };
}
const defaultsText = (schema: unknown) => { const d = graphicDefaults(schema); return Object.keys(d).length ? ` | ${JSON.stringify(d).slice(0, 300)}` : ""; };
/** 1:02.345: comment times to the millisecond (the app in the chat places them that finely). */
const fmtMs = (t: number) => { const ms = Math.round(Math.max(0, t) * 1000); return `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}.${String(ms % 1000).padStart(3, "0")}`; };
const fmtLeft = (s: number) => (s < 60 ? `${Math.max(1, Math.round(s / 5) * 5)} s` : s < 3600 ? `${Math.round(s / 60)} min` : `${Math.floor(s / 3600)} h ${String(Math.round((s % 3600) / 60)).padStart(2, "0")} min`);

/** The check of one version of an edit against its rendered file (pauses from 0.15 s, whatever the style says: the AI knows what it asked for). */
async function checkOf(projectId: string, version: number, loudness: FileLoudness | null, measured: FileMeasure | null, planned: number | null = null, renderNotes: string[] = [], heard: HeardTranscript | null = null): Promise<string> {
  const p = await prisma.project.findUniqueOrThrow({ where: { id: projectId }, include: { video: { include: { analysis: true } } } });
  const ver = await prisma.projectVersion.findUnique({ where: { projectId_v: { projectId, v: version } } });
  const snap = (ver?.timeline ?? { timeline: p.timeline, name: p.name, aspect: p.aspect, styleId: p.styleId }) as unknown as Snapshot;
  const others = await otherSources(p.userId, snap.timeline, p.videoId);
  const luts = await prisma.lut.findMany({ where: { userId: p.userId }, select: { id: true, name: true } });
  // Engine Part 3: each video's word edges in the sound, so the check names the words a cut goes through.
  const aligned = { [p.videoId]: alignedMap(p.video.analysis?.alignment as unknown as Alignment | null), ...Object.fromEntries(Object.entries(others).map(([id, o]) => [id, alignedMap(o.alignment)])) };
  return editCheck(snap, (p.video.analysis?.transcript as unknown as Transcript) || [], { loudness, measured, planned, renderNotes, videoId: p.videoId, lutName: (id) => luts.find((l) => l.id === id)?.name, footage: footageOf(p.video), transcripts: Object.fromEntries(Object.entries(others).map(([id, o]) => [id, o.transcript])), aligned, heard });
}

/** Within this long of the AI's last preview of an edit, another one needs the user to have asked for more. */
export const PREVIEW_GAP_MS = 45 * 60_000;
/**
 * One preview per change: when the AI already rendered a preview of this edit for the current request (in the last
 * PREVIEW_GAP_MS, and the user has left no feedback since: no comment, no change of theirs in the editor), the answer
 * why it is not rendered again; null when it may render.
 */
export async function previewGate(projectId: string): Promise<string | null> {
  const prev = await prisma.render.findFirst({ where: { projectId, kind: "preview", by: { not: "user" }, status: { in: ["queued", "running", "done"] }, createdAt: { gt: new Date(Date.now() - PREVIEW_GAP_MS) } }, orderBy: { createdAt: "desc" } });
  if (!prev) return null;
  const since = prev.createdAt;
  const [notes, client, mine] = await Promise.all([
    prisma.projectComment.count({ where: { projectId, createdAt: { gt: since } } }),
    // The client's notes on this edit's link, or on its folder's (a folder link's general notes have no edit).
    prisma.render.findUnique({ where: { id: prev.id }, select: { project: { select: { folderId: true } } } }).then((r) => prisma.reviewComment.count({ where: { createdAt: { gt: since }, review: { OR: [{ projectId }, ...(r?.project.folderId ? [{ folderId: r.project.folderId }] : [])] }, OR: [{ projectId: null }, { projectId }] } })),
    prisma.projectVersion.count({ where: { projectId, createdBy: "user", createdAt: { gt: since } } }),
  ]);
  if (notes || client || mine) return null;
  if (prev.status !== "done") return `Not rendered: preview v${prev.version} of this edit is still rendering for this request (render ${prev.id}). get_render {renderId: "${prev.id}", wait_seconds: 60} returns its check when it is done. Rendrr renders ONE preview per request; your later changes go into the next preview, after the user asks for more (then render_preview with newRequest: true).`;
  const p = await prisma.project.findUnique({ where: { id: projectId }, select: { currentVersion: true } });
  const mins = Math.max(1, Math.round((Date.now() - since.getTime()) / 60_000));
  return `Not rendered: preview v${prev.version} of this edit was made ${mins} min ago for this request, and the user has not asked for anything since. Rendrr renders ONE preview per request: every render is a new version the user has to look at, and costs them tokens. Your changes are saved${p && p.currentVersion !== prev.version ? ` (v${p.currentVersion})` : ""} and go into the next preview. Now tell the user what you changed and what is left, and stop. Call render_preview again only after the user sends a new request or feedback, with newRequest: true.`;
}

/** A library folder imported from Google Drive, brought up to date before the AI reads or edits it (new videos put in
 *  the Drive folder come in); what came in, in a few words. Not linked, Drive off or slow (20 s): nothing said. */
async function driveSyncLine(userId: string, folderId: string): Promise<string> {
  try {
    const r = await Promise.race([syncDriveFolder(userId, folderId, { fresh: 60_000 }), new Promise<null>((ok) => setTimeout(() => ok(null), 20_000).unref())]);
    const t = r ? syncText(r) : "";
    return t ? `${t}${r && r.added ? " They are being prepared (list_footage shows when each is ready)." : ""} ` : "";
  } catch { return ""; }
}

export const TOOL_HANDLERS: Record<string, (c: Ctx, input: any) => Promise<ToolOut>> = {
  // ---------------- read ----------------
  async get_editing_skill() {
    return { text: EDITING_SKILL };
  },

  async list_footage(c, i) {
    const folders = await listLibraryFolders(c.userId);
    const lf = i.libraryFolder ? await findLibraryFolder(c.userId, i.libraryFolder) : null;
    if (i.libraryFolder && !lf) throw notFound(`There is no library folder "${i.libraryFolder}". ${folders.length ? `Library folders: ${folders.map((f) => `${f.path} (${f.id})`).join(", ")}.` : "There are none yet: move_footage makes one."}`);
    const acct = await accountLine(c.userId);
    const where = (v: { sample: boolean; source: string }) => (v.sample ? "sample" : v.source === "drive" ? "drive" : v.source === "upload" ? "rendrr" : "computer");
    const row = (v: { id: string; name: string; kind: string; seconds: number; orientation: string; width: number | null; height: number | null; status: string; error: string | null; sample: boolean; source: string; still?: boolean }, folder?: string) =>
      `${v.id} | ${v.name} | ${v.still ? "picture" : v.kind} | ${fmtClock(v.seconds)} | ${v.orientation}${v.width ? ` ${v.width}x${v.height}` : ""} | ${v.status}${v.error ? ` (${v.error})` : ""} | ${where(v)}${folder !== undefined ? ` | ${folder || "-"}` : ""}`;
    if (lf) {
      // A folder: its videos and its subfolders', in the order create_project libraryFolder puts them. A folder imported
      // from Google Drive first takes in what was put in the Drive folder since.
      const synced = await driveSyncLine(c.userId, lf.id);
      const ff = await folderFootage(c.userId, lf);
      const vs = ff.all.filter((v) => (i.kind ? v.kind === i.kind : true));
      const subs = folders.filter((f) => f.parentId === lf.id);
      const subLine = subs.length ? `Folders inside (id | name | videos with theirs): ${subs.map((f) => `${f.id} | ${f.name} | ${f.total}`).join("; ")}.\n` : "";
      if (!vs.length) return { text: `${acct} ${synced}${subLine}The library folder "${ff.path}" is empty${i.kind ? ` of ${i.kind}` : ""}${subs.length ? ", its folders too" : ""}. move_footage puts videos in it.` };
      const pg = pageOf(vs, i);
      const nested = subs.length > 0;
      return { text: `${acct} ${synced}${subLine}Library folder "${ff.path}" (${lf.id})${nested ? " with its folders" : ""}, in the order create_project libraryFolder uses (its own videos in name order, then each folder inside, the same way): videos ${pg.offset + 1}-${pg.offset + pg.shown.length} of ${vs.length} (id | name | kind | length | shape | status | raw file${nested ? " | folder inside" : ""}):\n` +
        pg.shown.map((v) => row(v, nested ? v.folderPath : undefined)).join("\n") + pg.tail };
    }
    const vs = await prisma.video.findMany({ where: { userId: c.userId, ...(i.kind ? { kind: i.kind } : { kind: { not: "canvas" } }) }, orderBy: { createdAt: "desc" }, take: 500 });
    const recipes = i.kind === "reference" ? await prisma.reference.findMany({ where: { userId: c.userId }, orderBy: { createdAt: "desc" }, take: 50 }) : [];
    const folderLine = folders.length ? `Library folders (id | path | videos with its folders'): ${folders.map((f) => `${f.id} | ${f.path} | ${f.total}`).join("; ")}.\n` : "";
    if (!vs.length && !recipes.length) return { text: i.kind ? `${acct} ${folderLine}No ${i.kind === "reference" ? "reference videos" : "footage"} yet.` : `${acct} No footage yet: the user adds videos in Rendrr (Library > Add footage). ${EMPTY_HINT}` };
    const pg = pageOf(vs, i);
    const paths = new Map(folders.map((f) => [f.id, f.path]));
    const withFolder = folders.length > 0;
    return { text: `${acct} ${folderLine}Videos ${pg.offset + 1}-${pg.offset + pg.shown.length} of ${vs.length} (id | name | kind | length | shape | status | raw file${withFolder ? " | folder" : ""}):\n` +
      pg.shown.map((v) => row(v, withFolder ? (v.libraryFolderId && paths.get(v.libraryFolderId)) || "" : undefined)).join("\n") + pg.tail +
      (recipes.length ? "\nSaved recipes (id | name):\n" + recipes.map((r) => `${r.id} | ${r.name}`).join("\n") : "") };
  },

  async get_footage(c, i) {
    const v = await prisma.video.findUnique({ where: { id: i.videoId }, include: { analysis: true } });
    if (!v || v.userId !== c.userId) {
      const recipe = await recipeOut(c, i.videoId);
      if (recipe) return recipe;
      throw notFound("That video is not in the library. Use list_footage for the ids.");
    }
    if (!v.analysis || !["ready", "expired"].includes(v.status)) return { text: `"${v.name}" is ${v.status}${v.error ? ": " + v.error : ""}. It can be read once it is ready.` };
    const isRef = v.kind === "reference";
    // A reference read before: its rules are saved as a style, so say that instead of sending it all again.
    if (isRef && i.detail == null && !i.images && i.from == null && i.to == null) {
      const saved = await prisma.style.findMany({ where: { ownerId: c.userId, sourceVideoId: v.id }, orderBy: { createdAt: "desc" }, take: 3 });
      if (saved.length) return { text: `REFERENCE "${v.name}" ${v.id} (${fmtClock(v.seconds)}) was read before. Saved as style ${saved.map((s) => `${s.id} "${s.name}": ${s.cutPace}; ${s.captionRule}; ${s.zoomRules}; ${s.musicVibe}`).join(" | ")}. Apply it with apply_edits [{"op":"apply_style","styleId":"${saved[0].id}"}]. To read the video again, pass detail "sentences".` };
    }
    if (i.detail === "json") { const b = breakdownOf(v); return { text: b ? clip(JSON.stringify(b)) : "The breakdown is not ready yet. Ask again in a minute." }; }
    // One list of the words with their times in the sound (the transcriber's where a word was not placed): the short form.
    if (i.detail === "word_times") {
      const al = alignedMap((await deepOf(c.userId, v.id).catch(() => null))?.alignment ?? (v.analysis.alignment as unknown as Alignment | null));
      const a0 = i.from ?? 0, b0 = i.to ?? Infinity;
      const ws = allWords(v.analysis.transcript as unknown as Transcript).filter((w) => (w.end ?? w.t) >= a0 && w.t <= b0);
      const f2 = (x: number) => x.toFixed(2);
      const rows = ws.map((w) => { const x = al.get(w.id); return `${w.id} ${w.text}${w.filler ? "*" : ""} ${f2(x?.s ?? w.t)}-${f2(x?.e ?? w.end ?? w.t + 0.3)}`; });
      return { text: clip(`WORDS "${v.name}" ${ws.length}${i.from != null || i.to != null ? ` in ${a0}-${i.to ?? "end"}s` : ""} (id text start-end in the sound; * filler; ${al.size ? `${al.size} of ${allWords(v.analysis.transcript as unknown as Transcript).length} placed in the sound, the rest the transcriber's times` : "the transcriber's times: not placed in the sound yet"}):\n${rows.join("\n") || "(no speech found)"}`) };
    }
    const code = await videoAsCode(v, { from: i.from, to: i.to, images: i.images === true });
    let tr = v.analysis.transcript as unknown as Transcript;
    if (i.from != null || i.to != null) tr = tr.filter((l) => l.end >= (i.from ?? 0) && l.start <= (i.to ?? 1e9));
    const words = allWords(v.analysis.transcript as unknown as Transcript);
    const fillers = words.filter((w) => w.filler);
    const sil = (v.analysis.silences as unknown as Silence[]).filter((s) => s.end - s.start >= 0.4);
    const cuts = (v.analysis.sceneCuts as number[]) || [];
    const counts: Record<string, number> = {};
    for (const f of fillers) { const k = f.text.toLowerCase().replace(/[^a-z' ]/g, ""); counts[k] = (counts[k] || 0) + 1; }
    const lines = [
      ...(isRef ? ["REFERENCE: copy its rhythm, shot lengths, hook and look onto the user's footage, not its content. Then save_style with fromVideoId so it is not read again."] : []),
      code.text,
      `RAW FILE ${v.sample ? "Rendrr's sample" : v.source === "drive" ? "in Google Drive" : v.source === "upload" ? `kept by Rendrr (brought in from the chat)${v.still ? `; a picture, played as a still clip of ${v.seconds.toFixed(0)} s` : ""}` : "on the user's computer"}${v.status === "expired" ? " | preview copy expired: rebuild it in the Library to edit or take frames" : ""}`,
      `TRANSCRIPT (${v.analysis.transcriber === "stub" ? "SAMPLE: transcription is not set up" : "AssemblyAI"}) ${words.length} words. Line id [start] text${i.detail === "words" ? "; words as text(wordId@start-end)" : ""}:`,
      transcriptAsText(tr, undefined, i.detail === "words" ? "words" : "sentences") || "(no speech found)",
      `SILENCES 0.4s+ (${sil.length}): ${sil.slice(0, 80).map((s) => `${s.start.toFixed(1)}-${s.end.toFixed(1)}`).join(", ") || "none"}${sil.length > 80 ? ", …" : ""}`,
      `FILLERS ${fillers.length}${fillers.length ? " (" + Object.entries(counts).map(([k, n]) => `${k} x${n}`).join(", ") + ")" : ""}${i.detail === "words" && fillers.length ? ". Ids: " + fillers.slice(0, 200).map((f) => f.id).join(" ") : ""}`,
      `SCENE CUTS (${cuts.length}): ${cuts.slice(0, 100).map((t) => t.toFixed(1)).join(", ") || "none"}`,
      ...(await deepLines(c.userId, v.id, words, i.detail === "words", { from: i.from, to: i.to })),
    ];
    return { text: clip(lines.join("\n")), images: code.images };
  },

  async get_frames(c, i) {
    const v = await ownedVideo(c.userId, i.videoId);
    if (!v.proxyKey || !["ready"].includes(v.status)) return { text: `"${v.name}" has no preview copy to take frames from (${v.status}).${v.status === "expired" ? " Ask the user to rebuild the preview in the Library." : ""}` };
    let times: number[] = (i.times || []).slice(0, 8);
    if (!times.length) {
      const from = Math.max(0, i.from ?? 0), to = Math.min(v.seconds, i.to ?? v.seconds), n = Math.min(8, i.count ?? 4);
      times = Array.from({ length: n }, (_, k) => (n === 1 ? (from + to) / 2 : from + ((to - from) * k) / (n - 1)));
    }
    times = times.map((t) => Math.round(Math.min(Math.max(0, t), Math.max(0, v.seconds - 0.05)) * 1000) / 1000);
    const images = await videoFramesFor(v.id, times);
    if (!images.length) return { text: "No frames came back. Try again in a moment." };
    const b = breakdownOf(v);
    const where = (t: number) => b?.shots.find((s) => t >= s.start && t < s.end)?.id;
    return { text: `Frames of "${v.name}" at ${times.map((t) => `${t}s${where(t) ? ` (${where(t)})` : ""}`).join(", ")}, in that order. Each has its time (to the millisecond) and frame number written at the bottom left: the frame that plays at that moment.`, images };
  },

  async list_styles(c) {
    const ss = await prisma.style.findMany({ where: { OR: [{ ownerId: null }, { ownerId: c.userId }] }, orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] });
    const files = await styleFileLines(c.userId);
    return { text: "Styles (id | name | type | vibe | shapes | platforms):\n" + ss.map((s) => `${s.id} | ${s.name} | ${s.type} | ${s.vibe} | ${s.ori.join(" ")} | ${s.platforms.join(" ")}`).join("\n") + (files.length ? `\nStyle files (analyze_reference; read with get_style):\n${files.join("\n")}` : "") };
  },

  async get_style(c, i) {
    const file = await styleFileOut(c.userId, i.styleId);
    if (file) return { text: file };
    const s = await prisma.style.findFirst({ where: { id: i.styleId, OR: [{ ownerId: null }, { ownerId: c.userId }] } });
    if (!s) throw notFound("That style does not exist. Use list_styles for the ids.");
    return { text: [`${s.name} (${s.id}), ${s.type}: ${s.vibe}`, `Cut pace: ${s.cutPace}. Captions: ${s.captionRule} (${s.captionLook}). Zooms: ${s.zoomRules}. Music: ${s.musicVibe}.`, `apply_style sets its captions only. Its other rules, for you to carry out with explicit edits: ${styleGuidance(StyleRulesSchema.parse(s.rules)).join("; ") || "none"}.`, `Rules: ${JSON.stringify(s.rules)}`].join("\n") };
  },

  async list_folders(c) {
    const fs = await prisma.folder.findMany({ where: { userId: c.userId }, orderBy: { updatedAt: "desc" }, include: { _count: { select: { projects: { where: { deletedAt: null } } } } } });
    return { text: fs.length ? "Folders (id | name | edits):\n" + fs.map((f) => `${f.id} | ${f.name} | ${f._count.projects}`).join("\n") : "No folders yet." };
  },

  async list_projects(c, i) {
    const ps = await prisma.project.findMany({ where: { userId: c.userId, deletedAt: null, ...(i.folderId ? { folderId: i.folderId } : {}) }, orderBy: { updatedAt: "desc" }, take: 500, include: { folder: true } });
    if (!ps.length) return { text: `${await accountLine(c.userId)} No edits yet: use create_project. ${i.folderId ? "" : EMPTY_HINT}`.trim() };
    const pg = pageOf(ps, i);
    return { text: `Edits ${pg.offset + 1}-${pg.offset + pg.shown.length} of ${ps.length} (id | name | folder | style applied | aspect | status | version):\n` + pg.shown.map((p) => `${p.id} | ${p.name} | ${p.folder.name} | ${p.styleId ?? "none"} | ${p.aspect} | ${p.status} | v${p.currentVersion}`).join("\n") + pg.tail };
  },

  open_projects: (c, i) => openProjects(c, i),

  async get_project(c, i) {
    const p = await getOwnedProject(c.userId, i.projectId);
    const v = await prisma.video.findUniqueOrThrow({ where: { id: p.videoId }, include: { analysis: true } });
    const snap = { timeline: p.timeline, name: p.name, aspect: p.aspect, styleId: p.styleId } as unknown as Snapshot;
    const style = p.styleId ? await prisma.style.findUnique({ where: { id: p.styleId } }) : null;
    const preview = await prisma.render.findFirst({ where: { projectId: p.id, status: "done", kind: "preview" }, orderBy: { createdAt: "desc" } });
    // Phase 6: the user's imported LUTs (for set_grade lut) and whether the footage is HDR, only when there are any.
    const luts = await prisma.lut.findMany({ where: { userId: c.userId }, orderBy: { createdAt: "desc" }, take: 30, select: { id: true, name: true } });
    // Each V1 clip's sound at its edges, from where each word starts and ends in the sound (the alignment) when the
    // video has one, else the transcriber's times.
    const others = await prisma.video.findMany({ where: { id: { in: otherVideoIds(p.timeline as unknown as Timeline, p.videoId) }, userId: c.userId }, select: { id: true, analysis: { select: { transcript: true, alignment: true } } } });
    const said = new Map([v, ...others].map((x) => [x.id, { words: allWords((x.analysis?.transcript as unknown as Transcript) || []), aligned: alignedMap(x.analysis?.alignment as Alignment | null) }]));
    const clipNote = (cl: { sourceVideoId?: string; sourceIn: number; sourceOut: number }) => { const s = said.get(cl.sourceVideoId || p.videoId); return s?.words.length ? clipEdges(cl, s.words, s.aligned) : ""; };
    const opts = { v1Offset: i.clipsFrom, v1Limit: i.clipsLimit ?? 100, clipNote };
    return { text: clip([`Edit "${p.name}" (${p.id}) on footage ${v.id} "${v.name}"${v.hdr ? ` (HDR ${v.hdr === "pq" ? "PQ" : "HLG"}: the final keeps it unless set_export hdr sdr)` : ""}. ${p.status}, v${p.currentVersion}, ${p.styleId ? `style ${style?.name ?? p.styleId} applied` : "no style applied"}.`,
      ...[referenceLine(p.reference as ReferenceRef | null)].filter((x): x is string => !!x),
      summarizeTimeline(snap, (v.analysis?.transcript as unknown as Transcript) || [], 60, p.videoId, (id) => luts.find((l) => l.id === id)?.name, footageOf(v), opts),
      ...(await placementLine(c.userId, p.timeline as unknown as Timeline)),
      marksLine(v, p.timeline as unknown as Timeline),
      ...(luts.length ? [`Your LUTs (set_grade lut id): ${luts.map((l) => `${l.id} "${l.name}"`).join(", ")}`] : []),
      ...(await soundLines(c.userId, p.timeline as unknown as Timeline)),
      ...(await binLine(c.userId, p.timeline as unknown as Timeline)),
      preview ? `Latest preview: v${preview.version}${preview.version === p.currentVersion ? " (current)" : " (older than the current version)"}.` : "No preview yet."].join("\n")) };
  },

  // ---------------- marks: measured, never acted on ----------------
  async mark_silences(c, i) {
    const scope = await markScope(c.userId, i);
    const min = i.minLength ?? 0.3;
    const all = inRange(allMarks(scope).filter((m) => m.kind === "silence" && m.end - m.start >= min - 1e-9 && !m.hidden), i, scope);
    const cut = all.filter((m) => m.edit === null);
    const rows = i.includeCut ? all : all.filter((m) => m.edit !== null);
    const pg = pageOf(rows, { offset: i.offset, limit: i.limit ?? 100 });
    const multi = scope.inputs.length > 1;
    const head = `SILENCES ${min}s+ in ${scope.title}: ${rows.length}${scope.view && cut.length && !i.includeCut ? ` (${cut.length} more already cut from the edit: includeCut true lists them)` : ""}. Footage seconds; level_db -35: the audio is quiet there, null: a gap between words with some sound (a breath, a tail).`;
    const cols = `id ${multi ? "video " : ""}start-end length level_db${scope.view ? " | edit start-end" : ""}`;
    const body = pg.shown.map((m) => `${m.id} ${multi ? m.videoId + " " : ""}${m.start}-${m.end} ${(m.end - m.start).toFixed(3)} ${m.level_db ?? "null"}${m.edit === undefined ? "" : m.edit === null ? " | cut" : ` | edit ${m.edit.start}-${m.edit.end}${m.edit.partly ? " partly cut" : ""}`}`).join("\n");
    return { text: clip([head, cols, body || "(none)", pg.tail.trim(), `Nothing was cut. To cut one: apply_edits cut_words {from, to} with its footage times${multi ? " (main footage; another video's: its edit times and edit true)" : scope.view ? " (or its edit times and edit true)" : ""}.`].filter(Boolean).join("\n")) };
  },

  async mark_fillers(c, i) {
    const scope = await markScope(c.userId, i);
    const all = inRange(allMarks(scope).filter((m) => m.kind === "filler" && !m.hidden), i, scope);
    const cut = all.filter((m) => m.edit === null);
    const rows = i.includeCut ? all : all.filter((m) => m.edit !== null);
    const pg = pageOf(rows, { offset: i.offset, limit: i.limit ?? 100 });
    const multi = scope.inputs.length > 1;
    const head = `FILLERS in ${scope.title}: ${rows.length}${scope.view && cut.length && !i.includeCut ? ` (${cut.length} more already cut: includeCut true lists them)` : ""}. Footage seconds.`;
    const cols = `id ${multi ? "video " : ""}wordId "text" start-end${scope.view ? " | edit start-end" : ""}`;
    const body = pg.shown.map((m) => `${m.id} ${multi ? m.videoId + " " : ""}${m.wordId} "${m.text}" ${m.start}-${m.end}${m.edit === undefined ? "" : m.edit === null ? " | cut" : ` | edit ${m.edit.start}-${m.edit.end}`}`).join("\n");
    return { text: clip([head, cols, body || "(none)", pg.tail.trim(), `Nothing was cut. To cut some: apply_edits cut_words {wordIds}${multi ? " (main footage; another video's: cut_words {from, to, edit: true} with its edit times)" : ""}.`].filter(Boolean).join("\n")) };
  },

  async list_marks(c, i) {
    const scope = await markScope(c.userId, i);
    const kinds: string[] | null = i.kind == null ? null : Array.isArray(i.kind) ? i.kind : [i.kind];
    const every = inRange(allMarks(scope), i, scope).filter((m) => (!i.source || m.source === i.source) && (i.includeHidden || !m.hidden));
    const rows = every.filter((m) => (kinds ? kinds.includes(m.kind) : m.kind !== "music_beat"));
    const counts: Record<string, number> = Object.fromEntries(MARK_KINDS.map((k) => [k, 0]));
    for (const m of every) counts[m.kind]++;
    for (const k of MARK_KINDS) if (!counts[k]) delete counts[k];
    const pg = pageOf(rows, { offset: i.offset, limit: i.limit ?? 100 });
    const beats = !kinds && counts.music_beat ? `; music_beat ${counts.music_beat} not listed: kind "music_beat"` : "";
    const head = `MARKS on ${scope.title}: ${rows.length} (${Object.entries(counts).filter(([k]) => kinds ? kinds.includes(k) : k !== "music_beat").map(([k, n]) => `${k} ${n}`).join(", ") || "none"}${beats}). Footage seconds; rendrr = measured, ai = yours.`;
    const cols = `id kind${scope.inputs.length > 1 ? " video" : ""} start-end source confidence "label" (note)${scope.view ? " | edit start-end, or cut" : ""}`;
    return { text: clip([head, cols, marksText(pg.shown, { video: scope.inputs.length > 1 }) || "(none)", pg.tail.trim()].filter(Boolean).join("\n")) };
  },

  async get_retakes(c, i) {
    const scope = await markScope(c.userId, i);
    let groups = retakesOf(scope);
    if (i.from != null || i.to != null) {
      if (i.edit && !scope.view) throw new AppError("edit true needs projectId (edit seconds belong to an edit).", 400, "invalid-input");
      const a = i.from ?? 0, b = i.to ?? Infinity;
      groups = groups.filter((g) => g.takes.some((t) => {
        const at = i.edit ? markInEdit(scope.view!, g.videoId, t.start, t.end) : { start: t.start, end: t.end };
        return at && at.end >= a && at.start <= b;
      }));
    }
    const pg = pageOf(groups, { offset: i.offset, limit: i.limit ?? 15 });
    const multi = scope.inputs.length > 1;
    const out = pg.shown.map((g) => ({ groupId: g.groupId, ...(multi ? { videoId: g.videoId } : {}), takes: g.takes.map((t) => ({ ...t, text: t.text.length > 160 ? t.text.slice(0, 157) + "…" : t.text, ...(scope.view ? { edit: markInEdit(scope.view, g.videoId, t.start, t.end) } : {}) })) }));
    const head = `RETAKES in ${scope.title}: ${groups.length} ${groups.length === 1 ? "group" : "groups"} of lines said more than once. Footage seconds. confidence: how alike the take is to the others; score 0-1: 0.5 complete + 0.2 few fillers + 0.2 few stumbles + 0.1 ends a sentence. These are measurements: Rendrr never picks a take, you choose and cut the others.${scope.view ? " edit: where the take plays (null: cut already)." : ""}`;
    return { text: clip([head, JSON.stringify(out), pg.tail.trim()].filter(Boolean).join("\n")) };
  },

  // ---------------- the deeper measurements (Part 2) ----------------
  async get_audio(c, i) {
    const d = await deepOf(c.userId, i.videoId);
    if (!d.ready) return { text: d.note! };
    if (!d.audio) return { text: `"${d.name}" has no sound.` };
    const from = Math.max(0, i.from ?? 0), to = Math.min(d.seconds, i.to ?? d.seconds);
    if (!(to > from)) throw new AppError(`from must be before to, inside the video (0-${d.seconds.toFixed(2)}s).`, 400, "invalid-input");
    const frames = await audioFramesOf(d.audio);
    return { text: clip(deepAudioText(d.audio, { name: d.name, from, to, frames, step: i.step, peaks: i.peaks })) };
  },

  async get_waveform_image(c, i) {
    const d = await deepOf(c.userId, i.videoId);
    if (!d.ready) return { text: d.note! };
    if (!d.audio) return { text: `"${d.name}" has no sound.` };
    const from = Math.max(0, i.from ?? 0), to = Math.min(d.seconds, i.to ?? Math.min(d.seconds, from + 30));
    if (!(to > from)) throw new AppError(`from must be before to, inside the video (0-${d.seconds.toFixed(2)}s).`, 400, "invalid-input");
    const W = Math.round(i.width ?? 1200), H = Math.round(i.height ?? 240);
    const frames = await audioFramesOf(d.audio);
    if (!frames) return { text: "The sound's 10 ms frames are not in storage any more; ask again in a few minutes (they are measured again)." };
    const v = await prisma.video.findUniqueOrThrow({ where: { id: d.id }, select: { userId: true, analysis: { select: { transcript: true } } } });
    const al = alignedMap(d.alignment);
    const words = allWords((v.analysis?.transcript as unknown as Transcript) || []).map((w) => ({ w, a: al.get(w.id) ?? { s: w.t, e: w.end } })).filter(({ a }) => a.e >= from && a.s <= to);
    const key = `${PREFIX.frames}${v.userId}/${d.id}/wave-${Math.round(from * 1000)}-${Math.round(to * 1000)}-${W}x${H}.png`;
    await putObject(key, waveformPng(frames, d.audio, { from, to, width: W, height: H, words: words.map(({ a }) => a) }), "image/png");
    const pxs = W / (to - from);
    return {
      text: clip(`WAVEFORM "${d.name}" ${from}-${to}s as ${W}x${H}: x = ${from} + pixel x ${((to - from) / W).toFixed(5)}s (${pxs.toFixed(1)} px a second); y = the sample value, full scale at the top and bottom. Lime: the waveform; dark green band: speech; blue at the top: breaths; white ticks: clicks; orange: clipping; grey at the bottom: each word (its start ticked, in the sound); ticks every second, taller every 10 s${pxs >= 80 ? ", short ones every 0.1 s" : ""}.\nWORDS in range (id text start-end in the sound): ${words.slice(0, 80).map(({ w, a }) => `${w.id} ${w.text} ${a.s.toFixed(3)}-${a.e.toFixed(3)}`).join(", ") || "none"}${words.length > 80 ? ", …" : ""}`),
      images: [await signGet(key, 900)],
    };
  },

  async get_vision(c, i) {
    const d = await deepOf(c.userId, i.videoId);
    if (!d.ready) return { text: d.note! };
    if (!d.vision) return { text: `"${d.name}" has no picture measurements.` };
    const from = Math.max(0, i.from ?? 0), to = Math.min(d.seconds, i.to ?? d.seconds);
    const details = await visionDetailsOf(d.vision);
    return { text: clip(visionText(d.vision, { name: d.name, from, to, details, faces: i.faces === true })) };
  },

  async map_time(c, i) {
    const scope = await markScope(c.userId, { projectId: i.projectId });
    const view = scope.view!, main = view.mainVideoId;
    const name = (vid: string) => scope.names[vid] ?? vid;
    const lines: string[] = [`TIME in ${scope.title}: the edit is ${view.total.toFixed(3)}s long.`];
    for (const t of (i.editTimes ?? []) as number[]) {
      if (t > view.total + 1e-6) { lines.push(`edit ${t}s: after the end of the edit`); continue; }
      const p = view.pieceAt(t);
      lines.push(p ? `edit ${t}s = clip ${p.clipId}, video ${p.videoId === main ? "main" : p.videoId} "${name(p.videoId)}" at ${(Math.round(srcAt(p, t) * 1000) / 1000)}s` : `edit ${t}s: nothing plays`);
    }
    for (const q of (i.footage ?? []) as { t: number; videoId?: string }[]) {
      const vid = q.videoId && q.videoId !== "main" ? q.videoId : main;
      const hits = view.pieces.filter((p) => p.videoId === vid && q.t >= p.srcIn - 1e-6 && q.t <= p.srcOut + 1e-6);
      if (hits.length) lines.push(`video ${vid === main ? "main" : vid} ${q.t}s plays at edit ${hits.map((p) => `${(Math.round(editOf(p, q.t) * 1000) / 1000)}s (clip ${p.clipId})`).join(", ")}`);
      else { const next = view.videoToEdit(vid, q.t); lines.push(`video ${vid === main ? "main" : vid} ${q.t}s is not in the edit (cut)${next != null ? `; the next moment that plays is at edit ${next.toFixed(3)}s` : ""}`); }
    }
    if (lines.length === 1) lines.push("Send editTimes (edit seconds) or footage ([{t, videoId?}], footage seconds).");
    return { text: lines.join("\n") };
  },

  async list_graphics(c) {
    const custom = await prisma.graphic.findMany({ where: { ownerId: c.userId }, orderBy: { createdAt: "desc" }, take: 50 });
    const fonts = await listFonts(c.userId);
    // Recording progress of the ones not ready yet: "42%, about 3 min left".
    const progress: Record<string, string> = {};
    for (const g of custom.filter((x) => x.status === "rendering" || x.status === "queued")) {
      const p = await readGraphic(g.id);
      if (p) progress[g.id] = `${p.percent}%${p.etaSec != null ? `, about ${fmtLeft(p.etaSec)} left` : ""}`;
    }
    // Params as name:type, * = required (the full schemas are long and rarely needed).
    const params = (schema: Record<string, unknown>) => {
      const props = (schema.properties || {}) as Record<string, { type?: string; enum?: string[]; pattern?: string }>;
      const req = new Set((schema.required as string[]) || []);
      return Object.entries(props).map(([k, p]) => `${k}${req.has(k) ? "*" : ""}:${p.enum ? p.enum.join("/") : p.pattern ? "#hex" : p.type === "number" ? "number" : "text"}`).join(" ");
    };
    return { text: [
      "Graphic templates (id | name | seconds | params):",
      ...GRAPHIC_TEMPLATES.map((t) => `${t.id} | ${t.name} | ${t.durationSec}s | ${params(t.paramsSchema)}`),
      "Custom graphics (id | name | status | seconds | size | params = defaults): " + (custom.length ? "\n" + custom.map((g) => `${g.id} | ${g.name} | ${g.status}${progress[g.id] ? ` ${progress[g.id]}` : ""}${g.error ? " (" + g.error.replace(/\s+/g, " ").trim() + (graphicFailedOnServer(g.error) ? "; retry_graphic records it again" : "") + ")" : ""} | ${g.durationSec}s | ${g.width}x${g.height}${defaultsText(g.paramsSchema)}${warningsText(g.warnings)}`).join("\n") : "none (create_graphic)"),
      "Your fonts (add_font; use by name): " + (fonts.length ? fontsText(fonts) : "none"),
      "Music (trackId | name | mood): " + MUSIC_TRACKS.map((m) => `${m.id} | ${m.name} | ${m.mood}`).join("; "),
      "Sound effects for a3 (set_clips clip with sfxId): " + SFX.map((x) => `${x.id} ${x.seconds}s`).join(", "),
    ].join("\n") };
  },

  async get_comments(c, i) {
    const p = await getOwnedProject(c.userId, i.projectId);
    const cs = await prisma.reviewComment.findMany({ where: { review: { OR: [{ projectId: p.id }, { folderId: p.folderId }] }, OR: [{ projectId: null }, { projectId: p.id }] }, orderBy: { createdAt: "asc" }, take: 200 });
    const notes = await prisma.projectComment.findMany({ where: { projectId: p.id }, orderBy: { createdAt: "asc" }, take: 200 });
    const renders = await prisma.render.findMany({ where: { projectId: p.id, kind: "preview" }, select: { id: true, version: true, status: true, outputKey: true, createdAt: true }, orderBy: { createdAt: "desc" } });
    const sampleSets = await prisma.render.findMany({ where: { projectId: p.id, kind: "sample", id: { in: notes.map((n) => n.renderId).filter((x): x is string => !!x) } }, select: { id: true, version: true } });
    const short = (t: string) => (t.length > 600 ? t.slice(0, 600) + "…" : t).replace(/\s+/g, " ");
    const row = (x: { id: string; time: number; text: string; resolved: boolean }, extra = "") => `${x.id} | ${fmtMs(x.time)} | ${short(x.text) || "(no words)"}${extra} | ${x.resolved ? "resolved" : "open"}`;
    // The app in the chat: what a note carries besides words, said in words; the pictures themselves with images true.
    const noteExtra = (n: (typeof notes)[number]) => {
      const d = storedDrawing(n), ims = storedImages(n), on = renders.find((r) => r.id === n.renderId), sam = sampleSets.find((r) => r.id === n.renderId);
      return [on ? `on preview v${on.version}` : sam ? `on samples ${sam.id} of v${sam.version} (get_samples)` : "", d ? drawingText(d) : "", ims.length ? `${ims.length} ${ims.length === 1 ? "picture" : "pictures"}` : "", n.editedAt ? "edited" : ""].filter(Boolean).map((x) => " | " + x).join("");
    };
    const parts = [
      cs.length ? "Client comments (id | output time of the version they watched | text | state):\n" + cs.map((x) => row(x)).join("\n") : "No client comments.",
      notes.length ? "The user's notes (id | time in the edited video | text | what it carries | state):\n" + notes.map((n) => row(n, noteExtra(n))).join("\n") : "",
    ];
    if (!i.images) {
      const has = notes.some((n) => !n.resolved && (storedDrawing(n) || storedImages(n).length));
      return { text: parts.filter(Boolean).join("\n") + (has ? "\nimages true shows the open notes' pictures and drawings." : "") };
    }
    // Up to 8 pictures: each open note's drawing on the frame of the preview it was made on (else the latest), then its pictures.
    const urls: string[] = [], said: string[] = [];
    const latest = renders.find((r) => r.status === "done" && r.outputKey);
    for (const n of notes.filter((x) => !x.resolved)) {
      const d = storedDrawing(n);
      if (d?.key && urls.length < 8) {
        const r = renders.find((x) => x.id === n.renderId && x.status === "done" && x.outputKey) ?? latest;
        const [u] = r ? await framesFor(r.id, [n.time], [d.key]) : [];
        if (u) { urls.push(u); said.push(`${urls.length}. note ${n.id} at ${fmtMs(n.time)}: preview v${r!.version}'s frame with the drawing`); }
      }
      for (const im of storedImages(n)) {
        if (urls.length >= 8) break;
        urls.push(await signGet(im.key, 900)); said.push(`${urls.length}. note ${n.id}: picture${im.name ? ` "${im.name}"` : ""}`);
      }
    }
    return { text: parts.filter(Boolean).join("\n") + (said.length ? `\nImages, in order:\n${said.join("\n")}` : "\nNo open note has a drawing or a picture."), images: urls };
  },

  async check_edit(c, i) {
    const p = await getOwnedProject(c.userId, i.projectId);
    const done = await prisma.render.findFirst({ where: { projectId: p.id, kind: "preview", version: p.currentVersion, status: "done" }, select: { id: true } });
    return { text: clip(`Check of v${p.currentVersion} from the edit itself (nothing rendered${done ? "; this version already has a preview: get_render " + done.id : ""}). The file's own sound (gaps, clicks), loudness and graphics on screen come with render_preview, once.\n${await checkOf(p.id, p.currentVersion, null, null)}`) };
  },

  async get_preview_frames(c, i) {
    const p = await getOwnedProject(c.userId, i.projectId);
    const r = await prisma.render.findFirst({ where: { projectId: p.id, kind: "preview", status: "done", outputKey: { not: null } }, orderBy: { createdAt: "desc" } });
    if (!r) return { text: "No preview yet. Call render_preview first." };
    const times = (i.times?.length ? i.times : [0.1, 0.3, 0.5, 0.7, 0.9].map((f) => f * r.seconds)).slice(0, 5).map((t: number) => Math.min(Math.max(0, t), Math.max(0, r.seconds - 0.05)));
    const images = await framesFor(r.id, times);
    const v = await prisma.video.findUniqueOrThrow({ where: { id: p.videoId }, include: { analysis: true } });
    const ver = await prisma.projectVersion.findUnique({ where: { projectId_v: { projectId: p.id, v: r.version } } });
    const snap = (ver?.timeline ?? { timeline: p.timeline }) as unknown as Snapshot;
    const tr = (v.analysis?.transcript as unknown as Transcript) || [];
    // What is said, in edit order: each stretch of dialogue's words (other videos' too), one line per stretch.
    const tl = asSequence(snap.timeline, allWords(tr), p.videoId);
    const view = sequenceView(tl, allWords(tr));
    const others = await otherSources(c.userId, tl, p.videoId);
    const cut = new Set(tl.cut);
    const wordsOf = (vid: string) => (vid === view.mainVideoId ? allWords(tr) : allWords(others[vid]?.transcript ?? []));
    const isCut = (vid: string, id: string) => vid === view.mainVideoId && cut.has(id);
    // Engine Part 3: what a viewer hears is the preview's sound transcribed again (a job after the render); the
    // footage's word times are only a stand-in while there is no transcriber, said as such.
    let h = (r.plan as { heard?: HeardTranscript } | null)?.heard;
    if (!h && r.seconds > 0) {
      // A preview from before this existed: transcribed now.
      h = { status: "queued", seconds: r.seconds };
      await prisma.render.update({ where: { id: r.id }, data: { plan: { ...((r.plan ?? {}) as Record<string, unknown>), heard: h } as unknown as Prisma.InputJsonValue } });
      await enqueue<HeardJob>("heard", { renderId: r.id }, { jobId: `heard-${r.id}` }).catch(() => {});
    }
    let said: string;
    if (h?.status === "done" && h.words) {
      const al = new Map([[view.mainVideoId, alignedMap(v.analysis?.alignment as unknown as Alignment | null)], ...Object.entries(others).map(([id, o]) => [id, alignedMap(o.alignment)] as const)]);
      const ex = wordsAsPlayed(view, wordsOf, isCut, (vid) => al.get(vid));
      said = `Transcript as it plays (the preview's sound transcribed again; output times):\n${(h.sentences ?? []).map(([t, x]) => `[${fmtT(t)}] ${x}`).join("\n")}\n${heardDiffLine(heardDiff(ex, h.words), h.words.length, ex.length)}`;
    } else if (h?.status === "queued" || h?.status === "transcribing") {
      const spent = h.startedAt ? (Date.now() - Date.parse(h.startedAt)) / 1000 : 0;
      said = `Transcript as it plays: the preview's sound is being transcribed again (${h.status === "queued" ? "waiting its turn" : "transcribing"}, about ${fmtLeft(Math.max(5, 20 + (h.seconds ?? r.seconds) * 0.15 - spent))} left). Ask again then; the frames are below.`;
    } else {
      const why = h?.status === "failed" ? `could not be transcribed again (${h.error ?? "unknown error"})` : h?.status === "off" ? "is not transcribed again (no transcriber is set up)" : "was not transcribed again (a newer preview was)";
      const after = view.sound.filter((s) => !s.muted && !s.silent).map((s) => {
        const ws = wordsOf(s.videoId).filter((w) => !isCut(s.videoId, w.id) && w.t >= s.srcIn && w.t < s.srcOut);
        return ws.length ? `[${fmtClock(editOf(s, ws[0].t))}] ${ws.map((w) => w.text).join(" ")}` : null;
      }).filter(Boolean).join("\n");
      said = `Transcript as it plays: the preview's sound ${why}. The edit's words from the footage's word times instead (not heard; output times):\n${after}`;
    }
    return { text: clip(`Preview v${r.version}${r.version === p.currentVersion ? "" : ` (the edit is at v${p.currentVersion} now)`}, ${r.seconds.toFixed(1)}s. Frames at ${times.map((t: number) => t.toFixed(1) + "s").join(", ")}.\n${said}`), images };
  },

  // ---------------- write ----------------
  async create_folder(c, i) {
    const f = await createFolder(c.userId, i.name);
    return { text: `Created folder "${f.name}" (${f.id}). Put edits in it with folderId on create_project or create_shorts.`, data: { folderId: f.id } };
  },

  async move_footage(c, i) {
    let f = null, made = 0, path = "";
    if (i.libraryFolder !== null) {
      f = await findLibraryFolder(c.userId, i.libraryFolder);
      if (!f && /^c[a-z0-9]{20,}$/.test(i.libraryFolder.trim())) throw notFound("That library folder is not there any more. list_footage lists them.");
      if (!f) ({ folder: f, made } = await ensureLibraryFolderPath(c.userId, i.libraryFolder));
      path = (await listLibraryFolders(c.userId)).find((x) => x.id === f!.id)?.path ?? f.name;
    }
    const r = await moveVideos(c.userId, i.videoIds, f?.id ?? null);
    const n = `${r.moved} ${r.moved === 1 ? "video" : "videos"}`;
    return { text: f ? `Moved ${n} into ${made ? "the new " : ""}library folder "${path}" (${f.id})${made > 1 ? ` (${made} folders made)` : ""}. create_project libraryFolder "${path}" makes one edit of its ready videos (and its folders'), in name order.` : `Took ${n} out of their library folder.`, data: { libraryFolderId: f?.id ?? null } };
  },

  async create_project(c, i) {
    const actor = { actorKind: c.ai === "chatgpt" ? "chatgpt" as const : "claude" as const };
    if (i.libraryFolder) {
      if (i.blank || i.videoId || i.videoIds?.length || i.fromProjectId || i.clips?.length) throw new AppError("libraryFolder makes an edit of every ready video in that folder: send it without blank, videoId, videoIds, fromProjectId or clips.", 400, "invalid-input");
      const lf = await findLibraryFolder(c.userId, i.libraryFolder);
      if (!lf) throw notFound(`There is no library folder "${i.libraryFolder}". list_footage lists them.`);
      const synced = await driveSyncLine(c.userId, lf.id);
      const r = await projectFromLibraryFolder(c.userId, lf.id, { name: i.name, folderId: i.folderId, aspect: i.aspect }, { ...actor, folder: lf });
      const p = r.project;
      const left = r.skipped.length ? ` Left out: ${r.skipped.map((s) => `"${s.name}" (${s.why})`).join(", ")}.` : "";
      const named = r.videos.map((v) => (v.folderPath ? `${v.folderPath} / ${v.name}` : v.name)).join(", ");
      const head = `${synced}Created edit "${p.name}" (${p.id}) from the library folder "${lf.name}": ${r.videos.length} ${r.videos.length === 1 ? "video" : "videos"} back to back in name order${r.subfolders ? ", its folders' after its own" : ""} (${named}), ${p.aspect}.${left}`;
      if (i.reframe) {
        const st = await startEdits(p, { reframe: true });
        if (st.edits.length) { const e = await applyEdits(c, p.id, st.edits, undefined, { projectId: p.id }); return { text: `${head} ${e.text} Next: apply_edits.`, data: { projectId: p.id } }; }
      }
      return { text: `${head} Version 1 is the raw footage. Next: get_project, then apply_edits.`, data: { projectId: p.id } };
    }
    if (i.blank) {
      if (i.videoId || i.videoIds?.length || i.fromProjectId || i.clips?.length) throw new AppError("blank starts an edit with no footage: send it without videoId, videoIds, fromProjectId or clips.", 400, "invalid-input");
      const name = (i.name || "").trim() || "New video";
      const aspect = (i.aspect ?? "16:9") as Aspect;
      const canvas = await createCanvas(c.userId, { seconds: i.blank.seconds, aspect, color: i.blank.color, name });
      const p = await createProject(c.userId, { videoId: canvas.id, name, folderId: i.folderId, aspect, length: i.blank.seconds, styleId: i.styleId }, actor);
      const v1 = (p.timeline as unknown as Timeline).tracks.v1 as { id: string }[];
      const { width, height } = aspectSize(aspect, 1080);
      return { text: `Created edit "${p.name}" (${p.id}) from scratch: a blank ${i.blank.seconds}s canvas, ${(i.blank.color || "#000000").toUpperCase()}, ${aspect} (final ${width}x${height}), silent; V1 is the canvas clip ${v1[0]?.id} (trim_clip it to change the length, up to ${canvas.seconds.toFixed(0)}s). Nothing else is in it. Build the video on it: create_graphic for the animated scenes (transparent false for a full-frame scene; params to reuse one graphic with other words), then one apply_edits with add_graphic placements, add_text, add_library_item pieces, add_music and sfx, set_transition and set_keyframes. test_graphic shows a few seconds of a scene before a full preview. Then check_edit and render_preview once.`, data: { projectId: p.id } };
    }
    if (i.fromProjectId) {
      if (i.videoId || i.videoIds?.length) throw new AppError("Send fromProjectId (a copy of an edit) or videoId / videoIds (a new edit from footage), not both.", 400, "invalid-input");
      const src = await getOwnedProject(c.userId, i.fromProjectId);
      if (i.clips?.length) { const v = await ownedVideo(c.userId, src.videoId); await checkStretches(c.userId, v.id, v.seconds, i.clips, "Clip"); }
      const p = await copyProject(c.userId, src.id, { name: i.name, folderId: i.folderId, bare: !!i.clips?.length }, actor);
      const st = await startEdits(p, { clips: i.clips, aspect: i.aspect, reframe: i.reframe });
      const r = st.edits.length ? await applyEdits(c, p.id, st.edits, i.aspect && i.aspect !== src.aspect ? `A ${i.aspect} version of "${src.name}".` : undefined, { projectId: p.id }) : null;
      const what = i.clips?.length ? `its look (grade, sound, captions, cut words) on ${i.clips.length} ${i.clips.length === 1 ? "stretch" : "stretches"} of footage` : "every change kept";
      return { text: `Created edit "${p.name}" (${p.id}): a copy of "${src.name}" v${src.currentVersion}, ${what}. ${r ? r.text : `${p.aspect}.`} The first edit is untouched. Next: apply_edits.`, data: { projectId: p.id } };
    }
    if (!i.videoId && !i.videoIds?.length) throw new AppError("Send videoId, or videoIds for several videos in order (or fromProjectId to copy an edit).", 400, "invalid-input");
    if (i.clips?.length) {
      const v = await ownedVideo(c.userId, i.videoId || i.videoIds[0]);
      await checkStretches(c.userId, v.id, v.seconds, i.clips, "Clip");
    }
    const p = await createProject(c.userId, i, actor);
    if (i.clips?.length || i.reframe) {
      const st = await startEdits(p, { clips: i.clips, reframe: i.reframe });
      if (st.edits.length) {
        const r = await applyEdits(c, p.id, st.edits, undefined, { projectId: p.id });
        return { text: `Created edit "${p.name}" (${p.id}), ${p.aspect}${i.clips?.length ? `, made of ${i.clips.length} ${i.clips.length === 1 ? "stretch" : "stretches"} of footage (${st.seconds.toFixed(1)}s)` : ""}${st.of ? `, reframed on the speaker in ${st.reframed} of ${st.of} clips` : ""}. ${r.text} Next: apply_edits.`, data: { projectId: p.id } };
      }
    }
    const ref = referenceLine(p.reference as ReferenceRef | null);
    const parts = i.videoIds?.length > 1 ? (p.timeline as unknown as Timeline).tracks.v1 as { id: string; sourceVideoId?: string; sourceIn?: number; sourceOut?: number }[] : [];
    const more = parts.filter((x) => x.sourceVideoId !== p.videoId);
    const what = more.length ? `${more.length + 1} videos as recorded, back to back: the first is the edit's footage, then ${more.map((x) => `clip ${x.id} = video ${x.sourceVideoId} 0-${x.sourceOut}s`).join(", ")}` : "the footage as recorded";
    // Footage filmed sideways: said here, never turned by Rendrr.
    const ids = Array.from(new Set([p.videoId, ...more.map((x) => x.sourceVideoId!)]));
    const side = (await prisma.footageAnalysis.findMany({ where: { videoId: { in: ids } }, select: { videoId: true, vision: true } }))
      .map((a) => ({ id: a.videoId, turn: (a.vision as { turned?: number } | null)?.turned ?? 0 })).filter((x) => x.turn);
    const sideways = side.length ? ` Filmed sideways (faces upright when turned): ${side.map((x) => `${x.id === p.videoId ? "the footage" : `video ${x.id}`} ${x.turn}° clockwise`).join(", ")}; Rendrr did not turn ${side.length === 1 ? "it" : "them"}: apply_edits set_rotation {degrees${side.length > 1 || more.length ? ", clipIds" : ""}} does.` : "";
    return { text: `Created edit "${p.name}" (${p.id}), v1 = ${what} (nothing cut, captions off, no style), ${p.aspect}.${ref ? " " + ref : ""}${sideways} Next: apply_edits.`, data: { projectId: p.id } };
  },
  apply_edits: async (c, i) => applyEdits(c, i.projectId, parseEdits(i.edits || []), i.note, i),

  async create_shorts(c, i) {
    if (!i.videoId === !i.fromProjectId) throw new AppError("Send videoId (the long video) or fromProjectId (an edit of it, whose look the shorts take): one of them.", 400, "invalid-input");
    const actor = { actorKind: c.ai === "chatgpt" ? "chatgpt" as const : "claude" as const };
    const src = i.fromProjectId ? await getOwnedProject(c.userId, i.fromProjectId) : null;
    const video = await ownedVideo(c.userId, src?.videoId ?? i.videoId);
    if (!src && (video.status !== "ready" || !video.analysis)) throw new AppError(`"${video.name}" is not ready yet. Wait until it finishes processing.`, 409, "not-ready");
    // Every stretch is checked before anything is made.
    for (const [k, sh] of (i.shorts as { name?: string; clips: Stretch[] }[]).entries()) await checkStretches(c.userId, video.id, video.seconds, sh.clips, `Short ${k + 1}, stretch`);
    const folder = i.folderName ? await createFolder(c.userId, i.folderName) : null;
    const folderId: string | null = folder?.id ?? i.folderId ?? src?.folderId ?? null;
    const aspect = (i.aspect ?? "9:16") as Aspect;
    const base = (src?.name ?? video.name).replace(/\s+edit$/i, "");
    const lines: string[] = [], ids: string[] = [];
    for (const [k, sh] of (i.shorts as { name?: string; clips: Stretch[] }[]).entries()) {
      const name = sh.name?.trim() || `${base} short ${k + 1}`;
      const p = src ? await copyProject(c.userId, src.id, { name, folderId, bare: true }, actor) : await createProject(c.userId, { videoId: video.id, name, folderId, aspect }, actor);
      try {
        const st = await startEdits(p, { clips: sh.clips, aspect, reframe: i.reframe !== false, captions: i.captions ?? (src ? undefined : "bold") });
        const r = await applyEdits(c, p.id, st.edits, `Short ${k + 1} of ${i.shorts.length}: ${sh.clips.map((x) => `${fmtClock(x.from)}-${fmtClock(x.to)}`).join(", ")} of the footage.`, { projectId: p.id });
        ids.push(p.id);
        lines.push(`${k + 1}. "${name}" (${p.id}): ${st.seconds.toFixed(1)}s from ${sh.clips.map((x) => `${fmtClock(x.from)}-${fmtClock(x.to)}`).join(", ")}${st.of ? `, reframed on the speaker in ${st.reframed} of ${st.of} ${st.of === 1 ? "clip" : "clips"}` : ""}${st.seconds > 180 ? " (over 3 minutes: long for a short)" : ""}. ${flagsOf(r.text) || ""}`.trim());
      } catch (e) {
        // A short that cannot be made is taken back; the others stay.
        await prisma.project.update({ where: { id: p.id }, data: { deletedAt: new Date() } });
        lines.push(`${k + 1}. "${name}": not made: ${(e as Error).message}`);
      }
    }
    const f = folderId ? await prisma.folder.findUnique({ where: { id: folderId }, select: { name: true } }) : null;
    return {
      text: [`Made ${ids.length} of ${i.shorts.length} shorts, ${aspect}${i.reframe === false ? "" : ", reframed on the speaker"}${src ? `, with the look of "${src.name}"` : ""}${f ? `, in folder "${f.name}"${folder ? " (new)" : ""}` : ""}:`, ...lines,
        "Next: polish each with apply_edits (tight cuts inside: fillers, pauses, false starts), check_edit, then render_preview once each. open_projects shows them to the user."].join("\n"),
      data: { projectIds: ids, folderId },
    };
  },

  async save_style(c, i) {
    let base = PLAIN_RULES;
    if (i.baseStyleId) {
      const b = await prisma.style.findFirst({ where: { id: i.baseStyleId, OR: [{ ownerId: null }, { ownerId: c.userId }] } });
      if (!b) throw notFound("That base style does not exist. Use list_styles for the ids.");
      base = StyleRulesSchema.parse(b.rules);
    }
    const patch = StyleRulesPatchSchema.safeParse(i.rules);
    if (!patch.success) { const iss = patch.error.issues[0]; throw new AppError(`Rule ${iss.path.join(".") || "rules"}: ${iss.message}. Rules: cutSilencesOver, removeFillers, trimEdges, captions, zoom, music, sfxOnZoom.`, 400, "invalid-rules"); }
    const ref = i.fromVideoId ? await ownedVideo(c.userId, i.fromVideoId) : null;
    const rules = mergeRules(base, patch.data);
    const text = describeRules(rules);
    const s = await prisma.style.create({ data: {
      id: "u_" + Math.random().toString(36).slice(2, 10), ownerId: c.userId, name: i.name, type: "custom", vibe: ref ? `From the reference "${ref.name}"` : `Saved by ${aiName(c)}`,
      ori: ["9:16", "16:9", "1:1"], platforms: ["instagram", "tiktok", "youtube", "linkedin"], captionLook: rules.captions.look, ...text, rules: rules as unknown as Prisma.InputJsonValue,
      art: "a", sortOrder: 1000, sourceVideoId: ref?.id ?? null,
    } });
    return { text: `Saved style ${s.id} "${s.name}": ${text.cutPace}; ${text.captionRule}; ${text.zoomRules}; ${text.musicVibe}. Apply it with apply_edits [{"op":"apply_style","styleId":"${s.id}"}].`, data: { styleId: s.id } };
  },

  async undo(c, i) {
    const p = await getOwnedProject(c.userId, i.projectId);
    const target = Math.max(1, p.currentVersion - (i.steps ?? 1));
    if (target === p.currentVersion) return { text: "Already at the first version; nothing to undo." };
    const r = await restoreVersion(p.id, target, actorFor(c, "undo", i), `went back to version ${target}`);
    return { text: `Undone: the edit now matches v${target} (saved as v${r.version}).` };
  },

  async create_graphic(c, i) {
    // The code by a one-time link the AI's code workspace sends the file to (the graphic is made when it comes).
    if (i.upload) {
      const u = await graphicUploadLink(c.userId, i);
      return { text: `Upload link for the graphic's code (one HTML file), for 30 minutes: ${u.url}\nSend it from your code workspace:\n  curl -sS -T "<graphic.html>" "${u.url}"\nThe reply is JSON with the graphic's id once it is queued (the settings sent with upload: true apply); then get_graphic {graphicId, wait_seconds: 60}. ${c.ai === "chatgpt" ? "ChatGPT's code sandbox has no internet: use codeUrl (a share link) or code instead." : `If the workspace cannot reach ${u.host}, the user allows that host in their AI's settings (Claude: Settings > Capabilities, code execution, allowed domains), or use codeUrl or code instead.`}`, data: { uploadUrl: u.url } };
    }
    const r = await resolveGraphic(c.userId, i);
    const saved = await saveGraphic(c.userId, r, !!i.replace);
    const how = r.from ? `${saved.replaced ? "Changed" : `Made from ${r.from.id}`}${r.edits ? ` with ${r.edits} ${r.edits === 1 ? "edit" : "edits"}` : ""}${saved.replaced ? `: same id, its placements are recorded again with the new code.` : "."} ` : "";
    return graphicAnswer(saved.id, i.images === true, how);
  },

  test_graphic: async (c, i) => testGraphic(c.userId, i),

  // Engine Part 4: the hidden library (for the AI only).
  list_library: async (_c, i) => ({ text: listLibrary(i.kind) }),
  get_library_item: async (c, i) => getLibraryItem(c.userId, i.id),
  add_library_item: async (c, i) => addLibraryItem(c.userId, i, (edits, note) => applyEdits(c, i.projectId, edits, note, i)),
  search_icons: async (c, i) => searchIcons(c.userId, i.query, i.limit),
  analyze_reference: async (c, i) => analyzeReference(c.userId, i),

  async add_font(c, i) {
    const f = AddFontInput.safeParse(i);
    if (!f.success) throw new AppError(f.error.issues[0].message, 400, "bad-font");
    const buf = f.data.data ? Buffer.from(f.data.data.replace(/^data:[^,]*,/, ""), "base64") : await fetchFont(f.data.url!);
    const r = await addFont(c.userId, f.data, buf);
    const css = `font-family: "${r.family}"${r.weight !== 400 ? `; font-weight: ${r.weight}` : ""}${r.style === "italic" ? "; font-style: italic" : ""}`;
    return { text: `${r.replaced ? "Replaced" : "Added"} font "${r.family}" ${r.weight}${r.style === "italic" ? " italic" : ""} (${r.format}, ${Math.round(r.size / 1024)} KB).${r.installed ? ` ${r.family} is also installed: graphics that name it now draw with this file.` : ""} Use it in create_graphic code by name: ${css}, or ctx.font = "${r.style === "italic" ? "italic " : ""}${r.weight} 48px '${r.family}'".`, data: { fontId: r.id } };
  },

  async add_audio(c, i) {
    if (i.upload) {
      const u = await soundUploadLink(c.userId, i.name);
      return { text: `Upload link for one audio file, for 30 minutes: ${u.url}\nSend the file from your code workspace (up to 500 MB):\n  curl -sS -T "<file>" "${u.url}"${i.name ? "" : "\n(add ?name=<a name> to the link to name it; else it is called Audio)"}\nThe reply is JSON with the file's id and length once it is ready (a few seconds; a long file up to a minute). Then apply_edits set_voice{soundId} or add_music{soundId}. The link takes a video or a picture too (one the user attached to the chat): send it to "${u.url}?kind=footage&filename=<its file name>"; it goes into the library and the reply names its videoId for apply_edits add_broll{videoId, start, end}. ${c.ai === "chatgpt" ? "ChatGPT's code sandbox has no internet, so it cannot send the file: use url (a share link) or driveFileId instead." : `If the workspace cannot reach ${u.host}, the user allows that host in their AI's settings (Claude: Settings > Capabilities, code execution, allowed domains), or use url (a share link) or driveFileId instead.`}`, data: { uploadUrl: u.url } };
    }
    if (!i.url && !i.driveFileId) return { text: `Your audio files (newest first): ${await soundsText(c.userId)}. add_audio upload: true, url or driveFileId brings one in.` };
    const s = await soundFromSource(c.userId, { url: i.url, driveFileId: i.driveFileId, name: i.name });
    return { text: soundOut(s), data: { soundId: s.id, seconds: s.seconds, status: s.status } };
  },
  async add_footage(c, i) {
    const o = { name: i.name ?? null, kind: i.kind ?? null, libraryFolder: i.libraryFolder ?? null, projectId: i.projectId ?? null, ai: c.ai === "chatgpt" ? "chatgpt" as const : "claude" as const, aiName: c.aiName };
    const waitMs = Math.min(120, i.wait_seconds ?? 0) * 1000;
    if (i.upload) {
      const u = await footageUploadLink(c.userId, o);
      return { text: `Upload link for one video or picture, for 30 minutes: ${u.url}\nSend the file from your code workspace (a file the user attached is in your uploads folder):\n  curl -sS -T "<file>" "${u.url}?filename=<its file name>"\nThe reply is JSON with its videoId and how to place it (it waits up to 45 s for a picture or a short clip to be ready). ${c.ai === "chatgpt" ? "ChatGPT's code sandbox has no internet, so it cannot send the file: use url (a share link) or driveFileId instead." : `If the workspace cannot reach ${u.host}, the user allows that host in their AI's settings (Claude: Settings > Capabilities, code execution, allowed domains), or use url (a share link) or driveFileId instead.`}`, data: { uploadUrl: u.url } };
    }
    if (i.url || i.driveFileId) {
      const v = await footageFromSource(c.userId, { url: i.url, driveFileId: i.driveFileId, ...o });
      const now = await waitForFootage(v.id, waitMs || 30_000);
      return { text: footageText(now, { projectId: i.projectId }), data: { videoId: now.id, status: now.status } };
    }
    if (i.videoId) {
      const v0 = await ownedVideo(c.userId, i.videoId);
      if (i.projectId) await intoEdit(c.userId, i.projectId, v0.id, o);
      const v = await waitForFootage(v0.id, waitMs);
      return { text: footageText(v, { projectId: i.projectId }), data: { videoId: v.id, status: v.status } };
    }
    return { text: "Send one of: upload: true (a file in your code workspace, such as one the user attached), url (a share link), driveFileId (a file in their Google Drive), or videoId (one already in the library: where it is; with projectId it goes in that edit's Media panel)." };
  },
  async add_lut(c, i) {
    const l = AddLutInput.safeParse(i);
    if (!l.success) throw new AppError(l.error.issues[0].message, 400, "bad-lut");
    if (l.data.upload) {
      const u = await lutUploadLink(c.userId, l.data.name);
      return { text: `Upload link for one .cube file, for 30 minutes: ${u.url}\nSend the file from your code workspace:\n  curl -sS -X PUT --data-binary @"<file>.cube" "${u.url}"${l.data.name ? "" : "\n(add ?name=<LUT name> to the link to name it; else the file's TITLE)"}\nThe reply is JSON with the LUT's id; then apply_edits set_grade{all: true, lut: {id, amount: 1}}. ${c.ai === "chatgpt" ? `ChatGPT's code sandbox has no internet, so it cannot send the file: use set_grade lut {cube: the file's text} for a small LUT, or add_lut url (a share link) or driveFileId instead.` : `If the workspace cannot reach ${u.host}, the user allows that host in their AI's settings (Claude: Settings > Capabilities, code execution, allowed domains), or use url or driveFileId instead.`}`, data: { uploadUrl: u.url } };
    }
    const src = await lutSource(c.userId, l.data);
    const r = await saveLut(c.userId, l.data.name || src.name || "LUT", src.text);
    return { text: `${r.replaced ? "Replaced" : "Added"} LUT "${r.name}" ${r.id} (${r.kind.toUpperCase()}, ${r.size} points). Put it on an edit: apply_edits set_grade{all: true, lut: {id: "${r.id}", amount: 1}} (amount under 1 mixes it in; other set_grade fields go on top). Your LUTs: ${await lutsText(c.userId)}.`, data: { lutId: r.id } };
  },

  async get_graphic(c, i) {
    let g = await prisma.graphic.findUnique({ where: { id: i.graphicId } });
    if (!g || g.ownerId !== c.userId) throw notFound("That graphic does not exist. list_graphics shows yours.");
    if (i.retry && g.status === "failed") await recordGraphicAgain(c.userId, g.id);
    // wait_seconds (or a retry): until it is ready or failed, and (with projectId) its placements in that edit too.
    const tl = i.projectId ? ((await getOwnedProject(c.userId, i.projectId)).timeline as unknown as Timeline) : null;
    const waitMs = Math.min(120, i.wait_seconds ?? (i.retry ? TOOL_WAIT_MS / 1000 : 0)) * 1000;
    if (waitMs > 0) {
      await waitFor(async () => {
        const x = await prisma.graphic.findUnique({ where: { id: g!.id } });
        if (!x || (x.status !== "ready" && x.status !== "failed")) return null;
        return !tl || x.status === "failed" || !(await placementStatus(c.userId, tl, g!.id)).pending ? x : null;
      }, waitMs, 1000);
      g = await prisma.graphic.findUniqueOrThrow({ where: { id: g.id } });
    }
    const places = tl ? (await placementStatus(c.userId, tl, g.id)).line : "";
    const head = `${g.id} | ${g.name}`, size = `${+g.durationSec.toFixed(2)}s | ${g.width}x${g.height}${g.transparent ? ", transparent" : ""}`;
    const pl = places ? ` ${places}` : "";
    if (g.status === "failed") return { text: `${head} | failed: ${(g.error || "unknown error").replace(/\.$/, "")}. ${failedNext(g.id, g.error)}${pl}` };
    if (g.status !== "ready") {
      const p = await readGraphic(g.id);
      return { text: `${head} | ${p ? `recording: ${p.percent}% done${p.etaSec != null ? `, about ${fmtLeft(p.etaSec)} left` : ""}` : g.status} | ${size}. wait_seconds waits for it (up to 120); add_graphic can place it now.${pl}` };
    }
    const images = i.images === true ? await Promise.all(((g.checkFrames as string[]) || []).slice(0, 4).map((k) => signGet(k, 900))) : [];
    return { text: `${head} | ready | ${size}${defaultsText(g.paramsSchema).replace(/^ \| /, " | params ")}.${warningsText(g.warnings)}${images.length ? " 4 check frames attached." : ""} Place it with apply_edits add_graphic.${pl}`, images };
  },

  async retry_graphic(c, i) {
    const g = await prisma.graphic.findFirst({ where: { id: i.graphicId, ownerId: c.userId, kind: "custom" } });
    if (!g) throw notFound("That graphic does not exist. list_graphics shows yours.");
    // Its placements' failures forgotten and their recordings queued again (in the edits that use it).
    const busy = g.status === "queued" || g.status === "rendering";
    if (!busy) await recordGraphicAgain(c.userId, g.id, true);
    const cleared = await clearVariantErrors(g.id);
    const projects = (await prisma.project.findMany({ where: { userId: c.userId, deletedAt: null, ...(i.projectId ? { id: i.projectId } : {}) }, select: { timeline: true } }))
      .filter((p) => JSON.stringify(p.timeline).includes(`"graphicId":"${g.id}"`));
    let queued = 0;
    for (const p of projects) queued += await prewarmGraphics(c.userId, p.timeline as unknown as Timeline).catch(() => 0);
    const lead = `${busy ? "It is recording already. " : "Recording it again from its own code. "}${cleared || queued ? `${queued} placement ${queued === 1 ? "recording" : "recordings"} queued again${cleared ? ` (${cleared} had failed)` : ""}. ` : ""}`;
    return graphicAnswer(g.id, false, lead, Math.min(120, i.wait_seconds ?? TOOL_WAIT_MS / 1000) * 1000);
  },

  async link_account(c, i) {
    if (!c.loginId) throw new AppError("This connection did not say which login it is. Reconnect Rendrr and try again.");
    const r = await redeemLinkCode(c.loginId, i.code);
    const acct = await accountLine(r.userId);
    return { text: r.already ? `Already linked: this login opens the right account. ${acct}` : `Linked. This login now opens the user's Rendrr account (${acct.replace(/^Account |\.$/g, "")})${r.removedEmpty ? "; the empty account it had before was removed" : ""}. Call list_footage again.` };
  },

  // ---------------- render and share ----------------
  async render_preview(c, i) {
    // One preview per version: asking again with nothing changed returns the preview that version already has.
    const p = await getOwnedProject(c.userId, i.projectId);
    const latest = await prisma.projectVersion.findFirst({ where: { projectId: p.id }, orderBy: { v: "desc" }, select: { v: true } });
    const had = !i.again && latest ? await prisma.render.findFirst({ where: { projectId: p.id, kind: "preview", version: latest.v, status: "done", outputKey: { not: null } }, orderBy: { createdAt: "desc" } }) : null;
    // A graphic in the edit changed in place since (create_graphic replace, rerecord): the edit is the same, the
    // picture is not.
    const used = had ? Array.from(new Set((((p.timeline as unknown as Timeline).tracks?.v3 ?? []) as V3Clip[]).filter((x) => x.kind === "graphic" && x.graphicId).map((x) => x.graphicId!))) : [];
    const changed = had && used.length ? await prisma.graphic.findMany({ where: { id: { in: used }, ownerId: c.userId, changedAt: { gt: had.createdAt } }, select: { id: true, name: true } }) : [];
    if (had && !changed.length) {
      const out = await renderOut(had.id);
      return { ...out, text: `Nothing changed since preview v${had.version}, so nothing was rendered. Its check again:\n${out.text}\nMake every change in one apply_edits (check_edit checks it without rendering), then render once.` };
    }
    // One preview per change: the AI's second preview in a row is not rendered unless the user asked for more since
    // (newRequest) or left feedback (a comment, a change in the editor). Each render is a version the user sees and
    // costs them tokens; the AI's own fixes after a preview wait for the next request.
    // (A preview of this same version still rendering is joined below: nothing new is rendered.)
    const running = latest ? await prisma.render.findFirst({ where: { projectId: p.id, kind: "preview", version: latest.v, status: { in: ["queued", "running"] } }, select: { id: true } }) : null;
    const gate = i.newRequest || running ? null : await previewGate(p.id);
    if (gate) return { text: gate };
    const r = await startRender(c.userId, i.projectId, "preview", { by: c.ai ?? "claude" });
    await waitFor(async () => { const x = await prisma.render.findUnique({ where: { id: r.id } }); return x && (x.status === "done" || x.status === "failed") ? x : null; }, TOOL_WAIT_MS);
    const out = await renderOut(r.id);
    return had ? { ...out, text: `${changed.map((g) => `"${g.name}" (${g.id})`).join(", ")} changed since preview v${had.version}: rendering it again.\n${out.text}` } : out;
  },
  async render_samples(c, i) {
    let r;
    try { r = await startSamples(c.userId, i.projectId, { frames: i.frames, clips: i.clips }); } catch (e) {
      const err = e as AppError;
      if (err.code === "samples" || err.code === "expired") return { text: `${err.message} Nothing was rendered.` };
      throw e;
    }
    await waitFor(async () => { const x = await prisma.render.findUnique({ where: { id: r.id } }); return x && (x.status === "done" || x.status === "failed") ? x : null; }, TOOL_WAIT_MS);
    return samplesAnswer(c.userId, r.id, i.images !== false);
  },
  async get_samples(c, i) {
    const r = await prisma.render.findUnique({ where: { id: i.renderId } });
    if (!r || r.userId !== c.userId || r.kind !== "sample") throw notFound("Those samples do not exist.");
    if (i.wait_seconds) await waitFor(async () => { const x = await prisma.render.findUnique({ where: { id: r.id }, select: { status: true } }); return x && (x.status === "done" || x.status === "failed") ? x : null; }, Math.min(120, i.wait_seconds) * 1000, 1000);
    return samplesAnswer(c.userId, r.id, i.images !== false);
  },
  async render_final(c, i) {
    // Saving into Drive: the folder is found and checked first, so a wrong name or a refused folder is said now, not
    // after the render.
    const target = i.driveFolder != null || i.saveToDrive ? await driveTargetOrText(c.userId, i.driveFolder, i.createFolders) : null;
    if (typeof target === "string") return { text: target };
    let r;
    try { r = await startRender(c.userId, i.projectId, "final", { by: c.ai ?? "claude" }); } catch (e) {
      const code = (e as AppError).code;
      if (code === "need-original") return { text: "This footage is on the user's computer. Full quality needs the original file once: ask the user to open this edit in Rendrr and press Render final. The app will ask for the file and delete it within 24 hours." };
      if (code === "drive") return { text: "The original file is no longer reachable in Google Drive. Ask the user to reconnect it in the Rendrr Library." };
      throw e;
    }
    if (target) await askDriveSave(r, target, fileNameFor(i.fileName, (await renderResult(r)).fileName));
    await waitFor(async () => { const x = await prisma.render.findUnique({ where: { id: r.id } }); return x && (x.status === "done" || x.status === "failed") ? x : null; }, TOOL_WAIT_MS);
    return renderOut(r.id);
  },
  async save_to_drive(c, i) {
    await getOwnedProject(c.userId, i.projectId);
    // The newest final: one still rendering (newer than the last finished one) is saved when it is done.
    const running = await prisma.render.findFirst({ where: { projectId: i.projectId, userId: c.userId, kind: "final", status: { in: ["queued", "running"] }, ...(i.version ? { version: i.version } : {}) }, orderBy: { createdAt: "desc" } });
    const done = await latestFinal(c.userId, i.projectId, i.version);
    const r = running && (!done || running.createdAt > done.createdAt) ? null : done;
    if (!r) {
      if (!running) return { text: `This edit has no finished final${i.version ? ` of v${i.version}` : ""} yet. render_final with driveFolder renders it and saves it there when it is done.` };
      const t = await driveTargetOrText(c.userId, i.folder, i.createFolders);
      if (typeof t === "string") return { text: t };
      await askDriveSave(running, t, fileNameFor(i.fileName, (await renderResult(running)).fileName));
      return renderOut(running.id);
    }
    const t = await driveTargetOrText(c.userId, i.folder, i.createFolders);
    if (typeof t === "string") return { text: t };
    await askDriveSave(r, t, fileNameFor(i.fileName, (await renderResult(r)).fileName));
    // A short final is often there within the wait.
    await waitFor(async () => { const x = await prisma.render.findUnique({ where: { id: r.id } }); const s = x && (x.driveSave as { state?: string } | null)?.state; return s === "saved" || s === "failed" ? x : null; }, TOOL_WAIT_MS);
    return { text: `Final v${r.version} (render id ${r.id}): ${driveLine(await prisma.render.findUniqueOrThrow({ where: { id: r.id } }))}`, data: { renderId: r.id } };
  },
  async get_render(c, i) {
    const r = await prisma.render.findUnique({ where: { id: i.renderId } });
    if (!r || r.userId !== c.userId) throw notFound("That render does not exist.");
    // wait_seconds: answered as soon as it is done or failed, or when the time is up.
    if (i.wait_seconds) await waitFor(async () => { const x = await prisma.render.findUnique({ where: { id: r.id }, select: { status: true } }); return x && (x.status === "done" || x.status === "failed") ? x : null; }, Math.min(120, i.wait_seconds) * 1000, 1000);
    return renderOut(r.id);
  },
  async create_review_link(c, i) {
    const r = await createReviewLink(c.userId, { projectId: i.projectId, password: i.password, expiresDays: i.expiresDays, allowDownload: i.allowDownload });
    return { text: `Review link: ${WEB()}/review/${r.token}${r.password ? `\nPassword: ${r.password} (share it separately)` : ""}\nExpires ${r.expires}. ${r.allowDownload ? "Download on." : "No download."} If this version has no render yet, a preview is being made for the client now.` };
  },
  async resolve_comment(c, i) {
    const cm = await prisma.reviewComment.findUnique({ where: { id: i.commentId }, include: { review: true } });
    if (cm && cm.review.userId === c.userId) {
      await prisma.reviewComment.update({ where: { id: cm.id }, data: { resolved: true } });
      return { text: `Resolved: "${cm.text.slice(0, 120)}"` };
    }
    const note = await prisma.projectComment.findUnique({ where: { id: i.commentId } });
    if (!note || note.userId !== c.userId) throw notFound("That comment does not exist.");
    await prisma.projectComment.update({ where: { id: note.id }, data: { resolved: true } });
    return { text: `Resolved: "${note.text.slice(0, 120)}"` };
  },
};

export function toolDef(name: string) { return MCP_TOOLS.find((t) => t.name === name); }
