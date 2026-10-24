# Status

Last updated: 23 October 2026 (UTC). New: Phase 1 of the editor plan (docs/plans/phase-1.md). The timeline shows the edit as it renders, with no gaps. Picture and dialogue clips are linked and edit together. The player plays the real edit, or the rendered preview when it is up to date. The after-render check measures the file itself. The connector sends text only unless asked for images. One email is one account.

## 1. Links

| What | Address | Live? |
|---|---|---|
| Web app | https://web-production-9ef14.up.railway.app | Yes (since 23 October, 05:37 UTC) |
| API health | https://api-production-2428.up.railway.app/health | Yes |
| AI connector (MCP) | https://mcp-production-7fa0.up.railway.app/mcp | Yes |
| https://app.rendrr.live | Same web app on your domain | Yes (verified, certificate valid, 23 October) |
| api.rendrr.live | Verified | Certificate waiting: Let's Encrypt's hourly limit; retried automatically, then the app switches to it |

The Railway project `rendrr` runs Postgres, Redis, a private file bucket and the four services (`web`, `api`, `worker`, `mcp`), all in **US East**. Each service builds from the branch `claude/rendrr-backend-mcp-1vbkgg`, so every push redeploys it.

Checked on the live servers on 23 October: smoke test 23/23 (including the video breakdown, frames on request and reference videos), and the AI connector's full login and tools (see section 2).

### Still to do

- **Domains**: done on your side. app.rendrr.live works. api.rendrr.live is verified and gets its certificate once Let's Encrypt's hourly limit clears; until then the web app talks to the API's Railway address.
- **Keys after Railway's 21 October security incident**: new Clerk secret and AssemblyAI key from you. Already done: the file bucket keys (reissued by Railway; the services now reference them) and `INTERNAL_API_SECRET` (new; `mcp` references the one on `api`). Still to do: the Postgres and Redis passwords.

## Phase 1: the editor plays what renders

