// Names the UI shows. These strings are part of the contract with ui/rendrr-ui.html: do not reword them.
export const PROC_STEPS = ["Transcribing", "Finding silences", "Finding scene cuts"] as const;
export const DRIVE_STEPS = ["Linking", "Making preview", ...PROC_STEPS] as const;
export const LOCAL_STEPS = ["Making preview in your browser", "Uploading preview", ...PROC_STEPS] as const;

export const PREVIEW_STEPS = ["Reading timeline", "Cutting clips", "Burning captions", "Packing preview"] as const;
export const FINAL_RENDER_STEPS = ["Reading timeline", "Cutting clips", "Adding zooms", "Mixing music", "Burning captions", "Encoding 1080p", "Cleaning up raw file"] as const;
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
} as const;
export const PREVIEW_TIMEOUT_MS = 3 * 60_000;
export const FINAL_TIMEOUT_MS = 15 * 60_000;

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
  graphics: "graphics/",
  references: "references/",
  brand: "brand/",
  assets: "assets/",
  samples: "samples/",
} as const;

export const FILLER_WORDS = ["um", "uh", "like", "basically", "honestly"] as const;
export const FILLER_PHRASES = [["you", "know"]] as const;

export const MCP_RATE_LIMIT_PER_MIN = 120;
export const REVIEW_SIGNED_URL_SECONDS = 600;
