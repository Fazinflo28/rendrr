// Engine Part 4.4: style files, for the AI (and, as a public breakdown, beside a video published to Explore). analyze_reference measures a reference
// video into one (the worker's style queue); list_styles and get_style read them.
import { AppError, enqueue, notFound, type StyleJob } from "@rendrr/core";
import { Prisma, prisma } from "@rendrr/db";
import { STYLE_FILE_VERSION, notesText, plainWords, publicBreakdown, styleFileText, type PublicBreakdown, type StyleFile, type StyleNotes } from "@rendrr/shared";

/** How long the tool waits for a short reference to finish (clients drop calls after about a minute). */
export const STYLE_WAIT_MS = 8_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function analyzeReference(userId: string, i: { videoId: string; name?: string; again?: boolean; notes?: StyleNotes }): Promise<{ text: string; data?: unknown }> {
  const v = await prisma.video.findUnique({ where: { id: i.videoId }, select: { id: true, userId: true, name: true, seconds: true, status: true, proxyKey: true } });
  if (!v || v.userId !== userId) throw notFound("That video is not in the library. Use list_footage for the ids.");
  if (i.notes) return saveNotes(userId, v, i.notes);
  if (v.status !== "ready" || !v.proxyKey) throw new AppError(`"${v.name}" is not ready yet (${v.status}). Analyze it once it is.`, 409, "not-ready");
  // Measured before: the same file, unless asked again.
  const old = await prisma.styleFile.findFirst({ where: { userId, videoId: v.id, status: { in: ["ready", "measuring"] } }, orderBy: { createdAt: "desc" } });
  const fresh = old && (old.status === "measuring" || (old.data as { v?: number } | null)?.v === STYLE_FILE_VERSION);
  if (old && fresh && !i.again) {
    if (old.status === "ready") return { text: `${v.name} was measured before: style file ${old.id}.\n${styleFileText(old.id, old.name, old.data as unknown as StyleFile)}`, data: { styleFileId: old.id } };
    return { text: `Style file ${old.id} of "${v.name}" is being measured (${old.progress}%). get_style ${old.id} shows it when ready.`, data: { styleFileId: old.id } };
  }
  const sf = await prisma.styleFile.create({ data: { userId, videoId: v.id, name: (i.name || `Style of ${v.name}`).slice(0, 120) } });
  await enqueue<StyleJob>("style", { styleFileId: sf.id }, { jobId: `style-${sf.id}` });
  const end = Date.now() + STYLE_WAIT_MS;
  while (Date.now() < end) {
    const r = await prisma.styleFile.findUniqueOrThrow({ where: { id: sf.id } });
    if (r.status === "ready") return { text: styleFileText(r.id, r.name, r.data as unknown as StyleFile), data: { styleFileId: r.id } };
    if (r.status === "failed") return { text: `Measuring "${v.name}" failed: ${r.error ?? "unknown error"}.`, data: { styleFileId: r.id } };
    await sleep(700);
  }
  const r = await prisma.styleFile.findUniqueOrThrow({ where: { id: sf.id } });
  const left = Math.round(v.seconds * 0.15 * (1 - r.progress / 100));
  return { text: `Measuring "${v.name}" into style file ${sf.id}: ${r.progress}%${left > 5 ? `, about ${left < 90 ? `${left} s` : `${Math.round(left / 60)} min`} left` : ""}. It keeps going: get_style ${sf.id} shows it when ready.`, data: { styleFileId: sf.id } };
}

/** list_styles' lines for the user's style files. */
export async function styleFileLines(userId: string): Promise<string[]> {
  const fs = await prisma.styleFile.findMany({ where: { userId }, orderBy: { createdAt: "desc" }, take: 50, select: { id: true, name: true, status: true, progress: true, createdAt: true } });
  return fs.map((f) => `${f.id} | ${f.name} | style file (measured from a reference) | ${f.status === "ready" ? "ready" : f.status === "failed" ? "failed" : `measuring ${f.progress}%`}`);
}

/** get_style of a style file id: the file, how far measuring got, or why it failed; null when the id is not one. */
export async function styleFileOut(userId: string, id: string): Promise<string | null> {
  const f = await prisma.styleFile.findUnique({ where: { id } });
  if (!f || f.userId !== userId) return null;
  if (f.status === "failed") return `Style file ${f.id} failed: ${f.error ?? "unknown error"}. analyze_reference again to retry.`;
  if (f.status !== "ready") return `Style file ${f.id} is being measured (${f.progress}%). Ask again in a little while.`;
  return styleFileText(f.id, f.name, f.data as unknown as StyleFile);
}

/** The AI's notes from the frames (fonts, logo, what each scene shows), kept on the video's newest style file. A
 * part sent again replaces that part; the rest stays. Nothing is measured again. */
export function mergeNotes(old: StyleNotes | null | undefined, add: StyleNotes, now = new Date()): StyleNotes {
  const n: StyleNotes = { ...(old ?? {}) };
  for (const k of ["fonts", "scenes", "music", "sfx", "look", "summary"] as const) if (add[k] !== undefined) (n as Record<string, unknown>)[k] = add[k];
  n.at = now.toISOString();
  return n;
}

