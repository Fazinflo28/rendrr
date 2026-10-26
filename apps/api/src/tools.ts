// The AI tools, implemented on the API server. The MCP server forwards each call here with the user it verified.
// Every response is small text; images only when asked for (images: true, get_frames, get_preview_frames).
// Every write goes through applyTimelineChange.
import { AppError, applyTimelineChange, enqueue, notFound, readGraphic, restoreVersion, signGet, type BreakdownJob, type ChangeActor, type GraphicJob } from "@rendrr/core";
import { prisma, type Prisma } from "@rendrr/db";
import {
  AddFontInput, allWords, asSequence, breakdownAsText, CreateGraphicInput, customParamsSchema, describeRules, graphicDefaults, editCheck, editOf, EditOpSchema, StyleRulesPatchSchema, fmtClock, fmtT, GRAPHIC_TEMPLATES, mergeRules, MUSIC_TRACKS, outputDuration, sequenceView, SFX,
  MCP_TOOLS, sheetsIn, StyleRulesSchema, summarizeTimeline, transcriptAsText, unknownEditFields, type Breakdown, type ReferenceRef, type EditOp, type FileLoudness, type FileMeasure, type Sheet, type Silence, type Snapshot, type StyleRules, type Timeline, type Transcript, type VideoKind,
} from "@rendrr/shared";
import { otherSources } from "./services/sequence";
import { createProject, getOwnedProject, graphicPlacements } from "./services/projects";
import { addFont, fetchFont, fontsText, listFonts } from "./services/fonts";
import { renderResult, renderStatus, startRender } from "./services/render";
import { redeemLinkCode } from "./services/logins";
import { createReviewLink } from "./routes/reviews";
import { framesFor, videoFramesFor } from "./services/frames";
import { lutsFor, withMeasurements } from "./services/color";

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
  // The activity log keeps the edits, but long lists (clips, word ids) only as counts.
  const logged = { ...(input as object), edits: edits.map((e) => (e.op === "set_clips" ? { ...e, clips: e.clips.length } : "wordIds" in e && (e.wordIds?.length ?? 0) > 50 ? { ...e, wordIds: e.wordIds!.length } : e)) };
  // Phase 6: match_color gets the clips' measured frames (the worker reads them; a failure stops here, loudly).
  const ready = await withMeasurements(projectId, edits);
  const luts = ready.some((e) => e.op === "match_color") ? await lutsFor(c.userId, p0.timeline as unknown as Timeline) : undefined;
  const r = await applyTimelineChange(projectId, ready.length === 1 ? ready[0] : { op: "batch", ops: ready }, actorFor(c, "apply_edits", logged), { luts });
  const v = await prisma.video.findUniqueOrThrow({ where: { id: p0.videoId }, include: { analysis: true } });
  const out = outputDuration(r.snapshot.timeline, allWords((v.analysis?.transcript as unknown as Transcript) || []));
  if (r.unchanged) return { text: `Nothing changed (still v${r.version}): ${r.summary}.`, data: { version: r.version } };
  const steps = r.summary.split("; ");
  await prisma.aiChatMessage.create({ data: { projectId, userId: c.userId, role: "ai", ai: aiName(c), text: (note?.trim() || `Made ${steps.length === 1 ? "a change" : steps.length + " changes"}.`).slice(0, 600), workflow: steps.map((x) => x.charAt(0).toUpperCase() + x.slice(1)) as unknown as Prisma.InputJsonValue, changed: true } });
  return { text: `Done (v${r.version}, ${out.toFixed(1)}s of ${r.snapshot.timeline.duration.toFixed(1)}s): ${r.summary}.`, data: { version: r.version } };
}

/** The longest a tool call waits for a job: clients drop calls after about a minute (some sooner), so a longer
 *  recording or render answers with its id and is polled (get_graphic, get_render). */
export const TOOL_WAIT_MS = 8_000;
async function waitFor<T>(fn: () => Promise<T | null>, ms: number, every = 1000): Promise<T | null> {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, every)); }
  return null;
}

