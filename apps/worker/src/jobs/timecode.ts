// Phase 22: the start timecode of videos added before it was read on probe. The file is probed where it is (Drive,
// storage); its timecode, or "" when it has none, is kept on the video. A video whose file cannot be reached keeps
// null (read again next time).
import type { TimecodeJob } from "@rendrr/core";
import { prisma } from "@rendrr/db";
import { probe } from "../lib/ffmpeg";
import type { Ctx } from "../lib/job";
import { sourceInput } from "./proxy";

export async function timecodeJob(ctx: Ctx) {
  const { videoIds } = ctx.job.data as TimecodeJob;
  const vs = await prisma.video.findMany({ where: { id: { in: videoIds.slice(0, 9) }, timecode: null } });
  const out: Record<string, string | null> = {};
  for (const v of vs) {
    try {
      const src = await sourceInput(v);
      const info = await probe(src.input, { headers: src.headers, signal: ctx.signal });
      await prisma.video.update({ where: { id: v.id }, data: { timecode: info.timecode } });
      out[v.id] = info.timecode;
    } catch (e) {
      if (ctx.signal.aborted) throw e;
      console.error("[timecode] not read:", v.id, (e as Error).message.slice(0, 200));
      out[v.id] = null;
    }
  }
  return out;
}
