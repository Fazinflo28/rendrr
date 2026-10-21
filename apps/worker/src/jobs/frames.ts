import { signGet, uploadFile, type FramesJob } from "@rendrr/core";
import { prisma } from "@rendrr/db";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { frameAt } from "../lib/ffmpeg";
import type { Ctx } from "../lib/job";

// Frames for the AI to check a preview (get_preview_frames). Kept next to the render, so they expire with it.
export async function framesJob(ctx: Ctx): Promise<string[]> {
  const { renderId, times } = ctx.job.data as FramesJob;
  const r = await prisma.render.findUnique({ where: { id: renderId } });
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
  return out;
}
