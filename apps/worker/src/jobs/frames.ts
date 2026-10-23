import { headObject, signGet, uploadFile, type FramesJob } from "@rendrr/core";
import { prisma } from "@rendrr/db";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { frameAt } from "../lib/ffmpeg";
import type { Ctx } from "../lib/job";
import { framesPrefix } from "./breakdown";

// Frames for the AI to look at: from a preview render (get_preview_frames, output times) or from footage and
// references (get_frames, original times). Render frames are kept next to the render and expire with it; footage
// frames sit with the video's other frames and go when its preview copy goes.
export async function framesJob(ctx: Ctx): Promise<string[]> {
  const { renderId, videoId, times } = ctx.job.data as FramesJob;
  if (videoId) return videoFrames(ctx, videoId, times);
  const r = renderId ? await prisma.render.findUnique({ where: { id: renderId } }) : null;
  if (!r?.outputKey) return [];
  const url = await signGet(r.outputKey, 600);
  const out: string[] = [];
  for (const [i, t] of times.slice(0, 5).entries()) {
    const p = join(ctx.dir, `t${i}.jpg`);
    await frameAt(url, t, p, 540, ctx.signal).catch(() => {});
    if (!(await stat(p).then(() => true).catch(() => false))) continue;
    const key = r.outputKey.replace(/\.mp4$/, `-at${Math.round(t * 100)}.jpg`);
    await uploadFile(key, p, "image/jpeg");
    out.push(key);
  }
  // Recorded with the render's other frames (after the first five check frames), so cleanup and deletes remove them.
  if (out.length) {
    const fresh = await prisma.render.findUnique({ where: { id: r.id }, select: { framesKeys: true } });
    const have = (fresh?.framesKeys as string[]) || [];
    await prisma.render.update({ where: { id: r.id }, data: { framesKeys: Array.from(new Set([...have, ...out])) } });
  }
  return out;
}

async function videoFrames(ctx: Ctx, videoId: string, times: number[]): Promise<string[]> {
  const v = await prisma.video.findUnique({ where: { id: videoId } });
  if (!v?.proxyKey) return [];
  const url = await signGet(v.proxyKey, 600);
  const out: string[] = [];
  for (const [i, t0] of times.slice(0, 8).entries()) {
    const t = Math.min(Math.max(0, t0), Math.max(0, v.seconds - 0.05));
    const key = `${framesPrefix(v)}at-${Math.round(t * 100)}.jpg`;
    if (await headObject(key)) { out.push(key); continue; } // asked before
    const p = join(ctx.dir, `v${i}.jpg`);
    await frameAt(url, t, p, 960, ctx.signal).catch(() => {});
    if (!(await stat(p).then((s) => s.size > 0).catch(() => false))) continue;
    await uploadFile(key, p, "image/jpeg");
    out.push(key);
  }
  return out;
}
