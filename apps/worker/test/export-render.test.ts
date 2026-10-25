// Phase 7 rendered and read back: a final keeps its footage's frame rate (25 and 23.976 fps here), every frame is the
// right source frame across cuts on no particular grid, and picture and sound stay together; HEVC 9:16 at 720p and
// a 4K final come out at their size and codec. The footage shows its own frame number as two grey levels (left half:
// frame mod 25 in steps of 8, right half: frame / 25 in steps of 10); its sound is a tone with a one-frame gap 0.4 s
// into every second, so a gap's time in the file can be checked against the frame shown then. Needs ffmpeg.
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { applyOp, buildInitialTimeline, sequenceView, type EditContext, type Op, type Snapshot } from "@rendrr/shared";
import { ffmpegArgs, planRender, type PlanFiles, type RenderPlan, type SourceInfo } from "@rendrr/shared/renderPlan";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { probe, run } from "../src/lib/ffmpeg";

const execFileP = promisify(execFile);
const bin = async (cmd: string, args: string[]) => (await execFileP(cmd, args, { encoding: "buffer", maxBuffer: 512 << 20 })).stdout as Buffer;
const SECONDS = 20;
const SW = 96, SH = 54;

describe("export: frame rate kept, sizes and codecs", () => {
  let dir = "";
  const footage: Record<string, string> = {};
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "export-render-"));
    for (const [name, rate] of [["f25", "25"], ["f23976", "24000/1001"]]) {
      footage[name] = join(dir, `${name}.mp4`);
      await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y",
        "-f", "lavfi", "-i", `color=black:s=640x360:r=${rate}:d=${SECONDS},geq=lum='if(lt(X,320),16+mod(N,25)*8,16+floor(N/25)*10)':cb=128:cr=128`,
        "-f", "lavfi", "-i", `aevalsrc='0.5*sin(2*PI*440*t)*(1-between(mod(t\\,1)\\,0.4\\,0.44))':s=48000:d=${SECONDS}`,
        "-c:v", "libx264", "-preset", "ultrafast", "-crf", "6", "-g", "25", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-shortest", footage[name]]);
    }
  });
  after(async () => { if (process.env.KEEP) console.log("kept " + dir); else await rm(dir, { recursive: true, force: true }); });

  const ctx: EditContext = { videoId: "v", transcript: [], silences: [], sceneCuts: [], duration: SECONDS, getStyle: () => undefined, getVideo: () => undefined };
  // Clip edges on no frame grid in particular; the plan puts them on the output's.
  const edit = (more: Op[] = []): Snapshot => applyOp({ timeline: buildInitialTimeline([], SECONDS, "clean", [], "v"), name: "x", aspect: "16:9", styleId: "s2" }, { op: "batch", ops: [
    { op: "set_captions", on: false }, { op: "set_audio", loudness: null, cleanup: "none" },
    { op: "set_clips", track: "v1", clips: [{ id: "a", start: 0.513, end: 3.371, label: "" }, { id: "b", start: 5.207, end: 8.9, label: "" }, { id: "c", start: 10.33, end: 13.07, label: "" }, { id: "d", start: 15.77, end: 19.123, label: "" }] },
    ...more] as never }, ctx).snap;
  async function render(plan: RenderPlan, src: string, info: SourceInfo, name: string) {
    const files: PlanFiles = { source: src, output: join(dir, `${name}.mp4`) };
    const { args, filterGraph } = ffmpegArgs(plan, files, info);
    await writeFile(join(dir, `${name}.txt`), filterGraph);
    const t0 = Date.now();
    await run("ffmpeg", args.map((a) => (a === "__FILTER_SCRIPT__" ? join(dir, `${name}.txt`) : a)));
    console.log(`${name}: ${plan.width}x${plan.height} ${plan.rate} rendered in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    return files.output;
  }
  const stream = async (file: string) => JSON.parse((await run("ffprobe", ["-v", "error", "-select_streams", "v:0", "-count_frames", "-show_entries", "stream=codec_name,codec_tag_string,width,height,r_frame_rate,nb_read_frames,pix_fmt", "-of", "json", file])).stdout).streams[0];
  const lumas = async (file: string) => await bin("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", file, "-vf", `scale=${SW}:${SH}:flags=area`, "-f", "rawvideo", "-pix_fmt", "gray", "pipe:1"]);
  const px = (buf: Buffer, k: number, x: number, y: number) => 16 + (buf[k * SW * SH + y * SW + x] * 219) / 255;
  const shown = (buf: Buffer, k: number) => 25 * Math.round((px(buf, k, 72, 27) - 16) / 10) + Math.round((px(buf, k, 24, 27) - 16) / 8);
  /** Starts of the silent gaps in the file's sound (seconds). */
  const gaps = async (file: string) => {
    const pcm = await bin("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", file, "-ac", "1", "-f", "f32le", "-ar", "48000", "pipe:1"]);
    const x = new Float32Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.length / 4));
    // 2 ms windows; a gap is a quiet run of 30-50 ms (the footage's 40 ms gaps, not the 20 ms declick fades at cuts).
    const out: number[] = []; const W = 96; let start = -1;
    for (let i = 0; i + W < x.length; i += W) {
      let e = 0; for (let j = i; j < i + W; j++) e += x[j] * x[j];
      const q = e / W < 1e-5;
      if (q && start < 0) start = i;
      if (!q && start >= 0) { const len = (i - start) / 48000; if (len >= 0.03 && len <= 0.05) out.push(start / 48000); start = -1; }
    }
    return out;
  };

  for (const [name, fps, rate] of [["f25", 25, "25/1"], ["f23976", 24000 / 1001, "24000/1001"]] as const) {
    it(`keeps ${rate} fps: every frame the right source frame, sound in sync`, async () => {
      const info: SourceInfo = { width: 640, height: 360, fps: Math.round(fps * 100) / 100, seconds: SECONDS, hasAudio: true };
      const plan = planRender({ kind: "final", snapshot: edit(), transcript: [], source: info, videoId: "v" });
      assert.equal(plan.rate, rate === "25/1" ? "25" : rate);
      const out = await render(plan, footage[name], info, `out-${name}`);
      const st = await stream(out);
      assert.equal(st.r_frame_rate, rate);
      const expectFrames = plan.parts.reduce((n, p) => n + Math.round((p.srcOut - p.srcIn) * fps), 0);
      assert.equal(Number(st.nb_read_frames), expectFrames, "frame count = the parts' frames");
      // Every frame: part by part, consecutive source frames from the part's first. Each output frame is matched to the
      // nearest of the three source frames around the expected one (by its grey levels against the footage's own), so
      // a level of brightness lost in scaling (FFmpeg 7.1 loses about one) cannot be read as a frame off.
      const buf = await lumas(out), srcBuf = await lumas(footage[name]);
      const lv = (b: Buffer, k: number) => [px(b, k, 24, 27), px(b, k, 72, 27)];
      let k = 0, wrong = 0;
      for (const p of plan.parts) {
        const first = Math.round(p.srcIn * fps), n = Math.round((p.srcOut - p.srcIn) * fps);
        for (let j = 0; j < n; j++, k++) {
          const [a, b] = lv(buf, k);
          const near = [first + j - 1, first + j, first + j + 1].map((f) => { const [x, y] = lv(srcBuf, f); return { f, d: Math.abs(a - x) + Math.abs(b - y) }; }).sort((u, v) => u.d - v.d)[0];
          if (near.f !== first + j) { wrong++; if (process.env.SHOW) console.log(`  frame ${k} (part ${plan.parts.indexOf(p)}, +${j} of ${n}): looks like ${near.f}, expected ${first + j}`); }
        }
      }
      assert.equal(wrong, 0, `${wrong} frames show the wrong source frame`);
      // Sync: the sound is cut exactly where the edit says; each part's picture starts on the frame nearest its exact
      // start and shows the footage frame that covers its sound's moment. So at a gap in the sound, picture and sound
      // are apart by exactly that part's fraction of a frame (d below, from the exact edit), whatever came before it:
      // no drift, never a frame or more.
      const exact = sequenceView(edit().timeline, [], { seconds: { v: SECONDS } }).picture;
      const d = plan.parts.map((p, i) => exact[i].srcIn + (p.start - exact[i].start) - p.srcIn);
      assert.ok(d.every((x) => x >= -1e-6 && x < 1 / fps), `fractions ${d.map((x) => (x * 1000).toFixed(1)).join(", ")} ms`);
      const g = await gaps(out);
      assert.ok(g.length >= 8, `found ${g.length} gaps`);
      const offs: number[] = [];
      for (const t of g) {
        const near = Math.min(k - 1, Math.floor((t + 0.02) * fps));
        const second = Math.round(shown(buf, near) / fps - 0.4);
        const F0 = Math.round((second + 0.4) * fps);
        let m = -1;
        for (let j = Math.max(0, near - 3); j <= Math.min(k - 1, near + 3); j++) if (shown(buf, j) === F0) { m = j; break; }
        assert.ok(m >= 0, `no frame near ${t.toFixed(3)}s shows source frame ${F0}`);
        // In the footage the gap starts (second + 0.4) - F0/fps after frame F0 starts; in the file that less the part's d.
        const part = plan.parts.findIndex((p) => m / fps >= p.start - 1e-6 && m / fps < p.end - 1e-6);
        const off = (t - m / fps) - ((second + 0.4) - F0 / fps - d[part]);
        offs.push(off);
        if (process.env.SHOW) console.log(`  gap at ${t.toFixed(3)}s (source ${second}.4s, part ${part}, d ${(d[part] * 1000).toFixed(1)} ms): off by ${(off * 1000).toFixed(1)} ms`);
      }
      const lo = Math.min(...offs), hi = Math.max(...offs);
      console.log(`${name}: ${g.length} gaps, each part's picture ${d.map((x) => (x * 1000).toFixed(0)).join("/")} ms behind its exact cut; the file adds ${(lo * 1000).toFixed(1)} to ${(hi * 1000).toFixed(1)} ms (constant = the detection window and the tone's ramp; varying would be a cut off or drift)`);
      assert.ok(hi - lo <= 0.002, `the offset changes along the file by ${((hi - lo) * 1000).toFixed(1)} ms`);
      assert.ok(Math.max(Math.abs(lo), Math.abs(hi)) <= 0.012, `picture and sound ${(Math.max(Math.abs(lo), Math.abs(hi)) * 1000).toFixed(0)} ms off what the edit says`);
      const a = await probe(out);
      assert.ok(Math.abs(a.seconds - plan.outputSeconds) < 0.05, `file ${a.seconds}s, plan ${plan.outputSeconds}s`);
    });
  }

  it("HEVC 9:16 at 720p: size, codec, Apple tag, the footage's rate", async () => {
    const info: SourceInfo = { width: 640, height: 360, fps: 25, seconds: SECONDS, hasAudio: true };
    const plan = planRender({ kind: "final", snapshot: edit([{ op: "set_export", resolution: "720p", codec: "hevc" }, { op: "set_aspect", aspect: "9:16" }] as Op[]), transcript: [], source: info, videoId: "v" });
    const st = await stream(await render(plan, footage.f25, info, "hevc"));
    assert.deepEqual([st.codec_name, st.codec_tag_string, st.width, st.height, st.r_frame_rate, st.pix_fmt], ["hevc", "hvc1", 720, 1280, "25/1", "yuv420p"]);
  });

  it("4K: 3840x2160 H.264, and the plan says it was scaled up", async () => {
    const info: SourceInfo = { width: 640, height: 360, fps: 25, seconds: SECONDS, hasAudio: true };
    const snap = edit([{ op: "set_clips", track: "v1", clips: [{ id: "a", start: 1, end: 2.5, label: "" }] }, { op: "set_export", resolution: "4k" }] as Op[]);
    const plan = planRender({ kind: "final", snapshot: snap, transcript: [], source: info, videoId: "v" });
    assert.ok(plan.operations.some((l) => l.startsWith("Size: scaled up from the footage's 640x360 to 3840x2160")));
    const st = await stream(await render(plan, footage.f25, info, "uhd"));
    assert.deepEqual([st.codec_name, st.width, st.height, st.r_frame_rate, Number(st.nb_read_frames)], ["h264", 3840, 2160, "25/1", 38]);
  });
});
