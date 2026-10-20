// Integration check: real transcript -> style -> render plan -> FFmpeg -> playable file.
// Usage: tsx test/render-int.ts <assemblyai-transcript.json> <assets-dir> <out-dir>
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { applyOp, buildInitialTimeline, buildTranscript, sentencesFromWords, STYLES, type EditContext, type Snapshot } from "../src/index";
import { ffmpegArgs, planRender } from "../src/renderPlan";

const [trPath, assets, out] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const raw = JSON.parse(readFileSync(trPath, "utf8"));
const words = raw.words.map((w: any) => ({ text: w.text, start: w.start / 1000, end: w.end / 1000 }));
const tr = buildTranscript(sentencesFromWords(words));
console.log("lines", tr.length, "words", tr.flatMap((l) => l.words).length, "fillers", tr.flatMap((l) => l.words).filter((w) => w.filler).map((w) => w.text).join(","));
const source = { width: 1280, height: 720, fps: 30, seconds: 41, hasAudio: true };
const ctx: EditContext = { transcript: tr, silences: [], sceneCuts: [15, 28], duration: 41, getStyle: (id) => STYLES.find((s) => s.id === id) };
let snap: Snapshot = { timeline: buildInitialTimeline(tr, 41, "clean"), name: "t", aspect: "9:16", styleId: "s2" };
for (const [styleId, aspect, kind] of [["s1", "9:16", "preview"], ["s2", "16:9", "final"], ["s4", "1:1", "preview"]] as const) {
  const r = applyOp({ ...snap, aspect }, { op: "apply_style", styleId }, ctx);
  console.log("\n==", styleId, aspect, kind, "::", r.summary);
  const plan = planRender({ kind, snapshot: r.snap, transcript: tr, source, captionRules: STYLES.find((s) => s.id === styleId)!.rules.captions });
  plan.operations.forEach((o) => console.log("  -", o));
  const dir = join(out, styleId); mkdirSync(dir, { recursive: true });
  const audio: Record<string, string> = {};
  for (const a of plan.audio) audio[a.clipId] = join(assets, a.assetKey.replace(/^assets\//, ""));
  const files = { source: join(assets, "samples/sample-talking-head.mp4"), output: join(dir, "out.mp4"), assPath: join(dir, "c.ass"), audio };
  if (plan.ass) writeFileSync(files.assPath, plan.ass);
  const { args, filterGraph } = ffmpegArgs(plan, files, source);
  writeFileSync(join(dir, "graph.txt"), filterGraph);
  const a = args.map((x) => (x === "__FILTER_SCRIPT__" ? join(dir, "graph.txt") : x)).filter((x) => x !== "-progress" && x !== "pipe:1");
  const t0 = Date.now();
  execFileSync("ffmpeg", a, { stdio: ["ignore", "ignore", "inherit"] });
  const probe = execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration:stream=width,height", "-of", "compact", files.output]).toString().trim();
  console.log(`  rendered in ${((Date.now() - t0) / 1000).toFixed(1)}s, expected ${plan.outputSeconds}s ->`, probe.replace(/\n/g, " | "));
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-ss", "3", "-i", files.output, "-frames:v", "1", "-vf", "scale=-2:360", join(dir, "frame.jpg")]);
}
