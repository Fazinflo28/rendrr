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
- Long tools (`render_preview` 60 s, `render_final` 180 s, `create_graphic` 90 s) send MCP progress notifications every 5 s so clients do not time out, then fall back to `get_render`. (26 October: they now answer within 8 s; see below.)
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
- ~~The fake Drive (no Google keys) lists the UI's demo folders, backed by the built-in samples.~~ Removed on 23 October (see "No dummy data").

### Storage
- One private bucket with prefixes (`proxies/`, `audio/`, `frames/`, `previews/`, `finals/`, `temp-raw/`, `graphics/`, `brand/`, `assets/`, `samples/`). Retention is enforced by the worker's daily cleanup at 03:15 UTC (Railway Buckets have no lifecycle rules), plus deleting the temp original right after a successful final.
- The API sets the bucket's CORS rule at startup so browsers can upload preview copies and originals straight to storage.
- Brand photos and logos are uploaded as data URLs by the UI, stored in the bucket and served by signed URLs.

### Hardening after the overnight review
- **Region**: the Railway workspace default put every service and both databases in Singapore. All were moved to **US East** (`us-east4-eqdc4a`) next to the bucket (`iad`) before any data existed.
- **Music and sound effects come only from the built-in catalog.** A clip names a `trackId` (A2) or `sfxId` (A3); the storage key is always looked up from the catalog, in the timeline normaliser, in the render plan and again in the worker. A key sent by a client or an AI is never used.
- **Frame-exact cuts**: every kept part starts and ends on a frame of the 30 fps output, and the source is put on that grid before cutting. Picture and sound of each part are then exactly as long as the plan says, so nothing drifts at cuts.
- **Time limits grow with the footage**: the brief's 3 min (preview) and 15 min (final) cover footage up to 10 minutes; longer footage gets 0.3 s (preview) and 1.5 s (final) per second of footage. Preview copies and analysis: 10 minutes or 0.6 s per second of footage. The limit always wins, even over a stalled download.
- **Rate limits** key on Railway's `X-Real-IP` (the edge sets it); `X-Forwarded-For` is not trusted. The MCP server is keyed per user only when its shared secret is valid. Review passwords: 10 guesses a minute.
- **Live updates** (editor and render progress) share one Redis subscriber connection per API process.
- **Google Drive connect** finishes with the user's own login: the callback page hands the code to the tab that opened it (or to `/drive-done`), which calls `POST /drive/complete`; the signed state must name the same account.
- **Email change** is confirmed with Clerk's emailed code in the browser; the API only copies an address Clerk reports as verified and primary.
- **Review links** stop working when their edit is deleted, can be revoked (`DELETE /reviews/:token`), and the public payload carries no internal ids.
- **Review states survive renders**: "In review", "Changes requested" and "Approved" are kept while rendering; a finished final still moves the edit to "Final ready".

