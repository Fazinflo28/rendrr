// Engine Part 5: test_graphic. A few seconds of a graphic over the footage at 540p, back in under 10 s: a template
// recorded for the test, a custom graphic playing its recording or recording new params, over a plain frame or a
// video at a time; three frames, the clip, and what of the frame and the face it covers. Needs ffmpeg, Chromium,
// a database and storage (as in .env).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { after, before, describe, it } from "node:test";
import type { Job } from "bullmq";
import type { TestGraphicJob, TestGraphicResult } from "@rendrr/core";

const here = dirname(fileURLToPath(import.meta.url));
const db = !!process.env.DATABASE_URL && !!process.env.S3_BUCKET && !!process.env.REDIS_URL;
const run6 = Math.random().toString(36).slice(2, 8);
// The face the vision measured: the portrait's place in the 640x360 picture.
const FACE: [number, number, number, number] = [0.35, 0.1, 0.3, 0.55];

describe("test_graphic", { skip: !db && "needs a database, Redis and storage" }, () => {
  let dir = "", userId = "", videoId = "", boxId = "", codeId = "";
  let prisma: typeof import("@rendrr/db").prisma;
  let core: typeof import("@rendrr/core");
  let job: typeof import("../src/jobs/testGraphic").testGraphicJob;
  const runJob = async (d: Omit<TestGraphicJob, "key" | "userId">): Promise<TestGraphicResult> => job({ signal: new AbortController().signal, dir, isLastAttempt: true, job: { data: { userId, key: `k${Math.random().toString(36).slice(2, 8)}`, ...d } } } as unknown as Job);

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "test-graphic-"));
    ({ prisma } = await import("@rendrr/db"));
    core = await import("@rendrr/core");
    ({ testGraphicJob: job } = await import("../src/jobs/testGraphic"));
    userId = (await prisma.user.create({ data: { clerkId: `tg_${run6}`, email: `tg-${run6}@test.rendrr.dev`, name: "Test" } })).id;
    // A 20 s video: the portrait on a grey frame (a face where FACE says), and its faces measured at 10 fps.
    const video = join(dir, "talk.mp4");
    execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "color=0x506070:s=640x360:r=30:d=20", "-i", join(here, "fixtures/astronaut.jpg"), "-f", "lavfi", "-i", "sine=f=220:d=20",
      "-filter_complex", `[1:v]scale=${FACE[2] * 640}:${FACE[3] * 360}[f];[0:v][f]overlay=x=${FACE[0] * 640}:y=${FACE[1] * 360},format=yuv420p[v]`, "-map", "[v]", "-map", "2:a", "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-shortest", video]);
    const proxyKey = `proxies/${userId}/talk.mp4`;
    await core.uploadFile(proxyKey, video, "video/mp4");
    const visionKey = `frames/${userId}/vision.json.gz`;
    await writeFile(join(dir, "v.gz"), gzipSync(JSON.stringify({ v: 1, fps: 10, size: [640, 360], frames: Array.from({ length: 200 }, (_, i) => [i / 10, [[1, ...FACE, 0.9, null, null, null, null]]]) })));
    await core.uploadFile(visionKey, join(dir, "v.gz"), "application/gzip");
    videoId = (await prisma.video.create({ data: { userId, name: "Talk", seconds: 20, width: 640, height: 360, source: "local", status: "ready", hasAudio: true, proxyKey, analysis: { create: { transcriber: "stub", transcript: [], silences: [], sceneCuts: [], keyFrames: [], vision: { v: 1, size: [640, 360], key: visionKey, turned: 0 } as never } } } })).id;
    // A recorded custom graphic: an opaque box where the face is drawn in a 16:9 frame, 10 s.
    const box = join(dir, "box.webm");
    execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", `color=black:s=960x540:r=30:d=10,format=rgba,geq=r=255:g=255:b=255:a='if(between(X,${FACE[0] * 960},${(FACE[0] + FACE[2]) * 960})*between(Y,${FACE[1] * 540},${(FACE[1] + FACE[3]) * 540}),255,0)'`, "-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p", "-auto-alt-ref", "0", box]);
    await core.uploadFile(`graphics/${userId}/box.webm`, box, "video/webm");
    boxId = (await prisma.graphic.create({ data: { ownerId: userId, name: "Face box", kind: "custom", durationSec: 10, width: 960, height: 540, transparent: true, status: "ready", renderedKey: `graphics/${userId}/box.webm` } })).id;
    // A custom graphic with code and a param (its default recording stands in; other values are recorded for a test).
    codeId = (await prisma.graphic.create({ data: { ownerId: userId, name: "Label", kind: "custom", code: `<div id="t" style="position:absolute;left:40px;top:40px;font:bold 64px sans-serif;color:#fff">x</div><script>document.getElementById("t").textContent = window.params.label;</script>`,
      paramsSchema: { type: "object", properties: { label: { type: "string", default: "Hello" } } } as never, durationSec: 60, width: 960, height: 540, transparent: true, status: "ready", renderedKey: `graphics/${userId}/box.webm` } })).id;
  });
  after(async () => {
    await core.deletePrefix(`proxies/${userId}/`).catch(() => {});
    await core.deletePrefix(`frames/${userId}/`).catch(() => {});
    await core.deletePrefix(`graphics/${userId}/`).catch(() => {});
    await core.deletePrefix(`tests/${userId}/`).catch(() => {});
    await prisma.user.deleteMany({ where: { id: userId } });
    await rm(dir, { recursive: true, force: true });
    await core.redis().quit().catch(() => {});
  });

  it("a template over a plain frame: recorded for the test and back in under 10 s, with 3 frames, the clip and what it covers", async () => {
    const t0 = Date.now();
    const r = await runJob({ graphicId: "gt_title_card", params: { title: "Cold outreach works" }, at: 0, seconds: 3, aspect: "16:9" });
    const took = Date.now() - t0;
    console.log(`title card test: ${took} ms (recorded in ${r.recordedMs} ms); cover ${JSON.stringify(r.cover)}`);
    assert.ok(took < 10_000, `${took} ms`);
    assert.deepEqual([r.width, r.height, r.from, r.seconds, r.frames.length], [960, 540, 0, 3, 3]);
    assert.ok(r.recordedMs > 0 && r.cover && r.cover.visible > 0 && r.cover.max > 1, JSON.stringify(r.cover));
    assert.equal(r.face, undefined); // no footage under it
    for (const k of [r.clip, ...r.frames]) assert.ok(await core.headObject(k), k);
    const kept = JSON.parse((await core.getBytes(r.clip.replace(/\.mp4$/, ".json"))).toString()) as TestGraphicResult;
    assert.equal(kept.clip, r.clip);
    const { stdout } = { stdout: execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", await core.signGet(r.clip, 300)]).toString() };
    assert.ok(Math.abs(Number(stdout) - 3) < 0.1, stdout);
  });

  it("over a video at a time: the footage's shape, and how much of the face it covers (a lower third none, a box over the face all)", async () => {
    const low = await runJob({ graphicId: "gt_lower_third", params: { name: "Ronny" }, at: 0, seconds: 4, aspect: "16:9", over: { videoId, time: 5 } });
    assert.ok(low.face && low.face.of === 8 && low.face.max < 5, JSON.stringify(low.face));
    const box = await runJob({ graphicId: boxId, at: 2, seconds: 4, aspect: "16:9", over: { videoId, time: 5 } });
    assert.equal(box.recordedMs, 0); // it plays its recording
    assert.equal(box.from, 2);
    assert.ok(box.face && box.face.max > 90, JSON.stringify(box.face));
  });

  it("a custom graphic with new params is recorded for the test (up to 20 s in); past that it says how to test it", async () => {
    const r = await runJob({ graphicId: codeId, params: { label: "Bye" }, at: 1, seconds: 3, aspect: "16:9" });
    assert.ok(r.recordedMs > 0 && r.cover && r.cover.max > 0.1 && r.cover.max < 10, JSON.stringify(r));
    await assert.rejects(runJob({ graphicId: codeId, params: { label: "Bye" }, at: 30, seconds: 3, aspect: "16:9" }), /recording them for a test is done only up to 20 s in/);
    await assert.rejects(runJob({ graphicId: "nope", at: 0, seconds: 3, aspect: "16:9" }), /does not exist/);
  });
});
