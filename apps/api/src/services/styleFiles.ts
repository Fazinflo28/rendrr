// Engine Part 4.4: style files, for the AI only (never in the user interface). analyze_reference measures a reference
// video into one (the worker's style queue); list_styles and get_style read them.
import { AppError, enqueue, notFound, type StyleJob } from "@rendrr/core";
import { prisma } from "@rendrr/db";
import { STYLE_FILE_VERSION, styleFileText, type StyleFile } from "@rendrr/shared";

/** How long the tool waits for a short reference to finish (clients drop calls after about a minute). */
export const STYLE_WAIT_MS = 8_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function analyzeReference(userId: string, i: { videoId: string; name?: string; again?: boolean }): Promise<{ text: string; data?: unknown }> {
  const v = await prisma.video.findUnique({ where: { id: i.videoId }, select: { id: true, userId: true, name: true, seconds: true, status: true, proxyKey: true } });
  if (!v || v.userId !== userId) throw notFound("That video is not in the library. Use list_footage for the ids.");
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