### New UI (V2, `ui/rendrr-ui-v2.html`)
- **Merged, not rewritten.** The V2 design was merged into the existing Next.js port with a three-way merge (old design → V2 design, applied on top of the wired-up port), so every earlier fix (real footage, autosave conflicts, live AI reloads, honest stubs) stays.
- **Browse without an account.** `/`, `/explore`, `/create/:category` and `/styles` work signed out: `GET /styles`, `/styles/filters`, `/styles/:id` and `/gallery` answer without a login, and a valid login adds the user's own styles and likes. Everything that changes something (like, recreate, add footage, use a style) opens the login modal first, then carries on.
- **Categories** are a fixed list in the web client (each groups a few style types, exactly as the design).
- ~~**Example videos**~~ (removed on 23 October, see "No dummy data"): the gallery started with two examples per built-in style, posted by a "Rendrr" system user (`clerkId = system:rendrr`), with zero likes and views. No invented people or numbers.
- **Editor notes** are their own table (`ProjectComment`), separate from client review comments; the editor shows both in video order. The AI tools `get_comments` and `resolve_comment` cover both.
- ~~**Editor AI chat**~~ (removed on 23 October): it ran Claude on the API (Anthropic SDK tool runner). Rendrr's rule is no AI inside: Claude does the thinking through the connector, Rendrr measures, applies exact instructions and renders. The AI tab is now read only and shows the connector's changes and notes.
- **Connector edits in the AI tab**: each `apply_edits` call leaves one message (the AI's note, or "Made N changes", with the steps); older single-step changes and undos are grouped per sitting ("Made 3 changes through the Claude connector").
- **Billing** stays a stub: `GET /billing` shows the plan (Free / Pro / Studio from the design), no card and no invoices; `POST /billing/plan` switches the plan label and its storage figure. No limits are enforced.
- **Save to Google Drive** (final popup) uploads the final into the user's Drive with the `drive.file` scope (Rendrr only sees files it created). It needs the Google keys and a real Drive connection; until then it says so.

### Every video as text and frames (23 October)
- **Rendrr does the seeing, the AI does the thinking.** Every video (footage or a reference, from Drive, a computer or the sample) is broken down once, right after its transcript, into a **breakdown**: shots (from the scene cuts) with start/end, light, colour, motion, loudness and what is said; pacing (cuts and words per minute, speech and silence share, fillers); the hook (first 3 s); loudness per second; the music beat. It is stored as JSON (`FootageAnalysis.breakdown`) and read as compact text (`breakdownAsText`, "video code").
- **Contact sheets, not loose frames.** Frames are taken every 0.5, 1, 2, 3 or 5 s (the smallest spacing that keeps a video under 64 frames, 5 s for long ones, at most 400) plus the middle of every shot, so even a 0.3 s shot is seen once. They are tiled 4×4 with the time printed on each tile: one image shows the AI 16 moments. A 40 s clip is 3 sheets.
- **Measured with what the worker already has**: OpenCV and NumPy (`apps/worker/python/breakdown.py`), no new services and no models to download. Motion is how much the picture changes over 0.2 s; the beat comes from spectral-flux autocorrelation and only counts at confidence 0.5 or more (music tracks score 0.85 to 0.9, speech about 0.1). No face detection or text reading: OpenCV 5 ships no face models, and the AI reads faces and on-screen text from the sheets itself.
- **Exact moments on request**: `get_frames` takes up to 8 frames at given times from the preview copy (the worker's frames queue), cached next to the video's other frames.
- **References are videos** with `kind = "reference"`: added the same three ways (a switch in the Add dialog), read the same way, listed by `list_references`, read by `get_reference` with a note to match rhythm and look, not content. Any video can be switched between footage and reference (`PATCH /videos/:id`).
- **Never blocks editing**: if the breakdown fails the footage still becomes ready; the worker retries videos without a breakdown on its next start (which also filled in every video added before this existed).
- **Videos added from a computer** now get their five key frames and thumbnail in the same step (before, their preview was made in the browser and they had none).
- **Storage**: sheets and frames live under `frames/<user>/<video>/` and count toward the preview copy; they are deleted with the video and when the preview copy expires (the breakdown text and transcript stay; rebuilding the preview makes new sheets).
- **The editor's AI chat now sees images**: tool results carry the sheets and frames to Claude as images (before, the chat got text only).

### No dummy data (23 October)
- **Explore** shows only videos people publish. The seed no longer posts example videos and removes the old ones (and the "Rendrr" system user) on every start.
- **No fake Google Drive.** Without the Google keys, `POST /drive/connect` answers "Google Drive is not set up on Rendrr yet" and the Drive tab says so, with a button to use the computer instead; the Add dialog opens on "From your computer". Old fake Drive connections are deleted.
- **No sample footage in the app.** The "Add sample footage" buttons are gone. `POST /videos/sample` stays for the automated test, which deletes everything it made at the end.
- **Clean-up at start** (`apps/api/src/services/cleanup.ts`): videos from the fake Drive and sample videos are deleted with their files, unless an edit still uses them (so no edit breaks).

### Connector token audit fixes (23 October)
- **One call per edit.** `apply_edits` takes a list of the same ops the editor uses and applies them as a `batch` op: one version, one undo, all or nothing (the first bad edit stops it and is named). 17 single-step tools left the connector.
- **Schemas in words.** The edit list and style rules are described in the tool description (one line of fields) instead of full JSON schemas; the API checks every edit against `EditOpSchema` and the rules against `StyleRulesPatchSchema` and names the first problem. This took the tool list from ≈6,150 to ≈3,500 tokens.
- **One overview image.** The worker writes `sheet-overview.jpg` (16 frames spread over the whole video) next to the contact sheets; `get_footage` sends only that by default. Older breakdowns were rebuilt by the worker at start; one read before that shows sheet 1 and queues the rebuild.
- **Text check after a render.** `editCheck` (shared/qa.ts) measures the edit itself: pauses over 0.4 s and fillers still heard, caption coverage, zoom/b-roll/graphic times, music cover, cuts and pieces under 0.5 s, plus the file's integrated loudness and true peak (EBU R128, measured by the worker after each render). Fixed thresholds, no judgement.
- **Saved styles.** `save_style` stores rules (on top of a base style) with `sourceVideoId` when they come from a reference; `get_footage` on that reference then answers in one line. `apply_style` accepts overrides, including a new zoom mode `count` (exactly N zooms on sentence starts spread over the edit).
- **Several logins per account.** `UserLogin` maps extra Clerk users to an account; `ensureUser` checks it after `User.clerkId`. Linking is explicit (a 6-letter code from Connect AI, 15 minutes, once, kept in Redis), never by email: two Clerk users cannot share a verified email, and matching a stored email that changed would hand one person's account to another. An account that has anything in it is never removed by linking.
- **The owner's case** was fixed in the migration itself: link `user_3L5M6UOmxsqiH8rJz6fCjKrcxDN` to the owner of edit `cmvkonv8t000nrw4lufqt1x3l`, and delete that login's own account only if it has no videos, edits, styles, graphics, references, reviews, gallery items or Drive connection. In any other database it does nothing.

## Phase 1 (editor plan): model A, built for B

| Question | Decision |
|---|---|
| Sequence model | Model A for now (clips are footage ranges; V1 plays back to back). Every clip also stores its source and its place in the edit, and all timeline logic is in `sequence.ts`, so model B replaces one module. Migration steps: `docs/timeline-model.md`. |
| What the player plays | The render plan (`planRender`) itself, through `playback.ts`. When a preview of this exact version exists and nothing has changed, the player plays that file. Music and SFX are left out of the live player, and the up-to-date preview covers them (Phase 3: they play live now). |
| Linking rule | A V1 clip and the A1 clip with the same start and end are linked, unless marked `unlinked`. "Alt-click unlinks" toggles the mark. Alt-drag trims one side, which also unlinks them because their ends no longer match. |
| `cut_words` range | `from`/`to` removes exactly that footage range from V1 and A1, words or not (it used to cut the words that start inside it, plus the pause after the last one). Undo brings it back; `restore_words` only restores word cuts. |
| Clip edges in `cut_silences` | Silence over 0.3 s at a clip's start or end is trimmed to the speech, whatever `overSeconds` is (pads 0.1 s before and 0.15 s after). `edges: false` turns it off. |
| Pauses in the check | Listed from 0.15 s, not flagged: how long a pause may be is the edit's choice (cut_silences leaves 0.16 s). Flags are kept for problems and for places where the file and the edit disagree. |
| File measures | Previews: one decoding pass (blackdetect 0.15 s, silencedetect -45 dB 0.15 s, EBU R128). Finals: audio pass only, so a final takes no longer than before. A measurement that fails or times out is named in the check. |
| Footage filmed sideways | One rotation for the edit's footage (`timeline.rotate`, clockwise), applied before the fit (FFmpeg `transpose`). The live player rotates the video element the same way. In model B this becomes a per-clip transform. It was added when the reference-video test footage turned out to be sideways (no rotation flag in the file). |
| Position and scale | One static framing for the edit's footage (`timeline.framing`: scale about the centre, then x/y offsets as a share of the frame), applied after the fit and before zooms. The player applies the same transform. It becomes a per-clip, keyframable transform in Phase 2/5. |
| Duplicate accounts | Merged at API start-up, every time (safe to repeat). Only an account with nothing in it is removed. A folder other than the first "My edits" counts as something. Two accounts that both hold data are left alone and logged. |

## Phase 2: the sequence (model B)

| Question | Decision |
|---|---|
| Where clips sit | V1 is an ordered list played back to back (magnetic, like Final Cut's primary storyline), so ripple is built in. Every other clip hangs on a V1 clip at a moment of its footage and keeps its length (Final Cut's connected clips). |
| J/L cuts | One offset per cut between two clips (`audioStart` on the clip after it): a rolling edit on the dialogue only, so two clips' sounds never play over each other. Limited by the neighbouring pictures and the footage there is. |
| Ops' times | Unchanged input. Times are main-footage seconds, where that footage first plays. V1 clip ops take that clip's own footage seconds. `edit: true` takes edit seconds. |
| A clip's V1 clip is deleted | Clips that hung on it are put back by their footage (model A's rule): they leave if their footage no longer plays, and get shorter if it partly plays. Sound effects keep their length. |
| `set_link` | Kept so old callers do not fail. It changes nothing (dialogue always follows its picture) and says so. |
| `apply_style` | Rebuilds a plain cut of the footage from paragraphs, as before. A rearranged or multi-video sequence keeps its clips and only gets the cuts, zooms, music and captions. |
| Migration | Converted at API start-up only when both planners give the same plan within one frame. The old planner is kept unchanged (`renderPlanA.ts`), so old versions and unconverted projects render exactly as before. Old timelines are backed up in `TimelineBackup`. |
| Finals with other videos | Main footage as before. Other videos use their original when Rendrr keeps one (samples), else their 720p preview copy, and the plan says so. Phase 7 can fetch Drive originals. |
| Player | Wall clock plus one element per video, re-synced on cuts and drifts over 0.15 s. The clock waits up to 1.5 s for the picture to load. The up-to-date rendered preview still plays the exact file. |
| Keys | Premiere's: V, C, B, N, Y, U for the tools, S for snapping, Shift Z for fit, Cmd/Ctrl K to split. |

## Phase 3: sound

| Question | Decision |
|---|---|
| Ducking | A fixed envelope from the spoken words (0.2 s down, 0.5 s up, speech under 1 s apart joined), not a sidechain compressor. It is exact, the same curve is an FFmpeg `volume` expression and a function the player evaluates (tested equal), and the depth is a number the AI sets. A video without a transcript counts as speech wherever it is heard. |
| Loudness | Two passes: measure the mix (audio-only graph through ebur128), then render with that gain. One-pass `loudnorm` was not used: its dynamic mode changes the level over time, and its linear mode needs the measurement anyway. |
| True peak | `alimiter` at 192 kHz (4× oversampling), auto-level off, ceiling 1 dB under the target. Measured: the limiter's output is exact, but the 96k AAC preview adds up to 0.8 dB on sharp clicks. |
| Gain limit | −30 to +24 dB. A near-silent mix gets no gain. The check reports the file's real loudness, so a capped boost is visible and never silent. |
| Cleanup | Four fixed chains of FFmpeg's own filters (highpass, afftdn, agate, equalizer, deesser, acompressor). No models and no AI: rule 1. |
| Defaults | −14 LUFS / −1 dBTP (the online norm), ducking 12 dB, no cleanup. New renders of every sequence get them. A sequence with loudness off keeps the old limiter (`alimiter=limit=0.95`) and renders as before. Model A plans and their check are unchanged. |
| Live player | `element.volume` per element at the plan's level for that moment. Boosts above 0 dB are played by lowering everything else by the largest boost, so the balance is exact. No WebAudio: the preview copies come from the bucket without CORS, so cleanup and loudness are only in the rendered preview, and the editor says so. |
| Fade at cuts | 20 ms at every dialogue cut, always (the plan: 15-30 ms), set by `declick` (0 turns it off). The live player switches elements at cuts without it; the difference is a click, not a level. |
| Manual cleanup | Each preset is a set of numbers (`CLEANUP_PRESETS`), and the chain is built from them, so hand-set values and presets go through one path. Five values can be set by hand; the rest (noise floor, compressor timing) follow the preset. |
| Noise left | The median momentary loudness (EBU, 400 ms) of the windows wholly inside pauses between words, from the file. Reported, not flagged: what counts as too noisy depends on the room and the music. |
| Music files in the editor | Signed URLs of the catalog keys the edit uses (`audioMedia`), looked up from the catalog, never from the clip. |

## Phase 4: captions and text

| Question | Decision |
|---|---|
| How the editor matches the render | One layout in shared code (`captions.ts`) decides lines, sizes and positions in output pixels. libass and the editor draw it. libass in the browser (JASSUB) would match pixel for pixel, but it carries LGPL and GPL parts, and the plan allows MIT and Apache code only. |
| Line breaks | Made by us, never by libass (WrapStyle 2): words a line first, then by width with the fonts' real advance widths (`fontMetrics.ts`, generated from the files). A caption that needs more lines than allowed becomes two captions when each still stays 0.3 s on screen. |
| Fonts | 14 OFL families from Google Fonts, static weights, in `apps/web/public/fonts`. Each file is renamed to "RC <Family> <weight>", one face per family, so libass (fontsdir) and the browser (@font-face) pick exactly that file. The worker image copies the same folder. |
| Font size | ASS size = line height (libass scales so winAscent + winDescent = size). The editor uses font-size = size x unitsPerEm / (winAscent + winDescent), with ascent-override and descent-override set to the win metrics, so baselines match. Measured: within 2 px. |
| Box | libass BorderStyle 3: a square box per line, the box padding is the outline width. So a box has no stroke and no rounded corners, in the render and the editor alike. |
| The spoken word | One ASS event per word with that word's colour changed (`\1c`), so it is exact to the centisecond; the editor colours the word whose start has come. |
| Text layer animations | Linear, from ASS tags: fade (`\fad`), pop (`\fscx80` to 100 over 150 ms, `\fad(100,…)`), slide (`\move` from 4% lower over 250 ms). The editor evaluates the same curves (`textAnimAt`). |
| The three looks | Presets of the caption style with their old sizes, colours and boxes. Only line breaking changed: by words and width instead of libass's own wrapping. |

## Phase 5: transitions, keyframes, speed

| Question | Decision |
|---|---|
| Keyframes in the render | FFmpeg's `perspective` filter with `sense=destination`, evaluated per frame: the four corners go where position, scale and rotation put them, at output size, transparent around. Its cost does not grow with the zoom. A picture that only gets small is scaled down first with a real scaler, so it does not alias. Opacity: a 2x2 grey curve (`geq` on T), stretched and multiplied into the alpha. |
| Easing | The CSS curves (ease in, out, in-out) and any cubic bezier, turned into 16 straight pieces per segment. The render and the player use the same table, so they agree exactly. |
| Speed frames | Output frame n of a part shows source frame floor(rate x n), with the timestamps placed explicitly (`settb`, `setpts=ceil(N/rate)`), not left to FFmpeg's rounding, which differs by path. The player seeks inside that frame. |
| Sound at other speeds | `atempo` keeps the pitch. A ramp is one `atempo` whose tempo changes at each step (`asendcmd`), so steps do not click. Sound plays between 0.5x and 4x, because browsers mute it outside that and cannot play it backwards. Outside that range, reversed and frozen, the clip is silent in the render too. |
| Reverse | In 1 s chunks, each read from its own input (`-ss`) and fitted before `reverse`, so memory stays at about one second of frames at output size. |
| Transitions | Centred on the cut; the edit's length does not change. Dissolve, slide and whip use footage past the cut (handles), as Premiere does; they get shorter when a side has less, and the check says so. Dips and zoom need no handles. A dip or dissolve on the first clip fades in from the colour. Two transitions on one clip get at most half of it each. |
| Whip | Both sides slide together with a smoothstep, blurred along the move: `gblur` set per frame with `sendcmd` in the render, an SVG `feGaussianBlur` with the same sigma in the player. |
| V1 keyframe times | Stored at footage seconds (like `anchorAt`), so cut words or a split before a key do not move it relative to the picture. The ops take seconds from the clip's start, and get_project shows those. |
| Timing found by the new browser test | The joined picture's timestamps were in microseconds when parts were drawn one by one, so every overlay showed a frame late. It is now put back on the 1/30 s grid. Overlays start and end on whole frames, and the player reads curves at the frame's start. |

## Phase 6: colour and compositing

| Question | Decision |
|---|---|
| How a grade is applied | One 33-point 3D LUT built by shared code from all the controls. It covers white balance and exposure in linear light (gamma 2.4), contrast around 0.5 (like CSS `contrast()`), saturation with Rec. 709 luma, monotone cubic curves and the imported LUT (first or last, by amount). FFmpeg reads it as a .cube file with `lut3d` (trilinear). The player uploads the same numbers as a 3D texture. One table on both sides means they cannot drift apart. |
| Precision in the render | The look runs in 16-bit RGB after the key (8-bit `lut3d` truncates its output, half a level darker). Every RGB conversion has `flags=accurate_rnd`: without it, FFmpeg 7.1's round trip to RGB loses about a level of luma (FFmpeg 6.1 does not). |
| Key | FFmpeg's `colorkey` (RGB distance, similarity, blend) and `despill` (mix 0.5, the key colour's channel lowered by `spill`), keyed on the fitted original colours. The player's shader repeats the formulas, read from FFmpeg 7.1's source. |
| Masks and areas | One greyscale picture drawn by shared code (a signed distance to the edge, feathered across it), a PGM for FFmpeg and a texture for the player. Shapes are in shares of the frame, feather in shares of the short side, so preview and final match. |
| Blur and pixelate | `gblur` with 4 steps and a Gaussian shader with the same sigma. `pixelize` (average) and a two-pass block average on the same grid. Sizes are shares of the short side. |
| Player | A WebGL2 canvas the size of the plan, fed by the hidden `<video>`. The bucket's CORS (already set for uploads) lets it read the frames. A video with a look on any part is drawn through the canvas all along, so the picture never switches renderer mid-play. |
| Shot matching | No AI. The worker reads 4 small frames of each clip from its preview copy, as the editor shows them. Each channel's 2nd, 50th and 98th percentiles of the target are mapped onto the reference's (as graded) by three-point curves, then saturation matches the mean colourfulness. The op carries the measured pixels, so it stays pure, and the editor's Match button does the same. |
| B-roll behind V1 | `under: true` on a b-roll clip. The render lays it in the base each V1 part is drawn over (keyed, masked, framed or keyframed parts), so a green-screen speaker can have any background from the library. |
| HDR | A final keeps HDR footage HDR: HEVC Main 10, BT.2020, its PQ or HLG transfer and the tags. SDR content (other clips, b-roll, graphics, caption colours) goes in at SDR white (203 nits, BT.2408) through one LUT. A graded or keyed HDR clip is graded on its SDR tone-map, because grades are made on what the editor shows (SDR), and the check says so. `set_export {hdr: "sdr"}` converts the whole edit. Previews stay SDR. |
| Alpha at 10 bits | `alphamerge` is 8-bit only in FFmpeg 7.1. A 10-bit alpha is built with `mergeplanes`, and a `lutyuv` puts the TV-range conversion back to full range. Keyframed clips in an HDR final drop to 8 bits in `perspective`, which is 8-bit only (noted as a limit). |

