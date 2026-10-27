import { putObject, type SnapshotJob, type SnapshotResult } from "@rendrr/core";
import { PREFIX } from "@rendrr/shared";
import { JobError } from "../lib/ffmpeg";
import { snapshotHtml } from "../lib/graphics";
import type { Ctx } from "../lib/job";

/**
 * Engine Part 4: one picture of a page drawn by the graphics browser at a time of its clock (a library item's preview
 * frame for get_library_item, a sheet of icons for search_icons). On the test queue, so it answers in a few seconds.
 * A page that throws is said, not hidden: the errors come back with the picture.
 */
export async function snapshotJob(ctx: Ctx): Promise<SnapshotResult> {
  const d = ctx.job.data as SnapshotJob;
  const t0 = Date.now();
  if (d.width < 16 || d.height < 16 || d.width > 1920 || d.height > 1920) throw new JobError("A snapshot is 16 to 1920 px a side.", "bad-size", false);
  const r = await snapshotHtml(d.html, { width: d.width, height: d.height, at: d.at });
  const image = `${PREFIX.tests}${d.userId}/${d.key}.png`;
  await putObject(image, r.png, "image/png");
  return { image, width: d.width, height: d.height, errors: r.errors, ms: Date.now() - t0 };
}
