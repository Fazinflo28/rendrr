import { downloadFile, getBytes, type StyleJob } from "@rendrr/core";
import { Prisma, prisma } from "@rendrr/db";
import { allWords, buildStyleFile, type Breakdown, type DeepAudio, type ReferenceMap, type ReferenceMeasure, type Transcript, type VisionDetails, type VisionSummary } from "@rendrr/shared";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { JobError, probe, run } from "../lib/ffmpeg";
import type { Ctx } from "../lib/job";

const HERE = dirname(fileURLToPath(import.meta.url));
const PYTHON = process.env.PYTHON_BIN || "python3";

/**
 * Engine Part 4.4: analyze_reference. A reference video measured into a style file (python/reference.py: text on screen,
 * what happens at each cut, the grade, the sound; with its breakdown, words and faces) and mapped end to end
 * (python/reference_map.py: scenes, camera moves, animations, colours, music, sound effects), saved on the style file row
 * for the AI only. Progress on the row; a failure is written there, in plain words.
 */
export async function styleJob(ctx: Ctx) {
  const { styleFileId } = ctx.job.data as StyleJob;
  const sf = await prisma.styleFile.findUnique({ where: { id: styleFileId } });
  if (!sf || sf.status === "ready" || !sf.videoId) return;
  const v = await prisma.video.findUnique({ where: { id: sf.videoId }, include: { analysis: true } });
  if (!v || v.userId !== sf.userId) throw new JobError("That video is gone.", "not-found", false);
  if (!v.proxyKey || v.status !== "ready") throw new JobError(`"${v.name}" has no preview copy yet (it is ${v.status}).`, "not-ready", false);
  const started = Date.now();
  let last = -1;
  // Progress is best effort: a failed write must not become a rejected promise nobody waits for.
  const report = async (pct: number) => { if (pct !== last) { last = pct; await prisma.styleFile.update({ where: { id: sf.id }, data: { progress: Math.min(99, pct) }, select: { id: true } }).catch(() => {}); } };

  const proxy = join(ctx.dir, "ref.mp4");
  await downloadFile(v.proxyKey, proxy);
  const info = await probe(proxy, { signal: ctx.signal });
  await report(3);
  const a = v.analysis;
  const words = allWords((a?.transcript as unknown as Transcript) || []).map((w) => ({ t: w.t, end: w.end ?? w.t + 0.3, w: w.text }));
  const breakdown = (a?.breakdown as unknown as Breakdown | null) ?? null;
  // The cuts: the breakdown's shots (one per scene), else the scene cuts measured at upload.
  const cuts = breakdown?.shots?.length ? breakdown.shots.slice(1).map((s) => s.start) : ((a?.sceneCuts as unknown as number[]) || []);
  const audio = (a?.audio as unknown as DeepAudio | null) ?? null;
  const speech = audio?.speech?.length ? audio.speech : words.map((w) => [w.t, w.end]);
  await writeFile(join(ctx.dir, "cuts.json"), JSON.stringify(cuts));
  await writeFile(join(ctx.dir, "speech.json"), JSON.stringify(speech));

  // Read at a short side of 360 (text 1.2% of the frame tall and up is found), keeping the shape.
  const W0 = info.width || v.width || 1080, H0 = info.height || v.height || 1920, k = 360 / Math.min(W0, H0);
  const w = Math.max(2, Math.round((W0 * k) / 2) * 2), h = Math.max(2, Math.round((H0 * k) / 2) * 2);
  const out = join(ctx.dir, "reference.json");
  await run(PYTHON, [join(HERE, "../../python/reference.py"), "--video", proxy, "--seconds", String(info.seconds || v.seconds), "--w", String(w), "--h", String(h),
    "--cuts", join(ctx.dir, "cuts.json"), "--speech", join(ctx.dir, "speech.json"), "--out", out],
    { signal: ctx.signal, onLine: (line) => { const m = /^PROGRESS (\d+)/.exec(line); if (m) void report(3 + Math.round(Number(m[1]) * 0.6)); } });
  const measure = JSON.parse(await readFile(out, "utf8")) as ReferenceMeasure;

  // The map, end to end. Best effort, with its own time limit (a minute plus 0.4 s a second of video): without it the
  // style file still has everything measured above.
  const mapOut = join(ctx.dir, "map.json");
  let map: ReferenceMap | null = null;
  try {
    await run(PYTHON, [join(HERE, "../../python/reference_map.py"), "--video", proxy, "--seconds", String(info.seconds || v.seconds), "--cuts", join(ctx.dir, "cuts.json"), "--speech", join(ctx.dir, "speech.json"), "--out", mapOut, "--width", String(W0), "--height", String(H0)],
      { signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(60_000 + Math.round((info.seconds || v.seconds) * 400))]), stallMs: 120_000, onLine: (line) => { const m = /^PROGRESS (\d+)/.exec(line); if (m) void report(63 + Math.round(Number(m[1]) * 0.33)); } });
    map = JSON.parse(await readFile(mapOut, "utf8")) as ReferenceMap;
  } catch (e) {
    if (ctx.signal.aborted) throw e;
    console.warn(`[style] ${v.id}: the map could not be made (${(e as Error).message.slice(0, 200)}); the style file goes without it`);
  }

  // The faces at 10 fps (measured at upload), for punch-ins and zooms.
  const vs = (a?.vision as unknown as VisionSummary | null) ?? null;
  const vision = vs?.key ? await getBytes(vs.key).then((b) => JSON.parse(gunzipSync(b).toString()) as VisionDetails).catch(() => null) : null;
  const file = buildStyleFile({ video: { id: v.id, name: v.name, seconds: info.seconds || v.seconds, width: W0, height: H0 }, measure, breakdown, words, cuts, audio, vision, map });
  await prisma.styleFile.update({ where: { id: sf.id }, data: { status: "ready", progress: 100, error: null, data: file as unknown as Prisma.InputJsonValue }, select: { id: true } });
  console.log(`[style] ${v.id}: ${Math.round(info.seconds || v.seconds)}s reference measured in ${Math.round((Date.now() - started) / 1000)}s: ${measure.texts.length} texts, ${measure.transitions.length} cuts${map ? `, ${map.moves.length} camera moves, ${map.animations.length} animations, ${map.sfx.length} sound effects` : ", no map"}`);
}

/** The job failed for good: get_style says why. */
export async function styleFailed(styleFileId: string, message: string) {
  await prisma.styleFile.update({ where: { id: styleFileId }, data: { status: "failed", error: message.slice(0, 500) }, select: { id: true } }).catch(() => {});
}
