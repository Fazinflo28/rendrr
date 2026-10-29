// A comment's drawing (the Rendrr app in the chat) on the frame Claude looks at: the frames job takes the preview's
// frame at the comment's moment and lays the drawing's clear PNG over it, stretched to the frame; the strokes land
// where they were drawn, the rest of the picture is untouched, and asking again uses the kept frame.
// Needs ffmpeg, a database and storage (as in .env).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { after, before, describe, it } from "node:test";
import type { Job } from "bullmq";
import { run } from "../src/lib/ffmpeg";

const db = !!process.env.DATABASE_URL && !!process.env.S3_BUCKET;
const run6 = Math.random().toString(36).slice(2, 8);
const W = 640, H = 360;

/** A clear PNG with an opaque red box outline at (x, y, w, h), as the app's canvas makes it. */
function boxPng(pw: number, ph: number, b: { x: number; y: number; w: number; h: number }, t = 6): Buffer {
  const crcT = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (buf: Buffer) => { let c = 0xffffffff; for (const x of buf) c = crcT[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type: string, data: Buffer) => { const l = Buffer.alloc(4); l.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
  const raw = Buffer.alloc((pw * 4 + 1) * ph);
  for (let y = 0; y < ph; y++) for (let x = 0; x < pw; x++) {
    const inBox = x >= b.x && x < b.x + b.w && y >= b.y && y < b.y + b.h, inner = x >= b.x + t && x < b.x + b.w - t && y >= b.y + t && y < b.y + b.h - t;
    if (inBox && !inner) raw.set([255, 0, 0, 255], y * (pw * 4 + 1) + 1 + x * 4);
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(pw, 0); ihdr.writeUInt32BE(ph, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

describe("a comment's drawing on the frame", { skip: !db && "needs a database and storage" }, () => {
  let dir = "", userId = "", projectId = "", renderId = "";
  const keys: string[] = [];
  before(async () => {
    const { prisma } = await import("@rendrr/db");
    const { uploadFile, putObject } = await import("@rendrr/core");
    const { buildInitialTimeline, stubTranscript } = await import("@rendrr/shared");
    dir = await mkdtemp(join(tmpdir(), "drawing-"));
    // A 3 s grey preview.
    const mp4 = join(dir, "preview.mp4");
    await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", `color=0x606060:s=${W}x${H}:r=30:d=3`, "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", mp4]);
    userId = (await prisma.user.create({ data: { clerkId: `draw_${run6}`, email: `draw-${run6}@test.rendrr.dev`, name: "Draw" } })).id;
    const folder = await prisma.folder.create({ data: { userId, name: "F", workspace: "W" } });
    const analysis = { create: { transcriber: "stub", transcript: stubTranscript(3) as never, silences: [] as never, sceneCuts: [], keyFrames: [] } };
    const video = await prisma.video.create({ data: { userId, name: "v", seconds: 3, width: W, height: H, source: "drive", status: "ready", analysis } });
    const tl = buildInitialTimeline(stubTranscript(3), 3);
    projectId = (await prisma.project.create({ data: { userId, folderId: folder.id, videoId: video.id, name: "p", timeline: tl as never } })).id;
    const out = `previews/${userId}/${projectId}/r-${run6}.mp4`;
    await uploadFile(out, mp4, "video/mp4");
    renderId = (await prisma.render.create({ data: { projectId, userId, kind: "preview", version: 1, status: "done", outputKey: out, seconds: 3, steps: [] } })).id;
    // The drawing as the app makes it: the picture's shape, at another size (1280x720): a box over x 25-50%, y 25-75%.
    const dkey = `comments/${userId}/${projectId}/c1/drawing-${run6}.png`;
    await putObject(dkey, boxPng(1280, 720, { x: 320, y: 180, w: 320, h: 360 }, 12), "image/png");
    keys.push(out, dkey);
  });
  after(async () => {
    const { prisma } = await import("@rendrr/db");
    const { deleteObjects } = await import("@rendrr/core");
    await deleteObjects(keys).catch(() => {});
    await prisma.user.deleteMany({ where: { id: userId } });
    if (!process.env.KEEP) await rm(dir, { recursive: true, force: true }); else console.log("kept", dir);
  });

  it("lays the drawing over the preview's frame at the comment's moment, where it was drawn", async () => {
    const { framesJob } = await import("../src/jobs/frames");
    const { signGet } = await import("@rendrr/core");
    const job = (times: number[], overlays: (string | null)[]) => framesJob({ signal: new AbortController().signal, dir, isLastAttempt: true, job: { data: { renderId, times, overlays } } } as unknown as Job) as Promise<string[]>;
    const [k] = await job([1.5], [keys[1]]);
    keys.push(k);
    assert.match(k, /-at1500ms-drawing-\w+\.jpg$/);
    // The frame as pixels (960 wide, the drawing stretched to it): red on the box's edge, grey inside it and outside.
    const jpg = join(dir, "got.jpg");
    execFileSync("curl", ["-s", "-o", jpg, await signGet(k, 60)]);
    const size = execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=width,height", "-of", "csv=p=0", jpg]).toString().trim();
    assert.equal(size, "960,540");
    const rgb = execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", jpg, "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"], { maxBuffer: 8 << 20 });
    const px = (x: number, y: number) => { const i = (y * 960 + x) * 3; return [rgb[i], rgb[i + 1], rgb[i + 2]]; };
    const red = (p: number[]) => p[0] > 180 && p[1] < 80 && p[2] < 80, grey = (p: number[]) => Math.abs(p[0] - 96) < 20 && Math.abs(p[1] - 96) < 20 && Math.abs(p[2] - 96) < 20;
    const edge = px(240 + 4, 270), inside = px(360, 270), outside = px(700, 100);
    console.log(`edge ${edge}, inside ${inside}, outside ${outside}`);
    assert.ok(red(edge), `the box's left edge is red at x 25% (${edge})`);
    assert.ok(red(px(360, 135 + 4)), "and its top edge at y 25%");
    assert.ok(grey(inside) && grey(outside), `the rest of the picture is untouched (${inside}, ${outside})`);
    // Asked again: the kept frame.
    const t0 = Date.now();
    assert.deepEqual(await job([1.5], [keys[1]]), [k]);
    assert.ok(Date.now() - t0 < 2000);
    // A frame without a drawing is the usual one.
    const [plain] = await job([1.5], [null]);
    keys.push(plain);
    assert.match(plain, /-at150\.jpg$/);
  });
});
