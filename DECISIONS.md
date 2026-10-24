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
