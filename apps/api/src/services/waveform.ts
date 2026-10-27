// A picture of a stretch of sound for the AI (get_waveform_image): the waveform from the 10 ms peaks, speech shaded,
// breaths, clicks and clipping marked, word edges ticked, a tick every second. Drawn into pixels and written as a PNG
// here (no image library needed).
import { deflateSync } from "node:zlib";
import type { AudioFrames, DeepAudio } from "@rendrr/shared";

const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(b: Buffer) { let c = 0xffffffff; for (const x of b) c = CRC[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function chunk(type: string, data: Buffer) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
/** RGB pixels (w x h x 3) as a PNG file. */
export function png(w: number, h: number, rgb: Uint8Array): Buffer {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 3 + 1)] = 0; Buffer.from(rgb.buffer, rgb.byteOffset + y * w * 3, w * 3).copy(raw, y * (w * 3 + 1) + 1); }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 6 })), chunk("IEND", Buffer.alloc(0))]);
}

type RGB = [number, number, number];
const BG: RGB = [17, 17, 17], SPEECH: RGB = [34, 44, 14], WAVE: RGB = [189, 232, 22], TICK: RGB = [90, 90, 90], WORD: RGB = [150, 150, 150], BREATH: RGB = [80, 160, 255], CLICK: RGB = [255, 255, 255], CLIP: RGB = [255, 140, 0];

/** The picture: x = from + (pixel / width) x (to - from); y = the sample value, full scale at the top and bottom. */
export function waveformPng(f: AudioFrames, a: DeepAudio, o: { from: number; to: number; width: number; height: number; words?: { s: number; e: number }[] }): Buffer {
  const { width: W, height: H, from, to } = o;
  const px = new Uint8Array(W * H * 3);
  const set = (x: number, y: number, c: RGB) => { if (x < 0 || y < 0 || x >= W || y >= H) return; const i = (y * W + x) * 3; px[i] = c[0]; px[i + 1] = c[1]; px[i + 2] = c[2]; };
  const col = (t: number) => Math.round(((t - from) / (to - from)) * W);
  const vline = (x: number, y0: number, y1: number, c: RGB) => { for (let y = Math.max(0, y0); y <= Math.min(H - 1, y1); y++) set(x, y, c); };
  for (let i = 0; i < W * H; i++) { px[i * 3] = BG[0]; px[i * 3 + 1] = BG[1]; px[i * 3 + 2] = BG[2]; }
  const top = 10, bottom = H - 14, mid = (top + bottom) / 2, half = (bottom - top) / 2;
  // Speech shaded behind the waveform.
  for (const [s, e] of a.speech) if (e >= from && s <= to) for (let x = Math.max(0, col(s)); x < Math.min(W, col(e)); x++) vline(x, top, bottom, SPEECH);
  // The waveform: each column's min and max of the 10 ms frames under it.
  for (let x = 0; x < W; x++) {
    const t0 = from + (x / W) * (to - from), t1 = from + ((x + 1) / W) * (to - from);
    const i0 = Math.max(0, Math.floor(t0 / 0.01)), i1 = Math.min(f.n, Math.max(i0 + 1, Math.ceil(t1 / 0.01)));
    if (i0 >= f.n) break;
    let lo = 127, hi = -127;
    for (let i = i0; i < i1; i++) { lo = Math.min(lo, f.min[i]); hi = Math.max(hi, f.max[i]); }
    vline(x, Math.round(mid - (hi / 127) * half), Math.round(mid - (lo / 127) * half), WAVE);
  }
  // Breaths (blue band at the top), clicks (white ticks), clipping (orange band).
  for (const [s, e] of a.breaths) if (e >= from && s <= to) for (let x = col(s); x < col(e); x++) vline(x, 0, 4, BREATH);
  for (const [t] of a.clicks) if (t >= from && t <= to) vline(col(t), 0, 9, CLICK);
  for (const [s, e] of a.clipping) if (e >= from && s <= to) for (let x = col(s); x <= col(e); x++) vline(x, 5, 9, CLIP);
  // Word edges along the bottom: a tick at each start and end, the word's span lit.
  for (const w of o.words ?? []) if (w.e >= from && w.s <= to) { for (let x = col(w.s); x < col(w.e); x++) set(x, H - 12, WORD); vline(col(w.s), H - 14, H - 9, WORD); }
  // A tick every second (every 10 s taller), and every 0.1 s when a second is wide enough.
  const secW = W / (to - from);
  for (let t = Math.ceil(from * 10) / 10; t <= to; t = Math.round((t + 0.1) * 10) / 10) {
    const whole = Math.abs(t - Math.round(t)) < 1e-6;
    if (!whole && secW < 80) continue;
    const ten = whole && Math.round(t) % 10 === 0;
    vline(col(t), H - (ten ? 8 : whole ? 6 : 3), H - 1, ten ? WORD : TICK);
  }
  return png(W, H, px);
}
