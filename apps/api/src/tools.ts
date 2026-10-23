// The AI tools, implemented on the API server. The MCP server forwards each call here with the user it verified.
// Every response is small text (plus a few images: frames or contact sheets). Every write goes through applyTimelineChange.
import { AppError, applyTimelineChange, enqueue, notFound, restoreVersion, signGet, type ChangeActor, type GraphicJob } from "@rendrr/core";
import { prisma } from "@rendrr/db";
import {
  allWords, breakdownAsText, CreateGraphicInput, findMusic, fmtClock, fmtT, GRAPHIC_TEMPLATES, keptRanges, makeTimeMap, MCP_TOOLS, MUSIC_TRACKS, outputDuration, SFX,
  sheetsIn, summarizeTimeline, transcriptAsText, type Breakdown, type Op, type Silence, type Snapshot, type Transcript, type VideoKind,
} from "@rendrr/shared";
import { createProject, getOwnedProject } from "./services/projects";
import { renderResult, startRender } from "./services/render";
import { createReviewLink } from "./routes/reviews";
import { framesFor, videoFramesFor } from "./services/frames";

export type ToolOut = { text: string; images?: string[]; data?: unknown };
export type ToolCtx = { userId: string; ai: "claude" | "chatgpt" | null; aiName?: string; via?: "chat" };
type Ctx = ToolCtx;

const MAX_CHARS = 24_000; // ~6k tokens
export const clip = (s: string) => (s.length > MAX_CHARS ? s.slice(0, MAX_CHARS) + "\n…(cut to stay short; ask for a narrower range)" : s);
const actorFor = (c: Ctx, toolName: string, input: unknown): ChangeActor => ({ kind: c.ai === "chatgpt" ? "chatgpt" : "claude", userId: c.userId, ai: c.aiName, via: c.via, toolName, input });

async function ownedVideo(userId: string, id: string) {
  const v = await prisma.video.findUnique({ where: { id }, include: { analysis: true } });
  if (!v || v.userId !== userId) throw notFound("That video is not in the library. Use list_footage for the ids.");
  return v;
}
type OwnedVideo = Awaited<ReturnType<typeof ownedVideo>>;

/** Which Rendrr account this connection uses, so a user with two logins can tell. */
async function accountLine(userId: string) {
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { email: true } });
  return `Rendrr account: ${u?.email || "unknown"}`;
}

/** The stored breakdown with the video's current name and kind (both can change after it was made). */
export function breakdownOf(v: OwnedVideo): Breakdown | null {
  const b = v.analysis?.breakdown as unknown as Breakdown | null;
  return b?.v ? { ...b, video: { ...b.video, name: v.name, kind: (v.kind as VideoKind) || "footage" } } : null;
}

/** The breakdown text plus its contact sheets for a time range: what an AI reads instead of watching. */
async function videoAsCode(v: OwnedVideo, from?: number, to?: number, maxSheets = 4): Promise<{ text: string; images: string[] }> {
  const b = breakdownOf(v);
  if (!b) {
    const kf = ((v.analysis?.keyFrames as { t: number; key: string }[]) || []).slice(0, 5);
    return { text: `BREAKDOWN not ready yet for "${v.name}" (Rendrr makes it right after the transcript; ask again in a minute). Key frames at ${kf.map((k) => k.t.toFixed(1) + "s").join(", ") || "none"} attached.`, images: await Promise.all(kf.map((k) => signGet(k.key, 900))) };
  }
  const sheets = sheetsIn(b, from ?? 0, to ?? 1e9, maxSheets);
  const all = b.frames.sheets.length;
  const note = !all ? "Contact sheets are gone with the expired preview copy; the text above still holds."
    : `Attached: ${sheets.map((s) => `sheet ${b.frames.sheets.indexOf(s) + 1} (${fmtT(s.from)}-${fmtT(s.to)})`).join(", ")}${all > sheets.length ? `. ${all - sheets.length} more sheet${all - sheets.length === 1 ? "" : "s"}: ask with from/to` : ""}.`;
  return { text: `${breakdownAsText(b, { from, to })}\n${note}`, images: await Promise.all(sheets.map((s) => signGet(s.key, 900))) };
}

