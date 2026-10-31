// Phase 15: what the editor plays live equals what the render writes. Tones through the render's own EQ chain in
// FFmpeg (eqChain: bass, equalizer, treble, the parametric bands), measured at each frequency, against the live
// player's Web Audio biquads for the same EQ (eqBiquads), their response read from Chromium's own filters. Needs ffmpeg
// and Chromium (as the browser tests).
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import { promisify } from "node:util";
import { eqBiquads, eqChain, type Eq } from "@rendrr/shared";

const execFileP = promisify(execFile);
const require = createRequire(import.meta.url);
const web = resolve(import.meta.dirname, "../../web");
const FREQS = [50, 120, 400, 1000, 2000, 3000, 4500, 6000, 12000];

/** The level change (dB) the render's chain gives a steady tone at f. */
async function renderGain(chain: string, f: number): Promise<number> {
  const rms = async (af: string) => {
    const { stdout } = await execFileP("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", `sine=f=${f}:d=1.2:sample_rate=48000`, "-af", `${af ? af + "," : ""}atrim=0.4:1.1`, "-f", "f32le", "-ac", "1", "-"], { encoding: "buffer", maxBuffer: 1 << 24 });
    const b = stdout as Buffer; let s = 0; const n = b.length / 4;
    for (let i = 0; i < n; i++) { const v = b.readFloatLE(i * 4); s += v * v; }
    return Math.sqrt(s / n);
  };
  return 20 * Math.log10((await rms(chain)) / (await rms("")));
}

describe("the live EQ is the render's EQ", () => {
  it("the same response at every frequency, shelves, the 1 kHz bell and parametric bands", async () => {
    const { chromium } = require(require.resolve("playwright-core", { paths: [web] }));
    const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" }).catch(() => chromium.launch());
    const page = await browser.newPage();
    await page.setContent("<!doctype html><title>eq</title>");
    const cases: Eq[] = [
      { low: 6, mid: -4, high: 3 },
      { bands: [{ f: 3000, gain: -8, q: 2 }, { f: 120, gain: 5, q: 0.8 }] },
      { low: -3, high: 4, bands: [{ f: 60, gain: -18, q: 10 }, { f: 2500, gain: 3, q: 1.4 }] },
    ];
    let worst = 0;
    try {
      for (const eq of cases) {
        const live: number[] = await page.evaluate(([bq, freqs]: [ReturnType<typeof eqBiquads>, number[]]) => {
          const ctx = new OfflineAudioContext(1, 48000, 48000);
          const total = new Float32Array(freqs.length).fill(0);
          for (const b of bq) {
            const f = ctx.createBiquadFilter(); f.type = b.type; f.frequency.value = b.f; f.gain.value = b.gain; f.Q.value = b.q;
            const mag = new Float32Array(freqs.length), ph = new Float32Array(freqs.length);
            f.getFrequencyResponse(Float32Array.from(freqs), mag, ph);
            for (let i = 0; i < freqs.length; i++) total[i] += 20 * Math.log10(mag[i]);
          }
          return Array.from(total);
        }, [eqBiquads(eq), FREQS] as const);
        const chain = eqChain(eq);
        const rendered = [];
        for (const f of FREQS) rendered.push(await renderGain(chain, f));
        const diff = rendered.map((r, i) => Math.abs(r - live[i]));
        worst = Math.max(worst, ...diff);
        console.log(`${JSON.stringify(eq)}\n  ${FREQS.map((f, i) => `${f} Hz: render ${rendered[i].toFixed(2)} live ${live[i].toFixed(2)}`).join("; ")}`);
        diff.forEach((d, i) => assert.ok(d < 0.6, `${FREQS[i]} Hz: render ${rendered[i].toFixed(2)} dB, live ${live[i].toFixed(2)} dB`));
      }
    } finally { await browser.close(); }
    console.log(`largest difference ${worst.toFixed(2)} dB`);
  });
});