/** A finished render as text: a preview comes with the check of the edit; nothing to download into the chat. */
async function renderOut(renderId: string): Promise<ToolOut> {
  const r = await prisma.render.findUniqueOrThrow({ where: { id: renderId } });
  if (r.status === "failed") return { text: `The ${r.kind} render failed: ${r.error || "unknown error"}${r.errorCode === "need-original" ? "\nAsk the user to open the edit in Rendrr and press Render final; the app will ask for the original file." : ""}` };
  if (r.status !== "done") {
    // Phase 7: where it is and the time left (the worker's estimate), so the AI can say when to look again.
    const st = await renderStatus(r);
    const left = st.etaSec != null ? `, about ${fmtLeft(st.etaSec)} left` : ", estimating the time left";
    return { text: `The ${r.kind} render is ${st.status === "queued" ? "queued" : `at ${st.percent}% (${st.steps[st.step] ?? "starting"})${left}`} (render id ${r.id}, ${r.quality ?? ""}). Call get_render in a little while.` };
  }
  const res = await renderResult(r);
  const took = res.renderSeconds != null ? `, rendered in ${res.renderSeconds < 60 ? `${Math.round(res.renderSeconds)} s` : `${Math.floor(res.renderSeconds / 60)} min ${Math.round(res.renderSeconds % 60)} s`}` : "";
  const head = `${r.kind === "final" ? "Final" : "Preview"} v${r.version} ready: ${res.quality}, ${res.size}, ${res.seconds.toFixed(1)}s${took}. ${r.kind === "final" ? "The user downloads it" : "Watch"} in Rendrr: ${WEB()}/editor/${r.projectId}`;
  if (r.kind === "final") return { text: head, data: { renderId: r.id } };
  const plan = r.plan as { loudness?: FileLoudness; measured?: FileMeasure; outputSeconds?: number; operations?: string[] } | null;
  // Phase 6: what the render itself said about HDR and missing LUTs goes into the check.
  const notes = (plan?.operations ?? []).filter((l) => l.startsWith("HDR:") || /^Color: LUT .* left out/.test(l) || /^Graphic \S+ left out/.test(l));
  return { text: `${head}\n${await checkOf(r.projectId, r.version, plan?.loudness ?? null, plan?.measured ?? null, plan?.outputSeconds ?? null, notes)}`, data: { renderId: r.id } };
}

/** The footage facts the Export line needs (Phase 7). */
const footageOf = (v: { fps: number | null; width: number | null; height: number | null; hdr: string | null }) => ({ fps: v.fps, width: v.width, height: v.height, hdr: !!v.hdr });
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
/** What a graphic's recording noticed (a font that was not there), as one sentence ("" when nothing). */
const warningsText = (w: unknown) => (Array.isArray(w) && w.length ? ` Warning: ${w.join(" ")}` : "");
/** A custom graphic's params and their default values, for list_graphics ("" when it has none). */
const defaultsText = (schema: unknown) => { const d = graphicDefaults(schema); return Object.keys(d).length ? ` | ${JSON.stringify(d).slice(0, 300)}` : ""; };
const fmtLeft = (s: number) => (s < 60 ? `${Math.max(1, Math.round(s / 5) * 5)} s` : s < 3600 ? `${Math.round(s / 60)} min` : `${Math.floor(s / 3600)} h ${String(Math.round((s % 3600) / 60)).padStart(2, "0")} min`);

/** The check of one version of an edit against its rendered file (pauses from 0.15 s, whatever the style says: the AI knows what it asked for). */
async function checkOf(projectId: string, version: number, loudness: FileLoudness | null, measured: FileMeasure | null, planned: number | null = null, renderNotes: string[] = []): Promise<string> {
  const p = await prisma.project.findUniqueOrThrow({ where: { id: projectId }, include: { video: { include: { analysis: true } } } });
  const ver = await prisma.projectVersion.findUnique({ where: { projectId_v: { projectId, v: version } } });
  const snap = (ver?.timeline ?? { timeline: p.timeline, name: p.name, aspect: p.aspect, styleId: p.styleId }) as unknown as Snapshot;
  const others = await otherSources(p.userId, snap.timeline, p.videoId);
  const luts = await prisma.lut.findMany({ where: { userId: p.userId }, select: { id: true, name: true } });
  return editCheck(snap, (p.video.analysis?.transcript as unknown as Transcript) || [], { loudness, measured, planned, renderNotes, videoId: p.videoId, lutName: (id) => luts.find((l) => l.id === id)?.name, footage: footageOf(p.video), transcripts: Object.fromEntries(Object.entries(others).map(([id, o]) => [id, o.transcript])) });
}

