import type { MatteJob } from "@rendrr/core";
import { headObject } from "@rendrr/core";
import { matteKey } from "@rendrr/shared";
import { makeMatteBlock, matteVideo } from "../lib/matte";
import type { Ctx } from "../lib/job";

/** remove_background: one block of a video's matte, made ahead of the render (it is kept; a render reads it). */
export async function matteJob(ctx: Ctx) {
  const d = ctx.job.data as MatteJob;
  const v = await matteVideo(d.videoId, d.userId, d.turn);
  // The job's turn is the one its id was made with (the API's), so a render waiting on this id finds its block.
  v.turn = d.turn;
  if (await headObject(matteKey(v.userId, v.id, v.turn, d.k))) return { made: false };
  await makeMatteBlock(v, d.k, ctx.dir, ctx.signal);
  return { made: true };
}
