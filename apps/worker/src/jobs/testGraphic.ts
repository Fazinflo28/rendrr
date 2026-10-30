import { graphicVariant, headObject, putObject, signGet, uploadFile, type TestGraphicJob, type TestGraphicResult } from "@rendrr/core";
import { prisma } from "@rendrr/db";
import { boxCover, boxOnScreen, faceAt, findTemplate, graphicDefaults, PREFIX, templateHtml, templateSize, type VisionDetails, type VisionSummary } from "@rendrr/shared";
import { outputSize } from "@rendrr/shared/renderPlan";
import { gunzipSync } from "node:zlib";
import { join } from "node:path";
import { getBytes } from "@rendrr/core";
import { COVER_SIZE, cpuBudget, frameAt, graphicCover, JobError, run } from "../lib/ffmpeg";
import { brandLogoDataUrl, customGraphicHtml, fontWarning, GRAPHIC_FIELDS, recordHtml } from "../lib/graphics";
import type { Ctx } from "../lib/job";

/** Past this, a custom graphic's params with no recording yet are not recorded for a test (stepping there is slow). */
const RECORD_UP_TO = 20;

/**
 * Engine Part 5: test_graphic. 3 to 5 s of a graphic (a template, or a custom graphic with these params) drawn over a
 * video at a time (or a plain grey frame) at 540p, so the AI can check a look in a few seconds instead of a full
 * preview: the clip, 3 frames from it, and what of the frame and of the face the graphic covers. A template is
 * recorded for the test (up to the test's end); a custom graphic plays its recording (its params' recording when
 * there is one, else those params recorded now, up to 20 s in). The result is kept a day under the test's key.
 */
