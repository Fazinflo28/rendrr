// Names the UI shows. These strings are part of the contract with ui/rendrr-ui.html: do not reword them.
export const PROC_STEPS = ["Transcribing", "Finding silences", "Finding scene cuts", "Reading the frames"] as const;
export const DRIVE_STEPS = ["Linking", "Making preview", ...PROC_STEPS] as const;
export const LOCAL_STEPS = ["Making preview in your browser", "Uploading preview", ...PROC_STEPS] as const;

export const PREVIEW_STEPS = ["Reading timeline", "Measuring loudness", "Cutting clips", "Burning captions", "Packing preview"] as const;
export const FINAL_RENDER_STEPS = ["Reading timeline", "Measuring loudness", "Cutting clips", "Adding zooms", "Mixing music", "Burning captions", "Encoding 1080p", "Cleaning up raw file"] as const;
export const FINAL_DRIVE_STEPS = ["Fetching raw from Drive", ...FINAL_RENDER_STEPS] as const;
export const ORIGINAL_UPLOAD_STEPS = ["Uploading original"] as const;

export const VIDEO_STATUSES = ["linking", "preview", "previewing", "uploading", "paused", "processing", "ready", "failed", "missing", "expired"] as const;
export type VideoStatus = (typeof VIDEO_STATUSES)[number];
export const BUSY_STATUSES: VideoStatus[] = ["linking", "preview", "previewing", "uploading", "processing"];

export const PROJECT_STATUSES = ["Draft", "Rendering", "Preview ready", "In review", "Changes requested", "Approved", "Final ready"] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

export const ASPECTS = ["16:9", "9:16", "1:1"] as const;
export type Aspect = (typeof ASPECTS)[number];
export const CAPTION_LOOKS = ["clean", "bold", "outline"] as const;
export type CaptionLook = (typeof CAPTION_LOOKS)[number];

export const ACTORS = ["user", "claude", "chatgpt", "rendrr"] as const;
export type Actor = (typeof ACTORS)[number];

// Queues and their hard limits (guard rails). Timeouts in ms.
export const QUEUES = {
  proxy: { name: "proxy", timeoutMs: 10 * 60_000, attempts: 2 },
  analyze: { name: "analyze", timeoutMs: 10 * 60_000, attempts: 2 },
  render: { name: "render", timeoutMs: 15 * 60_000, attempts: 1 },
  graphic: { name: "graphic", timeoutMs: 2 * 60_000, attempts: 3 },
  maintenance: { name: "maintenance", timeoutMs: 10 * 60_000, attempts: 1 },
  frames: { name: "frames", timeoutMs: 60_000, attempts: 1 },
  breakdown: { name: "breakdown", timeoutMs: 10 * 60_000, attempts: 1 },
  deep: { name: "deep", timeoutMs: 10 * 60_000, attempts: 2 },
  // The transcriber gives up after 8 minutes; this is the job's limit around it.
  heard: { name: "heard", timeoutMs: 10 * 60_000, attempts: 2 },
  // Engine Part 5: test_graphic, a few seconds of a graphic over the footage; the tool waits under 10 s for it.
  test: { name: "test", timeoutMs: 90_000, attempts: 1 },
  // Engine Part 4.4: analyze_reference, a reference video measured into a style file (styleTimeoutMs).
  style: { name: "style", timeoutMs: 30 * 60_000, attempts: 1 },
} as const;
/** A reference is read at about 7x its speed on the worker; the limit allows 0.5 s a second of video and 4 minutes. */
export const styleTimeoutMs = (seconds: number) => 4 * 60_000 + Math.round(seconds * 500);
/** The deeper measurements' limit grows with the footage: 0.6x its length (faces at 10 fps are most of it) plus a
 *  fixed 5 minutes; a 22-minute video gets 18 minutes. */
export const deepTimeoutMs = (seconds: number) => 5 * 60_000 + Math.round(seconds * 600);
export const PREVIEW_TIMEOUT_MS = 3 * 60_000;
export const FINAL_TIMEOUT_MS = 15 * 60_000;

/**
 * Render limits grow with the footage: the brief's 3 and 15 minutes hold footage up to 10 minutes long. Phase 7: a
 * final's limit also grows with its quality label (renders.quality): 4K x3, HEVC x2 (x265 is the slow encoder).
 */
export function renderTimeoutMs(kind: "preview" | "final", sourceSeconds: number, quality?: string | null): number {
  const s = Math.max(0, Number(sourceSeconds) || 0);
  if (kind === "preview") return Math.max(PREVIEW_TIMEOUT_MS, Math.round(s * 300));
  const k = (/4K/i.test(quality || "") ? 3 : 1) * (/HEVC/i.test(quality || "") ? 2 : 1);
  return Math.max(FINAL_TIMEOUT_MS * k, Math.round(s * 1500 * k));
}

/** Phase 7: a final's quality label, e.g. "1080p", "4K HEVC", "1080p HEVC HDR" (HDR kept is always HEVC). */
export function qualityLabel(o: { resolution?: string | null; codec?: string | null; hdr?: boolean }): string {
  const res = o.resolution === "4k" ? "4K" : o.resolution === "720p" ? "720p" : "1080p";
  return [res, o.hdr || o.codec === "hevc" ? "HEVC" : null, o.hdr ? "HDR" : null].filter(Boolean).join(" ");
}
/** Preview copy and analysis limits: 10 minutes, or more for footage longer than about 17 minutes. */
export function processTimeoutMs(sourceSeconds: number): number {
  return Math.max(10 * 60_000, Math.round(Math.max(0, Number(sourceSeconds) || 0) * 600));
}

// Plans on the Billing page. Payments are not switched on (Stripe is stubbed): a plan is a label plus its storage figure.
export const PLANS = [
  { name: "Free", price: "$0", note: "3 renders a month, 720p", storageGB: 10 },
  { name: "Pro", price: "$29", note: "Unlimited renders, 1080p, 100 GB", storageGB: 100 },
  { name: "Studio", price: "$79", note: "4K, 1 TB, team seats", storageGB: 1000 },
] as const;

export const DAY_MS = 86_400_000;
export const PREVIEW_RETENTION_DAYS = 30;
export const TEMP_ORIGINAL_HOURS = 24;

// Storage key prefixes. One private bucket, one prefix per kind, retention enforced by the daily cleanup job.
export const PREFIX = {
  proxies: "proxies/",
  audio: "audio/",
  frames: "frames/",
  tempRaw: "temp-raw/",
  finals: "finals/",
  previews: "previews/",
  comments: "comments/",
  graphics: "graphics/",
  references: "references/",
  brand: "brand/",
  assets: "assets/",
  samples: "samples/",
  luts: "luts/",
  fonts: "fonts/",
  tests: "tests/", // test_graphic clips and frames, swept after a day
} as const;

export const FILLER_WORDS = ["um", "uh", "like", "basically", "honestly"] as const;
// Drawn-out spellings the transcriber writes for the same sounds: umm, uhh, erm, hmm.
export const FILLER_SOUNDS = /^(u+m+|u+h+|e+r+m*|h+m+)$/;
export const FILLER_PHRASES = [["you", "know"]] as const;

export const MCP_RATE_LIMIT_PER_MIN = 120;
export const REVIEW_SIGNED_URL_SECONDS = 600;
