// Face-aware Morph Cut rendered and measured, on a real face (NASA's public-domain portrait, test/fixtures): the
// portrait sits in a room, then (the next take) 60 px to the right and 10% bigger; the edit cuts from one to the other
// with a morph. The worker finds the face in the frames either side; the render slides and scales the head into place.
// In the middle of the window one face is found, half way across and half way in size (a dissolve shows two faint
// ones), and it matches the portrait placed there better than the plain morph and a dissolve do. Needs ffmpeg and
// OpenCV (YuNet).
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { applyOp, buildInitialTimeline, type EditContext, type Op, type Snapshot } from "@rendrr/shared";
import { ffmpegArgs, planRender, type PlanFiles, type SourceInfo } from "@rendrr/shared/renderPlan";
import { run } from "../src/lib/ffmpeg";
import { detectFaces } from "../src/lib/faces";
import { morphFaces } from "../src/lib/morph";

const execFileP = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const SECONDS = 8, SW = 1280, SH = 720;
const source: SourceInfo = { width: SW, height: SH, fps: 30, seconds: SECONDS, hasAudio: true };
// The person (the portrait cut to a soft oval, as a person on a still room): 320 px at (420, 200) until 4 s; then 352 px
// at (560, 184): 156 px right at the source's size, 117 px at the preview's (past the plain morph's 64 px search).
const A = { x: 420, y: 200, s: 320 }, B = { x: 560, y: 184, s: 352 };