async function edit(c: Ctx, name: string, projectId: string, op: Op, input: unknown): Promise<ToolOut> {
  await getOwnedProject(c.userId, projectId);
  const r = await applyTimelineChange(projectId, op, actorFor(c, name, input));
  const p = await prisma.project.findUniqueOrThrow({ where: { id: projectId }, include: { video: { include: { analysis: true } } } });
  const tr = (p.video.analysis?.transcript as unknown as Transcript) || [];
  const out = outputDuration(r.snapshot.timeline, allWords(tr));
  if (r.unchanged) return { text: `Nothing to change: ${r.summary}.\nStill version ${r.version}.`, data: { version: r.version } };
  return { text: `Done: ${r.summary}.\nNow version ${r.version}. Output length ${out.toFixed(1)}s of ${r.snapshot.timeline.duration.toFixed(1)}s footage. Render a preview to check it.`, data: { version: r.version } };
}

async function waitFor<T>(fn: () => Promise<T | null>, ms: number, every = 1000): Promise<T | null> {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, every)); }
  return null;
}

async function renderOut(renderId: string): Promise<ToolOut> {
  const r = await prisma.render.findUniqueOrThrow({ where: { id: renderId } });
  if (r.status === "failed") return { text: `The ${r.kind} render failed: ${r.error || "unknown error"}${r.errorCode === "need-original" ? "\nAsk the user to open the edit in Rendrr and press Render final; the app will ask for the original file." : ""}` };
  if (r.status !== "done") return { text: `The ${r.kind} render is still running (render id ${r.id}). Call get_render in a little while.` };
  const res = await renderResult(r);
  return { text: `${r.kind === "final" ? "Final" : "Preview"} ready: ${res.quality}, ${res.size}, ${res.seconds.toFixed(1)}s (version ${r.version}).\nWatch: ${res.url}\n(Link works for 6 hours.)`, images: res.frames.slice(0, 4), data: { renderId: r.id, url: res.url } };
}

