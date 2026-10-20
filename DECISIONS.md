# Decisions

Choices made while building, so nobody has to guess later. Newest at the bottom of each section.

## Answers to the Phase 0 questions (owner said "go with your picks")

| Question | Decision |
|---|---|
| Stack | As briefed, except: **file storage on Railway Buckets** (S3 compatible, private, signed URLs) instead of Cloudflare R2 for now. Moving to R2 = change the `S3_*` env vars, no code. **Graphics templates use the same locked Chromium recorder** as custom graphics, not Remotion (one engine, no Remotion company licence). |
| Region | US East everywhere (Railway `us-east`, bucket `iad`, Vercel `iad1`). |
| Login | **Clerk**. Dev instance `mature-joey-7879`. |
| Drive picker | Keep the UI's own Drive browser (needs `drive.readonly`, fine for the owner + up to 100 test users). Switch to Google Picker + `drive.file` before a public launch to avoid Google's restricted-scope audit. |
| Connector URL text | One URL for everyone, OAuth login. The Connect page sentence about a private URL is replaced. |
| Preview quality | 540p (UI text updated from "720p"). |
| AI edits while the editor is open | The editor listens for changes and pulls AI edits in live. |
| Undo on an AI action | Restores the timeline from just before that action as a new version. Later edits roll back too but stay in version history. |
| Versions vs autosave | Human autosaves in one sitting merge into one version (new version after 10 idle minutes, or after a render, share or AI change). Every AI change is its own version. |
| First pass without AI | Creating an edit in the app applies the style's rules straight away. |
| Plan while Stripe is stubbed | Studio, 100 GB, no render limits. |
| Domain | Links are built from the address the app runs on; `rendrr.live` can be pointed later. |

## Architecture

- **Monorepo**: pnpm workspaces + Turborepo. `apps/web` (Next.js), `apps/api` (Fastify), `apps/mcp` (MCP server), `apps/worker` (BullMQ jobs), `packages/shared` (zod schemas, timeline ops, render plan; no Node-only code), `packages/db` (Prisma), `packages/core` (server-side services shared by api and worker).
- **TypeScript runs through `tsx`** in the servers and worker (no build step for workspace packages). Next.js transpiles `@rendrr/shared` itself.
- **ORM**: Prisma 6. **Validation**: zod 3. **Tests**: vitest + plain integration scripts.
- **The MCP server talks to the API server over HTTP** (`/internal/tools/*`, shared secret, private Railway network). Only the API writes to the database for edits, and every timeline write goes through `applyTimelineChange()` in `packages/core`.
- **Ids**: built-in styles keep the UI's ids `s1`..`s17` (the UI defaults to `s2`). Graphic templates are `gt_*`, music `m_*`, sound effects `sfx_*`. Everything else uses cuid.

## Timeline and editing

- All timeline times are **seconds in the original footage** (that is how the UI's editor already works: the ruler is source time and playback skips cut words). Rendering keeps V1 clips minus cut words and maps every other track onto the output.
- Music (A2) and graphics keep their place in the edit: both ends move with cuts, and the music plays continuously in between (it is not chopped at every cut).
- A1 gaps mute the dialogue for that range.
- `cut_silences` removes pauses between words longer than the threshold (from word timings, padded by 0.08 s so breaths sound natural) plus long silences with no words at all (from FFmpeg `silencedetect -35dB 0.4s`). It splits V1 and A1 clips; it does not touch the cut word list.
- `apply_style` starts from the clean paragraph cut, removes what an earlier style added automatically (clips marked `auto`), and keeps everything placed by hand.
- Zoom clips have `mode: "punch"` (quick 0.12 s ramp, hold, ramp out) or `"push"` (slow ramp over the clip).
- Captions are timed by the server from transcript words. If an edited caption line has the same number of words as the transcript line, each word keeps its own timing; otherwise the new words are spread over the words still in the video. Bold and outline looks drop trailing commas and full stops.
- A caption line shows only if its V3 caption clip still exists (deleting the clip hides that line), or if V3 has no caption clips at all.

## Media

- **Proxy**: 720p H.264 ~2 Mbps, keyframe every 0.5 s (`-g 15`), constant 30 fps, SDR `yuv420p` BT.709, AAC 128k. Plus a separate 16 kHz mono AAC audio file for transcription.
- **Preview render**: 540p (short side), x264 `ultrafast` CRF 28, from the proxy.
- **Final render**: 1080p (short side), x264 `veryfast` CRF 20, AAC 192k, from the original.
- **One FFmpeg pass per render** (trim + concat, fit, zoom, overlays, captions, mix, encode). The progress steps the UI shows are mapped onto that one pass by percentage. This is much faster than one pass per step and loses no quality between steps.
- **Transcription**: AssemblyAI, `speech_models: ["universal-2"]` (the old `speech_model` parameter is deprecated), `disfluencies: true` so "um" and "uh" are kept. Behind an interface (`Transcriber`) so Deepgram can be added.
- **Built-in media** (sample footage, 8 music beds, 3 sound effects) are synthesised with FFmpeg by `apps/worker/assets/make-assets.sh`: royalty free by construction. The sample footage uses FFmpeg's built-in `flite` voice reading the UI's demo script. The worker uploads them to storage on first start.

## Queues (BullMQ on Redis)

| Queue | Hard timeout | Attempts |
|---|---|---|
| `proxy` | 10 min | 2 |
| `analyze` | 10 min | 2 |
| `render` (preview) | 3 min | 1 |
| `render` (final) | 15 min | 1 |
| `graphic` | 2 min | 3 |
| `maintenance` (daily cleanup) | 10 min | 1 |

## Clerk

- DCR, CIMD and default scopes (`openid profile email`) were enabled through Clerk's Backend API (`PATCH /v1/instance/oauth_application_settings`).
