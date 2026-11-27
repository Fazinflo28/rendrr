// Footage work done on the user's own computer. While the Rendrr Mac or Windows app is open and able, the preview copy
// of footage from Google Drive (or kept in Rendrr's storage) and the transcript of any footage are handed to it as a
// task (core/macRender.ts, the same hand-off renders use): the app fetches the original straight from Drive, makes the
// preview copy with its own FFmpeg and uploads it, and writes the transcript with its own speech model (whisper.cpp).
// Rendrr's cloud server only waits. Whatever stops that (no app open, an older app, the user picked the cloud, the app
// busy, a failure, the app going quiet) leaves the cloud to do it as before, and the reason is kept.
import { deleteObjects, downloadFile, macForRender, renderChoice, type MacInput, type MacTaskSpec, type MacTranscribe } from "@rendrr/core";
import { PREFIX } from "@rendrr/shared";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { needsOf, runOnMac, type MacRun } from "./macTask";

/** Where one footage step ran, kept on the video (Video.madeOn) for the usage page. */
export type StepWhere = {
  on: "computer" | "cloud";
  /** The computer's name and kind when it ran there. */
  device?: string | null; platform?: "mac" | "windows";
  /** What made it: "app" (the Rendrr app's FFmpeg), "browser" (the page's ffmpeg.wasm), "whisper", "assemblyai", "ffmpeg". */
  by?: string;
  /** Why it ran on the cloud when a computer was open (null: no app was open, or it ran on the computer). */
  why?: string | null;
  at: number;
};
export type MadeOn = { preview?: StepWhere; transcript?: StepWhere };

/** The app's capability for transcripts (its ping lists it with the FFmpeg features once its speech model can run). */
export const WHISPER = "whisper";

const machineWord = (p?: "mac" | "windows") => (p === "windows" ? "PC" : "Mac");

/** The computer to hand this to now, or why not (why null: no app is open, nothing to say). */
async function pick(userId: string, needs: string[]) {
  if (process.env.FOOTAGE_ON_COMPUTER === "off") return { info: null, why: null };
  const choice = await renderChoice(userId).catch(() => null);
  const m = await macForRender(userId, needs, choice).catch(() => ({ info: null, why: null }));
  if (!m.info || m.why) return { info: null, why: m.why === "the Rendrr app is not open" ? null : m.why };
  return { info: m.info, why: null };
}

type Common = { userId: string; videoId: string; signal: AbortSignal; dir: string; extend?: (ms: number) => void };
type Ran = { ok: true; where: StepWhere; outputs: Record<string, number> } | { ok: false; why: string | null };

async function hand(spec: Omit<MacTaskSpec, "deviceId" | "needs"> & { needs?: string[] }, o: Common & { label: string; onProgress: (frac: number) => void; renderWeight: number; seconds: number }): Promise<Ran> {
  const needs = Array.from(new Set([...(spec.needs ?? []), ...needsOf(spec.commands as MacRun[])]));
  const p = await pick(o.userId, needs);
  if (!p.info) return { ok: false, why: p.why };
  const W = machineWord(p.info.platform);
  let dlAt = 0;
  const res = await runOnMac({ ...spec, deviceId: p.info.id, needs }, {
    signal: o.signal, machine: W,
    onClaim: () => {},
    onDownload: (f) => {
      // The fetch is the user's line, not this server's work: the job's time limit moves later as it goes.
      const now = Date.now();
      if (dlAt) o.extend?.(now - dlAt);
      dlAt = now;
      o.onProgress(0.4 * f);
    },
    onRender: (cmd, sec) => {
      if (dlAt) { o.extend?.(Date.now() - dlAt); dlAt = 0; }
      const runs = spec.commands.length + (spec.transcribe ? 1 : 0);
      const within = cmd === 0 && o.seconds > 0 ? Math.min(1, sec / o.seconds) : 0;
      o.onProgress(0.4 + o.renderWeight * Math.min(1, (cmd + within) / Math.max(1, runs)));
    },
    onUpload: (f) => o.onProgress(0.4 + o.renderWeight + (0.99 - 0.4 - o.renderWeight) * f),
  }).catch((e) => { if (o.signal.aborted) throw e; return { ok: false as const, why: `the hand-off to your ${W} broke (${(e as Error).message.slice(0, 120)})` }; });
  if (!res.ok) { console.error(`[footage] ${o.videoId}: ${o.label} not made on the user's ${W} (${res.why}): the cloud makes it`); return { ok: false, why: res.why }; }
  console.log(`[footage] ${o.videoId}: ${o.label} made on the user's ${W}${res.device ? ` "${res.device}"` : ""}`);
  return { ok: true, where: { on: "computer", device: res.device, platform: res.platform, at: Date.now() }, outputs: res.outputs };
}

/** The original as the computer fetches it: from the user's Drive (never through Rendrr) or Rendrr's storage. */
export type ComputerSource = { drive: { fileId: string; version?: string }; size?: number } | { key: string; size?: number };

/**
 * The preview copy made on the user's computer: the same FFmpeg run the cloud makes (args from proxyArgs, reading
 * "src", writing proxy.mp4 and audio.m4a), then the key frames from the proxy, each uploaded to its own key.
 */