export const TOOL_HANDLERS: Record<string, (c: Ctx, input: any) => Promise<ToolOut>> = {
  // ---------------- read ----------------
  async list_footage(c) {
    const vs = await prisma.video.findMany({ where: { userId: c.userId }, orderBy: { createdAt: "desc" }, take: 100 });
    const acct = await accountLine(c.userId);
    if (!vs.length) return { text: `${acct}\nNo footage in this account yet. Ask the user to add some in Rendrr (Library > Add footage), from Google Drive or their computer. If they already have videos in Rendrr, they are logged in to Rendrr with a different email than this connection: they should disconnect Rendrr in their AI's connector settings and connect again with the email they use on the Rendrr website.` };
    return { text: `${acct}\nVideos (id | name | kind | length | shape | status | raw file). kind reference = a video whose style to copy, not to edit:\n` + vs.map((v) => `${v.id} | ${v.name} | ${v.kind} | ${fmtClock(v.seconds)} | ${v.orientation}${v.width ? ` ${v.width}x${v.height}` : ""} | ${v.status}${v.error ? ` (${v.error})` : ""} | ${v.sample ? "sample" : v.source === "drive" ? "Google Drive" : "user's computer"}`).join("\n") };
  },

  async get_footage(c, i) {
    const v = await ownedVideo(c.userId, i.videoId);
    if (!v.analysis || !["ready", "expired"].includes(v.status)) return { text: `"${v.name}" is ${v.status}${v.error ? ": " + v.error : ""}. It can be read and edited once it is ready.` };
    if (i.detail === "json") { const b = breakdownOf(v); return { text: b ? clip(JSON.stringify(b)) : "The breakdown is not ready yet. Ask again in a minute." }; }
    const code = await videoAsCode(v, i.from, i.to);
    let tr = v.analysis.transcript as unknown as Transcript;
    if (i.from != null || i.to != null) tr = tr.filter((l) => l.end >= (i.from ?? 0) && l.start <= (i.to ?? 1e9));
    const words = allWords(v.analysis.transcript as unknown as Transcript);
    const fillers = words.filter((w) => w.filler);
    const sil = (v.analysis.silences as unknown as Silence[]).filter((s) => s.end - s.start >= 0.4);
    const cuts = (v.analysis.sceneCuts as number[]) || [];
    const counts: Record<string, number> = {};
    for (const f of fillers) { const k = f.text.toLowerCase().replace(/[^a-z' ]/g, ""); counts[k] = (counts[k] || 0) + 1; }
    const lines = [
      code.text,
      `RAW FILE ${v.sample ? "Rendrr's built-in sample" : v.source === "drive" ? "in Google Drive" : "on the user's computer"}${v.status === "expired" ? " | preview copy expired: rebuild it in the Library to edit or take frames" : ""}`,
      `TRANSCRIPT (${v.analysis.transcriber === "stub" ? "SAMPLE transcript: transcription is not set up" : "AssemblyAI"}), ${words.length} words. Line id [start] text${i.detail === "words" ? "; words as text(wordId@start)" : ""}:`,
      transcriptAsText(tr, undefined, i.detail === "words" ? "words" : "sentences") || "(no speech found)",
      `SILENCES of 0.4s or more (${sil.length}): ${sil.slice(0, 80).map((s) => `${s.start.toFixed(1)}-${s.end.toFixed(1)}`).join(", ") || "none"}${sil.length > 80 ? ", …" : ""}`,
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
    return { text: `Frames of "${v.name}" at ${times.map((t) => `${fmtT(t)}${where(t) ? ` (${where(t)})` : ""}`).join(", ")} attached, in that order.`, images };
  },

  async list_references(c) {
    const [vs, saved] = await Promise.all([
      prisma.video.findMany({ where: { userId: c.userId, kind: "reference" }, orderBy: { createdAt: "desc" }, take: 100 }),
      prisma.reference.findMany({ where: { userId: c.userId }, orderBy: { createdAt: "desc" }, take: 50 }),
    ]);
    if (!vs.length && !saved.length) return { text: "No references yet. The user can add one in Rendrr: Library > Add footage > \"Add as a reference\" (a video whose style to copy). Any video in list_footage also works with get_reference." };
    return { text: ["References (id | name | type | length | status):",
      ...vs.map((v) => `${v.id} | ${v.name} | reference video | ${fmtClock(v.seconds)} | ${v.status}`),
      ...saved.map((r) => `${r.id} | ${r.name} | saved gallery recipe | - | ready`)].join("\n") };
  },

  async list_styles(c) {
    const ss = await prisma.style.findMany({ where: { OR: [{ ownerId: null }, { ownerId: c.userId }] }, orderBy: { sortOrder: "asc" } });
    return { text: "Styles (id | name | type | vibe | shapes | platforms):\n" + ss.map((s) => `${s.id} | ${s.name} | ${s.type} | ${s.vibe} | ${s.ori.join(" ")} | ${s.platforms.join(" ")}`).join("\n") };
  },

  async get_style(c, i) {
    const s = await prisma.style.findFirst({ where: { id: i.styleId, OR: [{ ownerId: null }, { ownerId: c.userId }] } });
    if (!s) throw notFound("That style does not exist. Use list_styles for the ids.");
    return { text: [`${s.name} (${s.id}), ${s.type}: ${s.vibe}`, `Shapes: ${s.ori.join(", ")}. Best on: ${s.platforms.join(", ")}.`, `Cut pace: ${s.cutPace}`, `Captions: ${s.captionRule} (look ${s.captionLook})`, `Zooms: ${s.zoomRules}`, `Music: ${s.musicVibe}`, `Machine rules apply_style uses: ${JSON.stringify(s.rules)}`].join("\n") };
  },

  async list_folders(c) {
    const fs = await prisma.folder.findMany({ where: { userId: c.userId }, orderBy: { updatedAt: "desc" }, include: { _count: { select: { projects: { where: { deletedAt: null } } } } } });
    return { text: fs.length ? "Folders (id | name | edits):\n" + fs.map((f) => `${f.id} | ${f.name} | ${f._count.projects}`).join("\n") : "No folders yet." };
  },

  async list_projects(c, i) {
    const ps = await prisma.project.findMany({ where: { userId: c.userId, deletedAt: null, ...(i.folderId ? { folderId: i.folderId } : {}) }, orderBy: { updatedAt: "desc" }, take: 100, include: { folder: true } });
    if (!ps.length) return { text: `${await accountLine(c.userId)}\nNo edits in this account yet. Use create_project. If the user already has edits in Rendrr, this connection is logged in with a different email than the Rendrr website: they should reconnect Rendrr with that email.` };
    return { text: "Edits (id | name | folder | style | aspect | status | version):\n" + ps.map((p) => `${p.id} | ${p.name} | ${p.folder.name} | ${p.styleId} | ${p.aspect} | ${p.status} | v${p.currentVersion}`).join("\n") };
  },

  async get_project(c, i) {
    const p = await getOwnedProject(c.userId, i.projectId);
    const v = await prisma.video.findUniqueOrThrow({ where: { id: p.videoId }, include: { analysis: true } });
    const snap = { timeline: p.timeline, name: p.name, aspect: p.aspect, styleId: p.styleId } as unknown as Snapshot;
    const style = await prisma.style.findUnique({ where: { id: p.styleId } });
    const preview = await prisma.render.findFirst({ where: { projectId: p.id, status: "done", kind: "preview" }, orderBy: { createdAt: "desc" } });
    return { text: clip([`Edit "${p.name}" (${p.id}) on footage ${v.id} "${v.name}". Status ${p.status}, version ${p.currentVersion}, style ${style?.name ?? p.styleId}.`,
      summarizeTimeline(snap, (v.analysis?.transcript as unknown as Transcript) || []),
      preview ? `Latest preview: version ${preview.version}${preview.version === p.currentVersion ? " (current)" : " (older than the current version)"}.` : "No preview rendered yet."].join("\n")) };
  },

  async get_reference(c, i) {
    // A video of the user's (marked reference or not): its breakdown and contact sheets.
    const rv = await prisma.video.findUnique({ where: { id: i.referenceId }, include: { analysis: true } });
    if (rv && rv.userId === c.userId) {
      if (!rv.analysis || !["ready", "expired"].includes(rv.status)) return { text: `The reference "${rv.name}" is ${rv.status}. Rendrr reads it once it is ready.` };
      const code = await videoAsCode(rv);
      const tr = (rv.analysis.transcript as unknown as Transcript) || [];
      return { text: clip(`Reference video: match its rhythm, shot lengths, hook and look with the user's own footage; do not copy its content.\n${code.text}\nTRANSCRIPT\n${transcriptAsText(tr) || "(no speech)"}`), images: code.images };
    }
    // Your own saved recipes, or a gallery video whose author allows recreating it.
    const g0 = await prisma.galleryItem.findUnique({ where: { id: i.referenceId } });
    const shared = !!g0 && (g0.userId === c.userId || g0.allowRecreate);
    const r0 = await prisma.reference.findUnique({ where: { id: i.referenceId } });
    const r = r0 && (r0.userId === c.userId || shared) ? r0 : null;
    const g = r ? null : shared ? g0 : null;
    if (!r && !g) throw notFound("That reference does not exist.");
    const recipe = r?.recipe ?? g!.recipe;
    const frames: string[] = [];
    const projectId = g?.projectId ?? (await prisma.galleryItem.findUnique({ where: { id: i.referenceId } }))?.projectId;
    if (projectId) {
      const rr = await prisma.render.findFirst({ where: { projectId, status: "done", outputKey: { not: null } }, orderBy: { createdAt: "desc" } });
      for (const k of ((rr?.framesKeys as string[]) || []).slice(0, 5)) frames.push(await signGet(k, 900));
    }
    return { text: `Reference "${r?.name ?? g!.title}". Recipe (match the rhythm, not the footage):\n${JSON.stringify(recipe, null, 1)}`, images: frames };
  },

  async list_graphics(c) {
    const custom = await prisma.graphic.findMany({ where: { ownerId: c.userId }, orderBy: { createdAt: "desc" }, take: 50 });
    return { text: [
      "Graphic templates (id | name | default seconds | params JSON schema):",
      ...GRAPHIC_TEMPLATES.map((t) => `${t.id} | ${t.name} | ${t.durationSec}s | ${JSON.stringify(t.paramsSchema)}`),
      "Custom graphics (id | name | status | seconds | size):",
      ...(custom.length ? custom.map((g) => `${g.id} | ${g.name} | ${g.status}${g.error ? " (" + g.error + ")" : ""} | ${g.durationSec}s | ${g.width}x${g.height}`) : ["none yet (create_graphic)"]),
      "Music for add_music (trackId | name | mood): " + MUSIC_TRACKS.map((m) => `${m.id} | ${m.name} | ${m.mood}`).join("; "),
      "Sound effects (put on a3 with set_clips: {id, start, end, label, sfxId}): " + SFX.map((s) => `${s.id} (${s.name}, ${s.seconds}s)`).join("; "),
    ].join("\n") };
  },

  async get_comments(c, i) {
    const p = await getOwnedProject(c.userId, i.projectId);
    const cs = await prisma.reviewComment.findMany({ where: { review: { OR: [{ projectId: p.id }, { folderId: p.folderId }] }, OR: [{ projectId: null }, { projectId: p.id }] }, orderBy: { createdAt: "asc" }, take: 200 });
    const notes = await prisma.projectComment.findMany({ where: { projectId: p.id }, orderBy: { createdAt: "asc" }, take: 200 });
    const short = (t: string) => (t.length > 600 ? t.slice(0, 600) + "…" : t).replace(/\s+/g, " ");
    const row = (x: { id: string; time: number; text: string; resolved: boolean }) => `${x.id} | ${fmtClock(x.time)} | ${short(x.text)} | ${x.resolved ? "resolved" : "open"}`;
    const parts = [
      cs.length ? "Client comments (comment id | time in the rendered video | text | resolved):\n" + cs.map(row).join("\n") + "\nClient comment times are OUTPUT times of the version the client watched." : "No client comments on this edit.",
      notes.length ? "The user's own notes in the editor (comment id | time in the edited video | text | resolved):\n" + notes.map(row).join("\n") : "",
    ];
    return { text: parts.filter(Boolean).join("\n\n") };
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
    const kept = keptRanges(snap.timeline, allWords(tr));
    const map = makeTimeMap(kept);
    const cut = new Set(snap.timeline.cut);
    const after = tr.map((l) => {
      const ws = l.words.filter((w) => !cut.has(w.id) && kept.some((k) => w.t >= k.start && w.t < k.end));
      return ws.length ? `[${fmtClock(map.toOutput(ws[0].t))}] ${ws.map((w) => w.text).join(" ")}` : null;
    }).filter(Boolean).join("\n");
    return { text: clip(`Preview of version ${r.version}${r.version === p.currentVersion ? " (current)" : `; the edit is now at version ${p.currentVersion}, render again to see newer changes`}, ${r.seconds.toFixed(1)}s. Frames at output times ${times.map((t: number) => t.toFixed(1) + "s").join(", ")} attached.\nTranscript as it plays now (output times):\n${after}`), images };
  },

  // ---------------- write ----------------
  async create_project(c, i) {
    const p = await createProject(c.userId, i, { autoStyle: false, actorKind: c.ai === "chatgpt" ? "chatgpt" : "claude" });
    return { text: `Created edit "${p.name}" (${p.id}), version 1 = the footage as recorded, aspect ${p.aspect}, style ${p.styleId}. Next: apply_style(${p.id}, styleId).`, data: { projectId: p.id } };
  },
  apply_style: (c, i) => edit(c, "apply_style", i.projectId, { op: "apply_style", styleId: i.styleId }, i),
  cut_words: (c, i) => edit(c, "cut_words", i.projectId, { op: "cut_words", wordIds: i.wordIds, from: i.from, to: i.to }, i),
  restore_words: (c, i) => edit(c, "restore_words", i.projectId, { op: "restore_words", wordIds: i.wordIds }, i),
  cut_silences: (c, i) => edit(c, "cut_silences", i.projectId, { op: "cut_silences", overSeconds: i.overSeconds }, i),
  remove_fillers: (c, i) => edit(c, "remove_fillers", i.projectId, { op: "remove_fillers" }, i),
  set_clips: (c, i) => edit(c, "set_clips", i.projectId, { op: "set_clips", track: i.track, clips: i.clips }, { projectId: i.projectId, track: i.track, clips: i.clips.length }),
  split_clip: (c, i) => edit(c, "split_clip", i.projectId, { op: "split_clip", track: i.track, clipId: i.clipId, at: i.at }, i),
  trim_clip: (c, i) => edit(c, "trim_clip", i.projectId, { op: "trim_clip", track: i.track, clipId: i.clipId, start: i.start, end: i.end }, i),
  delete_clip: (c, i) => edit(c, "delete_clip", i.projectId, { op: "delete_clip", track: i.track, clipId: i.clipId }, i),
  add_zoom: (c, i) => edit(c, "add_zoom", i.projectId, { op: "add_zoom", start: i.start, end: i.end, scale: i.scale }, i),
  add_broll: (c, i) => edit(c, "add_broll", i.projectId, { op: "add_broll", videoId: i.videoId, start: i.start, end: i.end, sourceStart: i.sourceStart ?? 0 }, i),
  set_captions: (c, i) => edit(c, "set_captions", i.projectId, { op: "set_captions", on: i.on, look: i.look }, i),
  edit_caption: (c, i) => edit(c, "edit_caption", i.projectId, { op: "edit_caption", lineId: i.lineId, text: i.text }, i),
  add_music(c, i) {
    const pick = i.trackId || i.mood;
    if (!pick) throw new AppError("Give a trackId or a mood. Moods: " + Array.from(new Set(MUSIC_TRACKS.map((m) => m.mood))).join(", ") + ".");
    if (!findMusic(pick)) throw new AppError(`No music track or mood called "${pick}". Use list_graphics to see the tracks.`);
    return edit(c, "add_music", i.projectId, { op: "add_music", trackId: pick, gainDb: i.gainDb }, i);
  },
  add_graphic: (c, i) => edit(c, "add_graphic", i.projectId, { op: "add_graphic", graphicId: i.graphicId, start: i.start, end: i.end, params: i.params || {} }, i),
  set_aspect: (c, i) => edit(c, "set_aspect", i.projectId, { op: "set_aspect", aspect: i.aspect }, i),
  rename_project: (c, i) => edit(c, "rename_project", i.projectId, { op: "rename", name: i.name }, i),
  async undo(c, i) {
    const p = await getOwnedProject(c.userId, i.projectId);
    const target = Math.max(1, p.currentVersion - (i.steps ?? 1));
    if (target === p.currentVersion) return { text: "Already at the first version; nothing to undo." };
    const r = await restoreVersion(p.id, target, actorFor(c, "undo", i), `went back to version ${target}`);
    return { text: `Undone: the edit now matches version ${target} (saved as version ${r.version}).` };
  },

  async create_graphic(c, i) {
    const g0 = CreateGraphicInput.parse(i);
    const g = await prisma.graphic.create({ data: { ownerId: c.userId, name: (g0.name || "Custom graphic").slice(0, 120), kind: "custom", code: g0.code, durationSec: g0.durationSec, width: g0.width, height: g0.height, transparent: g0.transparent, status: "queued" } });
    await enqueue<GraphicJob>("graphic", { graphicId: g.id }, { jobId: g.id });
    const done = await waitFor(async () => { const x = await prisma.graphic.findUnique({ where: { id: g.id } }); return x && (x.status === "ready" || x.status === "failed") ? x : null; }, 90_000);
    if (!done) return { text: `Graphic ${g.id} is still rendering. Call list_graphics in a little while to see its status.` };
    if (done.status === "failed") return { text: `The graphic did not render: ${done.error}. Fix the code and call create_graphic again.` };
    const images = await Promise.all(((done.checkFrames as string[]) || []).slice(0, 4).map((k) => signGet(k, 900)));
    return { text: `Graphic ready: ${done.id} (${done.width}x${done.height}, ${done.durationSec.toFixed(1)}s${done.transparent ? ", transparent" : ""}). 4 check frames attached. Place it with add_graphic.`, images, data: { graphicId: done.id } };
  },

  // ---------------- render and share ----------------
  async render_preview(c, i) {
    const r = await startRender(c.userId, i.projectId, "preview");
    await waitFor(async () => { const x = await prisma.render.findUnique({ where: { id: r.id } }); return x && (x.status === "done" || x.status === "failed") ? x : null; }, 60_000);
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
    await waitFor(async () => { const x = await prisma.render.findUnique({ where: { id: r.id } }); return x && (x.status === "done" || x.status === "failed") ? x : null; }, 180_000, 2000);
    return renderOut(r.id);
  },
  async get_render(c, i) {
    const r = await prisma.render.findUnique({ where: { id: i.renderId } });
    if (!r || r.userId !== c.userId) throw notFound("That render does not exist.");
    return renderOut(r.id);
  },
  async create_review_link(c, i) {
    const r = await createReviewLink(c.userId, { projectId: i.projectId, password: i.password, expiresDays: i.expiresDays, allowDownload: i.allowDownload });
    const base = (process.env.PUBLIC_WEB_URL || "").replace(/\/$/, "");
    return { text: `Review link: ${base}/review/${r.token}${r.password ? `\nPassword: ${r.password} (share it separately)` : ""}\nExpires: ${r.expires}. ${r.allowDownload ? "Download on." : "No download."} If this version has no render yet, a preview is being made for the client now.` };
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
