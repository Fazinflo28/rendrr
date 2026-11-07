import { sentencesFromWords, type RawWord } from "@rendrr/shared";
import { noteCost } from "./cost";
import { env } from "./env";

// Behind an interface so Deepgram (or anything else) can be swapped in.
export interface Transcriber {
  name: string;
  /** Returns sentences of timed words (seconds). `audioUrl` is a signed URL the provider can fetch. */
  transcribe(audioUrl: string, opts?: { language?: string; signal?: AbortSignal }): Promise<RawWord[][]>;
}

export class TranscriptionError extends Error { friendly = true; }

export class AssemblyAI implements Transcriber {
  name = "assemblyai";
  constructor(private key: string) {}
  private async call(path: string, init: RequestInit = {}) {
    const r = await fetch("https://api.assemblyai.com" + path, { ...init, headers: { authorization: this.key, "content-type": "application/json", ...(init.headers || {}) } });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new TranscriptionError(`Transcription service said: ${(body as { error?: string }).error || r.statusText}`);
    return body as Record<string, unknown>;
  }
  /** Local storage is not reachable from the internet: send the bytes instead of a link. */
  private async reachableUrl(audioUrl: string, signal?: AbortSignal) {
    if (!/^https?:\/\/(127\.|localhost|10\.|192\.168\.|\[?::1)/.test(audioUrl)) return audioUrl;
    const audio = await fetch(audioUrl, { signal });
    if (!audio.ok) throw new TranscriptionError("We could not read the audio for transcription.");
    const r = await fetch("https://api.assemblyai.com/v2/upload", { method: "POST", headers: { authorization: this.key, "content-type": "application/octet-stream" }, body: Buffer.from(await audio.arrayBuffer()), signal });
    const j = (await r.json().catch(() => ({}))) as { upload_url?: string };
    if (!r.ok || !j.upload_url) throw new TranscriptionError("We could not send the audio for transcription.");
    return j.upload_url;
  }
  async transcribe(audioUrl: string, opts: { language?: string; signal?: AbortSignal } = {}) {
    audioUrl = await this.reachableUrl(audioUrl, opts.signal);
    const created = await this.call("/v2/transcript", {
      method: "POST",
      // Universal-2 with word timestamps; disfluencies keeps "um" and "uh" so filler removal works.
      body: JSON.stringify({ audio_url: audioUrl, speech_models: ["universal-2"], disfluencies: true, punctuate: true, format_text: true, language_code: opts.language || "en" }),
      signal: opts.signal,
    });
    const id = created.id as string;
    const deadline = Date.now() + 8 * 60_000;
    for (;;) {
      if (opts.signal?.aborted) throw new TranscriptionError("Transcription was stopped.");
      if (Date.now() > deadline) throw new TranscriptionError("Transcription took too long. Try again.");
      await new Promise((r) => setTimeout(r, 2500));
      const t = await this.call(`/v2/transcript/${id}`, { signal: opts.signal });
      if (t.status === "error") {
        const msg = String(t.error || "");
        if (/no spoken audio|contain(s)? no speech|audio duration is too short/i.test(msg)) return [];
        throw new TranscriptionError("We could not transcribe this audio. " + (msg ? "(" + msg.slice(0, 120) + ")" : ""));
      }
      if (t.status === "completed") { noteCost({ transcribeSeconds: Number(t.audio_duration) || 0 }); break; }
    }
    try {
      const s = await this.call(`/v2/transcript/${id}/sentences`, { signal: opts.signal });
      const sentences = (s.sentences as { words: { text: string; start: number; end: number }[] }[]) || [];
      const out = sentences.map((x) => x.words.map((w) => ({ text: w.text, start: w.start / 1000, end: w.end / 1000 }))).filter((x) => x.length);
      if (out.length) return out;
    } catch { /* fall back to the flat word list below */ }
    const t = await this.call(`/v2/transcript/${id}`, { signal: opts.signal });
    const words = ((t.words as { text: string; start: number; end: number }[]) || []).map((w) => ({ text: w.text, start: w.start / 1000, end: w.end / 1000 }));
    return sentencesFromWords(words);
  }
}

/** null = no key: callers use the sample transcript instead. */
export function transcriber(): Transcriber | null {
  const k = env().ASSEMBLYAI_API_KEY;
  return k ? new AssemblyAI(k) : null;
}