export async function previewOnComputer(o: Common & {
  name: string; seconds: number; source: ComputerSource;
  proxyRun: string[]; frames: { args: string[]; name: string; key: string }[]; proxyKey: string; audioKey: string;
  onProgress: (frac: number) => void;
}): Promise<Ran> {
  const size = o.source.size && o.source.size > 0 ? { size: o.source.size } : {};
  const src: MacInput = "drive" in o.source ? { name: "src", drive: o.source.drive, ...size } : { name: "src", key: o.source.key, ...size };
  const commands = [{ args: o.proxyRun, seconds: o.seconds }, ...o.frames.map((f) => ({ args: f.args }))];
  const outputs = [
    { name: "proxy.mp4", key: o.proxyKey, type: "video/mp4" },
    { name: "audio.m4a", key: o.audioKey, type: "audio/mp4" },
    ...o.frames.map((f) => ({ name: f.name, key: f.key, type: "image/jpeg" })),
  ];
  return hand({ renderId: `prep-${o.videoId}`, userId: o.userId, kind: "footage_preview", label: `the preview copy of "${o.name.slice(0, 80)}"`, inputs: [src], commands, outputs, stallSec: 120 },
    { ...o, label: "preview copy", renderWeight: 0.55 });
}

export type HeardWord = { text: string; start: number; end: number };

/**
 * The transcript made on the user's computer by the app's speech model: the preview's 16 kHz sound (already in
 * storage, about 20 MB an hour) goes to the app, which writes the words. Null words: not made there (why says why).
 */
export async function transcriptOnComputer(o: Common & { audioKey: string; audioSize?: number; seconds: number; language: string; onProgress: (frac: number) => void }): Promise<{ words: HeardWord[]; where: StepWhere } | { words: null; why: string | null }> {
  const out = `${PREFIX.mac}heard/${o.videoId}-${Date.now()}.json`;
  const transcribe: MacTranscribe = { input: "speech.wav", output: "words.json", language: o.language, seconds: o.seconds };
  const r = await hand({
    renderId: `heard-${o.videoId}`, userId: o.userId, kind: "footage_transcript", label: "a transcript",
    inputs: [{ name: "audio.m4a", key: o.audioKey, ...(o.audioSize ? { size: o.audioSize } : {}) }],
    commands: [{ args: ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-i", "audio.m4a", "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", "speech.wav"] }],
    outputs: [{ name: "words.json", key: out, type: "application/json" }],
    transcribe, needs: [WHISPER], stallSec: 120,
  }, { ...o, label: "transcript", renderWeight: 0.58 });
  if (!r.ok) return { words: null, why: r.why };
  try {
    const path = join(o.dir, "heard-words.json");
    await downloadFile(out, path);
    const words = wordsOf(JSON.parse(await readFile(path, "utf8")), o.seconds);
    if (!words) return { words: null, why: "the words it sent back could not be read" };
    return { words, where: { ...r.where, by: "whisper" } };
  } catch (e) {
    return { words: null, why: `the words it sent back could not be read (${(e as Error).message.slice(0, 80)})` };
  } finally { await deleteObjects([out]).catch(() => {}); }
}

/**
 * The words the app sent back, checked: each a short text with a start and an end inside the footage, in order. Null:
 * not a list of words at all. (An empty list is a transcript too: footage with no speech.)
 */
export function wordsOf(body: unknown, seconds: number): HeardWord[] | null {
  const list = (body as { words?: unknown })?.words;
  if (!Array.isArray(list) || list.length > 200_000) return null;
  const top = seconds > 0 ? seconds + 1 : Infinity;
  const out: HeardWord[] = [];
  for (const w of list) {
    const text = typeof w?.text === "string" ? w.text.replace(/[\u0000-\u001f]/g, " ").trim().slice(0, 80) : "";
    const start = Number(w?.start), end = Number(w?.end);
    if (!text || !Number.isFinite(start) || !Number.isFinite(end) || start < 0 || start > top) continue;
    const e = Math.min(top, Math.max(start + 0.01, end));
    const prev = out[out.length - 1];
    out.push({ text, start: prev && start < prev.start ? prev.start : start, end: e });
  }
  return out;
}

/** The video's record of where its steps ran (Video.madeOn) with these steps put in. */
export function withMadeOn(was: unknown, add: MadeOn): MadeOn {
  const base = was && typeof was === "object" && !Array.isArray(was) ? (was as MadeOn) : {};
  return { ...base, ...add };
}

/** The usage record's note of where the steps ran (meta.preview, meta.transcript: "computer" | "cloud", meta.device). */
export function madeOnMeta(m: MadeOn): Record<string, string> {
  const out: Record<string, string> = {};
  if (m.preview) out.preview = m.preview.on;
  if (m.transcript) out.transcript = m.transcript.on;
  const dev = m.preview?.on === "computer" ? m.preview : m.transcript?.on === "computer" ? m.transcript : null;
  if (dev?.device) out.device = dev.device;
  if (dev?.platform) out.platform = dev.platform;
  return out;
}