export async function testGraphicJob(ctx: Ctx): Promise<TestGraphicResult> {
  const d = ctx.job.data as TestGraphicJob;
  const t0 = Date.now();
  const { width: W, height: H } = outputSize(d.aspect, "preview");
  const seconds = Math.min(5, Math.max(3, d.seconds || 4));
  const warnings: string[] = [];
  let gfile: string, from: number, recordedMs = 0;

  const tpl = findTemplate(d.graphicId);
  if (tpl) {
    // Templates time their exit to the placement's length.
    const len = Math.max(seconds, d.length ?? tpl.durationSec);
    from = Math.max(0, Math.min(d.at, len - seconds));
    const { width: tw, height: th } = templateSize(W, H);
    const logo = tpl.id === "gt_logo_reveal" ? await brandLogoDataUrl(d.userId) : null;
    const t1 = Date.now();
    const r = await recordHtml(templateHtml(tpl.id, { ...graphicDefaults(tpl.paramsSchema), ...(d.params ?? {}) }, tw, th, len, logo), { width: tw, height: th, durationSec: from + seconds, transparent: true, dir: ctx.dir, signal: ctx.signal });
    recordedMs = Date.now() - t1;
    gfile = r.path;
    warnings.push(...fontWarning(r.missingFonts));
  } else {
    const g = await prisma.graphic.findUnique({ where: { id: d.graphicId }, select: GRAPHIC_FIELDS });
    if (!g || (g.ownerId && g.ownerId !== d.userId)) throw new JobError("That graphic does not exist. list_graphics shows the templates and yours.", "not-found", false);
    if (!d.fresh && (g.status !== "ready" || !g.renderedKey)) throw new JobError(g.status === "failed" ? "That graphic failed to record: get_graphic says why." : "That graphic is still recording: get_graphic shows how far it got. Test it once it is ready.", "not-ready", false);
    from = Math.max(0, Math.min(d.at, g.durationSec - seconds));
    // rerecord: drawn from its code now (its own values, or these params), not from a kept recording.
    const v = g.code ? (graphicVariant(g, d.params) ?? (d.fresh ? { params: { ...graphicDefaults(g.paramsSchema), ...(d.params ?? {}) }, key: "" } : null)) : null;
    if (v && (d.fresh || !(await headObject(v.key)))) {
      if (from + seconds > RECORD_UP_TO) throw new JobError(`These params have no recording yet, and recording them for a test is done only up to ${RECORD_UP_TO} s in: test from at ${RECORD_UP_TO - seconds} or less, or place it with add_graphic (the render records it).`, "too-far", false);
      const t1 = Date.now();
      const r = await recordHtml(await customGraphicHtml(g.code!, v.params, g.ownerId), { width: g.width, height: g.height, durationSec: from + seconds, transparent: g.transparent, dir: ctx.dir, signal: ctx.signal });
      recordedMs = Date.now() - t1;
      gfile = r.path;
      warnings.push(...fontWarning(r.missingFonts));
    } else gfile = await signGet(v ? v.key : g.renderedKey!, 600);
  }

  // The footage under it: the stretch from `over.time`, fitted as the render fits V1 (cover, 40% down).
  let bg: string[] = ["-f", "lavfi", "-i", `color=c=0x3a3a40:s=${W}x${H}:r=30:d=${seconds}`];
  let video: { id: string; seconds: number; vision: VisionSummary | null } | null = null;
  if (d.over) {
    const v = await prisma.video.findUnique({ where: { id: d.over.videoId }, select: { id: true, userId: true, seconds: true, proxyKey: true, analysis: { select: { vision: true } } } });
    if (!v || v.userId !== d.userId) throw new JobError("That video is not in the library. Use list_footage for the ids.", "not-found", false);
    if (!v.proxyKey) throw new JobError("That video has no preview copy (still processing, or expired).", "not-ready", false);
    const at = Math.max(0, Math.min(d.over.time, v.seconds - seconds));
    bg = ["-threads", "2", "-ss", at.toFixed(3), "-t", String(seconds), "-i", await signGet(v.proxyKey, 600)];
    video = { id: v.id, seconds: at, vision: (v.analysis?.vision as unknown as VisionSummary | null) ?? null };
  }
  const out = join(ctx.dir, "test.mp4");
  // Threads set: FFmpeg would start one per CPU of the host for each decoder, the filters and x264 (hundreds).
  const th = String(cpuBudget());
  await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-filter_complex_threads", th, ...bg, "-threads", "2", "-ss", from.toFixed(3), "-c:v", "libvpx-vp9", "-i", gfile,
    "-filter_complex", `[0:v]fps=30,scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H}:(iw-ow)/2:(ih-oh)*0.4,setsar=1[bg];[1:v]fps=30,format=yuva420p,scale=${W}:${H}:force_original_aspect_ratio=decrease,tpad=stop_mode=clone:stop=-1[g];[bg][g]overlay=(W-w)/2:(H-h)/2:eof_action=repeat,trim=duration=${seconds},format=yuv420p[v]`,
    "-map", "[v]", ...(d.over ? ["-map", "0:a?", "-c:a", "aac", "-b:a", "96k"] : []), "-t", String(seconds), "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-threads", th, "-movflags", "+faststart", out], { signal: ctx.signal });

  // Three frames to look at, and what of the frame and the face it covers (8 moments, as the preview check measures).
  const base = `${PREFIX.tests}${d.userId}/${d.key}`;
  const times = [0.1, 0.5, 0.9].map((f) => Math.round(f * seconds * 100) / 100);
  const frames: string[] = [];
  for (const [k, t] of times.entries()) {
    const p = join(ctx.dir, `f${k}.jpg`);
    await frameAt(out, t, p, W, ctx.signal);
    await uploadFile(`${base}-f${k}.jpg`, p, "image/jpeg");
    frames.push(`${base}-f${k}.jpg`);
  }
  await uploadFile(`${base}.mp4`, out, "video/mp4");
  const c = await graphicCover(gfile, from, seconds, ctx.signal, 8).catch(() => null);
  let face: TestGraphicResult["face"];
  const vis = video?.vision;
  if (c && vis?.key) {
    const buf = await getBytes(vis.key).catch(() => null);
    if (buf) {
      const details = JSON.parse(gunzipSync(buf).toString()) as VisionDetails;
      let max = 0, at = 0, of = 0;
      c.at.forEach((ft, k) => {
        const t = ft - from, box = faceAt(details, video!.seconds + t);
        // The test draws the footage as filmed (no turn, no framing): the box as it lands then.
        const b = box && boxOnScreen(box, vis.turned ?? 0, details.size, W, H, { rotate: 0 });
        if (!b) return;
        of++;
        const cov = c.maps ? boxCover(c.maps[k], COVER_SIZE, b) : 100;
        if (cov > max || of === 1) { max = cov; at = Math.round(t * 100) / 100; }
      });
      face = of ? { max, at, of } : null;
    }
  }
  const result: TestGraphicResult = {
    clip: `${base}.mp4`, frames, times, width: W, height: H, from, seconds, recordedMs, totalMs: Date.now() - t0,
    cover: c ? { min: c.min, avg: c.avg, max: c.max, samples: c.samples, visible: c.visible } : null, face, warnings,
  };
  await putObject(`${base}.json`, Buffer.from(JSON.stringify(result)), "application/json");
  return result;
}