async function saveNotes(userId: string, v: { id: string; name: string }, add: StyleNotes): Promise<{ text: string; data?: unknown }> {
  const f = await prisma.styleFile.findFirst({ where: { userId, videoId: v.id, status: "ready" }, orderBy: { createdAt: "desc" } });
  if (!f) throw new AppError(`"${v.name}" has no style file yet: analyze_reference it first, then save the notes.`, 409, "no-style-file");
  const data = f.data as unknown as StyleFile;
  const next: StyleFile = { ...data, notes: mergeNotes(data.notes, add) };
  await prisma.styleFile.update({ where: { id: f.id }, data: { data: next as unknown as Prisma.InputJsonValue }, select: { id: true } });
  const plain = plainWords(next);
  return { text: [`Notes saved on style file ${f.id}.`, ...(plain.length ? ["IN PLAIN WORDS (for the user):", ...plain.map((x) => `- ${x}`)] : notesText(next.notes!))].join("\n"), data: { styleFileId: f.id } };
}
/** A style file still "measuring" after this long was lost (a worker restart): Explore offers to make it again. */
const STALE_MEASURING_MS = 30 * 60_000;

/** Starts measuring a video into a style file unless a current one exists or is being made. Never waits; null when
 * the video is not the user's or not ready yet. Explore uses it when a video is published or its owner asks. */
export async function startStyleFile(userId: string, videoId: string, name?: string): Promise<{ id: string; status: string } | null> {
  const v = await prisma.video.findUnique({ where: { id: videoId }, select: { id: true, userId: true, name: true, status: true, proxyKey: true } });
  if (!v || v.userId !== userId || v.status !== "ready" || !v.proxyKey) return null;
  const old = await prisma.styleFile.findFirst({ where: { userId, videoId, status: { in: ["ready", "measuring"] } }, orderBy: { createdAt: "desc" } });
  if (old?.status === "measuring" && Date.now() - old.createdAt.getTime() >= STALE_MEASURING_MS) {
    await prisma.styleFile.update({ where: { id: old.id }, data: { status: "failed", error: "Measuring stopped before it finished." } });
  } else if (old && (old.status === "measuring" || (old.data as { v?: number } | null)?.v === STYLE_FILE_VERSION)) return { id: old.id, status: old.status };
  const sf = await prisma.styleFile.create({ data: { userId, videoId, name: (name || `Style of ${v.name}`).slice(0, 120) } });
  await enqueue<StyleJob>("style", { styleFileId: sf.id }, { jobId: `style-${sf.id}` });
  return { id: sf.id, status: "measuring" };
}

export type GalleryBreakdownOut = { status: "ready" | "measuring" | "failed" | "none"; progress?: number; updating?: boolean; mine: boolean; canMake: boolean; breakdown?: PublicBreakdown };

/** Explore's breakdown beside a published video: the publisher's newest style file of the edit's footage, as the
 * public breakdown (no ids, names, links or emails). Open to everyone, like the gallery itself. */
export async function galleryBreakdown(itemId: string, me?: string): Promise<GalleryBreakdownOut> {
  const g = await prisma.galleryItem.findUnique({ where: { id: itemId }, select: { userId: true, projectId: true } });
  if (!g) throw notFound("That video is not in the gallery any more.");
  const mine = !!me && me === g.userId;
  const p = g.projectId ? await prisma.project.findUnique({ where: { id: g.projectId }, select: { videoId: true } }) : null;
  if (!p) return { status: "none", mine, canMake: false };
  const where = { userId: g.userId, videoId: p.videoId };
  const [ready, newest] = await Promise.all([
    prisma.styleFile.findFirst({ where: { ...where, status: "ready" }, orderBy: { createdAt: "desc" }, select: { data: true } }),
    prisma.styleFile.findFirst({ where, orderBy: { createdAt: "desc" }, select: { status: true, progress: true, createdAt: true } }),
  ]);
  const measuring = newest?.status === "measuring" && Date.now() - newest.createdAt.getTime() < STALE_MEASURING_MS;
  if (ready?.data) return { status: "ready", ...(measuring ? { updating: true } : {}), mine, canMake: mine, breakdown: publicBreakdown(ready.data as unknown as StyleFile) };
  if (measuring) return { status: "measuring", progress: newest!.progress, mine, canMake: false };
  return { status: newest?.status === "failed" ? "failed" : "none", mine, canMake: mine };
}

/** The publisher asks for the breakdown of their published video (Explore's "Make the breakdown"). */
export async function makeGalleryBreakdown(itemId: string, me: string): Promise<GalleryBreakdownOut> {
  const g = await prisma.galleryItem.findUnique({ where: { id: itemId }, select: { userId: true, projectId: true, title: true } });
  if (!g || g.userId !== me) throw notFound("That video is not one of yours in the gallery.");
  const p = g.projectId ? await prisma.project.findUnique({ where: { id: g.projectId }, select: { videoId: true } }) : null;
  if (!p) throw new AppError("This video's project is gone, so it cannot be broken down.", 409, "no-project");
  const started = await startStyleFile(me, p.videoId, `Style of ${g.title}`);
  if (!started) throw new AppError("The video is not ready to be broken down yet. Try again in a minute.", 409, "not-ready");
  return galleryBreakdown(itemId, me);
}
