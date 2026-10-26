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
| Recording graphics | Ranges recorded at once by `GRAPHIC_WORKERS` browsers (the container's CPU quota minus one, at most 6, and at about 100 threads a browser, 500 threads left under the cgroup's pids.max for a render at the same time; 5 on the live worker). Each range's pages step their clock frame by frame from 0 without drawing, so state, timers and transitions arrive as if playing. Up to 15 s every frame is captured; longer graphics are sampled every 0.5 s on a quarter-size picture. Pieces of 240 pictures are encoded as they come (encoder clock on the 30 fps grid) and joined without re-encoding. Limit: 90 s + frames x (40 + 130 x pixels/1080x1920) ms / workers, at most 25 min. |
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