- **Edit time everywhere.** The timeline, the player, the comments and the playhead use seconds of the edit, not of the footage. Removed parts close up (ripple), so the timeline is as long as the output. The timeline logic lives in one module (`packages/shared/src/sequence.ts`). Every clip stores `sourceVideoId`, `sourceIn`, `sourceOut`, `timelineStart` and `timelineEnd`, ready for the sequence model B (`docs/timeline-model.md`).
- **Linked clips.** A V1 clip and its A1 dialogue split, trim and delete together, in the editor and through the connector. Alt-click, or Link/Unlink in the toolbar, unlinks them. Alt-drag trims one side.
- **Player = render.** The live player reads the render plan itself:
  - cuts closed
  - captions as the render times them
  - zooms on the same curve
  - b-roll
  - graphics (templates drawn with the recorder's own HTML and clock; custom graphics from their recorded file)
  - picture without dialogue plays muted

  Music and sound effects play only in the rendered preview (since Phase 3 they play live too). When the preview is of the current version and nothing has changed since, the player plays that file instead. "Render preview" sits in the editor's top bar.
- **The check measures the file.** After every preview render, the worker measures the file in one pass:
  - the length of each stream
  - black and silent stretches from 0.15 s
  - loudness and true peak
  - how much of the frame each graphic covers

  render_preview's check prints this next to the edit and flags every disagreement (length, audio/video sync, black, silence where words should play, picture without dialogue, a missing or invisible graphic). "Flags: none" only appears when the file and the edit agree.
- **Ops.**
  - `cut_silences` also trims the silence at the start and end of every clip. There's also a Cut silences button in the editor.
  - `cut_words` with `from`/`to` removes exactly that range, words or not.
  - The transcript gives word end times.
  - `set_clips` takes plain start/end, and A1 follows V1.
  - New op `set_link`.
- **Text first.** `get_footage` and `create_graphic` attach images only with `images: true`.
- **Footage filmed sideways** (found by the reference-video test). New op `set_rotation` and a Rotate button in the editor turn the footage 90°, 180° or 270° clockwise before it is fitted to the shape. It works the same way in the render, the live player and the check.
- **Position and scale of the footage** (found by the same test: the reference puts the speaker in a card at the bottom). New op `set_framing{scale, x, y}` and a Frame control in the editor scale the footage about its centre and move it, over black. Graphics can then frame it, for example a canvas with a window. It is static for now: Phase 5's keyframes will animate it.
- **Bug fixed in older work (Step 9, graphics):** graphics were encoded at VP9 crf 32 in realtime mode. Wherever a graphic stopped changing, faint ghosts of earlier frames stayed (a card's old rows showed through the next card). They are now encoded at crf 20, at the same speed, about 1.5× the file size. Cached template files are made again. Custom graphics recorded before this keep the old encoding until they are made again.
- **One account per email.** A new login with a verified email that already has an account opens that account. At start-up the API merges duplicate accounts that share an email: only empty ones are removed, their logins move over, and each merge is logged.

## Phase 2: the sequence (model B)

- **V1 is a sequence.** It's an ordered list of clips from any of your videos, played back to back: repeats, several videos, any order. Every edit closes up by itself. Cut words still work on the main footage, wherever it plays.
- **J and L cuts.** A clip's dialogue follows its picture. Its sound can start before its picture (J) or run into the next clip (L), or be muted. In the editor, Alt-drag an A1 edge. Through the connector, use `set_audio_offset`.
- **Other tracks hang on a V1 clip.** Zooms, b-roll, graphics, music and sound effects move with their clip when it moves and keep their length. A music bed covers the whole edit.
- **Turn and framing per clip.** Rotate and Frame apply to the selected clip, or to every clip of the footage.
- **Connector ops.** Old ops take the same input as before. New ops, one line each in the tool text:
  - `add_clip`, `move_clip`
  - `set_audio_offset`
  - `roll_edit`, `slip_clip`, `slide_clip`
  - `edit: true` on any timed op (times are then seconds of the edit)

  `get_project` lists the sequence: each clip's video, footage in/out, place in the edit, and J/L cuts.
- **Render.** The plan uses one input per video. Each part is fitted, turned and framed on its own, and the dialogue is joined from its own parts. For finals, other videos use their original when Rendrr keeps one, else their 720p copy (the plan says so).
- **Check.** It reads the sequence. A new line says how many clips and videos, moved clips, repeats, J/L cuts and muted clips. A muted clip is flagged once as picture without its dialogue.
- **Editor.**
  - Tools: Select (V: click, drag to reorder, drag an edge to trim), Razor (C), Ripple (B), Rolling (N), Slip (Y), Slide (U)
  - Snapping (S), Zoom to fit (Shift Z), Split at playhead (Cmd/Ctrl K)
  - Alt-drag a dialogue edge for J/L cuts
  - Add clip (any video, at the playhead or at the end)
  - Mute or unmute a clip
- **Player.** One video element per video on V1 and a sound element per video for J/L cuts, all following the plan. A cut, or a drift over 0.15 s, seeks again. While the picture that should show is loading, the clock waits (at most 1.5 s).
- **Migration.** At API start-up, each project still in model A is converted only if the new planner gives the same render, within one frame, as the old one. Its old timeline goes to `TimelineBackup` first, and its place in the list of edits is kept. A project that differs stays on A, renders exactly as before, and is logged. Old versions render with the old planner (`renderPlanA.ts`, unchanged) and convert when restored. Details: `docs/timeline-model.md`.
- **Bug found in older work (Phase 1, editor):** on dialogue clips the label covered the left trim handle, so Alt-dragging that edge did nothing. The handles are now above the label.
- **Changed key:** S used to split at the playhead. As in Premiere, S is now snapping and Cmd/Ctrl K splits. The Split button is unchanged.

### Phase 2 tests

| What | Result |
|---|---|
| Shared (sequence, ops, render plan, check, player clock, migration) | 86 pass |
| 500 random model A edits convert to the same plan | all 500 |
| Worker: the same edit rendered by the A graph and the B graph, decoded frame by frame and sample by sample | identical |
| Worker: two videos (different size and frame rate), a J cut and a muted clip | right video at each moment, the early sound under the J cut, silence when muted, streams 10.0 s |
| API: start-up migration (backup, same plan, list order kept, safe to repeat); AI adds another video's clip and a J cut and reads them back | 9 pass |
| Browser, demo: every tool, add clip, undo | all work, no page errors |
| Browser, real files: player across a cut between two videos, and a J cut | right element and moment; J cut plays the next clip's sound early |

### Phase 2 live (23 October)

- **Migration on the live database:** 2 projects converted, 0 left on model A. Both matched the old planner within a frame, with backups in `TimelineBackup`. The reference-video edit reads back at the same 54.6 s, with its turn, framing and five graphic cards each attached to a clip.
- **Through the connector (smoke-test account), a new edit:**
  - `set_rotation`, `cut_silences`
  - `add_clip` of a second video, `add_zoom` with `edit: true`
  - `set_audio_offset` (J cut), `move_clip`, `roll_edit`, `slip_clip`
  - `render_preview`

  The preview rendered from both videos. The check's sequence line read "12 clips from 2 videos, 1 moved, 1 J cut".
- **Bug found by the live test, fixed:** the check compared the file with the edit's length before frame alignment. Over 12 parts that added up to 0.11 s, so it flagged "file is 73.37s but the edit is 73.48s". The worker now stores the planned length with each render and the check uses it: file 72.70 s, planned 72.70 s, no flag.
- **Live editor (browser):**
  - 12 V1 and 12 A1 clips; the other video's clip has its own colour
  - J cut and muted dialogue shown on A1; all six tools
  - after a change, one player element per video; undo works
  - no page errors

## Phase 3: sound

- **Dialogue cleanup presets:** `none` (default), `light`, `voice`, `noisy`. Each is a fixed FFmpeg chain on the dialogue before the mix: high-pass, denoise, gate, de-esser, presence and compression, by preset. Any preset also puts a 4 ms fade at every dialogue cut, so cuts don't click.
- **Loudness:** files come out at **−14 LUFS** with a **−1 dBTP** true-peak ceiling by default. Both are settable, and normalization can be turned off.
  - The worker measures the mix first ("Measuring loudness" step: audio only, with its own timeout, progress and plain error).
  - It then renders with the exact gain and a limiter at 4× the sample rate, set 1 dB under the ceiling for the AAC encoder.
  - The gain is capped at +24 dB. A source quieter than that comes out below target, and the check says so.
- **Ducking:** music goes down a set amount under speech (default 12 dB, 0 = off). Speech is the spoken words in the edit: 0.2 s down before them, 0.5 s up after, joined when less than 1 s apart. It is an exact envelope (it replaces the old sidechain compressor), so the live player follows it.
- **Fades and levels:** each V1 clip's dialogue, each music clip and each sound effect has its own level and fades. The whole mix can fade in and out. Music without fades of its own keeps the automatic ones.
- **Connector ops (one line each in the tool text):** `set_audio{cleanup, loudness, peak, duck, fadeIn, fadeOut}` and `set_clip_audio{track, clipId, gainDb, fadeIn, fadeOut}`. `get_project` shows a `Sound:` line and each clip's level and fades.
- **Check (`render_preview`):** a new Sound line (cleanup, target, ducking, fades). The file's loudness line reads, for example, "Loudness of the file: −14.0 LUFS, true peak −1.6 dBTP (target −14 LUFS, ceiling −1 dBTP)". Flagged when more than 1 LU off target, or when the true peak is over the ceiling. Versions mixed before Phase 3 are checked as they were mixed.
- **Editor:**
  - An Audio tab: cleanup, loudness target, true-peak ceiling, ducking, mix fades, and the selected clip's level and fades. Sliders change the edit live and make an undo step when let go.
  - Fades are drawn on the A1, A2 and A3 clips. Levels show in the clip labels.
  - The live player now plays music and sound effects at the render's levels, with clip levels, fades, ducking and mix fades.
  - Dialogue cleanup and loudness are only heard in the rendered preview: the preview copies are served without CORS, so the browser can't process their sound. The Audio tab says so.
- **Bug found in older work (before Phase 1, render):** the old mix ended in `alimiter=limit=0.95`, which has FFmpeg's auto-level on by default. It pushed every file's peaks to about −0.4 dBFS, which is why earlier files measured about −13.5 LUFS with a true peak near 0 dBTP. New renders use the measured gain and a true-peak limiter with auto-level off. A sequence with loudness turned off keeps the old limiter, so it renders as before.

### Phase 3 tests

| What | Result |
|---|---|
| Shared: settings, ops, speech ranges, the FFmpeg curves equal the player's, graph, measuring mode, legacy check, fades in the check | 102 pass |
| Worker, real renders measured with ebur128 | 8 pass |
| ↳ quiet voice (−33 LUFS) | −14 ± 1 LUFS, true peak ≤ −0.8 dBTP |
| ↳ full-scale clicks on a voice | true peak under the ceiling, still −14 ± 1 LUFS |
| ↳ −23 LUFS / −2 dBTP target | met |
| ↳ far too quiet source (−47 LUFS) | +24 dB at most; the file's real loudness is reported |
| ↳ ducking 12 dB | 12 ± 1 dB under speech, back up after |
| ↳ mix fades, dialogue clip at −6 dB | > 12 dB fade, 6 ± 0.5 dB lower |
| ↳ noisy-room cleanup | voice over noise improves ≥ 6 dB, still on target |
| Worker, older tests (A/B identical render, two videos, J/L, check end to end) | pass |
| API: one `apply_edits` call with `set_audio`, `add_music` and `set_clip_audio`; `get_project` reads it back; the editor payload carries the signed music URL | 10 pass |
| Browser, demo build: Audio tab, selects, sliders (live, undo), clip level and fades, fades drawn, music `<audio>` volume, phone width | music −18 dB, −36 dB under speech with 18 dB ducking; dialogue plays at 1/1.585 when a clip is +4 dB; no page errors |

### Phase 3 live (24 October)

- **Through the connector (smoke-test account), a new edit on the existing 1:17 footage:**
  - one `apply_edits`: `cut_silences`, `add_music`, `set_audio` (voice cleanup, 12 dB ducking, mix fades 0.5 / 1 s)
  - one `apply_edits`: `set_clip_audio` on a dialogue clip (+3 dB, fade in 0.2 s) and on the music (−20 dB, fade out 2 s)
  - `get_project` read all of it back

| Render (540p preview, 70.4 s) | File, measured by the worker |
|---|---|
| default target, −14 LUFS / −1 dBTP | −14.1 LUFS, true peak −1.4 dBTP, about 10 s to render |
| `set_audio` −16 LUFS / −2 dBTP | −16.0 LUFS, true peak −2.8 dBTP |
| loudness off | −19.4 LUFS, true peak −4.3 dBTP, "loudness not normalized" |

- **Live editor (browser):**
  - Audio tab shows the edit's settings; A1 shows "Dialogue · +3 dB" with its fade; A2 shows "Soft lo-fi 01 · −20 dB" with both fades
  - after a change, the live player has a music element from the bucket, looped, at −33 dB under speech (−20 dB, ducked 13 dB)
  - undo restores the setting; no page errors
  - The test browser (Playwright's Chromium) can't decode AAC or H.264, so it could not play the sound itself. The music URL returns HTTP 200 `audio/mp4`. Chrome and Safari play AAC.
- **Bugs found by the live test, fixed:**
  - With loudness off, the check flagged "silent 0.42s at 1:09.5 where words should play". The last words were inside the 1 s mix fade-out the edit asked for. The check now ignores silence inside requested fades (the mix's and each dialogue clip's) and still flags it anywhere else.
  - `get_project` showed a music clip with only a fade-out set as "fades 0/2s", but its automatic 0.6 s fade-in still renders. It now reads "fades 0.6 auto/2s", and the Audio tab shows the automatic fades too.
  - Check wording: "2 clips have its own gain" now reads "their own".
- **Bug you found (from Phase 2), fixed:** adding footage from the computer was broken. Phase 2 styled the timeline's reorder marker with the class `.drop`, which the file drop zones already used. Every drop zone (Add footage, Recreate, the library's empty state, drag-over overlay and add tile) became a 3 px yellow strip that ignored clicks and drops, so "Choose files" could not be clicked. The marker is now `.tl-drop`, scoped to the timeline. A check of every CSS rule added since Phase 1 found no other shared class. A browser pass over every page and modal, desktop and phone: Choose files opens the picker and the file is added, drag-and-drop adds the file, nothing overflows or is squeezed, no page errors.

## Reference-video test (23 October, live, through the connector only)

The test: copy the edit of a finished reel (Glow Flow, 51 s, vertical) onto a raw talking-head video (77 s, 4K), using only the MCP connector, the way Claude would.

| | |
|---|---|
| Result | 54.7 s 1080×1920 final with the reference's layout: an animated UI card for every point on a pink canvas, the speaker in a rounded card at the bottom, bold captions, no pauses. Slate, director notes and repeated takes are cut. |
| Check of the file | Length and sync right, no black or silent gaps, captions on 100% of words, 5/5 graphics on screen. One flag: true peak -0.4 dB (audio clean-up is Phase 3). |
| Times | Preview 25 s, final 35-39 s (from the 4K original) |
| Calls | 31, of which 15 were create_graphic (the graphics were made three times while the gaps below were fixed). A clean pass needs 17. |
| Text | 24k characters back from Rendrr; 143k sent, almost all of it the graphics' HTML. 2 images in total. |
| Gaps found and fixed | Footage filmed sideways (`set_rotation`). Speaker placed in a card (`set_framing`). Ghosts in graphics (encoder). |
| Gaps left | Caption position and style (Phase 4). The edit's audio peak (Phase 3). Clip labels keep the first words of the original paragraph after cuts. |

## Every video as text and frames

Rendrr does the seeing and rendering; Claude only does the thinking. Right after the transcript, every video is read once ("Reading the frames", the last processing step). That covers footage and reference videos, from Google Drive, a computer or the sample:

- **Breakdown ("video code")**: every shot with its times, light, colour, motion, loudness and what is said; pacing (cuts per minute, words per minute, speech and silence share); the hook (first 3 seconds); loudness per second; the music beat. Claude reads it as a few lines of text.
- **Contact sheets**: frames every 0.5 to 5 seconds plus one in the middle of every shot, 16 to an image, with the time printed on each frame. A 40-second clip is 3 images.
- **Exact moments**: Claude can ask for any frame (`get_frames`), and Rendrr takes it from the preview copy.
- **Reference videos**: in Library › Add footage, switch on "Add as a reference" for a video whose style to copy. The Library has a References filter, and any video can be switched on its page. Claude finds references with `list_footage` (kind reference), reads one once with `get_footage`, and saves what it learned as a style (`save_style`); after that, reading the reference again returns that style in one line.
- **Where Claude gets it**: the connector's `get_footage` returns the breakdown as text plus one **overview image** (16 frames across the whole video). The other contact sheets and exact frames come only when Claude asks.
- **Where you see it**: every footage page has a **What Claude sees** section with the pacing, a shot strip, the contact sheets (click a frame to jump there) and the video code, plus Copy as text.
- Videos added before this got their breakdown automatically when the worker started. Videos added from a computer now also get key frames and a thumbnail; before, they had none.

## The AI connector: fewer tokens, no AI inside Rendrr (23 October)

Measured on the same 32-second test video and the same edit ("cut silences over 0.4s, remove fillers, bold captions, 2 zooms, upbeat music, render a preview, check it, render the final"), on a local copy of the stack:

| | Before | Now |
|---|---|---|
| Tool calls | 12 | 6 |
| Tool replies (text) | ≈1,850 tokens | ≈1,300 tokens |
| Images | 17 (≈9,780 tokens) | 1 (≈1,260 tokens) |
| Tool list, sent once per conversation | 38 tools, ≈6,150 tokens | 22 tools, ≈3,500 tokens |
| New tokens per edit | ≈17,800 | ≈6,100 (about 66% less) |

- **`apply_edits`**: every change in one call, saved as one version (undo reverts them together; if one change is wrong nothing is saved and the reply says which). It replaces 17 single-step tools. A short note from Claude goes to the editor's AI tab with the steps.
- **`get_footage`**: text plus one overview image by default; `pictures: "sheets"` (with a time range) or `get_frames` when Claude needs to see more; `pictures: "none"` for text only.
- **`render_preview`**: returns a text check instead of frames: length, pauses and fillers left, caption coverage, zooms, b-roll, graphics, music, cuts (and very short pieces), and the file's loudness (measured by the worker). `get_preview_frames` only when Claude wants to look. Finals come back without frames.
- **Styles from rules**: `apply_style` takes overrides (for example exactly 2 zooms), and `save_style` saves Claude's own rules, including ones taken from a reference video, so a reference is read once.
- **Shorter replies**: no repeated "render a preview" line, no long signed links (a link to the edit in Rendrr instead), lists 20 at a time, graphics params as one line each.
- **No AI inside Rendrr**: the editor's built-in Claude chat and the Anthropic key setting are gone. Speech-to-text (AssemblyAI) stays: it turns speech into timed words.
- **Fillers**: "umm", "uhh", "erm" and "hmm" now count as fillers (the audit found an "umm" left in a preview); stored transcripts were re-marked at start.

### Your connector login

Your Claude connector signed in with a Google login Rendrr had not seen, so it got a new empty account; your edits are in your website account. Rendrr now lets one account have several logins: the deploy links that Google login to the account that holds "IMG_0033 edit" and removes the empty one (only if still empty). For anyone else: Connect AI › **Link another login** gives a code; tell your AI "Link my Rendrr account with code …" and it calls `link_account`.

## New design (V2)

The web app now uses `ui/rendrr-ui-v2.html`, wired to the real backend:

- **Explore** (the new start page), **Create** pages per category (Clipping, Talking head, Ads, …) and **Styles** work without logging in. Liking, recreating, adding footage or using a style opens the login window first, then carries on.
- Explore shows only videos people publish; it starts empty ("The gallery is empty", with Publish a video). There is no dummy content: no example videos, no fake Google Drive, no sample footage buttons.
- **Editor**: the AI tab shows what Claude or ChatGPT did through the connector: each edit's steps and the short note it left for you. You can't type there; you ask for changes in Claude or ChatGPT. Every change is a new version you can undo.
- **Editor notes**: leave a note at any moment of the video; it sits next to your client's review comments.
- **Billing** page: plans, card and invoices (payments are not switched on yet, see below).
- **Final ready** popup: Save to this computer, or Save to Google Drive.

### Phones and tablets

Under 1024px wide the app has its own touch layout (the desktop design above that is unchanged): the top bar wraps with the categories scrolling underneath, a bottom tab bar (Explore, Projects, Add, Library, Account) when logged in, dialogs and the login window as bottom sheets, one- or two-column grids, and an editor that stacks the player, the Comments/AI/Style/Transcript panel and the timeline. Checked on every screen at 360px, 390px, 820px and 1440px wide.

### Preview without the backend

A clickable preview of the whole UI runs in the browser with the design's demo data (no server, no real login): https://claude.ai/artifact/KduyKRPmudMLzg9L7fBZF5 (private to you until you share it from its Share menu). Rebuild it with `pnpm --filter @rendrr/web preview:build`.

In the preview you can log in with any email and password, browse Explore and the categories, add footage (sample, the fake Drive, or a video from your phone or computer, which then plays in the editor), make an edit, cut words, leave notes, render a final, share a review link and open the client page, publish to the gallery, and change plan or settings. Nothing is saved: a reload starts fresh. Downloads and "Save image" do nothing inside the preview window.

## 2. What works end to end

**On the live Railway servers (23 October)**: smoke test 17/17 (transcript by AssemblyAI in 12–25 s, 540p preview in 4.5 s, 1080p final in 13.5 s). The AI connector logs in like Claude does and lists 36 tools; apply_style, cut_silences, cut_words, add_zoom and add_music each save a new version. The web app loads Explore (29 examples) and the login window on desktop and phone.

Earlier, on a full local copy of the system (Postgres, Redis, S3-compatible storage, real Clerk login, real AssemblyAI), and again **from the exact Docker images Railway will build**:

- **First start on an empty database and empty bucket** (what Railway will do): migrations, seed, built-in media generation and the full smoke test all pass from the Docker images.
- **Smoke test: 17/17 steps pass** (log in → add footage → transcript, silences, scene cuts, key frames → create an edit with a style → AI edits → autosave → preview render with live progress → 1080p final → password review link → client comment → resolve → approve → usage).
- **AI connector**: log in like Claude does (dynamic client registration, PKCE, Clerk login, consent screen), then every main tool: list and read footage, apply a style, cut silences, add zooms, music, graphics, captions, render a preview and look at its frames, make a custom animated graphic, create a review link, read comments, undo.
- Footage: files from your computer (preview copy made in the browser, original uploaded once for a full-quality export) and Google Drive once its keys are set (until then the Drive tab says it is not set up yet). The automated test still uses the API's built-in sample clip.
- Editing: every change goes through one function with version history, AI changes are undoable, the editor pulls AI changes in live and refuses to overwrite them.
- Rendering: 540p previews in about 6–12 s and 1080p finals in about 13–17 s for a 30 s edit; captions in three looks, zooms, b-roll, graphics with transparency, music ducked under speech, sound effects.
- Reviews: password, expiry, download on/off, comments at a time, approve, request changes, folder reviews.
- Daily cleanup at 03:15 UTC (expired preview copies, raw originals after 24 h, old preview renders, stuck jobs).
- **The new design clicked through in a real browser** against the real API and worker (21 October): Explore and every Create page signed out, the login window (and carrying on with what you tried), Library, Recreate, the editor (transcript cuts, notes, AI chat, versions), the final render and its download, gallery publish and likes, Billing, Usage, Connect, Settings, search, client review links. Two rounds: the first found 3 crashes and 8 smaller bugs, all fixed; the second found none.
- **The previous design was also clicked through** against the real API and worker (about 290 checks): login and sign-up, gallery, library (sample, fake Drive, your computer, retry, resume, rebuild), footage page, project folders, the editor (cuts, captions, zooms, music, renders, versions, AI undo, local export), the client review page, Connect AI, Usage, Settings (including email change with the emailed code), search and menus.
- 22 unit tests for the timeline maths and the render plan.

## 3. What is stubbed, and the key that turns each one on

| Stub | What happens now | Key that unblocks it | Where it goes |
|---|---|---|---|
| Google Drive | The Drive tab says Google Drive is not set up yet (the fake Drive with demo folders is gone) | `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` (Google Cloud → OAuth client, Drive API on, redirect URI `https://api-production-2428.up.railway.app/drive/callback`) | Railway → `api` and `worker` → Variables |
| Billing | The Billing page shows Free / Pro / Studio. Switching changes the plan name and storage figure only; there is no card, no invoices and no limits | `STRIPE_SECRET_KEY` (plus product setup, not built yet) | Railway → `api` |
| Save final to Google Drive | Says it is not switched on yet; Save to this computer works | Same Google keys as Drive (above) | Railway → `api` |
| Transcription | **Real** (your AssemblyAI key is set). Without a key every video would get the sample transcript | `ASSEMBLYAI_API_KEY` | already set on `api` and `worker` |
| Login | **Real** Clerk (development instance `mature-joey-7879`; Google login uses Clerk's shared test credentials) | For a public launch: a Clerk production instance and your own Google OAuth app | Railway → `api`, `mcp`, `web` |

Keys live only in Railway's settings and in a local `.env` that is never committed.

## 4. The one command to test it

After the services are live (step 1 above):

```bash
API_URL=https://api-production-2428.up.railway.app CLERK_SECRET_KEY=sk_test_... pnpm smoke
```

It prints PASS or FAIL for each of the 24 steps. Details and the AI connector test: [SMOKE_TEST.md](SMOKE_TEST.md).
To try it by hand: open the web app, sign up, add a short video from your computer in the Library, wait for Ready, then make an edit.
To try the AI: in Claude, Settings → Connectors → Add custom connector → `https://mcp-production-7fa0.up.railway.app/mcp`.

## 5. Changes to the UI, and why

| Change | Why |
|---|---|
| Phone and tablet layout (bottom tab bar, bottom sheets, stacked editor) | The design was desktop only; on a phone it was shrunk to a tiny page |
| Explore shows only real published videos (no example videos, no invented creators, likes or views) | No dummy data in a real app |
| Billing: "No card on file. Payments are not switched on yet…", "No invoices yet.", PDF button only for a real invoice | Payments are stubbed |
| The editor's AI tab only shows what Claude or ChatGPT did through the connector, with their notes; there is no chat box | Rendrr runs no AI of its own: Claude does the thinking, Rendrr measures and renders |
| Connect AI has "Link another login" | So an AI that logged in with a different account can be pointed at yours with a code |
| Your own saved styles (for example ones Claude saved) have "Delete style" | Claude can now save styles |
| The hint on "Preview up to date" now says the player shows changes live and a preview render burns in captions, zooms and music | Previews are not rendered after every change |
| "Save to Google Drive" says it is not switched on until the Google keys are set | Google Drive is not set up yet |
| Logging in with Google and logging out land on Explore | Explore is the new start page |
| Connect page: the sentence about a private URL now says it is one URL for everyone with a login | The connector uses OAuth (Phase 0 answer) |
| "720p preview" text now says 540p | Previews render at 540p (Phase 0 answer) |
| Password reset gained a "code + new password" step | Clerk sends a code by email; the fake API had no real reset |
| Changing your email asks for the 6-digit code Clerk emails to the new address | Otherwise anyone could claim an address they do not own |
| New `/drive-done` page (only seen if the Google popup is blocked) | Finishes the Drive connection safely in your own logged-in tab |
| Demo state switches (profile menu) only exist in development builds | They fake errors; real users should never see them |
| The share dialog preselects the newest version | It preselected v1, which on the real backend is the raw footage |
| Retry on footage from your computer asks for the file again | The browser forgets the file after a reload; without it Retry hung |
| The client review page makes a preview for a version that was never rendered | Otherwise picking that version showed "Rendering…" forever |

Everything else is the UI from `ui/rendrr-ui-v2.html`, wired to the real API. (The old design stays in `ui/rendrr-ui.html` for reference.)

## Bugs found and fixed tonight

Three reviews (API, worker/render, web app) plus tests in the real Docker images. The important ones:

- Anyone could make a render pull another user's raw audio by putting its storage path in a music clip. Music and sound effects now come only from the built-in catalog.
- A request with an empty login token crashed the AI connector for everyone. Now it gets a normal "not logged in" answer.
- Rate limits could be dodged (fake header, spoofed IP), and the tighter limit on public review pages never applied. Review passwords are now limited to 10 guesses a minute.
- Live update streams leaked Redis connections when a browser disconnected early.
- Review links kept working after the edit was deleted; links can now be revoked.
- Rendering wiped "In review" / "Approved"; a render request could return an older version's render.
- Splitting the same clip twice failed; sound effects placed by the AI were silently dropped.
- Email change marked any address as verified; the Drive connect link could be used to attach someone's Drive to another account.
- Deleting a folder or footage left raw files in storage.
- All four Railway services and the databases were in Singapore while the file bucket is in US East; moved to US East.
- Picture and sound drifted later with every cut (about 1 s on a long edit) and the end was cut off. Cuts are now frame-exact: 0 ms drift on a 167-cut test.
- Zooms zoomed into the top-left corner instead of the face. Now centred.
- Finals from HDR phone footage came out washed out. Now they match the preview.
- Captions: some characters showed as empty boxes, Chinese/Japanese/Korean had no font, rewritten caption lines lost most of their words.
- Graphics lost their ending animation when words inside them were cut.
- A stalled download could block the render queue forever; time limits now also grow with long footage.
- On a first start the built-in sample footage was generated without speech (about 10 KB). Fixed and checked inside the worker image.
- Smaller: short music clips went silent early, cutting the last word left its tail, the graphics sandbox could send network traffic through WebRTC, frames taken for the AI were never deleted.

## Known limits (not blocking a test)

From the new design itself (kept as designed):
- `/styles` opens the Clipping wall; style packs are picked when you make an edit.
- There is no "Render preview" button: the player shows every change live, and "Render final" makes the video. (The AI connector can still render previews.)
- The dark look is the only theme.
- The plan cards and the sign-up box mention render limits, 4K and seats. None of that is enforced yet (no payments).

From before:

- The web app runs on Railway, not Vercel: the Vercel connector here may read projects but not create them. Moving later is described in [DECISIONS.md](DECISIONS.md).
- Login says whether an email has an account (friendlier messages; fine for a private app, change before a public launch).
- One worker renders one video at a time (`CONCURRENCY_RENDER`); raise it or add replicas when more people use it.
- Very heavily cut long edits (thousands of cuts on footage over 10 minutes) render slowly; normal edits (a few hundred cuts) are fine.
- The original design has no button to delete footage or to remove a profile photo, so there is none.
- A style found through the search box opens the Styles page, not that style.
