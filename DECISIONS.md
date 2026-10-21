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

## Later decisions (made while building)

### Hosting
- **The web app runs on Railway (`web` service) for now.** The Vercel connector in this session may read projects but is not allowed to create one (403). Moving to Vercel later: create a project with root directory `apps/web`, set `NEXT_PUBLIC_API_URL` and `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, add the Vercel URL to the API's `WEB_ORIGINS` and `PUBLIC_WEB_URL`.
- **Railway deploys from GitHub** (Dockerfile per service: `apps/{api,worker,mcp,web}/Dockerfile`, build context = repo root). The Railway GitHub app needs access to the `rendrr` repo.
- The API runs database migrations and the seed on every start (both idempotent).
- Servers listen on IPv6 (`::`) for Railway's private network and fall back to IPv4 where IPv6 is missing.

### Login
- **Email + password login is checked by the API** (Clerk Backend API `verifyPassword`), then the browser signs in with a one-time Clerk **sign-in ticket**. This keeps the UI's own login form and avoids Clerk's extra "new device" email code for password logins. Login is rate limited (10/min per IP). Sign up creates the Clerk user server side (no email code); `SIGNUP_ALLOWLIST` can restrict who may sign up.
- Google login uses Clerk's OAuth redirect (`/sso-callback`). Password reset uses Clerk's email code (the reset card gained a code + new password step).
- A Rendrr user row (and a first folder "My edits") is created the first time a Clerk user calls the API, from the web app or from an AI.

### AI connector (MCP)
- One URL for everyone: `https://mcp-production-7fa0.up.railway.app/mcp`. Clerk is the OAuth authorization server (dynamic client registration and CIMD on, PKCE required); the MCP server only verifies Clerk OAuth access tokens and serves the protected-resource metadata.
- **Stateless Streamable HTTP**: a fresh MCP server object per request. Survives restarts and needs no sticky sessions.
- **Which AI is calling**: the `clientInfo.name` from `initialize` (cached per user + OAuth client), else the Clerk OAuth application name, else the User-Agent. Names containing "openai/chatgpt/gpt" count as ChatGPT; everything else counts as Claude in the database's `createdBy` (the activity feed shows the real client name).
- Tool results are short text plus at most 5 images (frames are fetched by the MCP server and sent as base64 so the AI can see them). Transcripts are sentence level unless `detail: "words"`; responses are capped at about 6k tokens with paging by `from`/`to`.
- Long tools (`render_preview` 60 s, `render_final` 180 s, `create_graphic` 90 s) send MCP progress notifications every 5 s so clients do not time out, then fall back to `get_render`.
- **Logging**: every tool call is logged as a `usage_events` row (`kind = mcp_tool`, tool, AI name, duration, ok/error). Every write also creates an `ai_actions` row through `applyTimelineChange` (read-only calls are not put in `ai_actions`, which feeds the undoable activity list).
- Rate limit: 120 tool calls per minute per user (in memory, one MCP instance).
- Turning an AI off on the Connect page marks it revoked; its tool calls are refused until "Test connection" turns it back on.
- Extra tool beyond the brief: none. Music tracks and sound effects are listed by `list_graphics` so the AI can pick them.

### Media and graphics
- B-roll in finals uses the b-roll footage's 720p preview copy (fetching every b-roll original from Drive would make finals slow and fragile).
- Graphics (templates and custom) are recorded in headless Chromium with a virtual clock: CSS animations are seeked to each frame, `requestAnimationFrame`/`Date.now`/`performance.now` follow the recording clock, and `window.renderFrame(t)` is called if the code defines it. No network (all requests except `data:` are blocked and DNS is mapped to nowhere), 256 MB JS heap, one renderer process, 60 s kill switch. Large, long graphics are captured at 12–20 fps and played back at 30 fps to stay inside the limit. Templates are drawn at up to 720p and scaled to the output size.
- Template renders are cached in storage by a hash of everything that changes the picture.
- `get_preview_frames` takes frames at exact output times through a small `frames` queue on the worker (the API has no FFmpeg).
- Built-in sample footage is processed by the worker like Drive footage but shows the local steps in the UI, and keeps its original in storage so finals work without asking for a file.
- The fake Drive (no Google keys) lists the UI's demo folders, backed by the built-in samples.

### Storage
- One private bucket with prefixes (`proxies/`, `audio/`, `frames/`, `previews/`, `finals/`, `temp-raw/`, `graphics/`, `brand/`, `assets/`, `samples/`). Retention is enforced by the worker's daily cleanup at 03:15 UTC (Railway Buckets have no lifecycle rules), plus deleting the temp original right after a successful final.
- The API sets the bucket's CORS rule at startup so browsers can upload preview copies and originals straight to storage.
- Brand photos and logos are uploaded as data URLs by the UI, stored in the bucket and served by signed URLs.