## Phase 7: graphics and export

| Question | Decision |
|---|---|
| Frame rate of a final | The main footage's own rate, snapped to the nearest standard one within 0.5% (a phone's 29.92 is 29.97) and capped at 60. The sequence is aligned to that rate, so each part is a whole number of output frames and the sound (cut at the same aligned times) cannot drift, however many cuts. Previews stay 30 fps from the 30 fps preview copy the editor plays. A final's cuts can land up to half a frame from the preview's. |
| Previews unchanged | At 30 fps every filter string is byte for byte what it was. This was checked by hashing the arguments and graphs of the live smoke edit in every shape, before and after the change. |
| Export settings | `timeline.export` holds `resolution` (720p, 1080p, 4K short sides 720/1080/2160) and `codec` (H.264 or HEVC), set by `set_export` like HDR. Shape stays `set_aspect`. HEVC uses libx265 with the `hvc1` tag so Apple devices play it, and one preset faster at 4K. |
| Time limits | A final's limit is x3 at 4K and x2 for HEVC. The render row's `quality` label ("4K HEVC") carries it, so the queue guard, the stuck-render sweep and the app all use the same number. The app now waits for the server's limit instead of a fixed 17 minutes. |
| Time left | The worker publishes `etaSec`. Before encoding, it comes from this user's last renders of the same kind and quality (median seconds of work per second of output). During the encode, it comes from the encode's own speed, plus packing. It is null ("Estimating") when neither exists: never invented. |
| Long graphics | Over 15 s a graphic is sampled every 0.5 s by a scout page. Unchanged: held. Under 0.2% of pixels changed: shown from the sample (a progress bar's edge moves under a pixel per sample). More: a second page that only moves forward records that half second frame by frame. So JS graphics never see time go back. The page drawn from is brought to the front, because Chromium stops drawing a background page. The WebM has a variable frame rate. The limit is 60 s + 0.5 s per second. A graphic that changes nearly every frame for minutes fails with a plain message. Missed: something that comes and goes within half a second of a still stretch. `framerate` blending was tried and dropped: it has no alpha formats. |
| A clip longer than its graphic | It holds the last frame, in the render (`tpad`) and in the player (the `<video>` holds it). Before Phase 7 the render dropped the graphic at the end of its file while the editor held it. |

## After the 8 phases (25 October)

| Question | Decision |
|---|---|
| A new edit | The footage as recorded and nothing else: no style, captions off, nothing cut (only words the user removed on the footage page). It used to apply the default style (Clean Podcast Clip) straight away. |
| References | A style, a gallery recipe or a reference video can be attached to an edit (`Project.reference`). The AI reads it in `get_project`; Rendrr never applies it. `Project.styleId` is now only the style the AI applied with `apply_style`, so only an applied style's caption rules shape the captions. |
| Cut precision | To the millisecond. The sound is cut exactly; the picture goes on the nearest frame and shows the frame its sound plays, at most half a frame off at a cut and never adding up. The alternative, moving the frame grid itself to the cuts, would have moved every overlay, caption and transition off whole frames. |
| `cut_silences` | `keep` sets the pause left next to the speech (default 0.08 s as before, 0 = tight); pauses from 1 ms can be cut. |
| Deleting a video | Footage that edits use is refused with their names; the app then offers to delete the video and those edits together. The raw file is never touched. |
| Drive picker | Laid out like Google Drive's list view. `/drive/files` lists exactly one folder (any depth; a shared drive's folders carry its `driveId`) or a view: `shared`, `recent` (videos anywhere, newest first) or `search` (names, whole Drive). Search text is escaped and folder ids cleaned before they go into the Drive query. |
| Design system | Rendrr's (Higgsfield's, mapped element by element): lime #bde816 is the only colour; bg / panel / surface darks; white washes for quiet controls; Space Grotesk 700 uppercase for titles, Inter for everything read. No red: errors in ink. Existing class names kept; tokens changed underneath. |
| Recording graphics | Ranges recorded at once by `GRAPHIC_WORKERS` browsers (the container's CPU quota minus one, at most 6, and one less than `BROWSER_SLOTS`; 4 on the live worker). `BROWSER_SLOTS` is how many browsers the whole worker runs at once, across graphics, tests, a render's graphics and snapshots: about 100 threads each with its encoder, 500 threads kept under the cgroup's pids.max for a render (5 on the live worker). A recording waits for a free slot, up to 5 s for all it asked for, then runs with what is free. Encoders decode and filter on one thread each (FFmpeg would start one per CPU of the 48-CPU host). A failed recording stops its other lanes, waits for them, and closes every browser it started. Each range's pages step their clock frame by frame from 0 without drawing, so state, timers and transitions arrive as if playing. Up to 15 s every frame is captured; longer graphics are sampled every 0.5 s on a quarter-size picture. Pieces of 240 pictures are encoded as they come (encoder clock on the 30 fps grid) and joined without re-encoding. Limit: 90 s + frames x (40 + 130 x pixels/1080x1920) ms / workers, at most 25 min. |
| Graphic time | Everything a graphic can time itself by runs on its clock: performance.now, Date.now, requestAnimationFrame, setTimeout/setInterval (in order, each at its own due time), CSS animations and transitions, element.animate(). Each animation runs from when it first appears. Chromium's threaded animation is off so a capture never shows a frame or two old. |
| Graphic fonts | 82 Google Fonts families downloaded at image build from a pinned google/fonts commit (`apps/worker/fonts.txt`), plus Inter, Noto and the caption fonts. `fonts.conf` maps Arial/Helvetica to Arimo, Times to Tinos, Georgia to Gelasio, Calibri to Carlito, Courier to Cousine, Impact to Anton. The family list the AI sees is `GRAPHIC_FONTS`, and a test checks each one draws as itself. |
| Graphic progress | Kept in Redis (`graphic:<id>:progress`, percent and time left, 1 h), not the database, so no migration races the worker's deploy. |

## Faster, steadier graphics (26 October)

| Question | Decision |
|---|---|
| Recording a long graphic | Scan first, then record. Over 15 s, every 15th frame (and the last) is drawn at quarter size and compared with the one before; a stretch that changed is recorded frame by frame, a stretch that did not keeps one picture. The frames to record are split into ranges with about the same number of pictures, one browser each, joined into one file (no re-encode, alpha kept). The 393 s 1920x1080 canvas graphic that failed live records as one graphic in about 2 min on 3 browsers. |
| Time budget | Grows with the graphic: the scan gets 60 s plus 10 ms a frame (split over the browsers); the recording gets 60 s plus 2.5x its own estimate; both stop at the 25 min cap. A watch timer ends a stuck phase even when a page hangs. |
| Fail fast | After the scan the recording time is estimated (pictures x cost per picture at that size / browsers). Over the limit, it fails within seconds and says how long it would take, the share of frames that move, and what to change. |
| `window.renderFramePure` | Opt-in. When a graphic sets it, frames that are not recorded skip `renderFrame` (the clock, timers and animations still move). Not the default: a `renderFrame` that starts animations or changes the page must run on every frame. |
| `Math.random` | Seeded, the same in every browser, so a random layout looks the same in every range of a long graphic. |
| Reusing one graphic | `create_graphic params` are default values the code reads from `window.params` (set before its own scripts; stored as the graphic's params schema, no migration). `add_graphic from` starts a placement that many seconds into the recording (custom graphics only: a template is drawn for each placement); `add_graphic params` replaces some of the values. Names the graphic did not declare and values of another type are refused, with the graphic's params named. |
| A placement with its own params | Plays its own recording: the same code with those values, recorded once per set of values (the graphic's id and the values, keys sorted, hashed) and kept at `graphics/<owner>/<graphic>-v-<hash>.webm`. Saving the edit queues it on the graphic queue (job id from the hash, so it is queued once); a render takes it from storage, waits while the queue is recording it, or records it itself and keeps it. A failed one is noted in Redis for a day (not queued again on every edit) and never marks the graphic failed. |
| `from` in the render | The graphic is put on the frame grid, then cut at the offset (`fps,trim=start_frame`). Seeking the file (`-ss`) was wrong: a still stretch is one picture, so a seek inside it showed the next picture. The player plays the file from `from` + the time into the clip. |
| The editor's graphics | Sent by clip (`graphicClipMedia`), not by graphic, so a placement with its own params shows its own recording, once it exists (as in the render). `get_project` lists the placements with no file yet and why (queued, recording %, failed). |
| Installed fonts | 82 Google Fonts families are in the worker image (Phase "after the 8 phases"), so Open Sans, Montserrat, Poppins… draw as themselves, every weight they have: 'Open Sans' 700 is its real bold (letters about 6% wider than its regular), not a regular face made bolder. |
| Your own fonts | `add_font` (connector: an https url or base64 data) or Settings › Fonts (the browser sends the file): TTF, OTF, WOFF or WOFF2 up to 2 MB, recognised by its first bytes, kept by family, weight and style (the same three again replace the file; 100 per user). A url is downloaded only from public addresses (every redirect checked; no loopback, private, link-local or Railway-internal addresses), 20 s, 2 MB. The worker adds the user's fonts that a graphic's code or params name as @font-face rules with the file inside (the page has no network), and every @font-face is loaded before the first frame. A family that is also installed is replaced by the user's file in their graphics, and add_font says so. |
| Missing fonts | The recorder notes every font a graphic asks for: canvas `ctx.font` (hooked before the graphic's scripts), and the CSS font of every element with text (as it is added, and at the end of each browser's range). A family is missing when text in "Family, serif" and "Family, monospace" measures differently (a missing one falls back to two different fonts); generic names and fonts loaded by @font-face are not checked. Missing ones are named in a warning kept on the graphic (`Graphic.warnings`) and shown by create_graphic and list_graphics; a placement's own params recording keeps its warning in Redis (30 days) for get_project. |
| Deploy order | The worker names the graphic columns it reads and writes (`select`), and saves warnings in their own update: a worker that starts before the API has added the `warnings` column records graphics as before and only loses the warning. The font table missing has the same effect (no user fonts for that moment). |
| Long tool calls | `create_graphic`, `render_preview` and `render_final` answer within 8 s (`TOOL_WAIT_MS`): the result if the job is done by then (a short graphic usually is), else its id, its progress and time left. `get_graphic` (new) and `get_render` are polled for the rest; a finished preview comes back with its check from `get_render`. Before, they held the call for 90 s, 60 s and 180 s, and clients that drop calls sooner lost the id. Progress notifications stay for clients that send a progress token. |
| Is a graphic on screen | Measured on its file at 8 moments spread over the part on screen (from `add_graphic from`, for as long as it shows; past the file's last picture, that picture held, as the render does). Each moment is the average alpha of the picture (0-100% of the frame). The check shows min / avg / max and calls a graphic invisible only when every moment is under 0.2%: a graphic that fades in, flashes or is blank at its first frame is not. The file is put on the 30 fps grid before the moments are picked (one picture per still stretch: a seek showed the next picture instead). Older checks, measured at one moment, read as before. |
| `set_framing fitFaceTo` | `{x, y, r}`: where the face goes (0-1 from the top left) and half its height as a share of the frame's. apply_edits has the worker find the face in each clip it frames (the clips named, else every clip of the main footage; 40 at most): 3 frames per clip from its preview copy, turned and fitted as the render draws them, at 360 px on the short side (YuNet's box there is closest to its size in a full frame), one YuNet run for all of them (OpenCV `FaceDetectorYN`, the model in `apps/worker/models/yunet`, MIT). The median face per clip goes into the op, which works out each clip's scale and offset with the render's framing math (a point u of the fitted picture lands at (1 - scale) / 2 + x + u * scale). A clip with no face is left as it was and named; one the limits (scale 0.25-4, offset -1 to 1) cannot reach goes as close as allowed and is named; one that no longer fills the frame is named. Rendrr measures; where the face goes is the AI's call. |
| `set_clips` framing | A V1 clip in `set_clips` can carry its own `framing` {scale, x, y} (checked like set_framing; `null` fills the frame again). Before, it was passed through unchecked. |
| New clip ids | The result of an edit names the ids of the clips it made: add_zoom, add_broll, add_text, add_music, add_graphic, add_clip and split_clip ("clip …"), set_clips ("new clips: …"), so the next edit can name them without reading the project again. |

## Rendrr is the engine (26 October, night)

| Question | Decision |
|---|---|
| Who edits | The connected AI. Rendrr measures, marks, renders and checks; it never cuts, trims or reorders on its own. Every change is an explicit edit. |
| Rendrr's marks | Worked out on read from the stored analysis (transcript, silences, scene cuts, the breakdown's loudness, beat and dark shots), not stored: the same footage gives the same marks and ids (`sil_<ms>_<last 4 of the video id>`, `fil_<wordId>_…`, `rt_`, `stb_`, `fs_`, `dir_`, `scn_`, `beat_`, `dark_`, `loud_`). New measurements (Part 2) add marks without a migration. |
| The AI's marks | Stored in the edit (`timeline.marks`, ids `mk_…`, at most 5000) with its notes on Rendrr's marks (`timeline.markEdits`: label, note, hidden). Both are part of each version, so undo takes them back. An editor save that does not send them keeps them. Times are footage seconds of a video, so a mark stays on its moment whatever the edit does; edit seconds sent with `edit: true` are turned into footage seconds (a mark across a cut to other footage is refused). |
| Silence marks | Every gap between words from 0.15 s, before the first and after the last word (to the video's end), and stretches the audio analysis calls silent with no words. level_db is -35 where the audio is quiet over the whole gap (silencedetect's threshold), null where there is some sound (a breath, a tail): Part 2 measures the real level. `mark_silences` lists from 0.3 s by default. |
| Retakes | Lines that start with the same 3 words or share most of their word pairs, within 8 lines and 120 s, grouped (takes of takes join). Each take: words, fillers, stumbles, words a minute, loudness, how alike it is, and a score (0.5 complete, 0.2 few fillers, 0.2 few stumbles, 0.1 ends a sentence). pitch_var is null until Part 2. Rendrr never picks one. |
| `cut_silences`, `remove_fillers` | Retired. They still parse (an older client gets a clear answer: use mark_silences / mark_fillers, then cut_words) but are not in the tool's op list. The safest choice: no silent auto-cut through an old path. |
| `apply_style` | Looks only (D1): its captions (on, look, full caption style; the style's word counts shape them as before). It no longer rebuilds the clips, trims, cuts pauses or fillers, or adds zooms, music or sound effects; it lists those rules in its result for the AI. Clips an older style added stay until the AI removes them. |
| Cut silences button | Removed from the editor (D2). Cutting by hand (split, delete, trim) stays. |

## Several videos in one edit (27 October)

| Question | Decision |
|---|---|
| What an edit of several videos is | The first video is the edit's footage (`Project.videoId`: its transcript, cut words, aspect and thumbnail); each other video follows it on V1 as one whole clip, back to back, in the order picked, made by the same `add_clip` op the editor and the AI use. No new storage: a V1 sequence already plays clips of any video (Phase 2), with their own captions, sound and render source. |
| Order | The order clicked in the Library, changed in the new edit window (up, down, leave out). The AI or the user reorders later with move_clip or by dragging. |
| Limits | Up to 20 videos when the edit is made (more can be added in the editor). Every one must be ready; a reference video is refused in a several-video edit (it is a style to copy). |
| Name | "<first> + N more" unless named; v1 says "N videos as recorded, back to back". |
| Deleting a part | Treated like deleting the footage: the edits that play it on V1 are named first, and go with it only when the user confirms (found with `jsonb_path_exists` on the stored V1). |
| Demo build | The design's fake backend makes an edit of one video, so the preview opens the first of them. |

## Engine Part 2: deeper measurements (27 October)

| Question | Decision |
|---|---|
| Where the measurements live | A summary per video in `FootageAnalysis` (`audio`, `alignment`, `vision`, `deepVersion`, `deepError`, `deepAt`: one migration, columns only) and the large parts in storage next to the frames: `audio.bin` (4 bytes per 10 ms: min, max, dBFS, speech chance) and `vision.json.gz` (faces at 10 fps, the picture every 0.5 s). The API keeps the last 6 read in memory. |
| When they are made | A `deep` job after each analysis (concurrency 1, two tries). Older videos: on first use by a tool (queued once an hour, the tool says how long it takes) and by the worker's backfill at start (50 newest a day). `DEEP_VERSION` bumps measure everything again. |
| Speech | Silero VAD v5 (ONNX, MIT) on 16 kHz sound, 0.5 / 0.35 hysteresis, speech at least 250 ms, gaps under 150 ms joined (D4). |
| Word edges | wav2vec2-base-960h (ONNX, quantised, Apache-2.0) forced alignment per stretch of speech, then each edge moved onto the sound: a start to the nearest rise past the room + 10 dB (within -100/+50 ms), an end to the nearest fall under room + 6 dB (within 120 ms), two touching words split at the dip between them (D3). The model is downloaded at image build (too big for git); if it is missing the edges are only moved onto the sound and every tool says so. The model path could not be run here (Hugging Face is blocked in this sandbox): it is checked on the deployed worker. |
| An edge in a pause | After the moves above, a start still in the quiet (at or under the room + 6 dB) goes to the first frame inside the word that is over it and reaches the voice (room + 10 dB) within 150 ms; an end still in the quiet goes back to the last such frame. Found on the live 22-minute video, where the model sometimes began a word in the pause before it. A word that is quiet all through keeps its edges. A pause can be louder than that line (a breath, room noise at -45 dB), so an edge where the speech detector says no speech (Silero, under 0.5) also moves to the first (or last) speech frame inside the word, stepping back up to 50 ms while the sound is part of the same onset (within 12 dB). Last, no word holds a pause of 250 ms or more (no speech, or at the room): the model sometimes puts a word's first letter right after the word before it and the rest after the pause ("because" at 176.19-177.61 s, said at 177.3). The word is then the part between pauses that overlaps the transcriber's times most, else the longest. |
| Faces | YuNet finds the faces in every frame at 10 fps (up to 3, tracked by overlap); MediaPipe Face Landmarker runs on a crop around each (it misses small faces in a full frame) for the mouth (`jawOpen`), blinks and head pose (D6). The rest of the picture every 0.5 s. |
| Clipping | Flat tops near full scale (a 10 ms frame peaking at 0.89+ with a quarter of its samples within 3% of the peak), not samples at 32767: the preview copy is AAC, which rounds clipped tops down. |
| Clicks | A sharp jump in the sound (1 ms peaks of the first difference) 20 dB over the sound around it, 30 dB inside speech (consonants are sharp too). |
| A silence's level | The median of its 100 ms loudness values, so a click or a breath in a pause does not make the pause loud. Confidence 0.95 at the room, 0.8 well under the voice, 0.6 otherwise. |
| Dark shots | The 0.5 s picture replaces the breakdown's dark shots once a video has it (one source, finer). |
| Tool output | Text, short, ranges always; numbers series sized to about 300 values unless a step is given. The waveform is a PNG drawn on the server (no image library). get_project pages V1 at 100 clips (each clip now carries a note). |
| Burned-in times | get_frames writes the time (ms) and the frame number on each frame (no colons: FFmpeg's text filter reads them as syntax). |

## Reference edits: what blocked the C1744 edit (27 October)

| Question | Decision |
|---|---|
| An app's old copy of the tools | Apps keep a copy of a connector's tools, sometimes for days (the user's Claude had an apply_edits list from before rotation, add_clip and set_audio, so it said Rendrr cannot rotate). apply_edits' op is now free text in the tool (described, not an enum), so an old copy cannot hide newer ops; the API checks each op and names the ones it has. The guide (rendrr://how-to-edit, read fresh) now lists every op with its fields and says to send them even when the tool's own list looks shorter, or start a new chat. |
| A video as a card on a background | set_framing already shrank and placed V1; what was missing was the card look and what shows around it. set_card puts crop and rounded corners on the clip as one more mask (the mask system draws it identically in the render and the player), and the drop shadow and border as greyscale pictures at the output size in the framed place, made by one shared function (a PGM file for FFmpeg, a canvas in the player), filled with their colour. set_background is edit-wide: a colour or gradient (one picture made by the shared code, decoded once and repeated with FFmpeg's loop filter; the player uses the CSS gradient, which the shared picture follows exactly), a library video (looped from the edit's start), or the clip's own picture blurred (Gaussian, scaled up by three blur widths a side in both, so the soft edges each blur makes stay outside the frame). Rendered and compared with the player: 0.5-0.7 levels of 255 apart. The field is cardLook (text layers already have a card). |
| Footage filmed sideways | The picture measurement samples 8 frames and looks for clear faces at each quarter turn. When faces are clear only when turned (in at least half the frames and twice as often as filmed), the footage is measured turned that way and get_footage, get_vision and create_project say "filmed sideways ... set_rotation {degrees: 90}". The editor offers "Turn it upright" (or "Keep as is"). Rendrr never turns it by itself. |

## Connector fixes from a long editing session (30 October, night)

| Point | What changed |
|---|---|
| 1. Code sent in full each time | create_graphic takes codeFrom (a graphic of yours: its code, size, length and params) with edits [{find, replace, all?}] applied in order (a find missing, or there more than once without all, stops it and names the edit); replace: true changes that graphic itself (same id: its placements' recordings are dropped and recorded again with the new code; a recording of the old code that finishes later is thrown away). Also codeUrl (a raw file, gist, Drive or Dropbox link) and upload: true (a one-time link the code workspace sends the file to). |
| 2. Recorder crashes when busy | The crashes tonight (spawn EAGAIN, the 30 s waits, socket hang up) were before the thread fix went live (none since 18:11 UTC). On top of it: at most 2 recordings at once in the worker, the rest wait their turn; browsers a recording ended with cleanly are kept a minute for the next one; a chunk that crashes is recorded again up to 3 times after 2, 5 and 10 s; Chromium's start waits 90 s and one call 5 min; a new page that takes over 30 s (puppeteer's fixed wait) is waited for twice more. |
| 3. Several placements at once | Placement recordings already went through the graphic queue one at a time; a render no longer records one that is waiting there a second time (it takes it off the queue and records it in its turn). apply_edits, get_graphic {projectId} say each placement's state: ready, waiting, recording N%, failed. |
| 4. One broken recording breaks the render | Before it draws, a render waits for a graphic being recorded, records again one that failed (up to 3 tries), and takes over a waiting placement recording; one that still cannot be recorded stops the render with its placement id and params (before, a placement was left out and the render could fail later at "Cutting clips"). |
| 5. Long graphics | Already recorded in parts and joined (lanes of 90 s chunks); the 85 s crash was the thread limit. Tested again (the long-graphic tests). |
| 6. A failed graphic disappears | It never did: add_graphic treated a failed graphic as missing. Now it can be placed (the result says it failed and how to record it again), and retry_graphic records it again from its own code, with its failed placements. |
| 7. No way to force a new recording | add_graphic rerecord: true drops the kept recording for those params before the edit is saved (it is recorded again); test_graphic rerecord: true draws the test from the code and drops the kept recording too. |
| 8. open_projects too big | With a projectId only that edit and its preview are sent, not the list of edits and their picture links (the app loads the list when the user goes back). |
| 9. Words twice | get_footage detail "word_times": one list, a word a line in the sound's times ("w12 Every 7.37-7.54", * after a filler). |
| 10. Asking again and again | get_graphic and get_render wait_seconds (up to 120): answered as soon as it is done or failed. |
| 11. Free-form data | data (any JSON, declared or not) on a placement (add_graphic data, or params.data, test_graphic data) arrives as window.params.data; it is part of the recording's key. |
| 12. Restore after a range cut | restore_words from/to puts footage a range cut took out back (on the clip it was cut from; the two halves are one clip again when they are alike); word ids a range cut took out come back too. |
| 13. set_clips drops graphics | A V3 graphic or text whose V1 clip set_clips replaced stays at its edit times (over what plays there now), and the result names it; one that moved with its clip is named too. |
| 14. delete_clip needs the track | track is found from the clip id when left out. |
| A chat with the old tool list | It sends fields it does not know as text (edits as JSON text, replace as "true"). The new fields take that too (edits and data as JSON text, the yes/no fields as "true"/"false", wait_seconds as a number in text); a new chat still sees a list, a yes/no and a number. |
| Render after replace | create_graphic replace changes a graphic, not the edit, so render_preview said "Nothing changed" and kept the old preview. A graphic now keeps changedAt (its code replaced, or a recording dropped to be made again: replace, rerecord, retry_graphic); a preview made before a graphic in the edit changed is rendered again, and the answer names the graphic. |

## Premiere parity, phase 12b: more effects and transitions (31 October)

| Question | Decision |
|---|---|
| Transitions | push, wipe, iris, cross zoom, film dissolve, clock wipe, barn doors and iris diamond, drawn by FFmpeg's xfade from both sides' footage past the cut (handles), on the output's frames. push, wipe and barn doors take a direction. |
| Film dissolve | The two sides mixed in linear light (gamma 2.2 out, xfade's fade, gamma back): the middle of a red-to-blue dissolve is 160/155, where a plain dissolve gives 125/120, as film exposes. |
| Clock wipe and diamond | xfade's own radial wipe lags and eases (a quarter of the way through it has swept about 45°), so the clock wipe is a custom expression: a straight sweep clockwise from 12 o'clock that the player's conic mask draws exactly. The diamond is a custom expression too. |
| The player | Each new transition has its look: a CSS clip-path on B (wipe, iris, barn doors, diamond), a conic mask (clock), both sides moving (push), A zooming as B fades up (cross zoom), an opacity (film dissolve). The render test checks the render splits where the player does. |
| Effects | glow (the parts above mid-grey blurred and screened back), grain (noise on 8-bit RGB, strong enough to survive the encode), RGB split (rgbashift, red and blue pulled apart), camera shake (zoomed in just enough and moved by two waves each way that never line up), mirror (the left half reflected onto the right), corner pin (perspective to four corners; outside them transparent, so the background or the picture under b-roll shows). They are drawn in the render; the player marks them "(in the render)". |
| Corner pin's alpha | A white frame with a black 1 px edge, pinned the same way (perspective repeats the edge outside the corners), made full range (a grey frame from a colour source is limited range: 235 inside would show the clip at 92%). |

## Premiere parity, phase 12a: deliverables (31 October)

| Question | Decision |
|---|---|
| Captions files | Every final comes with SRT and WebVTT of the edit's words (cues laid out as the captions are, in the words' own case), whether or not captions are drawn on the picture. The editor's Export window saves them from the edit at once, without a render. |
| YouTube chapters | Chapter marks (add_marks kind chapter, with a label) where their footage plays in the edit, as "0:00 Title" lines; the first is put at 0:00; what YouTube needs (3 chapters, 10 s each) is said when it is missing. The final's answer carries them to paste. |
| Formats | set_export format: mp4 (default); gif (made from the MP4 with its own palette, 15 fps, 640 wide or 480 for portrait, up to 60 s: refused above); audio (AAC 256 kbit/s .m4a) and wav (PCM 48 kHz), written straight from the mix; overlay (the graphics, text and captions on transparency). |
| Transparency | The overlay export renders the edit twice with the picture as one colour (black, then white), footage, b-roll, zooms, adjustment layers and the person matte left out, losslessly (FFV1 4:4:4); alpha = 1 - (white - black), the colour un-premultiplied from the black pass, into ProRes 4444. This is exact for anything the graph composites, libass text and its soft shadows included, which an RGBA graph could not promise (libass does not write alpha). |
| Bitrate and frame rate | bitrate (Mbit/s) replaces constant quality with that average (peaks to 1.5x); fps (24, 25, 30, 50, 60) replaces the footage's for the final. HDR keeps constant quality. |

## Premiere parity, phase 11: flip, crop, anchor, shadow, motion blur, smooth slow motion, eased ramps (31 October)

| Question | Decision |
|---|---|
| Flip | set_flip on V1 clips and b-roll (h, v, both, none): after the turn and before the fit in the render (hflip, vflip), a CSS mirror in the player. A mirrored clip is its own part (it never joins an unmirrored neighbour). |
| Crop, corners, shadow on b-roll | set_card takes b-roll ids: the crop and rounded corners are its mask (the same mask V1 cards use), the drop shadow is made from the b-roll's own alpha after its movement (blurred, times the opacity, in its colour, offset) and laid on the picture before the b-roll, so it follows a moving picture-in-picture. A border stays a V1 card's (refused for b-roll). The player: the mask through the look canvas, the shadow as CSS drop-shadow. |
| Anchor point | On keyed V1 clips, b-roll and graphics (set_keyframes anchor): the perspective corners are mapped about that point of the picture, and the point lands at its own place in the frame plus the position keys (Premiere's Anchor Point). The player: CSS transform-origin. Text layers keep the middle (they are drawn by libass). |
| Motion blur | On keyed movement (set_keyframes motionBlur 0-100; 50 = a 180° shutter): the movement drawn at 4x the frame rate, the sub-frames inside the shutter averaged premultiplied (no dark fringes), back to the frame rate. Measured: a square moving 19 px a frame, edge 1 px sharp, 26 px blurred at 100. Render only; the player shows the movement sharp. |
| Smooth slow motion | set_speed interp: frames (each frame held, as before), blend (neighbours mixed) or flow (optical flow, minterpolate mci): the stretch's timestamps divided by the rate, then frames made on the output's grid, so frame n is footage srcIn + n x rate as frame sampling shows it, and the sound is unchanged. Only where the clip plays slower than 1x. Measured: a bar at half speed steps 4-5 px every frame (frame sampling: 0, 9, 0, 9). |
| Eased ramps | A ramp point's ease (in, out, in-out, a bezier) shapes the speed change to the next point; the ramp's steps follow it in the render and the player alike. |

## Premiere parity, phase 10: multicam (31 October)

| Question | Decision |
|---|---|
| What an angle is | Another camera of the same take (a library video) in the edit's multicam, with its offset: its second at the main video's second 0. A V1 clip's `angle` picks the camera its picture comes from. The clip's footage, cut words, transcript and timing stay the main video's, so every other op works as before. |
| Sync | By sound, on the server: each video's loudness every 10 ms (the deep measurements, already made for every video) less its own 1 s average, so a near and a far microphone match; the two slid past each other by FFT cross-correlation; the lag chosen by its strength against chance (a short overlap that happens to agree does not win); the peak to a fraction of a frame. Measured: 13.374 s found to under 6 ms on a camera 14 dB quieter with more room noise; 2.37 s to 0.1 ms on rendered files; unrelated recordings score about 0.11 and are not "sure" (0.3 and a margin of 1.5 needed), and the result says so. |
| Switching | switch_angle over clips, a range (clips split at its ends), or from `at` to the next change of camera (as cutting live in Premiere's multicam monitor). "main" goes back. |
| Sound | "main" (default): the main video's sound under every camera, as most podcasts are mixed. "follow": each camera's own sound with its picture. |
| No footage | Where an angle has no footage (it started later or stopped sooner) the clip shows and plays its own. |
| The render | An angle's picture is a part of its own video at the main moment plus the offset, fitted with the angle's own turn and framing (not the main camera's face focus). The worker downloads only the angles the edit shows. |
| The editor | A Multicam page: add a camera (synced by the server), a monitor per camera that follows the playhead (click one to cut to it from there), each camera's offset by hand, sync again, the sound choice, remove, off. V1 clips name their camera. |

## Premiere parity, phase 9: adjustment layers (31 October)

| Question | Decision |
|---|---|
| What it is | A V3 clip of kind "adjust" with a grade (set_grade's fields) and effects (as set_effects): the op adjustment_layer adds one over start..end (edit: true = edit seconds) or changes one by clipId; delete_clip removes it. It moves with the V1 clip it starts on, as graphics do. |
| What it covers | Everything drawn before it: footage, b-roll, graphics (as Premiere's covers the tracks under it). Text layers and captions go on after it and stay as they are: titles over a graded or blurred stretch stay readable, which is what an editor wants nearly every time. |
| The render | After the graphics, the picture over the layer's window goes through the clips' own colour chain (its grade as a LUT, then its effects), and is laid back in place (split, trim, colour, overlay with enable). Nothing else in the graph changes; an empty layer changes nothing. |
| HDR | In an output that keeps HDR the picture there is HDR, and the grade's LUT is SDR: the grade is left out there (said in the plan) and its effects apply. |
| The editor | Color tab: the whole-edit page lists the layers and adds one at the playhead (5 s); a layer picked on V3 or in the list opens its own page (grade, wheels, HSL, blur, darken, vignette, remove). The player previews it with a CSS backdrop filter (exposure as brightness, contrast, saturation, blur, darken): near enough to judge; the render is exact. On the timeline it is a band along the top of V3, so captions under it do not hide it. |
| set_grade's change rules | Moved into one function (mergeGrade) that set_grade and the adjustment layer's page both use, so a slider on a layer changes only its own field. |

## Premiere parity, phase 8: Morph Cut (31 October)

| Question | Decision |
|---|---|
| What it does | A transition on a jump cut: the window's frames are made from A's frame at its start and B's at its end, by motion-compensated interpolation (FFmpeg minterpolate: bidirectional block motion, overlapped blocks, variable block size, search 64 px), so a head that moved between the takes slides across instead of jumping. It replaces the window's real frames (as Premiere's does). |
| What minterpolate needs | It gives nothing for two frames (it works on the frames round each pair) and stops at a scene change: each frame goes in twice (A, A, B, B, D apart), the stretch between the second A and the first B is kept, and scene detection is off. Found by the render test: the first version showed B all through the window. |
| Handles | None: each side's own frames (A's last before the window, B's first after it). |
| The player | Shows a dissolve over the window (the morph is drawn in the render). |
| Limits | Small moves morph cleanly; a big change of pose or framing smears, as Premiere's does. |

## Premiere parity, phase 7: Warp Stabilizer (31 October)

| Question | Decision |
|---|---|
| Which stabilizer | vidstab's two passes (in the worker's Debian FFmpeg): detect the camera's motion, then transform with smoothing. deshake is one pass and much weaker. optzoom=1: a fixed zoom just large enough to hide the edges for the whole part. |
| Keeping the passes in step | vidstabtransform reads the moves frame by frame, so the detection must see exactly the frames the render gives it: the render puts each video on the plan's frame grid (setpts from the window's seek, fps) and trims each part; the detection does the same from a second before the part (the grid is anchored at 0, so the frames match). Same size too: the moves are in pixels. |
| Smoothness | smooth 0-100 maps to vidstab's smoothing window: 0.3 frames per point (50 = 15 frames, half a second at 30 fps). |
| Limits | Normal-speed parts only (a ramp or reverse plays as filmed and the plan says so); V1 only; the analysis runs at each render (fast against the render itself); the editor's player shows the footage as filmed. |
| The test footage | A still scene of blurred noise seen through a crop that shakes: a repeating pattern with shakes larger than its period cannot be tracked by anything, and lavfi's random() gives new noise every frame (both tried first). |

## Premiere parity, phase 6: audio (31 October)

| Question | Decision |
|---|---|
| Where a clip's sound effects go | On that clip's own sound before the joins (dialogue: each sound unit of the clip; music and sound effects: their own input, before they are placed in time). Volume keys ride the existing dialogue volume curve, so the live player hears them too. |
| Pan | A balance (the far side goes down, the near side stays), not equal-power: the middle is exactly as it was. |
| EQ | Three bands, as a quick voice EQ: a 120 Hz shelf, a 1 kHz bell 1.5 octaves wide, a 6 kHz shelf (FFmpeg bass, equalizer, treble). |
| Reverb | FFmpeg has no reverb filter worth hearing; convolution (afir) with a room's impulse response is the real thing. The response is made in shared code: 10 ms of nothing, then noise dying by 60 dB over 0.3-2.5 s, each side its own seeded noise, scaled to unit energy, written by the worker as a float WAV. afir's dry is its input gain (dry=0 silences it: found by the render test); the room is mixed back at 0.6 x amount. The tail stops at the clip's end. |
| Crossfade | Equal-power (quarter sine) over 0-0.5 s at dialogue cuts. Each side reads half of it from the footage past its own cut and the two overlap (acrossfade), so the edit's length and every cut's place stay. Only where both sides are normal-speed footage with footage to spare; elsewhere the declick fade. Off (the default): the graph is as before. |
| The live player | Plays volume keys; pan, EQ, reverb and crossfades are heard in the rendered preview, as cleanup and loudness are (the player plays the footage's own elements, not a WebAudio graph). |

## Premiere parity, phase 5: deeper colour (31 October)

| Question | Decision |
|---|---|
| Where the new controls go | Into the grade function, so into the one 3D LUT the render (lut3d) and the player (WebGL) already share: tone, vibrance, wheels, HSL secondaries and Hue vs Sat are all a colour in, a colour out. Order: input LUT, white balance and exposure, contrast, tone, wheels, saturation, vibrance, HSL and Hue vs Sat, curves, look LUT. |
| The formulas | Tone: the pixel's luma moved by four bumps (shadows peak at 1/3, highlights at 2/3, blacks at 0, whites at 1), the colour scaled with it so its hue stays. Wheels: each range ((1-y)^2, 4y(1-y), y^2) pushed towards its hue's colour less that colour's luma (brightness kept), plus its luma. Vibrance: saturation scaled by 1 + v(1 - saturation). HSL: a weight from the hue's distance (full within range/2, gone at range) and saturation (greys untouched), then hue turned, saturation scaled, value moved. Hue vs Sat: a curve round the hue circle, eased between points, 0.5 = as is. |
| LUT size | 33 points, or 49 when the grade has HSL secondaries or Hue vs Sat (their edges are sharp: 33 points err by up to 9 levels, 49 by 6). Both the render and the player read lutSizeFor(grade). |
| Vignette | An effect: darken outside a soft ellipse 120% of the frame (its own area if it has one), so it reuses the darken path in both the render and the player. |
| Scopes | In the editor only: a 160-wide copy of the picture showing now, through the grade's LUT (17 points), as a luma waveform and a BT.709 vectorscope with the skin line. A picture the browser cannot read (no CORS) says so. |
| The colour wheel control | Drag a dot: angle is the hue, distance the amount. It measures its own on-screen box (the panel can be drawn scaled), does not take focus on press (focus scrolled the panel under the pointer), and the Reset buttons keep their space so nothing moves while dragging. |

## Premiere parity, phase 4: blend modes and opacity (31 October)

| Question | Decision |
|---|---|
| Which layers | B-roll over V1 and graphics: the layers with their own picture. Not b-roll behind V1 (set_under), not text (libass draws it straight onto the frame; a text layer fades with set_keyframes opacity). |
| Which formulas | W3C compositing (CSS mix-blend-mode), which are Photoshop's and Premiere's. The editor draws with CSS, so the render had to match it: FFmpeg's built-in modes are the same formulas with the picture on top, except dodge and burn (the layer goes on top) and soft light (FFmpeg's is another curve: an expression of the W3C one). A render of all 12 modes over 16 colour pairs checks it. |
| How the render blends | Only the frames under the layer: the picture over that time is taken out, blended with the layer in RGB (gbrp; gbrp16le for HDR), mixed back by the layer's alpha times its opacity (maskedmerge), and laid back in place. Frames outside are untouched, and a plain layer draws exactly as before. |
| Opacity alone | Multiplied into the layer's alpha (lutyuv), then overlaid as before. |
| Limits | One mode per layer for the whole clip (no blend keyframes); dodge and burn magnify compression noise where they divide by a small number, as they do anywhere. |

## Premiere parity, phase 3: masks that move and follow the face (31 October)

| Question | Decision |
|---|---|
| How a shape moves | Keys on the box (at: the clip's footage second, x, y, w, h), a straight line between them. Footage time, not edit time: a cut or a trim leaves the shape on the same part of the picture. Rect and ellipse only; a path keeps its points. |
| Following the face | follow "face": the server measures the speaker's face every 0.1 s over the clip (the 10 fps face tracks, smoothed over three samples, placed as the render fits the clip) and the op turns that into keys. The shape keeps its place and size against the face where it is first seen; sent without a box it is an ellipse round the face (the skin area's shape). Keys are thinned where a straight line is within 0.4% of the frame (Douglas-Peucker), at most 3,000. A clip with no face keeps the shape still and the result says so. |
| How the render draws it | A moving shape is a small (at most 480 wide) lossless FFV1 grey video in footage time, written by the worker; the graph shifts it to its footage time and puts it through the segment's own trim and speed, as the picture, then scales it to the frame. A still one stays a .pgm. A reversed clip holds the shape where it is at the clip's start (the plan says so). |
| Darken | colorchannelmixer by 1 - amount%; the player's "dark" pass is the same multiply. A spotlight is darken outside an ellipse that follows the face (+ Spotlight in the Color tab: 55%, feather 8%). |
| The editor | The player draws a moving shape again at each footage moment, small (320 wide), stretched over the frame as the render scales its video. |

## Premiere parity, phase 2b: video inside text (30 October, night)

| Question | Decision |
|---|---|
| What it is | Two looks on a text layer. inside{videoId, from}: a library video plays inside the letters (Premiere's Track Matte Key). cutout: the letters are cut out of the layer's card, so the edit's picture shows through them. Same op (add_text, set_text), and a choice in the Text panel. Both can go behind the person. Shape wipes wait for the transitions phase. |
| Field name | `inside`, not `fill`: clips already have a `fill` (a clip over the whole edit). |
| How the render draws it | Each such layer from its own mask: an ASS file of the letters in white on black (or the card in white with the letters solid black) timed from the layer's start, drawn by libass on limited-range YUV, so the step to grey gives the alpha its whole 0-255 range (straight on grey it ran 16-235). The video (or the card's colour) takes the mask as alpha and is laid over the picture. A video in the letters keeps its card, stroke, shadow and box: drawn first from a second file with the letters left clear. |
| Order | On each side of the person: its graphics, then these layers, then its other text layers (and in front, the captions). So such a layer is under plain text layers placed with it. |
| Looping | A video shorter than the text loops. Read with a seek when it does not; when it loops, cut at `from` after the loop: with a seek, FFmpeg starts every loop from the seek point (measured: a 2 s video from 0.5 s looped every 1.5 s). |
| A cut-out's fade | The card fades as the layer's animation says; the hole in it does not (a fading hole would let the card show inside the letters half way). |
| In the editor | The layer's own block is laid out as before (its letters clear, so its stroke, shadow and box show); a canvas the size of the frame draws the letters where that block is, measured each frame (keyframes and animations carry over), then the video only inside them, or the card with them cut out. A video picked in the panel plays at once. Checked against the render frame by frame (`inside-match.mjs`). |
| A missing video | Not in the library or not ready: plain letters, and the plan's line says so. |

## Premiere parity, phase 2a: behind the person (30 October, night)

| Question | Decision |
|---|---|
| How it is drawn | The person is laid back over the layers behind them rather than the layers being cut by the matte: the picture as it is at that moment (zoomed with it, before b-roll and graphics) with the matte as its alpha, over the behind graphics and the behind text layers. One matte stream over the edit, joined part by part like the picture; a part without one gets black made from a copy of its own picture, so the two cannot drift by a frame. |
| Text layers | They are drawn by libass from one subtitle file with the captions. Text behind the person goes in a second file drawn before the person; captions always stay in front. |
| Where it does not apply | Over b-roll and transitions (the person is not on screen as the footage shows them), and for a clip framed smaller, moved, keyframed, drawn as a card or reversed (the matte would not line up). The layer is simply in front there; the plan's line and the result say where. |
| The matte | The same matte as remove_background (made per 10 s block, kept). It is made when the edit is saved for the clips under a layer behind the person (placed with the edit's words), and a render makes any still missing. |
| Not in this part | Video inside text (track matte): phase 2b, below. |

## Worker crashes from graphic-heavy renders (30 October, evening)

| Question | Decision |
|---|---|
| The cause | A render opens each graphic file (transparent VP9) with its own decoder, and FFmpeg gives each as many threads as the host has CPUs (up to 16; two decoders per graphic for the transparency). On the worker's 48-CPU host one preview with 15 graphics started about 1,500 threads (reproduced with -cpucount 48), over the container's 1,000. Everything beside it then failed: graphic recordings (spawn EAGAIN, socket hang up, 30 s launch timeouts), test clips, other renders. |
| The fix | Each graphic decodes with 1 thread (2 when there are 3 or fewer: they are simple pictures); the other inputs share twice the CPU quota between them; the encoder gets the quota (x264 left alone takes 1.5 times the host's CPUs). Same render: 73 threads. A render that still runs out tries once more with one thread per decoder and one filter thread; VP9's way of saying it ("thread creation failed") now counts. |
| Storage | The bucket answered "Please reduce your request rate" when many files went up at once, and a file upload (a stream) is not retried by the SDK. Uploads now retry throttling from the file, waiting 1, 2, 4, 8 s (spread); the client retries 5 times in adaptive mode, slowing itself while throttled. |

## Premiere parity, phase 1: remove the background (30 October)

| Question | Decision |
|---|---|
| The plan | Read again from the Premiere copy you sent (storytold/filmcraft): its masking, track mattes, blend modes, colour, audio, stabilising, morph cut, adjustment layers, multicam and deliverables, set against what Rendrr has. Written as 12 phases in `docs/plans/premiere-parity.md`, the background first since you asked for it. |
| The models | Two of MediaPipe's (Apache-2.0, 256x256), fetched into the worker image at pinned versions with their checksums: the selfie segmenter (250 KB, 7 ms) finds the people; the multiclass selfie model (16 MB, about 110 ms) cuts them out. The first live check used the selfie segmenter alone, and it took in bits of a painting behind the speaker (its yellow flowers by his head and hands); the multiclass model leaves them out. Chosen over larger matting models (RVM is GPL; BiRefNet and SAM 2 need a GPU to be quick): CPU only, about 190 ms a frame in all. People only; held objects go with the background. |
| Tall and wide frames | The model sees a square, and the closer the square is to the person, the cleaner the cut (larger squares let the painting back in). So one square centred on the person, with 12% room, followed frame to frame from the fine model's own reading (growing at once, shrinking slowly, so the crop does not jump); overlapping squares along the frame when someone is taller than it is wide. Islands under 3% of the person that the model is less than 85% sure of are dropped (a flower beside a hand); a hand seen apart from the arm stays. |
| Where the matte lives | Made once per 10 s block of footage (version 2 after the model change: blocks made by the first are not reused), from the preview copy (what the editor plays), kept in storage under the footage's id and turn. The preview, the final and the editor read the same blocks, so they agree. A block is made when an edit asks for it (queued at once), or by a render if still missing; a render waits for one already being made rather than making it twice. |
| The matte in the render | Read from the start of its concat list with the footage's times put back (a seek on the concat reader moved the frames' times and left the matte a frame behind), then sent through the clip's own trim, speed, freeze, turn and fit, so it follows the picture frame by frame. The one-look shortcut (all clips joined before the look) is off when a clip has it. |
| Edge and soft | Edge moves where the cut falls (a blur and a curve that keeps pure black and white), soft feathers it. The editor's player uses the same numbers in its WebGL pass. |
| What is behind | Not a new setting: the edit's background (set_background) already shows wherever the picture is clear. The result says so when nothing is set ("behind it: black until set_background"). |
| Not done | Reversed clips keep their background (the matte would need reading backwards). Objects (a product, a pet) wait for a model that finds them. |

## Engine Part 3: preview checks (27 October)

| Question | Decision |
|---|---|
| Gaps from the file | The preview's sound is measured by the same deep_audio.py as the footage, with three options for a rendered edit: speech from 0.15 s (not 0.25 s, so a short word between pauses is not lost), each stretch's edges moved onto the level (the detector's 32 ms windows and slow fall leave ends up to ~150 ms late: back while under max(room + 6, voice - 30) dB, at most 150 ms; the start at most 50 ms either way), and the joins passed in for clicks. Part 2's footage measurements are unchanged (the options are off for footage). |
| Which side of a join | The edit's dialogue joins are where its sound parts jump (another video, footage that does not continue, muted or silent changes). A gap that holds a join, or touches one within 30 ms, is cut there: the part before is "end of A", after it "start of B"; a clip wholly inside the gap is "all of". Footage times from the sound part playing then. Gaps at joins are all listed (25), inside clips the 10 longest; they are listed, not flagged: how long a pause may be is the edit's choice. The old pause line from word times stays for previews measured before this. |
| Clipped words | From the alignment (Part 2 word edges; the transcriber's times when a video has none, said so). A word is clipped when a dialogue edge (not a join where the footage goes on) is more than 0.5 ms inside its sound; both amounts are given in ms (cut off, plays). Flagged: a cut through a word is not something an edit asks for. |
| Clicks at joins | The footage's click rule (a 1 ms burst 20 dB over the sound around it, 30 dB in speech) within 20 ms of a join, plus the cut itself: the biggest sample-to-sample jump within 1 ms of the join, 20 dB over the usual jump in the 25 ms each side (and over 2% of full scale). A first try (any burst over 15.6 dB at a join) took a voice starting right after a cut for a click; the render's 20 ms fades mean a real cut click is now rare, and this keeps it rare to report. |
| Transcript as it plays | Transcribed again by the footage's own transcriber (AssemblyAI), so differences come from the edit and not from a different recogniser. A separate `heard` queue after the render (the preview is ready at once; transcription takes about 20 s plus 15% of the length). Only the newest preview of an edit (an older one waiting is marked skipped). The result is kept in the render's plan (no migration). The audio is read from the preview's signed link (no extra file to clean up). With no transcription key it says so and shows the footage's word times, labelled as not heard. The differences are a word diff (Myers) on lower-case words without punctuation, up to 1,500 places. |
| Graphics visible | Sampled 2 a second across the part on screen, 8 to 24 moments. Invisible only when no moment has a pixel over 1% opaque (the old rule, under 0.2% of the frame at the most covered moment, stays for older checks; it missed a small graphic). |
| Graphic over the face | The main face (largest box) from Part 2's 10 fps faces at the footage moment playing then, placed as the render draws it: undo vision's measuring turn, the clip's turn, fit (cover, centred across, 40% down), framing, V1 keyframes, zoom. The cover is the graphic's alpha (64x64 per moment) averaged over that box. A keyframed graphic moves, so it is not measured; b-roll over V1 means no face then. Flagged over 25%; a full-screen title over the face is flagged too (the AI knows if it meant it). |

## Rendrr inside Claude, one render per revision, the editing skill (29 October)

| Question | Decision |
|---|---|
| How the app gets into Claude | An MCP App (the io.modelcontextprotocol/ui extension, protocol 2026-01-26): open_projects carries `_meta.ui.resourceUri` (and the older `ui/resourceUri`), the page is a `ui://` resource of type `text/html;profile=mcp-app`. Works where the host supports MCP Apps (Claude on the web and desktop); elsewhere open_projects still answers in text. |
| The page | One HTML file with its own small JSON-RPC bridge (initialize, tool calls, messages, links, size, theme). The official app library bundled with its dependencies is 418 KB; the bridge is about 60 lines. No outside scripts, fonts or styles. |
| What the page may load | Only the storage the API signs links for: its origin is read from a signed link (so it is right for R2, Railway buckets or AWS, path or host style) and declared as the resource's `resourceDomains`; `connectDomains` is empty. Data comes through the host's tool calls, never by fetch. |
| The app's tools | app_list_projects, app_get_project, app_add_comment, app_resolve_comment, app_render_preview, marked visibility "app" so the AI does not see them (the AI has get_comments and resolve_comment). They go through the same internal route as the AI's tools, as the signed-in user. The app's reads are not logged as tool calls (it polls). |
| Comments | The editor's own notes table (ProjectComment), at the preview's time, so the Comments tab, the markers and get_comments show them. Client comments from review links are shown and can be resolved too. |
| Updates | Every 3 s while a preview renders, every 20 s otherwise (so a render the AI starts shows up), not while the app is hidden. The player is kept across updates (no reload), and so is what the user is typing. Inline sizes are fixed pixels: the frame grows to fit the app, so screen-height units would shrink it. |
| A render button in the app | Only when the latest version has no preview and nothing is rendering. It is the user's own action, so it does not go against "render once". |
| One render per revision | Not a hard limit (a user may want a second render). Instead: a check that needs no render (check_edit, and its flags at the end of apply_edits), a repeat render_preview with nothing changed returns the existing preview, and the guide, tool texts, instructions and prompts all say: one apply_edits, check, render once. |
| The skill in the connector | MCP has no skill type yet. So: the core (about 1,100 characters) in the server instructions, which hosts send with every chat; the whole skill (about 14,000) from a tool the instructions tell the AI to call, since an AI in Claude can call tools but not read resources itself; plus a `skill://` resource and a prompt for clients that use those. |
| Full screen | Asked for when the user opens an edit from the grid (a click, so hosts allow it); never on its own when Claude opens the app. The page sends its height only inline. If the host starts the page again for full screen, the edit just opened opens again (kept 30 s in the page's session storage). |
| Player controls | The browser's own controls show whole seconds, so the page draws its own: the time to the ms (redrawn every frame while playing), a seek bar that carries the comments, 0.1 s steps. |
| Drawings | Kept as strokes (0-1 of the picture, colour, width as a share of the width) so the app and the editor draw them sharp at any size, plus a clear PNG of them for the worker to lay over the preview frame (the page cannot read the video's pixels: the storage sends no CORS headers to the sandbox). The pen is about 4 px on screen whatever the picture's size. |
| Pictures | Sent through the host's tool call as base64 (no upload link: the page may not connect anywhere). Kept as they are up to 1 MB and 2400 px, else made 1600 px JPEG. Checked by their first bytes (JPEG, PNG, WebP only), up to 1.1 MB each, 4 a comment. Request limits went to 8 MB (connector and API). |
| Editing and deleting | The user's own notes: words, pictures and drawing. Client comments (from review links) can be deleted and resolved, not reworded. |
| Share | The review link Rendrr already has (watch, comment, approve, no account), for the version being watched; one made before (no password, not expired) is reused. Sharing marks the edit "In review", as sharing from the editor does. |

| A LUT inside set_grade | The .cube text rides in apply_edits and the server imports it first, so every chat (old ones too) can apply a LUT with the tool it already has; only the id is kept in the grade and the log keeps the file's length. Big LUTs still go by add_lut upload or Drive (a 33-point file is about 1 MB of text). |
| The filmstrip | Drawn in the browser from the preview copy the editor already streams (one hidden video per source, frames on demand, only for clips on screen, kept per half second), not made on the server: it works for every video at once with no reprocessing; the storage already allows CORS reads. |
| The project bin | Part of the edit (timeline.media), so it is versioned and undoable like any change, and the AI reads it in get_project. The reference stays on the project (one per edit), shown in the left monitor, never applied. |
| Voice presets | The dialogue cleanup's presets, named like Premiere's Essential Sound ones; each is a fixed FFmpeg chain (high/low-pass, denoise, gate, warmth, mud, presence, air, de-esser, compressor). Heard in exports, not yet in the live player. |
| LUTs from the AI | add_lut by link, the user's Drive file, or text, rather than an upload link: the AI's sandbox in claude.ai cannot reach Rendrr's storage, but Rendrr can fetch from Drive (its own connection reads any of the user's files) or any public https link. The same name replaces the file in place, so grades using it update. |
| Sharpen | A convolution, not FFmpeg's unsharp: unsharp has no effect on 16-bit RGB, which every look runs on. Binomial blur, 3x3 at preview size, 5x5 for finals, so the preview and the final look alike. |
| The app's look | The web app's, always dark: Claude's theme and colours are no longer applied (a light host made it white). Fonts load from Google Fonts like the web app's; where a host blocks them the system font shows and nothing else changes. |
| An edit with no preview | Opening it in the app starts its first preview once (one render, the one the user would ask for anyway). It is not started again for that edit while the app is open, and a failed render shows why, with a Render preview button to try again. |
| Claude's own bars on a phone | The app keeps clear of the space the host says it covers (safe-area insets; a fixed margin if the host gives none) and puts the comment box under the player, away from Claude's chat box. |
| The page's address | Claude kept showing the first version of the page after it changed: hosts keep app pages by their address. The address now carries a hash of the page (ui://rendrr/projects-<hash>.html), so every change is a new address and is fetched again; the first address still answers with the newest page. |
| What was taken out of the skill | Names of people and clients, the review site, client delivery, Drive downloads, local transcription and FFmpeg steps: private, or done by Rendrr itself. Its rules, mistakes table and QA gate are kept, each pointed at the Rendrr tool that catches it. |
| Reframing | A point of the footage the fit keeps in view (framing.focus), not a move after the fit: framing (scale, offset) works on the already cut picture, so a speaker sitting left of centre in 16:9 was cut away in 9:16 before any framing could reach them. The fit now cuts around the point, as near as the edges allow, in the render (crop expression), the player (object-position), the colour canvas and the measuring jobs. Without a focus nothing changes (middle across, 40% down). |
| Where the speaker is | From the faces measured at 10 fps when the video came in (no new job, no waiting): over each clip, the face on screen at least a third of the time whose mouth moves most (the biggest when there are no mouth readings), its median centre. A clip with no face keeps its fit and is named. |
| Shorts | One edit per short (each its own versions, comments, renders), made in one call so Claude does not need 4 calls per short. Captions default to bold for footage (a short without captions is rare); from an edit, its own caption style. Reframe defaults on for shorts, off for create_project (it changes the picture, so it is asked for). Stretches are seconds of the original footage, like every other time Claude sends; map_time converts from an edit. |
| 4:5 sizes | 1080x1350 final, 540x676 preview (even sizes for the encoder). Caption sizes as square: both are sized on the short side, the width. |
| An edit from scratch | A real blank video (the canvas) on V1 rather than an empty sequence: the editor, the render, checks, transitions and everything that hangs on V1 clips work unchanged. Two seconds are encoded and looped with stream copy (an hour in seconds, about 13 MB), BT.709 limited range so the colour lands exactly. It lasts twice the length asked (at least a minute more) so the edit can grow with trim_clip; it never expires and is not listed as footage. No preview transcription for it (no words). |
| ChatGPT | One server and one page for both: the MCP Apps keys first (ChatGPT has supported the standard since February 2026), ChatGPT's own key names beside them, and in the page window.openai only when the standard bridge does not answer within 2.5 s. The page says "ChatGPT" when it runs there, "Claude" otherwise. |
| Reading footage in windows | A window from the start of a file is read exactly as before (no seek, no length), so most graphs do not change at all. A seeked window starts a whole second early (frames stay on the output grid, handles have room) and its timestamps are put back to the footage's, so every trim keeps footage seconds. Sound rides on the picture's window when that one covers it (the file is read once). Decoding after a seek differs from decoding from the start by float noise only (1e-5 at most). |

## Engine Part 6: the user interface (28 October)

| Question | Decision |
|---|---|
| Waveform drawing | One canvas per sound track the width of the timeline's view, moved with the scroll and redrawn from the peaks for the columns on screen (min and max of every 10 ms frame each column covers). A canvas the length of a 22-minute edit at full zoom would be 800,000 px wide, past what browsers draw. |
| Music and effects | They have no stored peaks (they are files from the catalog): the browser decodes each once and works out the same 10 ms peaks. |
| Marks | Fetched with their own call (GET /projects/:id/marks) after the edit opens, so opening an edit is not slowed by working them out. Lines start under the ruler, so a click on the ruler still lands where it should. Beats (music_beat) are left out. |
| "Only their videos, the editor, the timeline" | The hidden things are hidden (the library, style files, measurements, tool names). The screens already there are kept: removing them was not asked for in so many words, and safest is to keep what works. Say if you want any of them gone. |
| The reference switch | Kept on the footage page (footage or reference), without the measurements around it. |

## Engine Part 4: the hidden library (28 October)

| Question | Decision |
|---|---|
| How the library is drawn | Each graphic item is an HTML template with a small runtime (easings, entrance and exit progress) whose renderFrame draws the whole frame from the time alone (renderFramePure). It goes through the same recorder, cache and editor player as the six templates (findTemplate), so nothing new had to be trusted. Items are not seeded into the graphics table, so they never show in the editor's graphics list. |
| Edits items | A picture in picture, a transition on a cut and a background are edits Rendrr already had. add_library_item makes those edits and says which; nothing new is hidden in the timeline. A picture in picture over part of a clip splits V1 first: that is a second version (undo steps 2), said in the result. |
| Position auto | Only add_library_item works it out (from the face's box at 9 moments of the range, as the render draws it), and stores the result in the params, so the render and the editor draw the same place. A tall frame's named places keep clear of the app's buttons (top 12%, bottom 20%). |
| Icons | Tabler (MIT): about 5,800 icons, the most of the three named, with tags for searching. Its "Brand" category (378 real logos) is left out. 413 KB gzipped on the API. The icon's SVG goes into the placement's params (the recording page has no network). |
| Illustration packs | Left out: the open packs on npm (Open Doodles, Open Peeps) ship as React code, and pulling their pictures out meant running that code. Safest: skip and note it. |
| Fonts | A library item naming a font that is not installed or added is refused before anything changes ("never fall back silently"). The editor's player embeds the same font files as data (its frame has no network). |
| Style files | A table of their own (StyleFile), read only by the AI tools, so they can never appear in a screen. Measured once per reference (again true measures again). The measuring is plain image and sound processing: text found by its strokes (contrast, even stroke width, one or two ink colours), followed frame to frame at 10 fps; cuts read at 30 fps; ducking from the 40-80 Hz band (under the voice) in pauses against under speech. Fonts are not named (Rendrr does not read letters); the weight is. |

## Engine Part 5: graphic engine reliability (27 October)

| Question | Decision |
|---|---|
| test_graphic: what it draws | 3 to 5 s at 540p in the output's shape (the footage's, else the graphic's, else 16:9), the footage fitted as the render fits V1 (cover, 40% down; not turned or framed: a look check, not the edit) under the graphic scaled as the render scales graphics. A template is recorded for the test up to its end; a custom graphic plays its recording, or its params' recording; params with none yet are recorded for the test only up to 20 s in (stepping a page further takes too long for a quick test). |
| test_graphic: speed and cost | Its own queue (concurrency 2), so a render or a long recording does not hold it up. The tool waits 9.5 s, then says to ask again; the job keeps going and the same test answers from its kept result. Results, clips and frames live under `tests/` and are swept after a day. |
| Chunks | Spec: 60-90 s chunks in parallel. The frames are split into lanes with the same work, one per browser (as before), and each lane into chunks of at most 90 s recorded in order on the same page, so a page never steps its clock back to 0 (stepping a busy page from 0 to minute 5 costs as much as recording). A chunk that crashes is recorded once more on a fresh page, which steps to the chunk's start. A graphic's own error, a time limit or a stop is never retried. |
| Encoders at once | As many as memory allows: the container's memory (cgroup memory.max, else the machine's) less 1.5 GB for the rest of the worker and 0.5 GB per browser, at 0.25 GB + 0.65 GB per 1080x1920 frame size per encoder; at least 1, at most one per browser. Capturing waits for a free encoder. |
| Saving finals into the user's Drive folders | Rendrr asks Google for drive.readonly + drive.file. drive.file lets it add files only to folders it made, so a final can always go to My Drive or a new folder, but the user's own folders need the full drive scope. That scope is asked only when the user presses Allow saving to my folders (incremental consent), not at connect: most people never need it, and Google shows it as access to every file. Before a render, an upload session is opened and cancelled to learn whether Google allows the folder, so a refusal is said at once instead of after a 10-minute render. |
| Library folders | Only for videos (edits keep their own project folders). Folders can hold folders, up to 6 levels; names are unique among a folder's own folders and cannot hold "/" (Claude names a folder by its path). Deleting a folder moves what is in it up one level. Editing a folder takes its own videos in name order, then each folder inside in name order, the same way down. A video is in at most one folder; deleting a folder leaves its videos loose. The top of the Library shows videos in no folder; a search looks in every folder. A folder sent to an edit uses its ready footage in name order with numbers read as numbers, so parts filmed as "Part 1 ... Part 10" play in order; the web shows that order before creating so it can be changed. More than 20 ready videos is refused (the limit of an edit from several videos). |
| Importing a Drive folder | The Library folder takes the Drive folder's name and is reused if one with that name is already there (same parent), so a second import fills it rather than making "Course (2)". Videos already linked (same Drive file) are moved into the matching folder instead of being linked again. Drive folders deeper than the Library allows are left out; past 200 videos the import stops and says so. A "/" in a Drive folder name becomes "-". |
| Cut to whoever speaks | From each camera's own loudness (already measured every 10 ms for sync), not speaker labels: it works on the footage people already have and needs no new transcription. It suits the usual podcast setup (a mic or camera per person). Level is over the camera's own 20th percentile, so a quieter camera is not left out; 6 dB over the room and 3 dB over the others to lead; 0.4 s of leading before the shot changes (a syllable or a laugh over the other person does not flip it); 2 s shortest shot; 0.2 s lead before the voice. The plan is worked out on the server and stored in the op, so undo and the text check see exactly what was applied. |
| Live audio = rendered audio | The browser's biquads are the RBJ cookbook filters; FFmpeg's bass/treble are not (at w=0.7 they shelve like Q 1). The render moved to FFmpeg's lowshelf/highshelf at Q 0.7071 and the 1 kHz bell to Q 0.9198 (1.5 octaves) rather than the player imitating bass/treble, so both use textbook filters. The live chain is only attached to an element once a clip it plays needs it (a routed element stays routed), so edits without pan, EQ or reverb play exactly as before. |
| Masked adjustment layers | Masks, strength and fades, not per-pixel opacity keys: strength keys would need a filter per frame in FFmpeg, while a fade covers the common case (an effect easing in or out). Masks are the clips' own shapes and pictures; their keys are seconds from the layer's start (a layer has no footage time). Outside the masks the layer is transparent, so what is under it shows untouched. Strength scales the layer's alpha and the fades ramp it in straight lines (FFmpeg's fade on the alpha); the player uses the same function as CSS opacity. |
| Text anchor and motion blur | A text layer's anchor is a point of its own text box (0,0 top left), not of the frame: titles of different lengths turn about the same corner. Without one it keeps turning about its alignment point, so earlier edits look the same. The ASS file cannot move the rotation origin within an event, so the anchor is folded into the position (the alignment point lands at A + move + R·S·(P - A)) and turned or scaled text is cut into 0.05 s pieces to follow the arc. Motion blur on text is drawn as its own layer (libass on a clear frame at 4x the rate, averaged premultiplied), like motion blur on graphics; text drawn from a mask (video inside the letters, cut out) is not blurred. |
| B-roll card border | The border is the V1 border picture on the b-roll's own frame, laid on the picture before its keyframes move it, so it scales and turns with the card. |