export const TOOL_HANDLERS: Record<string, (c: Ctx, input: any) => Promise<ToolOut>> = {
  // ---------------- read ----------------
  async list_footage(c, i) {
    const vs = await prisma.video.findMany({ where: { userId: c.userId, ...(i.kind ? { kind: i.kind } : {}) }, orderBy: { createdAt: "desc" }, take: 500 });
    const recipes = i.kind === "reference" ? await prisma.reference.findMany({ where: { userId: c.userId }, orderBy: { createdAt: "desc" }, take: 50 }) : [];
    const acct = await accountLine(c.userId);
    if (!vs.length && !recipes.length) return { text: i.kind ? `${acct} No ${i.kind === "reference" ? "reference videos" : "footage"} yet.` : `${acct} No footage yet: the user adds videos in Rendrr (Library > Add footage). ${EMPTY_HINT}` };
    const pg = pageOf(vs, i);
    const where = (v: (typeof vs)[number]) => (v.sample ? "sample" : v.source === "drive" ? "drive" : "computer");
    return { text: `${acct} Videos ${pg.offset + 1}-${pg.offset + pg.shown.length} of ${vs.length} (id | name | kind | length | shape | status | raw file):\n` +
      pg.shown.map((v) => `${v.id} | ${v.name} | ${v.kind} | ${fmtClock(v.seconds)} | ${v.orientation}${v.width ? ` ${v.width}x${v.height}` : ""} | ${v.status}${v.error ? ` (${v.error})` : ""} | ${where(v)}`).join("\n") + pg.tail +
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
      `RAW FILE ${v.sample ? "Rendrr's sample" : v.source === "drive" ? "in Google Drive" : "on the user's computer"}${v.status === "expired" ? " | preview copy expired: rebuild it in the Library to edit or take frames" : ""}`,
      `TRANSCRIPT (${v.analysis.transcriber === "stub" ? "SAMPLE: transcription is not set up" : "AssemblyAI"}) ${words.length} words. Line id [start] text${i.detail === "words" ? "; words as text(wordId@start-end)" : ""}:`,
      transcriptAsText(tr, undefined, i.detail === "words" ? "words" : "sentences") || "(no speech found)",
      `SILENCES 0.4s+ (${sil.length}): ${sil.slice(0, 80).map((s) => `${s.start.toFixed(1)}-${s.end.toFixed(1)}`).join(", ") || "none"}${sil.length > 80 ? ", …" : ""}`,
      `FILLERS ${fillers.length}${fillers.length ? " (" + Object.entries(counts).map(([k, n]) => `${k} x${n}`).join(", ") + ")" : ""}${i.detail === "words" && fillers.length ? ". Ids: " + fillers.slice(0, 200).map((f) => f.id).join(" ") : ""}`,
      `SCENE CUTS (${cuts.length}): ${cuts.slice(0, 100).map((t) => t.toFixed(1)).join(", ") || "none"}`,
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
    times = times.map((t) => Math.round(Math.min(Math.max(0, t), Math.max(0, v.seconds - 0.05)) * 100) / 100);
    const images = await videoFramesFor(v.id, times);
    if (!images.length) return { text: "No frames came back. Try again in a moment." };
    const b = breakdownOf(v);
    const where = (t: number) => b?.shots.find((s) => t >= s.start && t < s.end)?.id;
    return { text: `Frames of "${v.name}" at ${times.map((t) => `${fmtT(t)}${where(t) ? ` (${where(t)})` : ""}`).join(", ")}, in that order.`, images };
  },

  async list_styles(c) {
    const ss = await prisma.style.findMany({ where: { OR: [{ ownerId: null }, { ownerId: c.userId }] }, orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] });
    return { text: "Styles (id | name | type | vibe | shapes | platforms):\n" + ss.map((s) => `${s.id} | ${s.name} | ${s.type} | ${s.vibe} | ${s.ori.join(" ")} | ${s.platforms.join(" ")}`).join("\n") };
  },

  async get_style(c, i) {
    const s = await prisma.style.findFirst({ where: { id: i.styleId, OR: [{ ownerId: null }, { ownerId: c.userId }] } });
    if (!s) throw notFound("That style does not exist. Use list_styles for the ids.");
    return { text: [`${s.name} (${s.id}), ${s.type}: ${s.vibe}`, `Cut pace: ${s.cutPace}. Captions: ${s.captionRule} (${s.captionLook}). Zooms: ${s.zoomRules}. Music: ${s.musicVibe}.`, `Rules apply_style runs: ${JSON.stringify(s.rules)}`].join("\n") };
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

  async get_project(c, i) {
    const p = await getOwnedProject(c.userId, i.projectId);
    const v = await prisma.video.findUniqueOrThrow({ where: { id: p.videoId }, include: { analysis: true } });
    const snap = { timeline: p.timeline, name: p.name, aspect: p.aspect, styleId: p.styleId } as unknown as Snapshot;
    const style = p.styleId ? await prisma.style.findUnique({ where: { id: p.styleId } }) : null;
    const preview = await prisma.render.findFirst({ where: { projectId: p.id, status: "done", kind: "preview" }, orderBy: { createdAt: "desc" } });
    // Phase 6: the user's imported LUTs (for set_grade lut) and whether the footage is HDR, only when there are any.
    const luts = await prisma.lut.findMany({ where: { userId: c.userId }, orderBy: { createdAt: "desc" }, take: 30, select: { id: true, name: true } });
    return { text: clip([`Edit "${p.name}" (${p.id}) on footage ${v.id} "${v.name}"${v.hdr ? ` (HDR ${v.hdr === "pq" ? "PQ" : "HLG"}: the final keeps it unless set_export hdr sdr)` : ""}. ${p.status}, v${p.currentVersion}, ${p.styleId ? `style ${style?.name ?? p.styleId} applied` : "no style applied"}.`,
      ...[referenceLine(p.reference as ReferenceRef | null)].filter((x): x is string => !!x),
      summarizeTimeline(snap, (v.analysis?.transcript as unknown as Transcript) || [], 60, p.videoId, (id) => luts.find((l) => l.id === id)?.name, footageOf(v)),
      ...(await placementLine(c.userId, p.timeline as unknown as Timeline)),
      ...(luts.length ? [`Your LUTs (set_grade lut id): ${luts.map((l) => `${l.id} "${l.name}"`).join(", ")}`] : []),
      preview ? `Latest preview: v${preview.version}${preview.version === p.currentVersion ? " (current)" : " (older than the current version)"}.` : "No preview yet."].join("\n")) };
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
      "Custom graphics (id | name | status | seconds | size | params = defaults): " + (custom.length ? "\n" + custom.map((g) => `${g.id} | ${g.name} | ${g.status}${progress[g.id] ? ` ${progress[g.id]}` : ""}${g.error ? " (" + g.error + ")" : ""} | ${g.durationSec}s | ${g.width}x${g.height}${defaultsText(g.paramsSchema)}${warningsText(g.warnings)}`).join("\n") : "none (create_graphic)"),
      "Your fonts (add_font; use by name): " + (fonts.length ? fontsText(fonts) : "none"),
      "Music (trackId | name | mood): " + MUSIC_TRACKS.map((m) => `${m.id} | ${m.name} | ${m.mood}`).join("; "),
      "Sound effects for a3 (set_clips clip with sfxId): " + SFX.map((x) => `${x.id} ${x.seconds}s`).join(", "),
    ].join("\n") };
  },

  async get_comments(c, i) {
    const p = await getOwnedProject(c.userId, i.projectId);
    const cs = await prisma.reviewComment.findMany({ where: { review: { OR: [{ projectId: p.id }, { folderId: p.folderId }] }, OR: [{ projectId: null }, { projectId: p.id }] }, orderBy: { createdAt: "asc" }, take: 200 });
    const notes = await prisma.projectComment.findMany({ where: { projectId: p.id }, orderBy: { createdAt: "asc" }, take: 200 });
    const short = (t: string) => (t.length > 600 ? t.slice(0, 600) + "…" : t).replace(/\s+/g, " ");
    const row = (x: { id: string; time: number; text: string; resolved: boolean }) => `${x.id} | ${fmtClock(x.time)} | ${short(x.text)} | ${x.resolved ? "resolved" : "open"}`;
    const parts = [
      cs.length ? "Client comments (id | output time of the version they watched | text | state):\n" + cs.map(row).join("\n") : "No client comments.",
      notes.length ? "The user's notes (id | time in the edited video | text | state):\n" + notes.map(row).join("\n") : "",
    ];
    return { text: parts.filter(Boolean).join("\n") };
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
    const after = view.sound.filter((s) => !s.muted && !s.silent).map((s) => {
      const ws = (s.videoId === view.mainVideoId ? allWords(tr) : allWords(others[s.videoId]?.transcript ?? [])).filter((w) => !(s.videoId === view.mainVideoId && cut.has(w.id)) && w.t >= s.srcIn && w.t < s.srcOut);
      return ws.length ? `[${fmtClock(editOf(s, ws[0].t))}] ${ws.map((w) => w.text).join(" ")}` : null;
    }).filter(Boolean).join("\n");
    return { text: clip(`Preview v${r.version}${r.version === p.currentVersion ? "" : ` (the edit is at v${p.currentVersion} now)`}, ${r.seconds.toFixed(1)}s. Frames at ${times.map((t: number) => t.toFixed(1) + "s").join(", ")}.\nTranscript as it plays (output times):\n${after}`), images };
  },

  // ---------------- write ----------------
  async create_project(c, i) {
    const p = await createProject(c.userId, i, { actorKind: c.ai === "chatgpt" ? "chatgpt" : "claude" });
    const ref = referenceLine(p.reference as ReferenceRef | null);
    return { text: `Created edit "${p.name}" (${p.id}), v1 = the footage as recorded (nothing cut, captions off, no style), ${p.aspect}.${ref ? " " + ref : ""} Next: apply_edits.`, data: { projectId: p.id } };
  },
  apply_edits: (c, i) => applyEdits(c, i.projectId, parseEdits(i.edits || []), i.note, i),

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
    const g0 = CreateGraphicInput.parse(i);
    const g = await prisma.graphic.create({ data: { ownerId: c.userId, name: (g0.name || "Custom graphic").slice(0, 120), kind: "custom", code: g0.code, paramsSchema: customParamsSchema(g0.params) as Prisma.InputJsonValue, durationSec: g0.durationSec, width: g0.width, height: g0.height, transparent: g0.transparent, status: "queued" } });
    await enqueue<GraphicJob>("graphic", { graphicId: g.id }, { jobId: g.id });
    const done = await waitFor(async () => { const x = await prisma.graphic.findUnique({ where: { id: g.id } }); return x && (x.status === "ready" || x.status === "failed") ? x : null; }, TOOL_WAIT_MS, 500);
    if (!done) {
      const p = await readGraphic(g.id);
      return { text: `Graphic ${g.id} is recording${p ? `: ${p.percent}% done${p.etaSec != null ? `, about ${fmtLeft(p.etaSec)} left` : ""}` : " (queued)"}. It keeps going: get_graphic shows how far it got${p?.etaSec ? ` (look again in about ${fmtLeft(Math.min(p.etaSec, 300))})` : ""}. You can place it with apply_edits add_graphic now; renders include it once it is ready.`, data: { graphicId: g.id, status: "rendering" } };
    }
    if (done.status === "failed") return { text: `The graphic did not render: ${done.error}. Fix the code and call create_graphic again.` };
    const images = i.images === true ? await Promise.all(((done.checkFrames as string[]) || []).slice(0, 4).map((k) => signGet(k, 900))) : [];
    return { text: `Graphic ready: ${done.id} (${done.width}x${done.height}, ${done.durationSec.toFixed(1)}s${done.transparent ? ", transparent" : ""}).${images.length ? " 4 check frames attached." : ""}${warningsText(done.warnings)} Place it with apply_edits add_graphic.`, images, data: { graphicId: done.id } };
  },

  async add_font(c, i) {
    const f = AddFontInput.safeParse(i);
    if (!f.success) throw new AppError(f.error.issues[0].message, 400, "bad-font");
    const buf = f.data.data ? Buffer.from(f.data.data.replace(/^data:[^,]*,/, ""), "base64") : await fetchFont(f.data.url!);
    const r = await addFont(c.userId, f.data, buf);
    const css = `font-family: "${r.family}"${r.weight !== 400 ? `; font-weight: ${r.weight}` : ""}${r.style === "italic" ? "; font-style: italic" : ""}`;
    return { text: `${r.replaced ? "Replaced" : "Added"} font "${r.family}" ${r.weight}${r.style === "italic" ? " italic" : ""} (${r.format}, ${Math.round(r.size / 1024)} KB).${r.installed ? ` ${r.family} is also installed: graphics that name it now draw with this file.` : ""} Use it in create_graphic code by name: ${css}, or ctx.font = "${r.style === "italic" ? "italic " : ""}${r.weight} 48px '${r.family}'".`, data: { fontId: r.id } };
  },

  async get_graphic(c, i) {
    const g = await prisma.graphic.findUnique({ where: { id: i.graphicId } });
    if (!g || g.ownerId !== c.userId) throw notFound("That graphic does not exist. list_graphics shows yours.");
    const head = `${g.id} | ${g.name}`, size = `${+g.durationSec.toFixed(2)}s | ${g.width}x${g.height}${g.transparent ? ", transparent" : ""}`;
    if (g.status === "failed") return { text: `${head} | failed: ${(g.error || "unknown error").replace(/\.$/, "")}. Fix the code and call create_graphic again.` };
    if (g.status !== "ready") {
      const p = await readGraphic(g.id);
      return { text: `${head} | ${p ? `recording: ${p.percent}% done${p.etaSec != null ? `, about ${fmtLeft(p.etaSec)} left` : ""}` : g.status} | ${size}. Look again in a little while; add_graphic can place it now.` };
    }
    const images = i.images === true ? await Promise.all(((g.checkFrames as string[]) || []).slice(0, 4).map((k) => signGet(k, 900))) : [];
    return { text: `${head} | ready | ${size}${defaultsText(g.paramsSchema).replace(/^ \| /, " | params ")}.${warningsText(g.warnings)}${images.length ? " 4 check frames attached." : ""} Place it with apply_edits add_graphic.`, images };
  },

  async link_account(c, i) {
    if (!c.loginId) throw new AppError("This connection did not say which login it is. Reconnect Rendrr and try again.");
    const r = await redeemLinkCode(c.loginId, i.code);
    const acct = await accountLine(r.userId);
    return { text: r.already ? `Already linked: this login opens the right account. ${acct}` : `Linked. This login now opens the user's Rendrr account (${acct.replace(/^Account |\.$/g, "")})${r.removedEmpty ? "; the empty account it had before was removed" : ""}. Call list_footage again.` };
  },

  // ---------------- render and share ----------------
  async render_preview(c, i) {
    const r = await startRender(c.userId, i.projectId, "preview");
    await waitFor(async () => { const x = await prisma.render.findUnique({ where: { id: r.id } }); return x && (x.status === "done" || x.status === "failed") ? x : null; }, TOOL_WAIT_MS);
    return renderOut(r.id);
  },
  async render_final(c, i) {
    let r;
    try { r = await startRender(c.userId, i.projectId, "final"); } catch (e) {
      const code = (e as AppError).code;
      if (code === "need-original") return { text: "This footage is on the user's computer. Full quality needs the original file once: ask the user to open this edit in Rendrr and press Render final. The app will ask for the file and delete it within 24 hours." };
      if (code === "drive") return { text: "The original file is no longer reachable in Google Drive. Ask the user to reconnect it in the Rendrr Library." };
      throw e;
    }
    await waitFor(async () => { const x = await prisma.render.findUnique({ where: { id: r.id } }); return x && (x.status === "done" || x.status === "failed") ? x : null; }, TOOL_WAIT_MS);
    return renderOut(r.id);
  },
  async get_render(c, i) {
    const r = await prisma.render.findUnique({ where: { id: i.renderId } });
    if (!r || r.userId !== c.userId) throw notFound("That render does not exist.");
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