describe("face-aware Morph Cut, rendered", () => {
  let dir = "", main = "";
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "morph-face-"));
    main = join(dir, "talk.mp4");
    const face = join(dir, "person.png"), room = join(dir, "room.png");
    await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", join(here, "fixtures/astronaut.jpg"), "-vf", "format=rgba,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='255*clip((1-hypot((X-160)/120,(Y-170)/150))/0.08,0,1)'", "-frames:v", "1", face]);
    await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", `nullsrc=s=${SW}x${SH}:d=1,format=gray,geq=lum='70+40*random(1)',gblur=sigma=6,format=rgb24`, "-frames:v", "1", room]);
    await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-loop", "1", "-framerate", "30", "-t", String(SECONDS), "-i", room, "-loop", "1", "-framerate", "30", "-t", String(SECONDS), "-i", face,
      "-f", "lavfi", "-i", `sine=f=220:d=${SECONDS}:sample_rate=48000`,
      "-filter_complex", `[1:v]split[f1][f2];[f2]scale=${B.s}:${B.s}[fb];[0:v][f1]overlay=${A.x}:${A.y}:enable='lt(t,4)'[ra];[ra][fb]overlay=${B.x}:${B.y}:enable='gte(t,4)',format=yuv420p[v]`,
      "-map", "[v]", "-map", "2:a", "-c:v", "libx264", "-preset", "ultrafast", "-crf", "10", "-c:a", "aac", "-shortest", main]);
  });
  after(async () => { if (process.env.KEEP) console.log("kept " + dir); else await rm(dir, { recursive: true, force: true }); });

  const ctx: EditContext = { videoId: "v", transcript: [], silences: [], sceneCuts: [], duration: SECONDS, getStyle: () => undefined };
  const edit = (tr: Op | null): Snapshot => applyOp({ timeline: buildInitialTimeline([], SECONDS, "clean", [], "v"), name: "m", aspect: "16:9", styleId: "s2" },
    { op: "batch", ops: [{ op: "set_captions", on: false }, { op: "set_audio", loudness: null }, { op: "set_clips", track: "v1", clips: [{ id: "a", start: 1, end: 3, label: "" }, { id: "b", start: 5, end: 7, label: "" }] }, ...(tr ? [tr] : [])] as never }, ctx).snap;
  const render = async (s: Snapshot, name: string, faces = false) => {
    const plan = planRender({ kind: "preview", snapshot: s, transcript: [], source, videoId: "v" });
    const files: PlanFiles = { source: main, output: join(dir, `${name}.mp4`) };
    if (faces) files.morphFaces = await morphFaces(plan, files, dir);
    const { args, filterGraph } = ffmpegArgs(plan, files, source);
    await writeFile(join(dir, `${name}.txt`), filterGraph);
    await run("ffmpeg", args.map((a) => (a === "__FILTER_SCRIPT__" ? join(dir, `${name}.txt`) : a)));
    return { plan, files, out: files.output, graph: filterGraph };
  };
  /** Frame f of a render at w x h, raw RGB. */
  const frame = async (file: string, f: number, w: number, h: number) => (await execFileP("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", file, "-vf", `select=eq(n\\,${f}),scale=${w}:${h},format=rgb24`, "-frames:v", "1", "-f", "rawvideo", "-"], { encoding: "buffer", maxBuffer: 1 << 26 })).stdout as Buffer;
  /** Normalised correlation of two grey images over a box. */
  const ncc = (p: Buffer, q: Buffer, w: number, x0: number, y0: number, bw: number, bh: number) => {
    const g = (b: Buffer, i: number) => (b[i * 3] + b[i * 3 + 1] + b[i * 3 + 2]) / 3;
    let sp = 0, sq = 0, n = 0;
    for (let y = y0; y < y0 + bh; y++) for (let x = x0; x < x0 + bw; x++) { sp += g(p, y * w + x); sq += g(q, y * w + x); n++; }
    const mp = sp / n, mq = sq / n; let a = 0, b = 0, c = 0;
    for (let y = y0; y < y0 + bh; y++) for (let x = x0; x < x0 + bw; x++) { const u = g(p, y * w + x) - mp, v = g(q, y * w + x) - mq; a += u * v; b += u * u; c += v * v; }
    return a / Math.sqrt(b * c);
  };

  it("finds the face either side and slides the head into place", async () => {
    const W = 960, H = 540, k = W / SW;
    const fa = await render(edit({ op: "set_transition", clipId: "b", type: "morph", duration: 0.5 } as Op), "face", true);
    const t = fa.plan.transitions!.find((x) => x.type === "morph")!;
    const mf = fa.files.morphFaces?.b;
    assert.ok(mf, "the face is found in the frames either side of the cut");
    // A's face centre at the preview's size, and B's (as found either side).
    const cen = (b: [number, number, number, number]) => [(b[0] + b[2] / 2) * W, (b[1] + b[3] / 2) * H];
    const ca = cen(mf!.aBox), cb = cen(mf!.bBox);
    assert.ok(fa.graph.includes("perspective=") && !fa.graph.includes("minterpolate"), "the face-aware morph is drawn");
    const plain = await render(edit({ op: "set_transition", clipId: "b", type: "morph", duration: 0.5, face: false } as Op), "plain");
    const diss = await render(edit({ op: "set_transition", clipId: "b", type: "dissolve", duration: 0.5 } as Op), "dissolve");
    // The middle of the window: the portrait placed half way, as the reference.
    const mid = Math.round(((t.start + t.end) / 2) * 30), u = (mid - Math.round(t.start * 30)) / Math.round((t.end - t.start) * 30);
    const ref = join(dir, "ref.mp4"), rs = Math.round(A.s + (B.s - A.s) * u), rx = Math.round(A.x + (B.x - A.x) * u), ry = Math.round(A.y + (B.y - A.y) * u);
    await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", join(dir, "room.png"), "-i", join(dir, "person.png"), "-filter_complex", `[1:v]scale=${rs}:${rs}[f];[0:v][f]overlay=${rx}:${ry},scale=${W}:${H}`, "-frames:v", "1", "-pix_fmt", "yuv420p", ref]);
    const want = await frame(ref, 0, W, H);
    const box = [Math.round(rx * k + 10), Math.round(ry * k + 10), Math.round(rs * k - 20), Math.round(rs * k - 20)] as const;
    const got = { face: await frame(fa.out, mid, W, H), plain: await frame(plain.out, mid, W, H), dissolve: await frame(diss.out, mid, W, H) };
    const score = Object.fromEntries(Object.entries(got).map(([n, f]) => [n, ncc(f, want, W, ...box)]));
    const seen = await detectFaces(Buffer.concat([got.face, got.dissolve]), W, H, dir);
    const fc = seen[0] && [seen[0].x + seen[0].w / 2, seen[0].y + seen[0].h / 2];
    console.log(`middle frame (u ${u.toFixed(2)}): match to the portrait half way ${Object.entries(score).map(([n, v]) => `${n} ${v.toFixed(3)}`).join(", ")}; face found at ${fc?.map((v) => v.toFixed(0)).join(", ")} (A ${ca.map((v) => v.toFixed(0)).join(", ")}, B ${cb.map((v) => v.toFixed(0)).join(", ")}), score ${seen[0]?.score.toFixed(2)}; dissolve: ${seen[1] ? `a face at ${(seen[1].x + seen[1].w / 2).toFixed(0)}, score ${seen[1].score.toFixed(2)}` : "no face"}`);
    assert.ok(score.face > 0.9, `the middle frame shows the portrait half way (match ${score.face.toFixed(3)})`);
    assert.ok(score.face > score.dissolve + 0.1 && score.face > score.plain + 0.05, `better than a dissolve (${score.dissolve.toFixed(3)}) and the plain morph (${score.plain.toFixed(3)}) on a move this big`);
    assert.ok(fc && Math.abs(fc[0] - (ca[0] + (cb[0] - ca[0]) * u)) < 12 && Math.abs(fc[1] - (ca[1] + (cb[1] - ca[1]) * u)) < 12, "one face, half way across");
    // As long as the plain cut's edit.
    const len = async (f: string) => Number((await execFileP("ffprobe", ["-v", "error", "-count_frames", "-select_streams", "v:0", "-show_entries", "stream=nb_read_frames", "-of", "csv=p=0", f])).stdout.trim());
    assert.equal(await len(fa.out), await len(plain.out), "as long");
  });
});
