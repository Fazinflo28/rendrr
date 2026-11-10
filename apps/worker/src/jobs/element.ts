import { downloadFile, uploadFile, type ElementJob } from "@rendrr/core";
import { prisma } from "@rendrr/db";
import { ELEMENT_MAX_SIDE, ELEMENT_SECONDS, PREFIX } from "@rendrr/shared";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { JobError, probe, run } from "../lib/ffmpeg";
import type { Ctx } from "../lib/job";

/** The size an element is kept at: its own, the longer side at most ELEMENT_MAX_SIDE, both even (VP9 with alpha). */
export function elementSize(w: number, h: number): { width: number; height: number } {
  const k = Math.min(1, ELEMENT_MAX_SIDE / Math.max(w, h, 1));
  const even = (n: number) => Math.max(2, Math.round((n * k) / 2) * 2);
  return { width: even(w), height: even(h) };
}

/** ffmpeg arguments: the picture as a 1 s transparent VP9 WebM at 30 fps (the graphics layer holds its last frame). */
export const elementArgs = (src: string, out: string, width: number, height: number) => [
  "-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-loop", "1", "-i", src, "-t", String(ELEMENT_SECONDS), "-r", "30",
  "-vf", `scale=${width}:${height}:flags=lanczos,format=yuva420p`, "-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p", "-b:v", "0", "-crf", "16",
  "-deadline", "good", "-cpu-used", "4", "-row-mt", "1", "-auto-alt-ref", "0", "-an", out,
];

/**
 * An element (a logo or overlay picture added on the Assets page or by the AI): made into a transparent clip that the
 * graphics layer places like any graphic (moved, scaled, faded, blended), plus a thumbnail. The picture as sent stays.
 */
export async function elementJob(ctx: Ctx): Promise<{ key: string; width: number; height: number }> {
  const d = ctx.job.data as ElementJob;
  const g = await prisma.graphic.findUnique({ where: { id: d.graphicId } });
  if (!g || !g.ownerId) throw new JobError("That element is gone.", "gone", false);
  const src = join(ctx.dir, "src"), out = join(ctx.dir, "element.webm"), thumb = join(ctx.dir, "thumb.png");
  try {
    await downloadFile(d.srcKey, src);
    const info = await probe(src, { signal: ctx.signal }).catch(() => null);
    if (!info?.width || !info.height) throw new JobError("That picture could not be read. Send a PNG, WebP or JPEG.", "bad-element", false);
    const { width, height } = elementSize(info.width, info.height);
    await run("ffmpeg", elementArgs(src, out, width, height), { signal: ctx.signal });
    await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-i", src, "-frames:v", "1", "-vf", "scale='min(480,iw)':-2:flags=lanczos", thumb], { signal: ctx.signal });
    const key = `${PREFIX.graphics}${g.ownerId}/${g.id}.webm`, thumbKey = `${PREFIX.graphics}${g.ownerId}/${g.id}-thumb.png`;
    await uploadFile(key, out, "video/webm");
    await uploadFile(thumbKey, thumb, "image/png");
    const bytes = (await stat(out)).size + (await stat(thumb)).size + (await stat(src)).size;
    await prisma.graphic.update({ where: { id: g.id }, data: { status: "ready", renderedKey: key, thumbKey, width, height, durationSec: ELEMENT_SECONDS, sizeBytes: BigInt(bytes), error: null, changedAt: new Date() } });
    return { key, width, height };
  } catch (e) {
    await prisma.graphic.update({ where: { id: g.id }, data: { status: "failed", error: (e as JobError).friendly ? (e as Error).message : "Rendrr could not read that picture." } }).catch(() => {});
    throw e;
  }
}
