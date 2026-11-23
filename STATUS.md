# Status

Last updated: 31 October 2026 (UTC). New tonight: object tracking, a face-aware Morph Cut, Higgsfield-style comments and a UI sweep (see the sections below). New: Rendrr is the engine, Part 6: a real waveform on the timeline from the 10 ms peaks with deeper zoom, marks as thin coloured lines with notes and a toggle, and the measurements taken off the footage page (see "Engine Part 6" below). Part 4: a hidden library for the AI (48 ready animations, 5,844 icons, all font weights) and analyze_reference, which measures a reference video into a style file (see "Engine Part 4" below). Before that: Part 5: test_graphic (a few seconds of a graphic over the footage in under 10 s), and long busy graphics record in 90 s chunks without running out of memory (see "Engine Part 5" below). Before that: Part 3: the preview check reads the preview file's own sound (gaps placed at the joins, clicks at the joins), names the words a cut goes through in ms, says how much of the face each graphic covers, and the preview is transcribed again so "Transcript as it plays" is what a viewer hears (see "Engine Part 3" below). Before that: reference-edit blockers fixed (cards, backgrounds, sideways footage, the op list). Before that: Rendrr is the engine, Part 2: every video measured more deeply (the sound every 10 ms, where each word starts and ends in the sound, faces and the picture), with four new tools (see "Engine Part 2" below). Before that: one edit from several videos (see "Several videos in one edit" below). Before that: Rendrr is the engine, the AI is the editor. Part 1: marks instead of automatic edits (see "Rendrr is the engine" below). Before that: long graphics, reusable graphics, fonts, quick tool calls, the graphic check and face framing (see "Faster graphics and framing" below). Before that: Phases 6-8 of the editor plan. Phase 6: colour and compositing. Phase 7: export settings, the footage's frame rate kept, time left while rendering, and graphics as long as the video. Phase 8: a 20-minute talking head edited live through the connector only, in 8 calls with no images (see "Phase 8" below). Earlier phases are described in their own sections.

## 1. Links

| What | Address | Live? |
|---|---|---|
| Web app | https://web-production-9ef14.up.railway.app | Yes (since 23 October, 05:37 UTC) |
| API health | https://api-production-2428.up.railway.app/health | Yes (served by `api2` since 2 November) |
| AI connector (MCP) | https://mcp-production-7fa0.up.railway.app/mcp | Yes |
| https://app.rendrr.live | Same web app on your domain | Yes (verified, certificate valid, 23 October) |
| api.rendrr.live | On `api2` (not used by the app) | Needs its DNS CNAME changed to `oefcghrl.up.railway.app` |

The Railway project `rendrr` runs Postgres, Redis, a private file bucket and the four services (`web`, `api2`, `worker`, `mcp`), all in **US East**. Each service builds from the branch `claude/rendrr-backend-mcp-1vbkgg`, so every push redeploys it.

Checked on the live servers on 23 October: smoke test 23/23 (including the video breakdown, frames on request and reference videos), and the AI connector's full login and tools (see section 2).

### Still to do

- **Domains**: done on your side. app.rendrr.live works. api.rendrr.live is verified and gets its certificate once Let's Encrypt's hourly limit clears; until then the web app talks to the API's Railway address.
- **Keys after Railway's 21 October security incident**: new Clerk secret and AssemblyAI key from you. Already done: the file bucket keys (reissued by Railway; the services now reference them) and `INTERNAL_API_SECRET` (new; `mcp` references the one on `api`). Still to do: the Postgres and Redis passwords.

## Slow exports on the Mac (23 November)

Watched a live V3 final on the MacBook Air: 15 minutes on "Getting the files to your Mac", then about 45 minutes of
encode left, then "The render took too long".
- **The Drive original was downloaded on every final.** Footage in Rendrr's storage was kept in the Mac's cache, but an
  original in Google Drive (V3: 4K DJI, 8 min 41 s, several GB) was fetched whole each time. Now it is kept too, by its
  Drive file, size and when it last changed (a changed file is fetched again): the next final of the same footage
  fetches nothing. A Drive sign-in lasts an hour; a download that outlasts it asks Rendrr for a fresh one
  (POST /desktop/tasks/:id/link). Big files now come in six ranged requests at once (one connection to a far-away
  server is slow); a server without ranges gives the file in one piece. New Mac app needed (desktop/render.js).
- **The encode crawled.** One pass of a heavy edit (V3: 62 cuts, punch-ins, 3 full-length graphics, 4K footage) needs
  about 3.7 GB; on an 8 GB MacBook Air with the app and a browser open it swaps (the same final takes 3 minutes on
  four cloud cores). A heavy final (12+ inputs or 60+ scalers) on a Mac is now made in pieces of about 15 s, as the
  cloud makes one: the sound once, each piece's picture, joined under the sound (lib/macPieces.ts).
- **The time limit counted the download.** The job's limit (13 minutes plus allowances for V3) is now moved later while
  the Mac fetches the files, up to two hours in all; a preview's own clock stops meanwhile. The stuck-render sweep
  leaves a render alone while it still reports progress.
- **"About 5 s left" for the whole download.** The time left now follows the download's own pace, then the encode.

## Exports failing: the Mac app seen as closed, the cloud out of memory (22 November)

- **The Mac app counted as closed all day.** At 03:59 UTC the Mac app started while the API was restarting: its first
  look at the account got a 502, and the app took that as logged out for good (it never asked again), so it showed the
  public pages and never pinged; Claude rendered in the cloud. Now a failed look (network, 5xx) keeps the session and is
  asked again (1 s, 2 s, 4 s ... up to 30 s); only no session or a refusal (401) logs out (demo/auth-retry.mjs).
- **Cloud finals of the V3 short were killed for memory** (the worker is capped at 6 GB and 6 CPUs, a limit set on
  Railway). The edit: 62 cuts of 4K 10-bit portrait DJI footage, one grade on every clip, three full-length graphics,
  two clips with a punch-in. Rebuilt here with synthetic 4K 10-bit HEVC: FFmpeg peaked at 5.4 GB.
  - Two clips moving made every clip drawn and graded on its own; each clip's grade chain keeps its frames to the end.
    Now the same plain grade on every clip (colour only, SDR, every clip filling the frame) is drawn once on the joined
    picture: 5.4 GB to 3.7 GB, 254 scalers to 132, the same picture (test/shared-look-render.test.ts).
  - The WAV (and M4A) export made the whole picture and dropped it, as heavy as the video: it makes no picture now.


- Asked: the overexposure flash in a reference clip (the picture blowing out to white on the cut and coming back), which
  Claude could not make: Rendrr's only "white flash" was dip-white, a flat white layer fading in and out.
- New transition `flash` (set_transition type flash, 0.5 s by default; the editor's Transition menu: Flash
  (overexposure)). The picture itself is blown out, not covered: in float RGB its exposure and black level are set frame
  by frame (sendcmd), so the highlights go white first and a dark shirt comes up to a light grey; what goes over white
  glows (blurred, screened over). The curve (flashLevel) builds over the last frames before the cut, peaks on the cut's
  first frame, falls fast and fades out softly. Fitted to the user's clip: through Rendrr's own render its frames are
  221, 108, 88, 80, 76 against the clip's 228, 117, 90, 81, 76 (of 255, on a frame of 70). On a first clip it opens on the
  flash. HDR stays under SDR white. The editor's player draws the same values (CSS brightness under a white layer;
  checked in Chromium against the render's map).
- Claude's tool text says what flash is and how it differs from dip-white; the library's "Transition: overexposure
  flash" and analyze_reference's white flashes now use it.
- Tests: packages/shared/test/flash.test.ts, apps/worker/test/flash-render.test.ts (FFmpeg frame by frame, and the
  player's CSS), the editor's menu in demo/phase20.mjs.

## Cloud renders, the Mac seen as closed, and storyboards shown again (22 November)

- **Every cloud render of one edit failed at "Cutting clips"** ("Stream specifier ':v' ... matches no streams"). A
  block of the person's cut-out (remove_background) had been made with no frames when the worker could not read the
  footage, kept, and joined into every render after; "Render again" read the same block. matte.py now fails when its
  reader fails or reads nothing (the job tries again), the worker checks a block has a picture before keeping it, and a
  kept block with no picture is taken out of storage and made again (test/matte-kept.test.ts).
- **Claude said the Mac was not connected while the Rendrr app sat in the Dock.** The logs showed the app's ping every
  20 s until the evening, then nothing: on a Mac, closing the window closed the page that pings, while the app stayed in
  the Dock. Now closing the last window hides it (the page keeps running, pinging and rendering; the Dock icon brings it
  back; Cmd+Q quits). The app also pings at once after a wake-up or screen unlock, reloads a page that crashed or froze
  for 30 s, and says once when the computer cannot reach Rendrr (renders then go to the cloud). With no app open but one
  seen today, Claude is told when and where it was last seen and what to ask the user (get_project's Exports line and
  the render answers), instead of only "not open". Needs the new desktop build for the window part.
- **Claude could not show a storyboard again.** Only the first create_storyboard answer opened it in the chat.
  open_projects now takes renderId (a storyboard or samples) or storyboard: true with the edit, and get_project names
  the edit's newest storyboard.

## Storyboard mode (22 November)

- Asked: an optional storyboard before the whole render. A board of frames and short clips made from the user's ask,
  with captions, fonts, caption animation, visual rules and colours. Users comment on a panel, draw on it with a
  comment for Claude, approve it, then render the full video. Editing straight away still works the same.
- What it is: a set of samples with a board (`packages/shared/src/storyboard.ts`). Each panel is a frame or a short
  clip drawn exactly as the export draws it, so the final matches the board.
  - Panels: up to 24, 8 of them clips of up to 6 s. Each has a title, the words said, what we see and a note.
  - Rendrr fills in the words on screen at each panel (captions and text).
  - Style sheet, read from the edit when the board is drawn: caption font, size, colours, case, position and how they
    come on (3 words at a time, the spoken word lit in green); text fonts and animations; every colour with its use;
    look, background, transitions, music, sound and pacing.
  - Claude's visual rules and palette sit on the board too.
- Claude: new tool `create_storyboard` (54 tools now), only when the user asks to storyboard first. `get_samples`
  reads a board: the style sheet, panels, the user's changes per panel, and whether they approved it. With images,
  each drawing comes laid on its panel's picture.
- Editor: "Storyboard" in the top bar's menu and in tool search (`apps/web/src/rendrr/storyboard.js`).
  - Empty: "Make storyboard" (Rendrr picks the opening, scenes, titles, graphics and b-roll), or ask Claude.
  - The board: numbered panels with their words under each, like a printed storyboard; clips play on hover. The style
    sheet is above: captions drawn in their own font and colours, font specimens, colour swatches, rules.
  - A panel opens big: draw on it (5 pens, undo, clear), write the change, "Add change with drawing". Changes are
    listed per panel, can be resolved, and "Send to Claude" sends them.
  - "Make again" draws it from the edit as it is now. "Approve", then "Render the video" starts the preview.
  - Claude's link (`/editor/<id>?storyboard=<board>`) opens that board.
- Claude's chat app shows a board too: panel titles and words, "Open the board in Rendrr" (to draw), and
  "Approve: render the video" (new app tool `app_approve_storyboard`).
- API: `POST /projects/:id/storyboards`, `GET /projects/:id/storyboards`, `GET /storyboards/:id`,
  `POST /storyboards/:id/approve`; comments can carry `renderId` from the editor.
- Worker: picks the panels when left to Rendrr, fills the words on screen, reads the style sheet and keeps it with
  the board. The frames job lays a comment's drawing on a panel's picture.
- Tests: `packages/shared/test/storyboard.test.ts`, `apps/api/test/storyboard.test.ts` (with a database),
  `apps/worker/test/storyboard-render.test.ts` (the real render job draws boards), `apps/web/demo/storyboard.mjs`.

## Studio voice: real AI voice cleanup (20 November)

- Asked: asking for less echo, more crispness, more volume or a podcast sound did little. The old presets only had
  FFmpeg's FFT denoiser and EQ.
- Looked at the open-source options (only MIT or Apache-2.0):
  - **DeepFilterNet3** (MIT or Apache-2.0): the best noise and room removal that runs fast on a CPU. Used.
  - **WPE dereverberation**, after nara_wpe (MIT): the classic echo remover, no model. Used.
  - Resemble Enhance (MIT) and ClearerVoice MossFormer2 (Apache-2.0) are closer to Adobe Podcast (they rebuild the
    voice), but need a GPU to be quick. Not used yet; they fit a GPU worker later.
  - VoiceFixer (MIT): older, vocoder artefacts. Not used.
- New preset **Studio voice** (`studio`), first after Off: AI noise and room removal, echo removal, a full close-mic
  tone (body, less mud, presence, air), crispness, de-esser, leveling and compression, then the loudness step.
- Podcast voice, Clean voice, Clean up noisy dialogue and Dry up a roomy voice now use the AI instead of the FFT
  denoiser and the gate.
- Four new values, by hand over any preset (set_audio, the editor's Fine-tune):
  - `enhance` 0-100: AI noise and room removal (DeepFilterNet3).
  - `dereverb` 0-100: echo removal (WPE).
  - `level` 0-100: quiet and loud sentences evened (FFmpeg dynaudnorm, up to +12 dB).
  - `crisp` 0-100: sparkle above 6 kHz (FFmpeg aexciter).
- How it runs:
  - The worker makes the clean voice before the render (`apps/worker/python/voice.py`, `apps/worker/src/lib/voice.ts`),
    from the preview copy, in 30 s blocks of footage. Each block is kept with the video (`frames/<user>/<video>/voice-...`),
    so the next render, the final and a render on the Mac or PC reuse it.
  - The render reads the clean voice in place of the footage's sound; the tone chain stays in FFmpeg, so tone changes
    need no new AI pass.
  - The model is DeepFilterNet3's official ONNX export, pinned at v0.5.6 and checked by hash in the worker image. It
    runs on onnxruntime (already in the image). The features are written in numpy as libDF computes them.
  - The render's time limit grows for it (`voiceAllowanceMs`).
- Measured here (4 CPUs): about 8x faster than real time with both steps (echo removal is two thirds of it; noise
  removal alone is about 35x). Noise between words drops 25-39 dB above 80 Hz; the voice keeps its level within 2 dB.
  Echo: about 2 dB cleaner on a medium room.
- Claude's tool text says which value to use: less echo `dereverb`, less noise `enhance`, crisper `crisp` and
  `presence`, even volume `level`, louder `loudness`.
- A leveling setting found while testing: dynaudnorm's threshold option turned speech with pauses down by 10 dB, so it
  is not used.
- Tests: `packages/shared/test/studio-voice.test.ts`, `apps/worker/test/studio-voice.test.ts` (real speech, noise and
  echo, the blocks, the join and a render), `apps/worker/test/audio-render.test.ts` (noisy room on target at -14 LUFS),
  `apps/web/demo/audio6.mjs` (the preset and the sliders).

## Heavy finals timed out (6 November)

- The V30 final (Shift performance therapy) failed twice with "took too long". Worker log: 43 inputs, 224 scalers. The one pass ran 10 minutes, was killed for memory, started again in 9 pieces, and hit the job's 16-minute limit at 78%.
- Fixes:
  - A final with 24+ inputs or 150+ scalers is made in pieces from the start (`piecesFirst`, `apps/worker/src/jobs/render.ts`), so no time is lost on a pass that cannot fit in memory.
  - A render's time limit grows with its layers (`layerAllowanceMs`, `packages/shared/src/look.ts`): 20 s per b-roll, graphic, text, music, sound effect or other V1 video for a final (5 s for a preview). V30's limit goes from 16 to about 30 minutes.
- Tests: `packages/shared/test/layer-allowance.test.ts`, `apps/worker/test/pieces-first.test.ts`, and the pieces render test (pieces match one pass frame for frame).

## Drive picker: one import bar, not two (6 November)

- Inside a Drive folder the picker showed two bars: "Bring in all of <folder> / Import this folder" and, under it, the bar for what was ticked ("1 folder selected / Import 1 folder"), each with its own "With its folders" box.
- Now there is one bar at the bottom with one button: with nothing ticked inside a folder it is "Import this folder" (naming the folder); once videos or folders are ticked it is the ticked ones ("Import 1 folder", "Add 2 videos"). One "With its/their folders" box.
- Test: `apps/web/demo/library-folders.mjs` (one bar, one button, one box, with and without ticks).

## The editor made clean and dark like Edits (6 November)

- Rail icons redrawn in one plain outline style like the Edits app's (my own drawings: picture, music notes, "Aa", "CC", three rings for Color, a camera for Multicam, a page for Transcript, a bookmark, a sparkle, a speech bubble).
- No coloured backgrounds: the open tool, the active timeline tool and toggles just turn white. While no tool is open the rail shows the names beside the icons; with one open, icons only.
- Darker (#0b0c0e) and flat: no cards or shadows; the rail, the open tool, the player, the inspector and the timeline are split by hairlines. Settings in the panes are flat sections with hairlines. Top bar buttons are outlined pills; Export is a white pill.
- The inspector with nothing selected only says "Select a clip".
- Phone: the top bar grows with its rows (it overlapped the player).
- Tests: `apps/web/demo/panel.mjs` (names only while no tool is open, no coloured background, empty inspector says only "Select a clip"), plus the phone and comment tests.

## The editor laid out like Instagram Edits for Mac (6 November)

- Studied from the screen recording you shared (Edits for macOS, every screen). The lupikovoleg/instagram-edits-sdk repo (MIT) is a Reel analytics SDK (insights, retention); it has nothing on the editor's layout, so nothing was taken from it.
- Same structure as Edits, with Rendrr's own look and features:
  - Top bar: back, name, version; aspect ratio menu (9:16 Reels, TikTok, Shorts / 16:9 / 4:5 / 1:1, set_aspect); quality menu (resolution and frame rate, set_export, and More export settings); Search tools (every panel and action by name, Enter opens the first); Samples, Share for review, Export.
  - Left: a rail of tools (Media, Audio, Text, Captions, Color, Multicam, Transcript; then Reference, Your AI, Comments with a count). Each opens in the panel beside it, Media first; its X closes the panel and the player takes the room.
  - Middle: the player.
  - Right: the inspector, the settings of what is selected: a clip shows speed, motion, transition and its sound; a text its content and style (and keyframes); music or a sound effect its level and fades; an adjustment layer points to Color. Nothing selected: "Select a clip" and the project's shape, length, version, captions and export.
  - Bottom: the timeline across the whole width, its tools in one bar (select, razor, ripple, roll, slip, slide; split, add, rotate, frame, delete, mute; snapping, marks; undo, redo; zoom). Track names are short (V1...), the hint on hover.
  - Phone: player, the rail as one scrolling row, the open tool, the inspector, the timeline.
- Code: `apps/web/src/rendrr/editor.js` (rail, panel, inspector, top bar), the Text and Audio tools split in parts (the panel shows what to add and the whole edit; the inspector the selected item, never twice), `export.js` (QualityMenu), `styles.css`.
- Tests: `apps/web/demo/panel.mjs` rewritten for this layout (desktop and phone: rail groups, every tool opens under its name with nothing cut off, X closes and the player widens, inspector for nothing, a clip and a text, aspect menu and undo, quality 4K, search tools, tools in the timeline's bar, comment pins); the other browser tests now find a clip's settings in the inspector.

## Finals from another copy of the footage came out upside down (6 November)

- A final came out upside down while the editor and the preview were upright. The edit was made looking at the preview copy, which the browser makes from the file first added (here a "-compressed" file stored upside down, so the edit turned it 180°). Since the original may now be a renamed or re-saved copy, the copy given for the final (likely the camera's own file) was stored the right way up, so the edit's 180° turn made the final upside down.
- Checked first: the browser's FFmpeg (5.1, ffmpeg.wasm) and the worker's (7.1) agree on every orientation tag (rotations, flips, rotation with a flip), so tags were not the cause.
- Fix (`apps/worker/src/lib/orient.ts`, used by the render job for local finals): before rendering, small grey frames of the original and of its preview copy at 4 times are compared in each of the 8 ways a picture can face. When another way clearly matches better than the file as it plays (here -0.93 against 1.00), the file's orientation tag is rewritten (its streams copied, no new encode) and checked again. A copy that already faces the same way is left alone. So the final always faces the way the editor showed.
- The timeline's clip pictures now show a turned clip turned, as it plays (`filmstrip.js`).
- Tests: `apps/worker/test/facing.test.ts` (upside down, sideways, mirrored, a wrong tag: fixed; the same way up, plain or through its tag: left alone), `apps/worker/test/original-length.test.ts` (a copy stored upside down makes a final that matches the preview copy, likeness 1.00), `apps/web/demo/filmstrip.mjs` (a clip turned 180° shows its frames turned).

## The original file: a renamed or re-saved copy is accepted (6 November)

- Picking the original still said "That is not the same file" for a file the user says is the right one. The check wanted the exact name and the exact size from when the video was added. A renamed copy, a re-saved one, or a name with a different hidden space failed, and the message did not say what was picked.
- Now (`packages/shared/src/original.ts`, used by the web app and the API): names compare as people see them (case, Unicode form, no-break spaces). If the name or size still differs, the browser reads the picked file's length from its header (`fileLength` in `apps/web/src/rendrr/local.ts`; FFmpeg if the browser can't), and the same length (within 1 s or 0.5%) counts as the same video. The uncompressed file a compressed one came from is accepted too, and the final is made from it.
- The worker checks the length again on the uploaded file itself before rendering. A different video stops with both lengths ("The file you gave is 0:07.0 long; the footage is 0:03.0 ...") and is deleted, so the next export asks again.
- A refused file now says both sides: "You picked 'other.mp4' (9 MB, 0:31.0); we need '...' (1482 MB, 10:58.7)."
- Tests: `packages/shared/test/original.test.ts`, `apps/api/test/original-file.test.ts` (the route takes a renamed copy of the same length, refuses another video), `apps/worker/test/original-length.test.ts` (a 7 s file for 3 s footage is refused and deleted; a renamed 3 s copy makes the final), `apps/web/demo/file-length.mjs` (the real length reader in Chromium), `apps/web/demo/original-file.mjs` (the editor flow).

## Export final with footage from this computer (5 November)

- "Upload original and export" did nothing but say "Pick the original file to continue." The window showed that button whenever the browser remembered the file from a drop (Chrome keeps a handle to it), but the upload only looked for a file already open in the tab, which is gone after a reload. The picker button was hidden, so there was no way through.
- Now the button opens the remembered file in the click (Chrome may ask to allow it) and, if it can't, opens a file picker. A "Pick the file" button is always there too. The final keeps the Export window's choices (Best quality).
- Claude's message for this case now says "Export final" (the button's name).
- Test: `apps/web/demo/original-file.mjs` (a remembered file uploads and makes the final with Best kept; a file the browser can't open shows the picker; a wrong file is refused by name). It fails on the old code.

## Library thumbnails load fast (4 November)

- The Library asked for the whole list again every second while any video was being prepared, and every answer signed each thumbnail's link afresh (the time is in the link), so the browser fetched every picture again each time: on a slow connection they never finished.
- Now: links to stored files are signed at the start of a time slot (a quarter of their life, from a minute to an hour) and last that much longer (`signGet`, `packages/core/src/storage.ts`), so asking again gives the same link; the web app keeps a thumbnail's first link while it is good (`apps/web/src/rendrr/thumbs.ts`); the Library refreshes every 3 s while a video is being prepared (was 1 s). Thumbnails are 640 px JPEGs; videos load only when one is opened.
- Tests: `packages/core/test/sign.test.ts` (the same link within a slot, a new one after, always good for the life asked), `apps/web/test/thumbs.test.ts`.

## Finals that failed to export; best quality; straight to Drive (3 November)

- Video 4's final failed every time at "Cutting clips" (FFmpeg "exited with null": killed). The worker's memory was at its 6 GB limit each time. The edit had four wide 3D b-roll clips: in a vertical edit each is scaled up to cover the frame (about 3400x1920) before it is cropped, and FFmpeg's crop keeps the big frame, so every b-roll branch held frames three times the output size. It worked once Claude swapped in clips cropped to vertical.
- Fix: when FFmpeg is killed (out of memory), the worker makes the edit again in pieces of about 15 s, each drawn from the plan cut down to it (`windowPlan`: only the sources it shows, drawn exactly as the whole), with its sound as PCM; then joins them (`joinPieces`: picture copied, sound encoded once). A piece killed again is made as two halves (down to 2 s). Cuts go on joins of two clips where one is near, never inside a transition (`pieceRanges`).
- Tested (`apps/worker/test/pieces-render.test.ts`): an edit with a slowed clip, a dissolve, b-roll, a text box and a zoom, whole vs 4 pieces joined: same length, every frame the same (worst difference 0.19; one frame off is 17.9), the same sound (correlation 1.0000), no gap or click at any join.
- Best quality: `render_final` takes `quality: "best"` (and the web Export window has Quality: Standard / Best): the largest resolution the footage fills in the edit's shape (`bestResolution`: 4K from vertical 4K footage in a 9:16 edit; landscape 4K cropped to vertical is 1080p), x264 medium at CRF 16 (x265 CRF 18, 16 for HDR) and 320k sound; twice the time limit. Carried as "best" in the render's quality label.
- Drive: Rendrr already saves a final into a Drive folder itself (render_final driveFolder: a folder link, path, id or name; save_to_drive). In this chat Claude downloaded the files to the Mac and uploaded them with another connector instead. render_final's description and the connector's instructions now say to use driveFolder and never download and re-upload.

## Share a whole project with one link (2 November)

- One link to a project folder: anyone with it watches every video in it, each at its newest version, and leaves comments, no account needed. Videos added to the project later show up on the same link. Comments come back to each video.
- Web app: the project's Share button (and Share folder in the projects list), as before. The review page of a shared project now shows its videos as cards (picture, length, name) in a row that scrolls sideways; tap one to watch it. The header says how many videos; the version switch is gone there (each video is at its newest version).
- Claude: `create_review_link` takes `folderId` (from list_folders) for the whole project, or `projectId` for one edit. In the Rendrr card, an open project has a Share button: the project's link (the same one each time), with how many videos it has.
- Tests: `apps/api/test/claude-app.test.ts` (folder link from Claude and from the card, the same link again, someone else's project refused), `apps/mcp/test/app-browser.mjs` (the card's Share on a project), `apps/web/demo/review-folder.mjs` (the shared project page on desktop and phone).

## Claude card opened and closed at once (2 November)

- Claude now speaks MCP protocol version `2026-07-28`; the MCP library we use (1.32.1) knows versions up to `2025-11-25` and refused, with 400, every call whose header named the newer one, before any tool ran. The connector's logs showed these 400s each time the card was opened.
- The connector now answers such calls as the newest version it knows (`apps/mcp/src/protocol.ts`), and logs any request it refuses with its method and version. Confirmed live: the log names `2026-07-28` and the calls succeed.
- Test: `apps/mcp/test/protocol.test.ts` (the library alone refuses an unknown version; with the fix it answers).
- Then the card disappeared after a few minutes. Found: a `ping` from Claude (only checking the card is alive) stopped the card's refreshing, as a close does; fixed. The card now refreshes once a minute when nothing renders (was every 20 s; every 3 s while rendering, as before).
- The card now writes its life to the connector's log (`app_log`, a card-only tool, nothing saved): when it starts (host, phone or desktop, size), when Claude changes its mode or closes it (and after how long), errors, and when the page goes away. Search the `mcp` logs for `[card]`.

## Claude card on phones: the comments scroll (2 November)

- 3 November, on a computer: full screen in a short panel (a laptop's), the comments were squeezed to 0 px between the tabs and the box to write one, so there was nothing to scroll. Now they keep at least 160 px, the page scrolls when the panel is short, the player takes what is left (at least 220 px), and the bottom keeps 72 px clear of Claude's reply box. Tested with a 560 px panel: a wheel scrolls to the comments and the box.

- Full screen in Claude's phone app the card did not scroll, and its top sat under Claude's header (the safe area Claude gives counts only the phone's notch and home bar; its header and chat box lie over the card).
- Now, full screen on a phone, the card scrolls in its own box, never taller than the screen or the container Claude reports, so a frame taller than the screen still scrolls. It keeps at least 112 px clear at the top and 172 px at the bottom, so the last comment comes up above Claude's chat box. The toast and the picture viewer stay in that box.
- Tested in `apps/mcp/test/app-browser.mjs`: a swipe scrolls 11 comments to the last one, with Claude's real insets, and again in a frame taller than the screen. Before the fix both failed (the header sat 59 px down, behind Claude's).

## Old API service removed (2 November)

- `api2` (made earlier to get past a stuck deploy) now does all the API work. The old `api` service was a second copy of the same code on the same database, costing about $3-5 a month.
- `api2` no longer reads any setting from `api`: it takes its keys from `worker`, `mcp`, Postgres, Redis and the file bucket.
- The internal key between the AI connector and the API is now worked out from the Clerk secret both already have (`packages/core/src/crypto.ts`), so no key had to be copied from `api`. `INTERNAL_API_SECRET` still works if it is set.
- The address `api-production-2428.up.railway.app` moved from `api` to `api2` (the old one is now `api-retired-2428`). The address stayed the same, so the Google Drive login link, the web app, upload links and Claude did not need changes.
- Checked after the move: health, the web app allowed through, no-login calls refused, the live web app's calls arrive at `api2`, Claude's list of edits and the Drive library.
- The old `api` service is deleted (you deleted it in Railway; the tool's approval prompt did not reach you). Checked again after: health, the web app allowed through, no-login calls refused, the Drive callback, the live web app, Claude's projects card, and no errors on `mcp` or `worker`.
- `api.rendrr.live` is now on `api2`. Only bots ever visited it. For it to work, change its DNS CNAME at your domain provider from `s1qj853o.up.railway.app` to `oefcghrl.up.railway.app`.

## Renders failing with "ran out of threads" (2 November)

- The worker hit its 1000-thread cap and stayed there for hours: every graphic recording and loudness pass failed with `pthread_create() failed`.
- Cause (reproduced): the worker ran as `npx tsx` as process 1, which never collects processes handed to it. Every browser start leaves Chromium helper processes with process 1 as parent; when the browser closes they die but stay as zombies. Measured: 4 zombies per browser opened and closed, for good. The worker opens a browser for each graphic, variant, test and snapshot, so after about 150-200 of them the cap was full and nothing could render until a restart. With tini as process 1: 0 zombies.
- Also: under heavy load FFmpeg could still run out. Measured: one heavy render's FFmpeg peaks around 210-300 threads, a recording's browsers about 320, and two renders run at once. Browsers, the loudness pass and the render now wait up to a minute for free threads before starting (and before retrying), and each holds its share for 15 s while it starts, so two jobs starting together do not count the same free threads.
- Each render first ran out of threads, even alone on a fresh worker, then finished slowly on the one-thread retry (one went over its time limit): the browsers that recorded its graphics stay open a minute for reuse (about 320 threads) while its FFmpeg starts. A render now closes those kept browsers before encoding, and sets FFmpeg's filter and decoder threads from what is free (scalers and inputs counted from the graph; logged per render as "N scalers, N inputs, N threads free").
- Fix: `tini` is process 1 now (Dockerfile ENTRYPOINT) and collects them. A watchdog (`apps/worker/src/lib/threads.ts`) looks every minute: it stops stray browsers, FFmpeg and Python whose parent is gone, logs what holds the threads when over half are used, and restarts the worker if they stay used up (over 90% for 3 minutes with no job running, or over 97% for 10 minutes).
- Tested in `apps/worker/test/threads.test.ts`.

## The Rendrr card in Claude: projects first, then their videos (2 November)

- The card used to list every edit of every project in one grid. Now it opens on your projects (one card each: the newest video's picture, how many videos, open comments, rendering).
- Tap a project to see only its videos, with a search inside it. The back button goes to all projects; any project opens from there.
- In a video, back goes to that video's project, also when Claude opened the video itself.
- Server: `app_list_projects` takes `folderId` and sends `folders` with the first page; every edit carries `folderId`. A chat whose cached tool list is older still works: the card picks the project's videos out of the full list.
- Tested in `apps/mcp/test/app-browser.mjs` (desktop and phone) and `apps/api/test/claude-app.test.ts`.

## Folders added never mix, and videos in the Trash can be added again (18 November)

- **A folder added is always its own folder.** Importing a Google Drive folder used to fill any Library folder with the same name, so a second client's "B-roll" went into the first client's "B-roll" (and the sync switched to the second one). Now another Drive folder of the same name gets a folder of its own, named after the Drive folder it sits in ("B-roll (Client B)", else "B-roll (2)"). The same Drive folder imported again still fills the folder it made. A folder from the computer is a new folder every time too ("Shoot (2)"), and the Library opens on it.
- **Videos in the Trash can be added again.** A Drive video moved to the Trash still counted as "Already in your library": the picker greyed it out and a folder import hid it. Now the picker lets you pick it, and picking it (or importing its folder, or Claude adding it by driveFileId) brings that same video back out of the Trash, into the folder you add it to. A folder sync still leaves it in the Trash.
- Already mixed folders: import the first client's Drive folder again and its videos move into a new folder of their own.
- Tested: `apps/api/test/drive-folder-import.test.ts` (two clients' "B-roll", a third with a number, trashed video picked into another folder, re-import restores, sync leaves it), `apps/api/test/library-folders.test.ts`, `apps/web/demo/library-folders.mjs` (the same computer folder twice opens "Shoot (2)").

## Quick fixes: client comments, several Drive folders, deleting from the Library (1 November)

- Client review page: the comment box is always under the comments. A tap or click on the video pauses it and opens the box at that moment. Phone, small phone and desktop tested (`demo/review-phone.mjs`).
- Google Drive picker: every folder has a tick box. Tick several (and videos too, from anywhere in the Drive), or "Select all folders", then one button imports them all. A folder ticked inside a ticked folder is not brought in twice. One that fails (no videos) does not stop the others. Tested in `demo/library-folders.mjs` (desktop and phone).
- Deleting from the Library: the delete itself worked, but a Drive video in a synced folder came back with the next sync (on opening the folder, or within 5 minutes). Now Rendrr remembers what you deleted (table `DriveRemoved`, migration `20261101120000_drive_removed`); syncs leave it out. Deleting a Drive subfolder keeps it out too. Picking the video again, or importing its folder again, brings it back. Tested in `apps/api/test/drive-folder-import.test.ts`.
- Select mode in the Library has Delete: several videos at once. Videos used by edits are named and asked about once more; "Keep those" keeps them. Tested in `demo/library-delete.mjs` (desktop and phone).
- Windows on phones: they were drawn inside the page, and on iPhones the top bar and tab bar covered them (the Create button was hidden). Now every window is drawn over the whole app. Small ones (new project, new folder, rename, questions) sit in the middle of the screen and move up above the keyboard. Big ones (Add footage) stay a sheet from the bottom. Tested in `demo/modal-phone.mjs` (390 and 360 wide phones, and desktop).

## Drive folders that stay in step, and videos and pictures from the chat (1 November)

- **Drive folders sync.** A folder imported from Google Drive stays linked to it. Videos you put in that Drive folder later come into the Library by themselves: when you open the folder (at most every 2 minutes), with Sync now, when Claude lists the folder or makes an edit from it, and every 5 minutes on the server. New Drive folders become library folders. A video you moved elsewhere stays where you put it; nothing is removed.
- **Videos and pictures from the chat.** A new tool, add_footage. When you give Claude a video or a picture (attached to the chat, a link, or a file in your Drive), Claude puts it in your library, and in the edit's Media panel. Then it places it with apply_edits like any footage.
  - From the chat: Claude gets a one-time link and its code workspace sends the file to it. Up to 2 GB for a video, 50 MB for a picture.
  - A link (Google Drive, Dropbox, any direct link), or a file in your Drive. A Drive video is linked, not copied.
  - A picture becomes a 60 s still clip: b-roll over the talk, a V1 clip, a background, inside text. Pictures are not transcribed.
  - Rendrr keeps these files (there is no Drive or computer copy). Deleting the video deletes the file. The Library marks them "From the chat", and pictures "Picture".
- **Works in chats started before add_footage.** Chat apps keep the tool list they loaded, so an older chat cannot see add_footage. In any chat, Claude can place a Drive clip straight away: apply_edits add_broll with the Drive file's id or share link as videoId (also add_clip, set_background, multicam angles, video inside text). Rendrr links it into the library, waits for its preview (about a minute for a short clip; b-roll no longer waits for the transcript), puts it in the Media panel and places it. A file attached to an older chat goes through add_audio's upload link with ?kind=footage.
- **Music from the chat.** A music file the user gives Claude goes under the edit in any chat: add_audio then add_music{soundId}, or add_music{url | driveFileId | upload: true} in one step. A Drive link or file id given as add_music's soundId is taken as the file. Music sent to add_footage (or its upload link) is kept as audio and the reply gives its soundId; music given as b-roll says to use add_music.
- **Known limits.** HEIC/AVIF pictures are refused (send JPEG or PNG). A transparent PNG loses its transparency (it becomes a still clip). Claude's code workspace must be allowed to reach Rendrr's API host to send a file; if not, a link or Drive works.
- **Tests.** API: drive-folder-import (sync, the server sweep, a moved video left alone) and add-footage (a picture and a video through the link, the real worker making their previews, the picture placed as b-roll, deletion). Browser: library-folders (linked folder, Sync now).

## Review of every phase: bugs found and fixed (1 November)

Three reviewers read the new phases side by side; every finding was checked and fixed with a test.

- **Versions and renders.** Rendering or sharing no longer looks like "Claude just changed this edit". Undo after "undo, then a new change" no longer brings back what was undone. The open editor now shows Claude's later changes in the same version instead of saving over them. `again: true` no longer gets round the one-preview rule. A client's note on a folder review link counts as feedback.
- **Comments.** Drawings made in the editor now reach Claude (it can see them on the frame). A drawing is posted at the frame it was drawn on. Drawing on a phone no longer leaves stray listeners after a scroll.
- **Morph Cut.** Sending a morph to all cuts keeps the ones you made plain. The face-aware morph falls back to the plain one where a side is stabilized or keyframed (it would have slid the head off target).
- **Multicam timecode.** Exact 23.976/29.97/59.94 rates, midnight wrap per rate, 00:00:00:00 treated as no timecode, angles synced at the same time.
- **Masks.** A path redrawn at the clip's start now renders the new shape. A path with keys but no points no longer crashes.
- **Tracking and pins.** Pinned text keeps its own fades and turns. Pins follow the object across a split clip, mirror with a flipped clip, move with the clip's keyframes and use a multicam angle's framing. Long pins use their 60 keys where they matter most and say when the follow is rough. Tracking on an angle uses its own framing and start. Edit times use the transcript.
- **Samples and stabilize.** Frame samples render with loudness on (they failed before). A sample inside a transition keeps the cut-out of the far side. A stabilized clip at 4x with a transition no longer runs out of smoothed footage. The cut-out of a stabilized clip now moves with the smoothed picture. A failed sample set leaves no files; two identical asks at once make one render.
- **Known limits left.** HDR footage is stabilized at 8 bits (the stabilizer works only in 8 bits; it is dithered and the plan says so). A clip made in the same apply_edits cannot be tracked in that call (the message says to send it in a second call; it stays the same version). The cut-out of a clip that is both slowed and stabilized is not smoothed.
- **Tests.** Shared 498, worker render tests, API tests against a real database, browser tests (comments, tracking, mask paths).

## One version and one render per request (1 November)

- **Why.** Claude was making 4 or 5 versions for one request: each fix-up apply_edits was a new version, and the editing guide let it render "once more, up to 3 rounds" after its own checks. Every render is a version you have to watch, and costs tokens.
- **One version per request.** Claude's edits before a render now join the version it is making, so a request goes from v1 to v2 however many calls it takes. The version closes when it is rendered, shared, or when you change the edit yourself. Undo goes back to before the whole request. Samples no longer close a version.
- **One preview per request.** Rendrr refuses Claude's second preview of the same edit for the same request (within 45 minutes) unless you have left a comment or changed the edit since, or Claude says you sent a new request (newRequest). Claude's own fixes after a preview are saved and go into the next one. Previews you start yourself (the editor, the card in Claude) are never limited.
- **The guide.** "Render once more, up to 3 rounds" is gone. It now says: fix what the preview's check shows, do not render again, tell the user; one render per request.
- **Safety.** The editor's autosave cannot overwrite a change Claude added to the same version after the editor loaded it (it reloads instead).
- **Tests.** apps/api/test/one-render.test.ts (against a real database), packages/shared/test/editing-skill.test.ts.

## Comments like Higgsfield, and a UI sweep (31 October)

- **Comments.** The editor's Comments panel: an empty edit shows "No comments yet" in the middle. The box to write in has a clock chip with the moment, Draw (draw on the picture in five pen colours, with Undo and Clear), emoji, pictures (pick, paste or drop, up to 4) and a round send button that lights up once there is something to post. A drawing or a picture alone can be posted. On a phone, Draw brings the video into view.
- **UI sweep.** A new check (apps/web/demo/sweep.mjs) opens every screen, each editor tool, comments, and the Export and Samples windows on a desktop, a laptop and a phone, and looks for page errors, sideways scrolling, things off the screen, buttons on top of each other, cut-off button text and tap targets under 24 px. Fixed what it found: small tap targets on phones (the + next to each video in the project bin, the anchor-point grid, card select boxes, the comment resolve box) and a cramped Folders row in the Library. It now reports 0 issues on 69 screens. All 46 browser tests pass.
- **Live check of object tracking** (on your "Skin retouch test (safe to delete)" edit, then undone): the speaker's head was followed over the whole 8 s clip (80 boxes, never lost), a pixelate box followed it with 21 keys, and a title was pinned to it.
- **Tests.** apps/web/demo/comments-compose.mjs, apps/web/demo/sweep.mjs.

## Face-aware Morph Cut (31 October)

- **What it is.** Morph Cut now looks for the face. On a jump cut, Rendrr finds the speaker's face in the frame before the cut and the one after, and slides and scales the head from one place to the other while the room behind dissolves. A cut with no face found (or a head that turned or was reframed) gets the plain morph as before.
- **How good.** On a real face moved 117 px and grown 10% across a cut, every frame of the morph matched the face drawn at its in-between place (0.99 on a 0-1 match). The plain morph smeared at that size (0.12), and a dissolve showed two faces.
- **Editor.** Speed & motion, Transition: with Morph Cut picked, "Follow the face" (on by default; off = the plain morph). The player still shows a dissolve there; the render draws the morph.
- **Claude.** set_transition type morph is face-aware; face: false makes it plain. The render plan says which.
- **Tests.** packages/shared/test/morph.test.ts, apps/worker/test/morph-face-render.test.ts (a real render with a real face), apps/web/demo/morph.mjs.

## Object tracking (31 October)

- **What it is.** Draw a box round anything (a logo, a licence plate, a product, a face) and Rendrr follows it through the clip, like Premiere's mask tracking. Where it is covered or leaves the frame, Rendrr says so and what follows it holds still there.
- **What follows it.** Masks and blur, pixelate, darken and the other effect areas (follow "object"). Text layers and graphics can be pinned to it: they move with it, and can grow and shrink with it.
- **Editor.** Color, Tracking: "+ Track an object", then drag a box on the picture. Each object shows where it was followed and lost, with "Blur it", "Pixelate it", "Mask to it", "Track again here" and a name. Its box is drawn on the player at the playhead. Masks and effect areas get a "Follow" choice. Text tab: "Pin to a tracked object" and "Grow and shrink with it".
- **Claude.** track_object {clipId, at, box, label} (the server tracks it), then set_masks / set_effects with follow "object", object id, and pin_layer {clipId, to {clipId, object}, scale}. get_project lists tracked objects and pinned layers.
- **Limits.** Up to 8 objects a clip; at most 60 s of a clip is tracked in one go (round the moment the box is drawn).
- **Tests.** packages/shared/test/tracking.test.ts, apps/worker/test/track.test.ts (accuracy), apps/worker/test/tracking-render.test.ts (a real render), apps/api/test/track.test.ts (needs the database), apps/web/demo/tracking.mjs.

## Mask path keyframes (31 October)

- **What it is.** A path mask can change shape over time, like Premiere's mask path keyframes. Each point moves in a straight line to its place in the next shape. Shapes drawn with a different number of points still morph smoothly.
- **Editor.** Color, Masks: on a path, "Key the shape here" keeps the shape at the playhead, and "Redraw here" draws a new shape that becomes a key at the playhead. The outline on the player now shows each mask where it is at the playhead (moving rectangles too).
- **Render = player.** Both use one rule for the in-between shape. Measured: the rendered mask matched it on 100% of pixels away from the soft edge, at the keys and between them.
- **Claude.** set_masks and set_effects areas take pathKeys: [{at, points}] on a path.
- **Tests.** packages/shared/test/maskpath.test.ts, apps/worker/test/maskpath-render.test.ts, apps/web/demo/maskpath.mjs.

## Multicam sync by timecode (phase 22, 31 October)

- **What changed.** Cameras are lined up by their timecode when both files carry one. The sound still checks it: if the two clearly disagree (a camera whose clock was not jammed), the sound wins. With no timecode, the sound syncs as before.
- **Reading timecode.** Rendrr reads each file's start timecode when it makes the preview copy (MOV and MP4 timecode tracks, drop-frame too). Videos added before today are read the first time they are synced.
- **Editor.** Multicam shows "by timecode, sound check 87%" next to each camera synced that way.
- **Claude.** multicam without an offset syncs by timecode first; the result says how each camera was lined up.
- **Note.** Footage the browser turned into a preview copy (local files) usually has no timecode left in it, so those sync by sound.
- **Tests.** packages/shared/test/phase22.test.ts (timecode maths incl. drop-frame and midnight, the timecode-or-sound choice), apps/worker/test/timecode.test.ts (real MOV/MP4 files), apps/web/demo/multicam.mjs.

## Stabilize b-roll and clips at other speeds (phase 21, 31 October)

- **What changed.** Warp Stabilizer now works on b-roll and on V1 clips played at another speed: slowed, sped up, reversed, frozen or with a speed ramp. Before, those played as filmed.
- **How.** Such a clip's footage is stabilized once, over the whole clip, then every part of it reads that stabilized copy. A ramp is smoothed through its speed changes, with no jump where the speed changes.
- **Measured** (frame-to-frame shake on a shaky test clip): half speed 21.9 to 0.7, a ramp 22.3 to 0.7, reversed 30.1 to 0.1, b-roll 29.7 to 0.1.
- **Editor.** Speed & motion, Stabilize is offered on b-roll too; its note says when it smooths through speed changes.
- **Claude.** stabilize takes b-roll ids and clips at any speed.
- **Tests.** packages/shared/test/phase21.test.ts, apps/worker/test/stabilize21-render.test.ts, apps/web/demo/phase21.mjs.

## Samples: a few frames and short clips before the whole preview (31 October)

- **What it is.** Claude (or you) renders a few key moments of an edit on their own: up to 8 frames and 3 clips of up to 6 s. Only those seconds are rendered, so it takes seconds, not minutes. Each is drawn exactly as the whole preview draws that moment.
- **In Claude.** render_samples opens a samples card in the chat, like a generations card: the picked sample big, the strip under it, Claude's note on it, a box to ask for a change on it. "Send changes to Claude" sends them all in one message; "Looks good" asks for the full preview. Claude reads the changes with get_samples (they are comments on the samples at each moment).
- **In the editor.** A Samples button in the top bar: add a frame or a 4 s clip at the playhead, render them, see each one big, "Go to" moves the player there. The edit's latest sets (Claude's too) are listed.
- **Measured.** A 4.5 s sample over a slowed clip, a dissolve, b-roll, a text box and a zoom against the whole render: every frame within 0.6 out of 255 (one frame off is 6), the sound the same (correlation 0.9999). A reversed clip cut at both ends: every frame within 0.6. Stills show the same footage frame as the render.
- **Bugs found and fixed on the way.** A sample starting mid-way through a slowed clip showed every other frame one footage frame off; a cut point half a frame off could drop a frame. Both fixed (the sample starts on a whole footage frame, cuts are on exact frames).
- **Not versions.** Samples have no check, are not a version to watch, do not change the edit's status, and are cleaned up with old previews.
- **Tests.** packages/shared/test/samples.test.ts, apps/worker/test/samples-render.test.ts, apps/mcp/test/app-samples.mjs (the card in Chromium), apps/mcp/test/server.test.ts, apps/api/test/samples.test.ts, apps/web/demo/samples.mjs.

## Five more shape wipes, GIFs up to ten minutes (phase 20, 31 October)

- **New transitions** (Speed & motion, Transition): Iris box, Iris cross, Venetian blinds (across, or up and down with a direction), Checker wipe and Wedge wipe, as in Premiere.
- **Render = player.** Each shape is one rule shared by the render (FFmpeg) and the player (CSS). Measured at the middle of each transition: every grid point away from the edge matched the rule, in the render and in the player.
- **GIFs up to ten minutes.** Up to a minute: 15 fps, 640 px wide. Up to three minutes: 10 fps, 480 px. Beyond: 6 fps, 360 px. Over ten minutes is refused.
- **Bug fixed on the way.** Venetian blinds' direction was dropped by the edit; it is kept now.
- **Claude.** set_transition types box, cross, blinds (dir left/right = vertical bands), checker, wedge; set_export format gif up to 10 minutes.
- **Tests.** packages/shared/test/phase20.test.ts, apps/worker/test/wipes20-render.test.ts (render and player against the rule), apps/worker/test/deliver-render.test.ts (a long GIF at 10 fps, 480 px), apps/web/demo/phase20.mjs.

## Glow, grain, RGB split, shake and mirror live in the player (phase 19, 31 October)

- **Live.** These five effects now show in the editor's player while you edit, drawn with the render's own formulas (before, only after a render). Only the corner pin is still render-only.
- **Measured against the render** (mean difference per pixel, out of 255; the plain clip's baseline is 2.2): glow 2.8 (the effect itself changes 9.9), RGB split 2.7 (4.8), shake 3.6 (17.6), mirror 1.7 (110). Grain: noise 16.6 in the player against 15.8 from FFmpeg's own filter.
- **Two render bugs fixed on the way.**
  - Glow washed every colour out at strengths under about 70 (FFmpeg's screen blend is wrong on 16-bit RGB; it now runs in float).
  - Camera shake or mirror on one clip of several made the render fail ("parameters do not match"): the shake left non-square pixels. Both now keep square pixels.
- **Tests.** apps/web/demo/effects-match.mjs (player against render, all five), apps/worker/test/effects12-render.test.ts (glow keeps dark colours; shake and mirror on one of two clips render).

## Remove background on b-roll and reversed clips (phase 18, 31 October)

- **B-roll.** Pick a b-roll clip, Color, Remove background: the person in the b-roll is cut out and the picture under it shows round them. Edge, softness and invert work as on V1. B-roll laid behind V1 is refused (nothing would show it).
- **Reversed clips.** A reversed clip now loses its background too (before, it kept it). Its matte is read backwards in the same 1 s pieces as its picture. Text behind the person also works over reversed clips now.
- **Bug fixed on the way.** On a mirrored clip, the cut-out was not mirrored with the picture. It is now.
- **Measured.** A red box jumping 30 px a frame, with its matte: red to its edges and the right thing just outside (green background, or the blue picture under b-roll) on every frame checked, reversed, mirrored and on b-roll from its own source second.
- **Claude.** remove_background takes b-roll clip ids.
- **Tests.** packages/shared/test/phase18.test.ts, apps/worker/test/phase18-render.test.ts, apps/web/demo/phase18.mjs.

## Text anchor and motion blur, b-roll borders (phase 17, 31 October)

- **Text anchor.** Speed & motion for a text layer now has the 3x3 anchor grid: the point of the text it turns and scales about (its alignment point is lit until you pick another). Turning about a corner swings the text on an arc, as Premiere does.
- **Text motion blur.** The motion blur slider works on text layers too. The render draws a blurred text layer on its own, averaged over four sub-frames per frame (the player shows it sharp, as for other layers).
- **B-roll borders.** Speed & motion, Border (colour, width) on b-roll cards too, not only V1. It moves with the card's keyframes.
- **Measured.** A text box turned a quarter about its left edge landed within 1 px of the player's position. A fast sweep with blur 100 had 37 part-covered columns against 2 without. A white border showed white just inside the card's edge, orange further in, and stayed on the card when it was scaled to half.
- **Bug fixed on the way.** With b-roll in an edit, the whole-edit Remove background and Skin sent the b-roll too and failed ("b1 is b-roll"). They now take V1 clips only.
- **Claude.** set_keyframes `anchor` and `motionBlur` on text (track v3); set_card `border` on b-roll ids.
- **Tests.** packages/shared/test/phase17.test.ts, apps/worker/test/phase17-render.test.ts, apps/web/demo/phase17.mjs.

## Masked and keyframed adjustment layers (phase 16, 31 October)

- **Masks.** An adjustment layer can work on part of the frame only: Color tab, the layer's page, + Rectangle / + Ellipse (box, feather, invert, add, subtract, intersect). Grade a sky, blur a corner, darken round a face.
- **Moving masks.** A layer's rect or ellipse moves with keys at seconds from the layer's start (Claude sends them). Follow face is refused: a layer has no footage of its own.
- **Strength and fades.** Strength 0-100% and a fade in and out (seconds) ramp the layer's whole effect.
- **Player = render.** The player masks its preview with the render's own mask picture and sets its strength as opacity. Measured: a moving mask darkened only inside it, on the left 0.1 s in and on the right 1.8 s in; with 50% strength and a 1 s fade in, the rendered grey was within 2 levels of the player's numbers at every point.
- **Claude.** adjustment_layer `masks`, `opacity`, `fadeIn`, `fadeOut` (null removes; left out keeps).
- **Tests.** packages/shared/test/adjust16.test.ts, apps/worker/test/adjust16-render.test.ts, apps/web/demo/adjust2.mjs.

## Audio heard live, parametric EQ (phase 15, 31 October)

- **Live.** The editor now plays each clip's pan, EQ and reverb while you edit (before, only after a render). The player routes a clip's sound through a Web Audio chain only when it has one of them.
- **Parametric EQ.** Audio tab: + Parametric band (up to 4): frequency, gain, Q. A notch for a hum: 60 Hz, -18 dB, Q 10.
- **One EQ.** The render's low and high shelves now use FFmpeg's lowshelf/highshelf (RBJ, Q 0.7071) and the 1 kHz bell its Q, the same filters the browser uses. Measured: tones through the render's chain and the browser's filters agree within 0.01 dB at 9 frequencies. Older renders with a low or high shelf sound up to 0.6 dB different around the shelf.
- **Claude.** set_clip_audio `eq.bands: [{f, gain, q}]`.
- **Tests.** packages/shared/test/audio15.test.ts, apps/worker/test/live-eq.test.ts (render against browser), apps/web/demo/audio6.mjs (bands, and the live chain's pan, filters and room on the playing clip).

## Colour curves and RGB parade (phase 14, 31 October)

- **Hue vs Hue.** Color tab: turn each of six colours toward another (greens toward teal), up to 90° either way; greys stay grey.
- **Luma vs Sat.** Color tab: saturation at five brightnesses (less colour in the shadows, richer midtones).
- **RGB parade.** The scopes have a Luma waveform / RGB parade switch.
- Both curves live in the grade's LUT, so the player and the render use the same numbers. Measured: the rendered file matches the shared grade (mean difference 2.15 of 255, against 2.13 for a plain render), and a green moved from 115° to 155°.
- **Claude.** set_grade `hueHue`, `lumaSat` (curves of [x, value] points; 0.5 = as is).
- **Tests.** packages/shared/test/color14.test.ts, apps/worker/test/color14-render.test.ts, apps/web/demo/color5.mjs (sliders and the parade).

## Multicam: cut to whoever speaks (phase 13, 31 October)

- **Cut to whoever speaks.** In the Multicam page: the person loudest on their own camera's mic gets the shot. Options: the camera to use when both talk (or keep the shot), the shortest shot (1, 2, 3 or 5 s). A camera must lead 0.4 s before the shot changes, and each cut comes 0.2 s before the voice.
- **Number keys.** 1 is the main camera, 2 to 9 the others: press one to cut there at the playhead, while it plays too. Each monitor shows its key.
- **Claude.** apply_edits `multicam_auto {cameras?, wide?, minShot?, start?, end?}`; the server works out the cuts from the measured sound and the result names the cuts and each camera's share.
- **Tests.** packages/shared/test/multicam-auto.test.ts (two voices on two cameras, an interjection, both talking), apps/api/test/multicam-auto.test.ts (measured sound in storage, apply_edits and the editor's route), apps/web/demo/multicam.mjs (keys and the button).

## Library folders (31 October)

- **Folders in the Library.** New folder makes one; a video goes in with its folder button, Select then Move to folder, or by dragging its card onto the folder. Rename and Delete folder (its videos stay in the Library). Add videos inside a folder puts new uploads straight in it.
- **Folders inside folders.** Up to 6 levels. Inside a folder, New folder here makes one; the path shows at the top (Library / Course / Module 1). Move a folder with Move or by dragging its card onto another; never into itself. Deleting a folder moves its videos and folders up a level (a clashing name gets "(2)"). A folder card counts its folders' videos too.
- **Import a whole Google Drive folder.** In Add footage > Google Drive, open a folder and press Import this folder (with its folders, or not): a Library folder named after it, its Drive folders inside, every video linked; no picking videos one by one. A video already in the Library is moved in, not linked twice; importing the same folder again adds only what is new. Up to 200 videos at once. Added from inside a Library folder, it goes inside that folder. `POST /videos/drive-folder`.
- **A whole folder from the computer.** Add footage > From your computer > Choose a folder, or drop a folder on the Library: the same folders are made in the Library (inside the open folder, if one is open), each video goes in its own, other files are left out, and the Library opens on the top folder. Up to 200 videos at once. Previews are made in the tab two at a time, so a big folder does not freeze the page.
- **Edit a whole folder.** Edit this folder opens the new-edit window with every ready video in the folder, in name order (Part 2 before Part 10), named after the folder. References and videos not ready yet are left out and named. Up to 20 videos, like any edit from several videos.
- **Claude.** list_footage lists the folders as paths and takes libraryFolder (id, name or path); move_footage sorts videos into a folder (a new path like Course/Module 1 makes the levels); create_project libraryFolder makes one edit of the folder and its folders (its own videos first, then each folder's).
- **Old server.** If the API is an older version without folder routes, the Library says "Folders are not on the server yet" instead of "That page does not exist."
- **Railway.** The api service has a deployment from 08:01 (phase 5, dbd0e25c-aa88-422c-b1ec-c90ec051b4b5) that Railway cannot stop ("unable to achieve a quorum"), so every new api deploy was dropped after 8 minutes. Moved around it (31 October, 13:25): a new service **api2** built from the same Dockerfile and branch, every variable a reference to the api service's (no secret copied), domain api2-production-c657.up.railway.app. The web app's NEXT_PUBLIC_API_URL and the connector's API_INTERNAL_URL point at api2. api.rendrr.live still points at the old api service (it only serves the Google Drive sign-in page, which just hands the code back to the web app); move that custom domain to api2 in Railway and update its DNS when convenient, then remove the old api service.
- **API.** `GET/POST /library/folders`, `PATCH/DELETE /library/folders/:id`, `POST /videos/move`, `POST /library/folders/:id/project`; `PATCH /videos/:id` and the add routes take `libraryFolderId`. Migrations `20261031100000_library_folders`, `20261031120000_library_subfolders`.
- **Tests.** apps/api/test/library-folders.test.ts (routes and connector, local Postgres), apps/api/test/drive-folder-import.test.ts (a fake Google Drive), apps/web/demo/library-folders.mjs (browser, desktop and phone).

## Rendrr inside Claude, one render per revision, the editing skill (29 October)

| What | Where | Tests |
|---|---|---|
| **The Rendrr app in the chat** (an MCP App). open_projects shows every edit as a grid (thumbnail, folder, version, latest preview, rendering, open comments, search). Opening one plays its latest preview, with the comments as dots under the player. A comment goes at the player's moment (mm:ss.mmm), lands in the editor's own comments (the Comments tab, get_comments), and the AI's context hears about it. Jump to a comment, resolve it, open it again. "Send to Claude" posts the open comments to the chat with how to work through them. A render's progress shows every 3 s; when it is done the new preview replaces the old one and plays. Full screen, Open in Rendrr, the host's light or dark theme. No timeline or other tools, as asked. | `mcp/src/app/projects.html`, `mcp/src/build.ts`, `api/src/services/claudeApp.ts`, `api/src/routes/internal.ts`, `shared/src/mcpApp.ts` | browser `mcp/test/app-browser.mjs` (36 checks, real Chromium, the host's content security policy), `mcp/test/server.test.ts`, `api/test/claude-app.test.ts` |
| **One render per revision.** check_edit checks the current version without rendering (pauses, words a cut goes through, fillers left, short clips, captions, text placement), in about a second. apply_edits ends with the same check's flags. render_preview with nothing changed since the last preview renders nothing and returns that preview's check (again true renders it again). The guide, the tool texts and the prompts now say: every change in one apply_edits, check_edit, fix, then render once. | `api/src/tools.ts`, `shared/src/mcpTools.ts` | `api/test/claude-app.test.ts` |
| **The editing skill comes with the connector.** The Fazinflo Editing Skill, rewritten for Rendrr's tools: the rules, the mistakes reviewers flag most and how to catch each in Rendrr, the workflow, the comments loop, the QA gate. Every connected AI gets its core in the server instructions (sent with every chat), the whole skill from get_editing_skill (the instructions say to call it before the first edit), a `skill://` resource and an "editing-skill" prompt. Left out: the people, clients and pipeline it was written for (review site, client delivery, Drive downloads), since every Rendrr user gets this text. | `shared/src/editingSkill.ts`, `mcp/src/build.ts` | `shared/test/editing-skill.test.ts` (every tool it names exists, nothing private, sizes), `mcp/test/server.test.ts` |

| **The app, round 2** (from your screenshots). Opening an edit asks Claude for full screen (its own panel). Top to bottom: the player, the comments (scrolling), the comment box pinned at the bottom. Rendrr's own player controls: the time in mm:ss.mmm moving every frame, a seek bar with the comments as dots, 0.1 s steps (arrow keys, Shift 1 s), sound on or off. | `mcp/src/app/projects.html` | browser `mcp/test/app-browser.mjs` |
| **Comments: edit, delete, draw, pictures, links.** Draw on the picture (5 pen colours, undo, clear); the drawing is kept as strokes and as a clear PNG. Up to 4 pictures a comment (pick, paste or drop; big ones made 1600 px JPEG). Web addresses become links (open through Claude). Your own comments can be edited (words, pictures off or on, the drawing off), any comment deleted (asks once more). Files live under `comments/<user>/<edit>/<comment>/` and go with the comment or the edit. The editor shows them too: pictures, links, the drawing on the player at its moment, Edit, Delete. Claude reads them: get_comments gives times to the ms, the preview each note was made on, the drawing in words; images true shows the pictures and the preview frame with the drawing on it (the worker lays the PNG over the frame). | `api/src/services/commentMedia.ts`, `claudeApp.ts`, `routes/projects.ts`, `tools.ts`, `worker/src/jobs/frames.ts`, `web/src/rendrr/editor.js`, migration `20261029150000_comment_drawings` | `api/test/claude-app.test.ts` (12), `worker/test/comment-drawing.test.ts`, browser `mcp/test/app-browser.mjs`, `web/demo/comments-claude.mjs` |
| **Share.** A Share button makes (or reuses) a review link for the version being watched: watch and comment, no account. Copy (where Claude allows the clipboard, else selecting it) and Open. | `claudeApp.ts` (app_share_link) | browser `mcp/test/app-browser.mjs` |
| **Phones.** Two cards a row; a compact header and controls on one line; 16 px text in the comment box (no zoom on tap); bigger tap targets; drawing with a finger; the share panel floats. | `mcp/src/app/projects.html` | browser `mcp/test/app-browser.mjs` (390 x 844 with touch: nothing wider than the screen, comment, draw, share) |
| **Phones, round 2.** Claude's phone app draws its header and chat box over the app in full screen, so a tap on the comment box went to Claude's chat box. The app now keeps clear of the space Claude says it covers (safe-area insets), and on a phone the comment box sits right under the player. | `mcp/src/app/projects.html` | browser `mcp/test/app-browser.mjs` (phone host with a 100 px header and a 140 px chat box: header and comment box clear of both) |
| **First preview on its own.** Most edits were never rendered (the editor plays them live), so the app had nothing to play. Opening such an edit starts its first preview once and plays it when ready. | `mcp/src/app/projects.html` | browser `mcp/test/app-browser.mjs` (starts once, not again on reopen) |
| **LUTs from Claude (add_lut).** Claude could not put a custom LUT on an edit: Rendrr had no way to receive a .cube file through the connector, so a look approved on a frame was rebuilt with curves. add_lut takes a link (Google Drive and Dropbox share links too), a file in the user's Google Drive (through their Rendrr Drive connection), or the file's text; it is checked, kept, listed in get_project, and the same name replaces it. set_grade lut puts it on the edit, live in the editor and in every render. The editing skill now says: an approved look goes into Rendrr this way, never rebuilt from curves or graded outside Rendrr. | `api/src/services/luts.ts`, `fetchPublic.ts`, `tools.ts`, `shared/src/mcpTools.ts`, `editingSkill.ts` | `api/test/luts.test.ts` (4) |
| **Seek bar and comment pins.** The seek bar was 22 px with a 6 px track, hard to hold. Now a 64 px strip (70 on phones) you press anywhere and drag, the track thickening under the pointer, the time under the finger shown above it, the picture following once a frame. Comments are pins under it, like Frame.io: the author's initial in a circle pointing up at its moment, with a tick on the track; pressing one goes there paused, shows its drawing and the comment in the list. The comment being written has a lime + pin that follows its moment. Phones: the edit's header on one row. | `mcp/src/app/projects.html` | browser `mcp/test/app-browser.mjs` (drag to 60%, pin at its moment, pin opens its comment, draft pin) |
| **LUT from any chat (set_grade lut by text or name).** A chat started before add_lut existed (Claude loads a connector's tools when a chat starts) could not import a LUT. set_grade's lut now also takes the .cube file's own text, imported by the server in the same apply_edits, or an imported LUT's name. Tested live: the user's "Ronnii 6K Daydream" (9 points) applied to all 200 clips of "Cold Outreaching in 2027" (v17) from this session, preview rendered in 2 min 18 s, the look matching their approved frame. | `api/src/services/luts.ts` (resolveLutRefs), `shared/src/look.ts`, `ops.ts` | `api/test/luts.test.ts` |
| **Voice presets (Essential Sound).** set_audio cleanup gains Premiere's dialogue presets: balanced, podcast, roomy (dry up a roomy voice), warm, bright, soft (soften a harsh voice), punchy, radio, phone, with light, voice and noisy. The chain gains low-pass, warmth, presence at its own frequency and air. The Audio tab shows them as a grid. Heard in exports (the live player plays the balance). | `shared/src/audio.ts`, `web/src/rendrr/editor.js` | `shared/test/phase3.test.ts`; each chain run through FFmpeg |
| **Editor like Premiere.** Left column: a monitor (the reference, or a bin video to insert) over the project bin (footage used or kept, the library, Import). Timeline: an icon tool bar on the left with names on hover, icon actions, marks as ticks on the ruler (no lines through the tracks), V1 clips as a filmstrip of their own footage. Right panel like Higgsfield's: two tabs, Edit and Comments. Edit lists the tools in two cards (Edit video: Transcript, Speed & motion, Text & captions, Audio, Color; Your AI: Reference, What your AI did), each with a word on what it has going on; a tool opens on its own page under a back arrow, its icon and name, its sections as rounded cards. Comments like Frame.io (Open/All/Done, a check, actions on hover); a comment pin opens them. Color tab with no clip: the whole edit (LUT import, basic correction, sharpen). Play is a plain triangle. Export preview / Export final. Claude: add_media / remove_media, set_reference; get_project lists the bin. | `web/src/rendrr/media.js`, `filmstrip.js`, `editor.js`, `color.js`, `styles.css`, `shared/src/ops.ts`, `api/src/tools.ts` | browser `web/demo/filmstrip.mjs`, `timeline-part6.mjs`, `ruler-click.mjs`, `sideways.mjs`, `panel.mjs`, `comments-claude.mjs`; `api/test/project-bin.test.ts` |
| **Faster renders (from the speed audit).** (1) Footage is read in windows: an input seeked straight to where its parts are, a new one for a part played out of order (a hook from later) or past a gap over 10 s, so FFmpeg no longer decodes everything before a part or holds frames for later parts in memory. A shorts-style edit from a 10-minute video rendered in 4.1 s instead of 33.2 s, with the same frames and the same sound (to float noise before the encoder). (2) A light graph (a few scalers) uses every CPU the container has for filter threads instead of 4. (3) After the encode, the upload, the check frames, the file's measuring, the sound measuring and the face reading run at once; the sound check decodes the file once instead of twice. (4) Preview copies (and canvases, samples, b-roll) are cached on the worker (3 GB, least recently used dropped, re-fetched when the stored copy changes), and other videos on V1 are fetched at once. Not done yet from the audit: mixing the sound once for the loudness pass and the encode (about 20%), drawing runs of alike parts together in edits that are not uniform (up to 2.4x there), tone-mapping HDR after the downscale. | Done, tested (new render test: windows vs one input, frame hashes and samples; every worker render test; shared tests) |
| **Your own audio through Claude.** add_audio brings in the user's audio file (mp3, wav, m4a, aac, flac, ogg; up to 4 hours, 500 MB): a one-time upload link Claude's code workspace sends the file to (curl -T), a share link (Google Drive, Dropbox, direct), or a file in their connected Drive. The worker makes it AAC 48 kHz stereo and measures it. apply_edits set_voice{soundId} plays it in place of every clip's own sound from the edit's start (for a voice enhanced outside Rendrr, like Adobe Podcast, from this edit's exported sound): renders read no footage sound at all, the editor's live player mutes the footage and plays the file, and a cut made after it is said in the render's notes (the file would be out of sync after it). add_music{soundId} puts the user's file under the edit as music, ducked like library music. get_project lists the voice and the user's files; the editor's Audio tab shows the voice file with Use the clips' sound. A chat whose tool list is older than add_audio still gets there: set_voice and add_music take the file itself (url, driveFileId, or upload: true, which answers with an upload link and changes nothing). | Done, tested (shared tests for set_voice, own music, the graph, the player's levels; a real render: the output is the file's 1 kHz and none of the footage's 300 Hz, with a control render; API test: upload link, AAC conversion, set_voice, get_project, a used link, a text file refused, set_voice with the file itself from an old tool list) |
| **Claude card: download, versions, rename, icons.** The edit's header in the in-chat card: icon buttons with their names on hover (back to projects, full screen, share, download, open in Rendrr); a version menu with every rendered preview and final, newest first (the latest preview plays by default; a version picked stays picked through the polls, and a new render is said once); Download gets the file being watched with its name (through the host, since a page in a chat cannot save files); click the edit's name to rename it (Enter saves, Esc cancels). On phones the name gets its own line and the buttons the next. | Done, tested (Claude-style host in Chromium: icons, download link, version menu, the final playing, back, rename, Esc, phone layout; ChatGPT-style host; API tests for versions, another user's render id, download names, rename and its owner check) |
| **Export into Google Drive from Claude.** The user tells Claude where ("put it in Clients/BFS Health/Finals"): render_final driveFolder renders and then saves the final there; save_to_drive saves a final already made (the newest; one still rendering is saved when it is done). The folder can be a path from My Drive, a shared drive's name first, a Drive folder link or id, or just a name found anywhere (when several folders share it, Claude gets their paths and ids to choose). A missing folder is said with the folders that are there; createFolders: true makes the missing ones. Rendrr checks the folder before rendering (Google is asked whether Rendrr may add a file there, nothing is saved), then the worker copies the file from storage in 32 MB chunks as a resumable upload, picking up where a failed chunk stopped. get_render shows the progress and the Drive link. Google's drive.file access adds files only to folders Rendrr made: for the user's own folders, Settings › Google Drive › Allow saving to my folders asks Google once for that, and the tool says so when Google refuses. | Done, tested (a stand-in Google: path, shared drive, link, name anywhere, several with that name, folders made, refused folder, a chunk lost and sent again, the bytes exactly, a final still rendering, a failed final, Drive not connected). Not yet tried against a real Google Drive. |
| **Fix: finals ran out of memory at 'Cutting clips'.** Reading footage in seeked windows opened one decoder per window, and FFmpeg runs them all at once, each holding frames: a final from a 4K or 6K original with dozens of gaps (a long talking head cut down) went past the worker's 6 GB and was killed. Each video now has a window budget from its frame size (about 1.2 GB of decoders: one input for 6K, a few for 4K, ~16 for 1080p, 64 for a 540p preview copy); over it, the render reads through the gaps instead (the smallest gap that fits, else one input as before windows). Same cuts and frames. | Done, tested (a 4K, 25-gap final under a 3 GB cap: before, killed for memory; now 414 MB peak, 21 s; shared tests for the budget; worker render tests) |
| **Done comments leave the bars.** A resolved comment no longer has a pin on the seek bar, in the Claude card, the editor's player and timeline, and the review page. The comment stays in the All (and Done) list; reopened, its pin comes back. | Done, tested (Claude-style host: pin and tick go on resolve, come back on reopen; editor demo: player and timeline marks go on resolve, come back on reopen) |
| **Claude app player: loading shimmer, no auto-play.** While a preview loads (or stops to load more as it plays), a shimmer and "Loading preview…" cover the player, at the edit's shape, so it never looks stuck; a seek or stall shows it only after a moment, so scrubbing does not flash it. A preview that cannot load (a link run out) says so with Try again, which gets a fresh link. Nothing plays on its own any more: not when an edit opens, not when a new preview is done (it says "Preview v2 is ready. Press play to watch."). When the user plays one card, the other Rendrr cards in the chat that can hear it pause theirs (only where the chat gives the cards a shared origin). | Done, tested (Claude-style host in Chromium: shimmer on a slow preview, gone once the picture is in, no auto-play on open or after a render; ChatGPT-style host: failed preview and Try again, two cards playing one at a time) |
| **Rendrr in ChatGPT.** The same connector URL works in ChatGPT (it is recognised as ChatGPT and named so in Rendrr). The in-chat app speaks the open MCP Apps standard, which ChatGPT supports, and now also ChatGPT's own bridge (window.openai) when the standard one does not answer: projects from toolOutput, tools through callTool, Send to ChatGPT through sendFollowUpMessage, links, full screen, its height. Tools and the page carry ChatGPT's metadata too (outputTemplate, widget-callable and private tools, widget CSP, border, description). add_lut tells ChatGPT to send a LUT as text or a link (its code sandbox has no internet). The Connect AI page gives the ChatGPT steps (Settings › Apps, Developer mode, Create). | Done, tested (MCP test of the ChatGPT metadata; a ChatGPT-style host in Chromium that only offers window.openai: list, open, play, comment, Send to ChatGPT, full screen, height). Not yet tried in a real ChatGPT account. |
| **Edits from scratch (no footage).** For a video with no camera footage (a SaaS launch, an explainer, animated type), create_project blank {seconds, color} at any shape starts an edit on a blank canvas: a solid colour with a silent sound track, made by the worker in a few seconds. Claude builds the whole video on it with create_graphic scenes (HTML/CSS/JS animation), add_graphic, add_text, the library, music, sound effects, transitions and keyframes, like a composition in After Effects; trim_clip changes the length. The canvas is hidden from the library. The web app's New edit window has From footage / From scratch (length, shape, background). The editing skill has a from-scratch workflow (script, scenes, product shots, type and sound, check every scene). | Done, tested (API test with the real canvas job: size, 30 fps, length, exact colour, hidden from lists, text and trim on it; browser test of the New edit window, desktop and phone) |
| **Shorts, shapes and new edits from Claude.** create_shorts makes several shorts from a long video in one call: one edit per short, made of the stretches Claude picked (a hook from later can open it), 9:16 by default, reframed on the speaker, captioned (bold by default), optionally in a new folder. From a finished edit (fromProjectId) the shorts keep its grade, LUT, sound settings, caption style and the words it cut; its text, b-roll and music stay with it. create_project fromProjectId copies an edit (another shape, reframed) and leaves the first as it is; create_project clips starts an edit from stretches of footage; create_folder makes a new project folder. Every stretch is checked before anything is made. | Done, tested (API test: folders, shorts in a new folder, stretches checked first, shorts with an edit's look, a vertical copy, focus face through apply_edits) |
| **4:5 and auto reframe.** A fourth shape, 4:5 (1080x1350, Instagram portrait), everywhere: render, editor, Export window, Claude app, checks. Reframing like Premiere's Auto Reframe: set_framing focus "face" keeps the speaker's face in view when the footage's shape is not the frame's, per clip, from the faces Rendrr measured at 10 fps when the video came in (the face whose mouth moves most); focus {x, y} picks the point by hand. The editor's Frame menu has Follow the speaker and pan sliders; the Export window offers Follow the speaker when the footage is another shape. Fixed on the way: picking a shape in the Export window said "Changed shape" but the editor did not keep it. The render, the live player, the colour canvas and the measuring jobs all cut at the same place. | Done, tested (shared tests; editor vs render picture match: 9:16, 4:5, turned footage in 16:9, all under 1/255; browser test of the Export window and Frame menu) |
| **LUT upload link.** A full LUT (33 points, about 1 MB) is too big to send as a tool's input, so add_lut upload: true gives a one-time link (30 minutes, api.rendrr.live) that the AI's code workspace sends the .cube to with curl; the reply names the LUT's id. Any content type, curl -T too; a form or a web page is refused with how to send it; the link is spent only by a saved file. The workspace must be allowed to reach api.rendrr.live (Claude: Settings > Capabilities). | `api/src/routes/lutUpload.ts`, `services/luts.ts`, `tools.ts` | `api/test/luts.test.ts` (curl against the running server) |
| **Sharpen.** set_effects sharpen (1-100; 20 light, 50 clear): an unsharp mask, over the picture or an area. FFmpeg's unsharp does nothing on Rendrr's 16-bit colour path, so it is a convolution (3x3 up to 720p, 5x5 above); the editor's player draws it with the same weights. Color tab: + Sharpen. About +0.55 s per second of 1080p on 4 cores. | `shared/src/look.ts`, `renderPlan.ts`, `web/src/rendrr/look-gl.js`, `color.js` | `shared/test/phase6.test.ts`, browser `web/demo/color-match.mjs` (edges +42% in the render, editor within 9%) |
| **Skin retouch.** retouch_skin (Claude, and Color > Skin retouch in the editor): smooth (pores and texture, edges kept), blemishes (small dark spots and marks), even (blotchy colour; lips keep theirs), brighten; each 0-100, a natural 35/40/35/0 when sent without values. On each clip's face by default: an ellipse from forehead to neck around where Rendrr measured the speaker's face over the clip (10 fps face boxes), placed as the render fits the clip; a clip with no face measured gets the whole picture and says so; or "frame", or a shape. The skin is found by its colour (hue and saturation bands, a luma floor: skin of light and dark tones; not beige walls, orange clothes, hair). Render: before the grade, on the clip's own YUV, at a working size of 540p at most (above it only the change is added, so fine texture stays and preview and final look alike); spots found on a smoothed copy against a closing, filled from the skin around them, then the local brightness put back (the tone stays); sizes follow the face's height. About 16-19 ms a frame more than a plain look at preview size on 4 cores. The editor's player draws it with a WebGL pass close to the render. HDR footage: a retouched clip is worked in SDR (as the editor shows it), like a graded one, and the render's notes say so. | `shared/src/look.ts` (SkinSchema, skinParams, skinChroma, faceSkinArea), `ops.ts`, `renderPlan.ts` (skinChain), `previewCheck.ts` (speakerFaceBox), `api/src/services/color.ts` (skinFaceAreas), `routes/projects.ts`, `web/src/rendrr/color.js`, `look-gl.js`, `mcpTools.ts`, `editingSkill.ts` | Done, tested (shared `skin.test.ts` 9; worker `skin-render.test.ts`: on a real face with grain the fine texture drops 54%, tone within 1 level, the flag beside it unchanged, an area keeps it to one face, a 1080p final retouches the same, an HDR final stays 10-bit PQ with the face retouched; API `skin.test.ts` 4: the face's area from measured faces, get_project lines, values, off, no faces; browser `skin-match.mjs`: the player's texture drop 31% vs the render's 35%, colour within 2 levels; `skin.mjs`: the editor's controls) |
| **Remove the background (Premiere parity, phase 1).** remove_background (Claude, and Color > Remove background in the editor) cuts the person out of each V1 clip; what shows behind them is the edit's background (set_background: a colour, the footage blurred, a gradient or a pattern; the editor's Behind menu). Edge (-20 to 20: shrink or grow the cut-out), soft (0-100: feather), invert (keep the room, remove the person), off. The cut-out is an AI matte from two of MediaPipe's models (Apache-2.0, in the worker image): the selfie segmenter finds the people, the multiclass selfie model cuts them out from a square centred on them (followed frame to frame from its own reading; overlapping squares when someone is taller than the frame is wide), small islands it is unsure of dropped, smoothed over time where nothing moves, its edge refined on the picture's own edges (a fast guided filter). Held objects (a laptop, a mug) go with the background. Made once per 10 s block of footage from the preview copy and kept, so the preview, the final and the editor share it: an edit with it queues the blocks at once (one job each), a render makes any still missing (about 4 s of work a second of 30 fps footage, two blocks at once), and the editor's player shows the cut-out live as blocks arrive. In the render the matte goes through the clip's own trim, speed, freeze, turn and fit, into the alpha. People only for now (the model finds people, not objects). A reversed clip keeps its background. | `worker/python/matte.py`, `worker/src/lib/matte.ts`, `worker/src/jobs/matte.ts`, `core/src/matte.ts`, `shared/src/look.ts` (SubjectSchema, matteBlocks), `ops.ts`, `renderPlan.ts`, `api/src/routes/projects.ts` (GET /projects/:id/matte), `web/src/rendrr/color.js` (BackgroundSection), `look-gl.js`, `editor.js` (useMattes), `mcpTools.ts`, `editingSkill.ts`, `worker/Dockerfile` | Done, tested (shared `subject.test.ts` 10; worker `subject-render.test.ts` 3: a box moving 30 px a frame stays red to its edges with the background right outside, across the blocks' join, at 2x, inverted; `subject-matte.test.ts`: the real model on a person, the room's corners become the background, the face stays, kept blocks read again in 0 s; API `subject.test.ts` 5: one job per block, the measured turn, kept blocks not queued, the editor's links; browser `matte-match.mjs`: the editor's player matches the render at every frame checked; `background.mjs`: the editor's controls) |
| **Text and graphics behind the person (Premiere parity, phase 2a).** A title the speaker stands in front of: add_text or add_graphic with behind: true, behind_person{clipIds} for layers already there (off: true in front again), and a "Behind the person" switch on a text layer (Text & captions) and on a selected text or graphic (Speed & motion). The render draws the layers behind the person (graphics, then the text layers in a subtitle pass of their own), then lays the person back over them: the picture as it is at that moment (zoomed with it, before b-roll and graphics) with the same AI matte remove_background uses as its alpha, joined part by part over the edit. Not over b-roll or a transition, and not for a clip framed smaller, moved, keyframed or reversed (the plan and the check name them). The mattes of the clips under such layers are made when the edit is saved. The editor's player stacks them the same way: the person layer draws the footage's own video through the look canvas with the matte as alpha. | `shared/src/ops.ts` (behind_person), `timeline.ts`, `sequence.ts` (clipsUnderBehind), `renderPlan.ts` (PersonOp, assBehind, overlays order), `playback.ts`, `core/src/matte.ts`, `worker/src/jobs/render.ts`, `web/src/rendrr/editor.js` (PersonLayer, LiveOverlays, switches), `mcpTools.ts` | Done, tested (shared `behind.test.ts` 8; worker `behind-render.test.ts`: a moving box stays in front of a full-frame card behind it on every frame checked, across the matte's join and through a 1.3x zoom, a card in front covers it; browser `behind-match.mjs`: the editor's player matches the render frame for frame; `behind.mjs`: the switches) |
| **Video inside text (Premiere parity, phase 2b).** A text layer takes inside{videoId, from}: a library video plays inside its letters (Premiere's Track Matte Key; looped when shorter), its card, stroke, shadow and box drawn round them; or cutout: true: the letters are cut out of its card and the edit's picture shows through. add_text and set_text, an "Inside the letters" choice in the Text panel, get_project and check lines. The render draws each such layer from its own mask (libass, white letters on black), before that side's other text layers; behind the person works too. The editor draws the same with a canvas measured from the layer's own block. | `shared/src/captions.ts` (TextInsideSchema, textMatteAss, buildStyledAss draw modes), `ops.ts` (textInside), `timeline.ts` (libraryVideoIds), `renderPlan.ts` (TextMatteOp, drawTextMatte), `qa.ts`, `mcpTools.ts`, `worker/src/jobs/render.ts`, `api/src/services/projects.ts`, `web/src/rendrr/editor.js` (TextLayer, TextMatte, InsideControls) | Done, tested (shared `inside.test.ts` 11; worker `inside-render.test.ts`: red then green video in an "I" over a yellow card, looping at the right moment, and an "I" cut out of a blue card showing the footage; browser `inside-match.mjs`: the editor matches the render on 8 checks; `inside.mjs`: the control) |
| **Moving masks, areas that follow the face, darken (Premiere parity, phase 3).** A rect or ellipse mask, effect area or skin area moves with keys [{at, x, y, w, h}] (a straight line between them), or follows the face (follow "face": Rendrr measures the speaker's face over each V1 clip and makes the keys, keeping the shape in its place against the face; without a box, an ellipse round the face). A new effect, darken; a spotlight is darken outside an ellipse that follows the face. The render writes each moving shape as a small lossless grey video in footage time and puts it through the clip's own trim and speed; a reversed clip holds it still (said in the plan). The editor draws the same each frame. Color tab: "Follow the face", "Hold still", + Darken, + Spotlight. | `shared/src/look.ts` (AreaKeySchema, areaAt, followFace, simplifyKeys, darken), `ops.ts` (following), `renderPlan.ts` (moving look files, movingFrames, picture steps), `mcpTools.ts`, `worker/src/lib/moving.ts`, `api/src/services/color.ts` (faceTracks), `api/src/routes/projects.ts` (/face-tracks), `web/src/rendrr/color.js` (lookSpecAt, controls), `look-gl.js` (dark pass) | Done, tested (shared `moving-masks.test.ts` 10; worker `moving-mask-render.test.ts`: a darken box and a mask that move in footage time on a trimmed clip; api `skin.test.ts`: a spotlight through apply_edits; browser `spotlight.mjs` 9 checks) |
| **Blend modes and opacity (Premiere parity, phase 4).** set_blend on b-roll (V2) and graphics (V3): normal, multiply, screen, overlay, soft light, hard light, add, lighten, darken, difference, exclusion, color dodge, color burn, and an opacity. The formulas are the W3C ones (what CSS draws in the editor, and Premiere's). The render blends only the frames under the layer, in RGB (16-bit for HDR), with FFmpeg's blend where its mode is the same formula (dodge and burn with the layer on top) and an expression for soft light, and lays them back in place; opacity alone goes into the layer's alpha. Clip tab: a Blend menu and an Opacity slider. get_project and the plan say it. | `shared/src/blend.ts`, `timeline.ts`, `ops.ts` (set_blend, blendNote), `renderPlan.ts` (blendWindow, fadeTo), `playback.ts`, `mcpTools.ts`, `web/src/rendrr/editor.js` (LiveOverlays, Blend section) | Done, tested (shared `blend.test.ts` 7; worker `blend-render.test.ts`: all 12 modes and 50% opacity rendered, 16 colour pairs each matching the formula; browser `blend-match.mjs`: the editor blends as the render does, within 4 levels of the plain picture) |
| **Deeper colour (Premiere parity, phase 5).** set_grade takes Lumetri's highlights, shadows, whites, blacks and vibrance, three colour wheels (shadows, midtones, highlights: hue, amount, luma), up to 4 HSL secondaries (one colour only: skin, sky, greens) and a Hue vs Sat curve. All of it is in the grade's LUT, so the render and the player draw it with the same numbers (49 points when it has HSL or Hue vs Sat). New effect: vignette (darken outside a soft ellipse a little larger than the frame). Color tab: Light, Vibrance, colour wheels you drag, Hue vs Sat by six colours, HSL presets, + Vignette, and scopes (waveform and vectorscope of the picture through the grade). | `shared/src/look.ts` (toneStep, wheelStep, hueStep, hueCurveFn, rgbHsv, lutSizeFor, VIGNETTE_AREA), `ops.ts` (set_grade), `renderPlan.ts`, `mcpTools.ts`, `web/src/rendrr/color.js` (GradeMore, Scopes), `controls.js` (OpWheel), `look-gl.js` | Done, tested (shared `color5.test.ts` 8; worker `color5-render.test.ts`: the graded file equals the shared LUT applied to the source as closely as a plain render does, worst 5.2/255; the vignette darkens the corners 36% at amount 40 and leaves the middle; browser `color5.mjs` 11 checks; scopes read a real video in `blend-match.mjs`) |
| **Audio: crossfades, volume keys, pan, EQ, reverb (Premiere parity, phase 6).** set_clip_audio on a dialogue, music or sound-effect clip takes pan (a balance: the middle as it was), a three-band EQ (120 Hz shelf, 1 kHz bell, 6 kHz shelf), reverb (amount and room size: a seeded impulse response, convolved by afir) and volume keys (a straight line in dB). set_audio crossfade: an equal-power crossfade at every dialogue cut, each side reading half of it from the footage past its cut, so nothing moves. Audio tab: Pan, EQ, Reverb and Room, volume keys at the playhead, Crossfade at every cut. The live player plays the volume keys; pan, EQ, reverb and crossfades are heard in the rendered preview (as cleanup is). | `shared/src/audio.ts` (keys, panGains, eqChain, reverbIr, wavStereo, clipFxText), `timeline.ts`, `ops.ts` (set_clip_audio, set_audio crossfade), `renderPlan.ts` (clipFx, irs, soundFx, crossfade joins), `playback.ts`, `mcpTools.ts`, `worker/src/jobs/render.ts` (impulse responses), `web/src/rendrr/editor.js` (ClipSound) | Done, tested (shared `audio6.test.ts` 6; worker `audio6-render.test.ts`: hard left leaves the right silent and the left as it was, low -12 takes 60 Hz down 12.7 dB and leaves 5 kHz, keys measured at 0/-9.9/-20 dB, a room rings on at -31 dB after a burst, a crossfade dips 0.5 dB at the cut where the declick dips 22 dB and the edit is as long; browser `audio6.mjs` 12 checks) |
| **Warp Stabilizer (Premiere parity, phase 7).** stabilize on V1 clips (smooth 0-100, off). The worker first measures how the camera moved over each stabilized part (vidstabdetect, on exactly the frames the render reads: the plan's frame grid from the part's first frame), then the render smooths it out over the part's own frames (vidstabtransform, zoomed in just enough to hide the edges). Parts at another speed play as filmed (the plan says so). Speed & motion tab: a Warp Stabilizer switch and Smoothness. The player shows the footage as filmed. | `shared/src/ops.ts` (stabilize), `renderPlan.ts` (StabilizeOp, stabilizeKey, stab), `mcpTools.ts`, `worker/src/lib/stabilize.ts` (detectShake), `worker/src/jobs/render.ts`, `web/src/rendrr/editor.js` | Done, tested (shared `stabilize.test.ts` 3; worker `stabilize-render.test.ts`: a hand-held shake over a still scene, frame-to-frame movement 30.4 as filmed, 0.15 stabilized, the same 165 frames; browser `stabilize.mjs` 6 checks) |
| **Morph Cut (Premiere parity, phase 8).** set_transition type morph on a jump cut: A's frame at the window's start flows into B's at its end, the frames between made by motion-compensated interpolation (minterpolate), so the face moves from one place to the other instead of jumping. Each side uses only its own clip's frames (no footage past the cut needed). Clip tab: "Morph Cut (jump cuts)" in the transition menu; the player shows a dissolve there. | `shared/src/motion.ts` (TRANSITIONS, transitionAt), `renderPlan.ts` (morph sides, the minterpolate chain), `mcpTools.ts`, `web/src/rendrr/editor.js` | Done, tested (shared `morph.test.ts` 2; worker `morph-render.test.ts`: a textured square that jumps 60 px sits halfway across, 419.5 between 389.5 and 449.5, one square wide, in the middle of the window; the edit as long; browser `morph.mjs` 3 checks) |
| **Adjustment layers (Premiere parity, phase 9).** adjustment_layer: a V3 layer over a time range whose grade and effects go on everything under it (footage, b-roll, graphics); text and captions stay on top as they are. Changed by clipId, removed with delete_clip, moves with its V1 clip. Color tab: listed on the whole-edit page with "+ Adjustment layer here"; a picked layer has its own page (grade, wheels, HSL, blur, darken, vignette). The player previews it with a backdrop filter; on the timeline it is a band along the top of V3. | `shared/src/timeline.ts` (V3 kind adjust), `ops.ts` (adjustment_layer, get_project line), `look.ts` (mergeGrade, adjustCss), `renderPlan.ts` (plan.adjust, the windowed colour chain after graphics), `playback.ts`, `mcpTools.ts`, `web/src/rendrr/color.js` (AdjustList, AdjustPanel), `editor.js` | Done, tested (shared `adjust.test.ts` 7; worker `adjust-render.test.ts`: under the layer the grey picture 126 -> 62, the orange b-roll grey 63,63,63, the magenta text box 229,34,227 as before, nothing changes before or after; browser `adjust.mjs` 11 checks) |
| **Multicam (Premiere parity, phase 10).** multicam: other cameras of the same take, synced to the main video by their sound on the server (each video's 10 ms loudness, cross-correlated by FFT); switch_angle: which camera V1 shows over clips, a range, or from the playhead to the next change; sound from the main video or each camera's own; the clip's own picture where an angle has no footage. Editor: a Multicam page with a monitor per camera that follows the playhead (click to cut), offsets, sync again, sound, remove. | `shared/src/multicam.ts` (fft, syncEnvelope, syncOffset, multicamText), `timeline.ts` (MulticamSchema, V1 angle, sourceVideoIds), `sequence.ts` (angle pictures, sound follow, coverage), `ops.ts` (multicam, switch_angle, get_project lines), `renderPlan.ts` (angle inputs, Multicam line), `api/src/services/multicam.ts` (syncAngle, resolveMulticam), `routes/projects.ts` (/multicam-sync), `worker/src/jobs/render.ts`, `web/src/rendrr/multicam.js`, `editor.js` | Done, tested (shared `multicam.test.ts` 8: 13.374 s found to under 6 ms, unrelated recordings not sure; worker `multicam-render.test.ts` 3: sync 2.3701 s for 2.37 s, the angle's frames at edit 3.5/4.5/5.5 s equal its own at +2.37 s (98, 110, 122), main sound under it (440 Hz 26 dB over 880 Hz), with follow the angle's own (880 Hz 29 dB over 440 Hz), as long; browser `multicam.mjs` 12 checks) |
| **Flip, crop, anchor, shadow, motion blur, smooth slow motion, eased ramps (Premiere parity, phase 11).** set_flip (V1, b-roll); set_card on b-roll (crop, rounded corners, drop shadow from its alpha: picture-in-picture cards); set_keyframes anchor and motionBlur (V1, b-roll, graphics); set_speed interp frames/blend/flow (optical flow slow motion); ramp points with ease. Clip tab: Flip and crop section (flip buttons, crop sliders, corners, shadow), slow motion frames, ramp easing, anchor point grid, motion blur. | `shared/src/motion.ts` (AnchorSchema, easeAt, eased speedAt), `timeline.ts` (flip, interp, anchor, motionBlur, b-roll cardLook), `sequence.ts` (part flip and interp), `ops.ts` (set_flip, set_keyframes, set_speed, set_card), `renderPlan.ts` (flipFilter, minterpolate chain, motionChain anchor and sub-frame blur, dropShadow, extrasLines), `playback.ts`, `mcpTools.ts`, `web/src/rendrr/editor.js` (FrameLook, Clip tab) | Done, tested (shared `phase11.test.ts` 5; worker `phase11-render.test.ts` 5: flip swaps red and blue and turns b-roll upside down; scale 0.5 about the top left fills the top left quarter; motion blur edge 1 px sharp, 26 px at 100; optical flow steps 4-5 px every frame against 0/9 held; b-roll card cropped with the picture round it and its shadow 26 levels darker under its edge; browser `phase11.mjs` 13 checks) |
| **Deliverables (Premiere parity, phase 12a).** set_export format mp4/gif/audio/wav/overlay (graphics, text and captions on transparency, ProRes 4444 by a black and a white pass), bitrate and fps; every final comes with SRT and WebVTT captions and YouTube chapters from chapter marks (add_marks kind chapter), linked and listed in the final's answer. Export window: format, frame rate, bitrate, SRT and WebVTT saved from the edit, chapters copied. | `shared/src/deliverables.ts` (srtText, vttText, chaptersText, chapterProblems, formatFile), `timeline.ts` (ExportSchema, chapter marks), `renderPlan.ts` (subtitles, chapters, format, bitrate, fps, pictureAs, encode), `ops.ts` (set_export), `worker/src/lib/deliver.ts` (makeGif, mergeOverlay, writeSideFiles), `jobs/render.ts`, `api/src/services/render.ts`, `tools.ts`, `web/src/rendrr/export.js` | Done, tested (shared `deliverables.test.ts` 6; worker `deliver-render.test.ts` 5: 25/1 at 2.18 Mbit/s for 2 asked; WAV pcm_s16le and AAC alone, 4.00 s; GIF 640 px 15/1 60 frames; ProRes 4444 with the text box opaque magenta and the corners alpha 0; SRT, WebVTT and chapters files; browser `deliver.mjs` 10 checks) |
| **More effects and transitions (Premiere parity, phase 12b).** set_transition push, wipe, iris, cross-zoom, film-dissolve, clock, barn-door, diamond (FFmpeg xfade from both sides' handles; direction for push, wipe, barn doors); set_effects glow, grain, rgbsplit, shake, mirror, pin (corner pin with four corners, transparent outside). Clip tab: the transition menu and direction; Color tab: the effect buttons, corner pin sliders, "(in the render)" marks; the player draws each transition's split. | `shared/src/motion.ts` (TRANSITIONS, xfadeOf, transitionAt), `look.ts` (EFFECTS, effectPx, effectsText), `renderPlan.ts` (xfade chain, linear-light film dissolve, effect filters, pin alpha), `mcpTools.ts`, `web/src/rendrr/editor.js`, `color.js` (PinCorners), `look-gl.js` | Done, tested (shared `effects12.test.ts` 4; worker `effects12-render.test.ts` 3: wipe, push, iris, barn doors, diamond and clock split where the player does; film dissolve 160/155 against 125/120; grain spread 0 to 18, RGB split edges 12 px apart, mirror, shake 0 to 4.1 frame-to-frame, glow 0 to 83 past the edge, corner pin black round the middle quarter; browser `effects12.mjs` 16 checks) |
| **Connector fixes from a long session (14 points).** create_graphic codeFrom + edits (+ replace: the same graphic changed in place), codeUrl, upload; recorder: 2 recordings at once, kept browsers, chunk retries x3 with waits, longer browser waits; renders check every placement first (wait, take over, record again, or stop naming the placement and params); retry_graphic; a failed graphic can be placed; add_graphic/test_graphic rerecord; open_projects with projectId sends only that edit; get_footage word_times; get_graphic/get_render wait_seconds; data on placements (window.params.data); restore_words from/to; set_clips keeps V3 at its edit times; delete_clip finds the track. | `api/src/services/graphicCode.ts`, `routes/graphicUpload.ts`, `tools.ts`, `services/claudeApp.ts`, `core/src/graphics.ts`, `worker/src/lib/graphics.ts`, `jobs/graphic.ts`, `jobs/render.ts`, `jobs/testGraphic.ts`, `shared/src/ops.ts`, `sequence.ts` (restoreSourceRange), `catalog.ts`, `mcpTools.ts`, `mcp/src/app/projects.html` | Done, tested (api `graphic-tools.test.ts` 6, `graphic-retry.test.ts`, `claude-app.test.ts`; worker `placement-precheck.test.ts` 3, `graphic-cleanup.test.ts` (a lane survives 3 browser deaths), `long-graphic.test.ts`; shared `mcp-fixes.test.ts` 6) |
| **The app looks like the web app.** Rendrr's own dark look whatever Claude's theme (it was white in a dark Claude): the web app's colours, buttons, Space Grotesk titles, project cards with the name over the picture, the editor's transport bar and comment cards (avatar, lime time chip), the time over the picture. Fonts from Google Fonts, as the web app (declared in the page's allowed domains). | `mcp/src/app/projects.html`, `mcp/src/build.ts` | browser `mcp/test/app-browser.mjs`, `mcp/test/server.test.ts` |

Found while adapting the skill, not changed: a render fades the sound out and in over 20 ms at every cut (set_audio declick). The skill lists exactly that as a mistake ("dropouts at every join" in rooms with hiss). The skill says how to lower it for now; a real fix is a crossfade at each join, a change in the render engine.

## Engine Part 6: the user interface (28 October)

| What | Where | Tests |
|---|---|---|
| The timeline's sound tracks show a real waveform, drawn from the 10 ms peaks the deep measurements keep for every video (music and effects: worked out in the browser from their files). Only the part on screen is drawn, one column a pixel, so it works at any length and zoom. Zoom now goes from the whole edit (4 px a second) to the 10 ms frames (600 px a second); the slider is on a log scale. The dialogue track is taller. The fake waveform pattern is gone. | `shared/src/waveform.ts`, `web/src/rendrr/editor.js`, `api/src/services/projects.ts` (links to the peaks) | browser `demo/timeline-part6.mjs` |
| Marks (Rendrr's silences, fillers, retakes, stumbles, notes to the crew, breaths, clicks and the rest, and the AI's own marks) show as thin coloured lines across the tracks, with a note on hover (kind, label, note, times; "from your AI" for the AI's). A stretch also gets a tint in the ruler. Marks on / Marks off hides them, and is remembered. Beats are left out (too many). | `api/src/routes/projects.ts` (GET /projects/:id/marks), `web/src/rendrr/editor.js`, `styles.css` | browser `demo/timeline-part6.mjs` |
| Not shown: the footage page's measurements ("What Claude sees": the breakdown, the frames the AI reads, the video as text) are gone; the page keeps only the switch between footage and reference. The hidden library and style files never had screens. Tool names are no longer sent to the browser (AI activity). | `web/src/rendrr/screens.js`, `api/src/serialize.ts` | browser `demo/timeline-part6.mjs` (no tool names, library items or style files on the main screens) |

Kept as they are: the other screens you already use (projects, styles, settings, connect AI, review links, explore). Removing them was not asked for, and they show none of the hidden things.

## Engine Part 4: the hidden library (28 October)

For the AI only. Nothing here shows in the user interface.

| What | Where | Tests |
|---|---|---|
| 4.1 Animation library: 48 ready items (35 graphics, 13 that make edits). Text entrances (blur-in, slide-in, pop, typewriter, word-by-word, mask reveal, highlight wipe, underline, strike; each leaves with the matching exit), 6 lower thirds, stats (counter, ring, bars, before/after), lists (steps, checklist, flow), callouts (arrow, circle, zoom box, spotlight), a whiteboard with a moving camera, picture in picture (circle, box), transitions (white flash, dip to black, whip, zoom punch, slide, glitch, light leak), social cards (comment, notification, followers, chat, post; no real logos), backgrounds (solid, gradient, grid, dots, paper, blurred footage), icons. Each takes text, colours, font, size, position or auto, easing (linear, ease-out-cubic, ease-in-out, spring), entrance speed and exit. Every frame is drawn from the time alone, so the render, test_graphic and the editor's player draw the same. | `shared/src/library.ts`, `shared/src/libraryHtml.ts`, `shared/src/graphicHtml.ts` | worker `library.test.ts` (every item drawn in the graphics browser at 16:9 and 9:16: no page errors, on screen once in; one recorded through the render's own path); API `library.test.ts` |
| Tools: list_library {kind}, get_library_item {id} (every param with its default and limits, and a preview frame drawn by the worker), add_library_item {projectId, itemId, start, end, params} (one new version). Graphics go on V3; position auto is worked out from the face measured there (a tall frame keeps clear of the app's buttons). Items that are edits become those edits and say so: a transition goes on the nearest cut, a background is set_background, picture in picture splits V1 at the range's ends and makes those clips a card around the face in a corner. apply_edits add_graphic checks a library item's params too. | `api/src/services/library.ts`, `shared/src/ops.ts`, `worker/src/jobs/snapshot.ts` | API `library.test.ts`: ten items in one edit, wrong params, a missing font |
| A new background kind: pattern (grid, dots, paper), the same pixels in the render and the editor's player. | `shared/src/cardLook.ts`, `shared/src/renderPlan.ts`, `web/src/rendrr/editor.js` | worker `card-render.test.ts` (each pattern rendered matches the shared picture within 4 levels) |
| 4.2 Icons: 5,844 Tabler icons (MIT licence, outline and filled), brand logos left out. search_icons {query} gives ids best first with a numbered sheet to look at; the Icon item animates one in with any entrance. | `api/src/data/icons.json.gz`, `scripts/build-icons.mjs` | API `library.test.ts` |
| 4.3 Fonts: all weights of the 16 named Google Fonts in the graphics browser and the caption engine; the editor's player now loads the same font files for built-in graphics. add_font was already there. A library item with a font that is not installed or added is refused (never drawn with a fallback); custom graphics still get the missing-font warning. | `web/public/fonts`, `worker/fonts.txt`, `web/src/rendrr/editor.js` | worker `library.test.ts` (a missing font is reported) |
| 4.4 analyze_reference {videoId}: a reference measured into a STYLE FILE kept with the account (a new hidden table): pacing (shot lengths, cuts a minute, pauses kept), captions (place, size, colour, active word, outline, box, stroke weight, words at once, how often they change, how they come in), text graphics (sizes, colours, places, entrances and exits in ms, easing), transitions (flash, dip to black, whip, cut), punch-ins and slow zooms (from the face's size), the grade (brightness, contrast, saturation, warmth), sound (loudness, a bed in the pauses, ducking from its low end, hits at cuts) and every graphic moment with its time. list_styles lists style files; get_style reads one. Measured only, never applied. About 7x faster than real time (a 22-minute reference in about 3 minutes). | `worker/python/reference.py`, `worker/src/jobs/style.ts`, `shared/src/styleFile.ts`, `api/src/services/styleFiles.ts` | API `reference.test.ts` (the request's test 3): a made-up reference with a known style read back correctly; 10 library items placed from its numbers; test_graphic answered in 7.4 s with the real worker. Shared `style-file.test.ts` |

Not done: open illustration packs. Bundling one meant running a third-party package's code to pull its pictures out, which this session does not allow. Icons cover most uses; an illustration pack can be added from its plain SVG files later.

## Engine Part 5: graphic engine reliability (27 October)

| What | Where | Tests |
|---|---|---|
| test_graphic {graphicId, params, at, seconds 3-5, length, over: {videoId, time}, aspect}: 3 to 5 s of a template or a custom graphic drawn over the footage (or a grey frame) at 540p, with 3 frames, a link to the clip, and what of the frame and of the face it covers. Its own queue (a render does not hold it up); the tool waits up to 9.5 s; the same test again answers from the kept result (a day). Changes nothing. | `api/src/services/testGraphic.ts`, `worker/src/jobs/testGraphic.ts`, `shared/src/mcpTools.ts` | worker `test-graphic.test.ts` (a title card in 7.1 s on 4 CPUs, recorded in 4.8 s; a lower third covers none of the face, a box over it all; new params recorded up to 20 s in); API `test-graphic.test.ts` |
| A 6-minute graphic moving on every frame at 1080x1920 records without failing. It failed before: the recorder started a video encoder for every 90 pictures without waiting, each holding about 0.8 GB, and ran out of memory after 3.5 minutes (the error then escaped). Now as many encoders run as memory allows and the browsers wait for a free one; a failed encoder is caught. | `worker/src/lib/graphics.ts` | worker `graphic-busy.test.ts`: 6 min recorded in 388 s with 3 browsers (limit 702 s), 10,800 pictures, 6 chunks, frames from every chunk where their time says |
| Long graphics record in chunks of at most 90 s, one lane of chunks per browser in parallel, joined into one file. A chunk whose page or browser crashes is recorded again once on a fresh page. | `worker/src/lib/graphics.ts` | the graphic tests above and the earlier long-graphic ones |
| Uploads to storage try again (twice) when the connection drops, reading the file afresh: the storage client reused a connection the server had closed after a pause, and a streamed upload cannot be retried by the SDK. Found by the test above. | `core/src/storage.ts` | worker `test-graphic.test.ts` |

Already in place from earlier work (26 October): params per placement (window.params, cached per graphic and params), create_graphic answering in under 10 s with get_graphic for progress, and the cost estimate before recording that fails fast with the reason.

## Engine Part 3: preview checks (27 October)

render_preview's check now reads the preview FILE, not only the edit. Still measurements only: the AI decides.

| What | Where | Tests |
|---|---|---|
| Gaps in speech measured in the preview's own sound (Silero VAD, edges moved onto the level, from 0.15 s). Each gap has its edit time, length, footage time and clip, and at a join which side the silence is on ("end of k0 0.25s + start of k1 0.12s"). It replaces the old pause line from word times. Silent gaps and breaths are said. | `worker/python/deep_audio.py` (`--joins --min-speech --edges`), `worker/src/lib/sound.ts`, `shared/src/previewCheck.ts`, `shared/src/qa.ts` | shared `preview-check.test.ts`; worker `preview-check.test.ts` (real render: sides measured 0.25 s and 0.12 s for 0.25 s and 0.12 s kept) |
| Clipped words: every word whose sound (the Part 2 word edges) a cut goes through, with the ms cut off and the ms that play; a cut word still partly heard too. Flagged. | `shared/src/previewCheck.ts`, `api/src/tools.ts` (alignments of every video on V1) | shared and API `preview-check.test.ts`; worker: "pick" 80 ms cut off, as cut |
| Clicks at joins: a click within 20 ms of a join (the footage's click rule), or the cut itself jumping the waveform (20 dB over the jumps around it). Flagged. A word starting at the join is not a click. | `worker/python/deep_audio.py` | worker: a hard cut in a tone clicks (over 20 dB); renders with the 20 ms fades do not |
| "Transcript as it plays" is the preview's sound transcribed again (same transcriber as the footage), done by a new `heard` job after each preview (newest preview only), with where it differs from the edit's words ("0:01.00 heard "by" for "my""). An older preview is transcribed on first ask. While it runs the tool says so and how long; a failure is said. | `worker/src/jobs/heard.ts`, `api/src/tools.ts` (get_preview_frames, get_render) | worker (job with a stand-in transcriber, skipped when a newer preview exists); API `preview-check.test.ts` |
| Graphics: sampled across their whole time (2 a second, 8 to 24 moments); invisible only when no moment shows any pixel. How much of the main face's box each graphic covers at most (face boxes from Part 2, placed as the render draws the clip: turn, fit, framing, keyframes, zoom; b-roll over V1 hides it). Over 25% is flagged. | `worker/src/lib/ffmpeg.ts` (graphicCover), `worker/src/jobs/render.ts`, `shared/src/previewCheck.ts` | worker: a box over the face covers 98% of it, one in a corner under 5% |

Spec test (AI-style script, real render): clips cut at start_audio and end_audio of chosen words. Check: "Clipped words: none", "Clicks at joins: none", and the only gap over 0.15 s is the 0.89 s pause the script kept inside its clip. Flags: none.

Found while testing: cut_words still cuts by the transcriber's times (a word to the next word's start). On the test video that left 20 ms of a cut word and took 20 ms off the next one. The check now names both, so the AI can cut on the word edges instead (set_clips or cut_words from/to).

Checked live on the 22-minute video's edit (289 s preview, rendered in 1 min 27 s, transcribed again within 4 minutes): 32 gaps at joins with both sides, 5 clipped words in ms, 54 heard differences. Three things from that run were fixed straight away: a word starting right at a cut ("But" after a006|a007, 22.7 dB) was counted as a click (bursts next to a join now need the in-speech 30 dB; the cut's own jump keeps 20 dB); a word whose transcriber time started a hair before its clip showed as "heard, not in the edit's words" (a word now plays where the middle of its sound is); "silent where words should play" and the noise between words used the transcriber's times (now the word edges and the file's own speech). Also: today's deploys stopped the 22-minute video's re-measurement mid-job, and the daily backfill would not retry it until the next day; a failed backfill job is now cleared and queued again at each start.

Cost: each preview's sound goes to AssemblyAI once (the newest preview of an edit only), the same rate as transcribing footage.

## Reference edits: blockers fixed (27 October)

From the C1744 edit, where Claude said Rendrr could not rotate, could not lay the talking head out as a card on a background, and the op list was old.

| What | Where | Tests |
|---|---|---|
| apply_edits' op is free text: an app's old copy of the tool cannot hide newer ops. The guide lists every op; an unknown op is named with the full list. | `shared/src/mcpTools.ts`, `api/src/tools.ts` | shared `edits.test.ts`, API `marks.test.ts` |
| A video as a card on a background: set_card (crop, rounded corners, drop shadow, border) and set_background (a colour, a gradient, a library video looped, or the footage blurred), with set_framing to shrink and place it. Drawn the same in the render and the editor's player; named in get_project. | `shared/src/cardLook.ts`, `shared/src/ops.ts`, `shared/src/renderPlan.ts`, `worker/src/jobs/render.ts`, `web/src/rendrr/editor.js` | shared `card-look.test.ts`, worker `card-render.test.ts` (compared with the shared maths: 0.28 levels apart), `web/demo/card-match.mjs` (player vs render: 0.5-0.7 levels) |
| Footage filmed sideways is found (faces clear only when turned), measured upright, and named in get_footage, get_vision and create_project with the set_rotation to send. The editor offers "Turn it upright"; nothing turns by itself. | `worker/python/vision.py`, `shared/src/deep.ts`, `api/src/services/projects.ts`, `web/src/rendrr/editor.js` | worker `deep.test.ts`, `web/demo/sideways.mjs` |

## Engine Part 2: footage measured more deeply (27 October)

Rendrr still decides nothing: these are measurements for the AI to cut on.

| What | Where | Tests |
|---|---|---|
| The sound every 10 ms: peaks, loudness, speech (Silero VAD), onsets, breaths, clicks, clipping (flat tops, found after AAC too), room tone, voice level, LUFS and true peak. Kept as a summary in the database and the 10 ms frames in storage (4 bytes a frame: 22 min = 530 KB). | `worker/python/deep_audio.py`, `worker/src/jobs/deep.ts` | worker `deep.test.ts` (espeak voice + a breath, a click and clipping put in at known times) |
| Where each word starts and ends in the sound: wav2vec2 (ONNX) forced alignment per stretch of speech, then each edge moved onto the sound (a rise past the room, a fall, or the dip between two touching words). Without the model, the edges are still moved onto the sound and the tools say so. | `worker/python/align.py` | worker `deep.test.ts` (alignment math, edge moves) |
| Faces at 10 fps (YuNet boxes, tracked; MediaPipe on each face: mouth open, blinks, head turn), the picture every 0.5 s (brightness, sharpness, motion, shake, face exposure, main colours) and stretches: face lost, looking away, head turns, soft, shaky, dark, blown out, and where text can go. | `worker/python/vision.py` | worker `deep.test.ts` (a face that leaves, a shake, a dark end) |
| A new queue, `deep`, after the analysis; old videos are measured on first use (the tool says so and how long) and by a backfill at worker start (50 a day). Each step reports percent and time left; the time limit grows with the video (5 min + 0.6 s a second); a failure is stored and named. | `worker/src/index.ts`, `api/src/services/deep.ts` | API `deep.test.ts` |
| Tools: `get_audio` (numbers in a range, any step from 10 ms), `get_waveform_image` (a PNG drawn on the server: speech, breaths, clicks, clipping, word edges, ticks), `get_vision` (summary, rows every 0.5 s, faces at 10 fps on request), `map_time` (edit seconds to footage seconds and back). | `api/src/tools.ts`, `shared/src/deep.ts`, `api/src/services/waveform.ts` | API `deep.test.ts`, shared `deep.test.ts` |
| `get_footage`: one line each for the sound, the alignment and the picture; detail "words" lists every word whose edges in the sound differ from the transcript by over 60 ms. `get_frames`: times to the millisecond, the time and frame number written on each frame. | `api/src/tools.ts`, `worker/src/jobs/frames.ts` | API `deep.test.ts` |
| `get_project`: each V1 clip says what its sound does at the edges (time before the first word and after the last, a word the cut goes through and how much of it is lost, pauses inside), from the alignment. Long edits page their V1 clips (clipsFrom, clipsLimit, 100 by default). | `shared/src/ops.ts`, `api/src/tools.ts` | API `deep.test.ts` |
| New marks from these: breath, click_pop, clipped_audio, out_of_focus, face_lost, off_camera, and low_light from the 0.5 s picture. Silence marks get their real level (median of the 100 ms values) instead of -35 / null. | `shared/src/marks.ts` | shared `deep.test.ts` |

Speed measured here: 22 minutes of sound in 13 s; faces and picture at 0.3x real time (a 22-minute video about 7 minutes) on one core.

Live (27 October): the worker image built with wav2vec2 ("wav2vec2 ready") and MediaPipe; the migration applied; the backfill queued the 4 earlier videos. "Ai Editor Pro VSL" (22 min) was measured in about 5 minutes: 1756 of 1756 words placed in the sound, face on screen 100%, 4 breaths, 10 clicks, no clipping. Two things found and fixed there: LUFS and true peak were empty on a long video (FFmpeg's per-frame loudness lines filled the kept output; now only its summary is written), and some word starts sat in the pause before the word ("because" at 176.19 s in a silence from 176.2 to 177.4 s; such an edge now moves onto the first sound, or the first speech the detector hears, inside the word, and no word holds a pause of 250 ms or more). DEEP_VERSION 4 measures every video again with these fixes; after it, "because" is at 177.44-177.61 s, where the silence ends, and the video reads -20 LUFS, true peak -4.3 dBTP. Frames from get_frames carry the time and frame number ("177.250s (2m 57.250s) · frame 10624 at 59.94 fps"). A 20-minute video measured in 2 minutes on the live worker. Not checked live: get_audio, get_waveform_image, get_vision and map_time by name (this session's connector still had the old tool list; they are covered by the API tests and the MCP server deployed with them).

Models: Silero VAD (MIT) and MediaPipe Face Landmarker (Apache-2.0) are in `apps/worker/models` with their licences and checksums. wav2vec2 (Apache-2.0, ~95 MB) is downloaded from Hugging Face when the worker image is built; the build log says "wav2vec2 ready" or prints a warning and the aligner falls back to moving the edges onto the sound.

## Several videos in one edit (27 October)

For a video filmed in parts. Adding many videos at once already worked (Add footage takes several files, or several videos in Drive); this makes one edit of them.

| What | Where | Tests |
|---|---|---|
| Library › Select: click videos in the order they play (each gets its number), then Make one edit. A video still processing, or a reference, is refused with a message. | `web/src/rendrr/screens.js` | `web/demo/multi-video.mjs` |
| New edit: tick one video or several; the order list moves them up or down or leaves one out. The parts play whole, back to back; the first is the edit's footage. Up to 20 at the start. | `screens.js` (`VideoOrderPicker`, `NewProjectModal`), `api/src/services/projects.ts`, `shared/src/ops.ts` (`buildRawSequence`) | `shared/test/multi-video.test.ts`, `api/test/multi-video.test.ts` |
| Editor › Add videos: several whole videos at once, in order, at the end or the playhead (or a part of one, as before). One change, one undo. | `web/src/rendrr/editor.js` | `web/demo/multi-video.mjs` |
| Connector: `create_project` takes `videoIds` (in order); the result names each part's clip. | `shared/src/mcpTools.ts`, `api/src/tools.ts` | `api/test/multi-video.test.ts` |
| Deleting a video now also names the edits that play it on V1 (a part of a several-video edit), not only the edits made from it. | `api/src/routes/library.ts` | `api/test/multi-video.test.ts` |

## Rendrr is the engine (26 October, night)

Rendrr measures, marks, renders and checks. It never cuts, trims or reorders on its own: every change is an explicit edit the AI sends.

### Part 1: marks instead of automatic edits

| What | Where | Tests |
|---|---|---|
| Marks: what Rendrr noticed, with exact footage times. 17 kinds; Rendrr makes silence, filler, retake, stumble, false_start, director_note, scene_change, low_light, loud_peak, music_beat from the analysis it already has (Part 2 adds breath, click, clipped audio, focus, face). Worked out on read, the same ids every time; never stored. | `shared/src/marks.ts` | `shared/test/marks.test.ts` |
| The AI's own marks (`add_marks`, `update_mark`, `delete_mark` in `apply_edits`) and its notes on Rendrr's (label, note, hidden) are kept with the edit (`timeline.marks`, `timeline.markEdits`), so undo takes them back. Old edits have neither and load as before. | `shared/src/ops.ts`, `timeline.ts` | `shared/test/marks.test.ts`, `api/test/marks.test.ts` |
| New read tools: `mark_silences` (id, start, end, length, level_db), `mark_fillers` (id, wordId, text, start, end), `list_marks` (kind, source, from/to, edit seconds), `get_retakes` (groups of takes, each measured and scored, never picked). On an edit each mark says where it plays, or that it is cut. 28 tools now. | `api/src/tools.ts`, `api/src/services/marks.ts`, `shared/src/mcpTools.ts` | `api/test/marks.test.ts` |
| `cut_silences` and `remove_fillers` are retired: a call gets a clear answer with what to do instead, and nothing is saved. They are no longer offered to the AI. | `shared/src/ops.ts` | `shared/test/edits.test.ts` |
| `apply_style` sets the style's looks only (its captions). Its other rules (pauses, fillers, zooms, music, sound effects) come back as text for the AI to carry out. It no longer rebuilds the clips, cuts, zooms or adds music. `get_style` says the same. | `shared/src/ops.ts`, `api/src/tools.ts` | `shared/test/ops.test.ts`, `phase2.test.ts` |
| The editor's Cut silences button is gone. | `web/src/rendrr/editor.js` | `next build`, browser match tests |

## Faster graphics and framing (26 October)

Six fixes for long, graphics-heavy edits through the connector. Each has its own tests; the full suites pass after each.

| # | What | Tests |
|---|---|---|
| 1 | Long graphics: scanned first, cost estimated (over 25 min fails in seconds with the reason), recorded in balanced ranges by several browsers, one file. The 393 s 1920x1080 canvas graphic records in about 2 min. `window.renderFramePure` (opt-in) skips frames not recorded; `Math.random` is seeded. | `worker/test/graphic-scan.test.ts`, `worker/scripts/repro-long-graphic.ts` |
| 2 | One graphic, many placements: `create_graphic params` (window.params), `add_graphic from` (start part way in) and `params` (its own values, recorded once per set and cached). The editor plays each placement's own file. | `shared/test/graphic-reuse.test.ts`, `worker/test/graphic-reuse.test.ts`, `api/test/graphic-reuse.test.ts`, `web/demo/graphic-match.mjs` |
| 3 | Fonts: 82 Google Fonts installed ('Open Sans' 700 is its real bold); `add_font` and Settings › Fonts add a file once, used by name; a font that is not there is named in a warning. New `Font` table and `Graphic.warnings`. | `worker/test/graphic-font-warnings.test.ts`, `api/test/fonts.test.ts` |
| 4 | Tool calls answer within 8 s: `create_graphic`, `render_preview` and `render_final` return the id and progress; `get_graphic` (new) and `get_render` are polled. | `api/test/long-calls.test.ts` |
| 5 | The graphic check measures 8 moments across the part on screen (min / avg / max) and calls a graphic invisible only if all are blank. | `worker/test/graphic-cover.test.ts`, `shared/test/phase1.test.ts` |
| 6 | `set_framing fitFaceTo {x, y, r}` (YuNet finds the face, the op frames each clip), `set_clips` framing per clip, new clip ids in every edit's result. | `shared/test/framing-faces.test.ts`, `worker/test/faces.test.ts`, `api/test/fit-face.test.ts` |

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

### Phase 3, finished after re-reading the plan (24 October)

Three items of the plan were not fully built in the first pass. They are now:

- **Fade at every cut, 20 ms** (the plan asks for 15-30 ms). Every dialogue cut fades out and in, with or without a cleanup preset. Before, it was 4 ms and only with a preset. It can be set from 0 to 30 ms (`set_audio{declick}`).
- **Manual cleanup values.** Each preset is now a set of numbers. `set_audio` and the Audio tab's "Fine-tune" sliders can change any of them, and `null` goes back to the preset's value:
  - high-pass (Hz)
  - noise reduction (dB)
  - presence lift at 3.5 kHz (dB)
  - de-esser
  - compression ratio

  The preset chains are unchanged, character for character (tested).
- **Noise left, in the check.** A new line reads, for example, "Noise between words: -61.3 LUFS (median of 24 windows in pauses)". It is measured from the file (the 400 ms loudness windows lying wholly inside pauses between words), and says when music is included.
- **Bug found in older work:** with loudness off, the mix still ended in FFmpeg's limiter with auto-level on. Auto-level raises everything to the limit, and the limiter then rides loud sound wave by wave, which distorts it. Loudness off now uses a plain safety limiter. Model A plans keep the old one, unchanged.

### Phase 3 tests

| What | Result |
|---|---|
| Shared: settings, ops, speech ranges, the FFmpeg curves equal the player's, graph, measuring mode, legacy check, fades in the check, cut fades, hand-set cleanup, noise between words | 105 pass |
| Worker: a cut in a loud tone, rendered | without the fade the cut jumps more than 3x the tone's own step between samples; with 20 ms, under 1.3x |
| Worker: noisy room, rendered | the check's noise between words drops by 6 dB or more with the noisy-room cleanup |
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

## Phase 4: captions and text

- **Caption styles.** A caption style sets:
  - font (14 bundled fonts) and weight, size (share of the frame's short side), colour
  - stroke, shadow, box (colour, opacity, padding), position (x, y of the caption's bottom centre)
  - words at once, words a line, lines, case (as typed, upper, lower), the spoken word's colour

  The three looks (clean, bold, outline) are presets of it, with the same sizes, colours and boxes as before. The connector's `set_caption_style` changes any field, and `set_captions{look}` goes back to a preset.
- **Text layers.** Title cards and callouts are text clips on V3, not HTML graphics:
  - text with line breaks, the same style fields, alignment, a full-frame card behind, an animation (none, fade, pop, slide)
  - presets: title, callout, lower-third, plain

  They hang on a V1 clip like graphics. Ops: `add_text`, `set_text`.
- **save_style keeps a full caption style.** `save_style{rules: {captions: {style: {...}}}}` stores it. `apply_style`, or `set_captions{styleId}`, gives any video exactly those captions in one step.
- **One caption layer.** One caption is on screen at a time, with up to `lines` lines. Text layers stack in V3 order under the captions.
- **The editor draws what the render draws.**
  - Shared code lays out every caption and text layer in output pixels: the lines (by words a line, then by width using the fonts' own glyph widths), sizes, positions, boxes, strokes, shadows, the spoken word and the animation at each moment.
  - libass draws that layout from one ASS file. Lines are broken by us (WrapStyle 2), so libass never re-wraps.
  - The editor draws the same layout on a stage the size of the output, scaled to the player.
  - Both use the same font files (OFL, in `apps/web/public/fonts`). Each file has its own family name, so neither side fakes a weight. The browser is given the font metrics libass uses (`ascent-override`), so lines sit at the same height.
- **Check.** The Captions line names the style. A new Text line lists the layers. New flags: text that does not fit in the frame, and text that covers the captions while someone speaks.
- **Editor.** A Text tab:
  - caption on/off, the look to start from, font, weight, size, colour, box, stroke, shadow, position, case, the spoken word's colour, words at once, words a line, lines
  - text layers: add one at the playhead (title, callout, lower-third, plain), edit its text and every style field, alignment, animation, card; remove it

  Text clips show on V3.
- **Bug found in older work (demo data):** the demo's caption clips named no transcript line, so the demo editor never showed captions. The demo now gives each its line.

### Phase 4 tests

| What | Result |
|---|---|
| Shared: presets equal the old looks, set_caption_style, faces and widths, line breaking (words, width, two captions when too many lines), spoken word, text layers (presets, set_text, animation curves = ASS tags), the ASS file, live frame, apply_style / set_captions{styleId}, check lines and flags | 118 pass |
| Worker: a render with a custom caption style and a text layer, read back | libass uses the bundled fonts by name; the caption box and the text box are within 1 to 2 px of the layout; the yellow spoken word moves word by word under the right word |
| Editor vs render (`apps/web/demo/caption-match.mjs`): the editor's own TextLayers component and the rendered frame, 16:9 and 9:16, two-line captions, box, stroke, Bebas Neue | every box within 2 px |
| API: save_style with a full caption style, apply_style, add_text, get_project reads both | 11 pass |
| Browser, demo build: Text tab (font, weight, spoken word, size), captions drawn with the bundled fonts, add a title, edit text, animation and card, undo, phone width | all work, no page errors |

### Phase 4 live (24 October)

- **Through the connector (smoke-test account), on the Phase 3 test edit:**
  - one `apply_edits`: `set_caption_style` (Montserrat 800, 7%, white, 60% black box, yellow spoken word, 4 words, 1 line, 86% down) and `add_text` (title preset, two lines, pop)
  - `render_preview` (540p, 70.4 s): the check reads "Captions: on (own style: Montserrat 800, …)" and "Text: 1 layer: 0:00.3-0:03.5 "AUDIT YOUR / LAST 20 PATIENTS" pop"
  - `get_preview_frames` at 1 s and 20 s: the title in two lines, the caption in its box, the spoken word in yellow
- **Live editor (browser):**
  - the Text tab shows the style (own style, Montserrat 800, 7%, 50% / 86%, box 60%, padding 24%, 4 words, 1 line) and the title layer; V3 shows the title clip
  - after a change, the live player draws the title and the caption on a 960x540 stage scaled to the player
  - the browser loads RC Montserrat 800 and 900 from the web app's `/fonts/` (HTTP 200)
  - undo returns to the rendered preview; no page errors

## Phase 5: transitions, keyframes, speed

- **Speed (V1 clips).**
  - Constant speed from 0.1x to 10x, reverse, speed ramps (speed points at the clip's footage moments, linear between them), and freeze frames (a still of one frame for N seconds).
  - Sound keeps its pitch (`atempo` in the render, the browser's own in the editor). It plays from 0.5x to 4x. Outside that, reversed and frozen, the clip is silent in the render and the editor alike, because browsers mute sound there and cannot play it backwards.
  - A ramp is one `atempo` whose tempo changes at each step, so the steps do not click.
  - A clip off normal speed has no J/L cut at its edges.
- **Transitions** on the cut before a V1 clip: cut, dissolve, dip to black, dip to white, whip pan (left, right, up, down, with motion blur), zoom, slide (four directions). Each has its own duration.
  - They are centred on the cut, so the edit's length stays the same.
  - Dissolve, slide and whip use footage past the cut, as Premiere does. With too little of it, the transition gets shorter and the check says why.
  - A dip or dissolve on the first clip fades it in from the colour.
- **Keyframes** on V1 clips, b-roll (a moving picture-in-picture), text layers and graphics: position, scale, rotation, opacity. Easing: linear, ease in, ease out, ease in-out (the CSS curves), or any cubic bezier.
- **Ops in apply_edits:** `set_speed`, `freeze_frame`, `set_transition` (one cut, several, or all), `set_keyframes`. get_project shows each clip's speed, transition and keys.
- **Check.** New lines appear only when the edit uses these: Speed, Transitions, Keyframes. New flags: a transition made shorter or left out, with the reason. A requested dip or a keyframed fade is not flagged as black, and a frozen or reversed clip is not flagged as silent.
- **Editor.**
  - A Clip tab: speed slider, reverse, normal speed, freeze this frame, speed ramp points; the transition into the clip (type, duration, direction); keyframes at the playhead (across, down, scale, rotation, opacity sliders, easing, the list of keys).
  - Timeline marks: speed on the clip label, the transition's window at the cut, keyframe diamonds.
  - The player plays each part at its rate. Reverse steps frame by frame, a freeze holds its frame, keyframes move the picture, and transitions are drawn from both sides with the render's curves.
- **The editor plays what renders** (`apps/web/demo/motion-match.mjs`):
  - The editor's own player components and the FFmpeg render of one edit (speed 1.5x, a freeze, 2x reversed, dissolve, dip to white, whip, slide up, zoom, keyframed V1 clip, keyframed picture-in-picture) are compared at 46 moments.
  - Every plain frame is the same source frame. Transitions and keyframes differ by at most 4.8 out of 255 on average (edge smoothing and blur).
- **Bugs found in older work, fixed:**
  - When a sequence's parts were drawn one by one (several videos, turns or framings, since Phase 2), the joined picture's timestamps were in microseconds. Every overlay (b-roll, graphics) then showed one frame late. The picture is now put back on the 1/30 s grid.
  - Overlays started and ended between frames, so the editor and the render could disagree by one frame at their edges. They now start and end on whole frames.
  - The player read zooms and text animations at the exact playhead time; the render draws them at frame times. The player now reads every curve at the start of the frame showing.
  - Chromium could keep showing the old frame of a paused video after a seek. The player now seeks again 0.1 ms later, inside the same frame.
  - The demo build's page did not declare UTF-8, so "·" showed as "Â·" when it was opened without a server that says so.
- **Found by the live check, fixed:** a freeze frame rendered as a single frame on the server, so the file was 0.77 s short (the check flagged it: "file is 68.63s but the render planned 69.40s"). The worker runs FFmpeg 7.1. There, `tpad` after a `trim` that leaves one frame gives its copies one timestamp, and they are dropped. Local tests ran FFmpeg 6.1, which does not do that. The stream is now put on the 30 fps grid before `tpad`. Since then, the worker tests and the editor-vs-render test also run with the worker image's FFmpeg 7.1.5: 32 of 32 pass, and the match test passes.

### Phase 5 tests

| What | Result |
|---|---|
| Shared: easings (the CSS curves); every curve's FFmpeg expression equals the player's value; speed (lengths, footage mapping, sound rate, silent ranges, no J/L, captions follow sped-up speech and leave out reversed speech); ramps (steps, the integral of 1/speed); the four ops; transitions (windows, handles, made shorter, first clip, zoom curve, live frame); keyframes (footage seconds, after a cut, split, ASS pieces); the player's frame choice; check and get_project lines | 135 pass (17 new) |
| Worker, rendered and read back (footage that shows its own frame number): 2x frames and pitch; freeze; reverse; dissolve mix; dip black at the cut; centred scale; slide; ramp frames equal to the player's, pitch kept, length exact; keyframed text and picture-in-picture where the shared curves put them | 9 new, 32 in all, pass |
| Editor vs render in a browser (`motion-match.mjs`) | 46 moments, pass 3 runs in a row |
| API: speed, freeze, transition and keyframes in one apply_edits; get_project reads them back; a bad value is refused and nothing is saved | 12 pass |
| Browser, demo build: Clip tab (speed, transition, keys, ease, freeze, reverse, undo), marks on the timeline, the player's transform, phone width | all work, no page errors |

### Phase 5 live (24 October)

- Through the connector on the smoke project: one apply_edits set 1.5x on a clip, a 0.8 s freeze, a dissolve at 0:24.2, a whip left at 0:48.1 and scale keys on the first clip.
- With the fix deployed, render_preview took 14 s. The check gives the file as video 69.40 s and audio 69.39 s, the same as the edit, with no length flag. Its Speed, Transitions and Keyframes lines read back what was sent.
- get_preview_frames at 24.1 s and 24.25 s shows the dissolve's double picture. At 48.05 s and 48.15 s it shows the whip's motion blur. At 68.0 s it shows the held frame.

## Phase 6: colour and compositing

- **Grade** on any V1 clip or b-roll clip:
  - exposure, contrast, temperature, tint and saturation
  - curves (master, red, green, blue)
  - an imported .cube LUT, with an amount, applied first (log footage) or last (a look)
  - copy a grade to every clip, or to one video's clips
- **Shot matching** from measured values, with no AI. The worker reads small frames of the clips from their preview copies. Each channel's 2nd, 50th and 98th percentiles are mapped onto the reference's (as graded) by curves, and saturation is matched. The result is an ordinary grade you can see and change.
- **Chroma key**: colour (with an eyedropper on the picture), similarity, softness and spill removal.
- **Masks** (rectangle, ellipse, a path drawn on the picture) with feather, invert, and add, subtract or intersect.
- **Blur and pixelate**, on the whole picture or inside an area.
- **B-roll under V1** (`under`): a keyed or masked speaker gets a background.
- **HDR stays HDR**: a final of PQ or HLG footage is HEVC 10-bit, BT.2020, with its transfer; SDR content goes in at 203 nits. Set the export to SDR to convert. Previews and the editor are SDR, and the check says so.
- **Ops in apply_edits:** `set_grade`, `copy_grade`, `match_color` (the server measures the frames), `set_key`, `set_masks`, `set_effects`, `set_under`, `set_export`. get_project shows the looks, grouped, and your LUTs.
- **Check:** Looks, Under V1 and HDR lines, only when the edit uses them; a LUT that is gone is named.
- **Editor:**
  - A Color tab with every control above, and a curve editor (click, drag, double-click).
  - LUT import (checked before it is stored).
  - Match to a clip, an eyedropper for the key, path drawing, and outlines of masks and areas on the picture.
  - The player draws a clip with a look through WebGL2, using the render's own numbers (the same LUT, key formulas, mask pictures, blur and block sizes).
- **Found and fixed while testing:** FFmpeg 7.1 (production) loses about one level of luma converting to RGB and back unless `accurate_rnd` is set (6.1 does not), and `lut3d` truncates at 8 bits. The look runs in 16-bit RGB with accurate rounding, and both FFmpeg versions now give the same result.

### Phase 6 tests

| What | Result |
|---|---|
| Shared: curves, every grade control, LUTs first or last with an amount, .cube both ways (3D, 1D, bad files refused plainly), mask pictures (feather, invert, subtract, intersect, path), colorkey and despill numbers, matching a darker, bluer, flatter shot onto its reference, every op, the plan's looks and files, the graph (LUT, key, despill, pixelize, maskedmerge), one grade drawn once, b-roll under V1, HDR plans (kept, converted, preview line), SDR white in PQ and HLG, caption colours, check lines | 20 new, 155 pass |
| Worker, rendered and read back on FFmpeg 6.1 and 7.1: grade = the shared function on the plain clip (mean 0.73/255), imported LUT, mask, pixelate blocks = block means, blurred area flat, key shows the b-roll under V1 and keeps the subject, HDR final (HEVC 10-bit, PQ tags, HDR picture untouched, SDR white at PQ 203 nits) | 7 new, 39 in all, pass |
| API with a real frames worker: a grade with an imported LUT, match_color measured (red lifted, blue lowered towards the reference), key, masks, blur; get_project reads them back; a wrong clip is refused | 13 pass |
| Editor vs render in a browser (`color-match.mjs`): plain baseline 0.67, grade 0.66, LUT 0.74, masks 0.27, pixelate + blurred area 0.74, key over b-roll 0.61 (mean difference out of 255) | pass |
| Phase 4 and 5 browser tests after the player changes | 46 motion moments, captions within 2 px: pass |
| Browser, demo build: Color tab (sliders, curve point, LUT import and amount, copy to every clip, key, ellipse and path masks with outlines, blur area, undo, HDR setting), phone width | all work, no page errors |
| Timeline clicks under the page's 0.8 zoom (`ruler-click.mjs`, new) | 10 of 10 off on the old code; all on their label now |

### Phase 6 live (24 October)

- **The first live preview failed** ("Render failed at Cutting clips"). The cause: every scaler in FFmpeg's graph starts one thread per CPU. A graded edit has about 70 scalers, and the worker (6 CPUs) has a limit of 1,000 threads. Reproduced locally with a 400-thread container limit. Renders now cap the graph at 4 threads (`FFMPEG_FILTER_THREADS` changes it). If FFmpeg still runs out, the render tries once more with one thread. The worker logs its CPUs and thread limit when it starts.
- **Graphics stopped recording on 30 Oct 2026** ("can't start browser", spawn EAGAIN, pthread_create failed) until the worker restarted. Two causes. First, a long graphic ran 5 browsers and 5 encoders, and each encoder started about 70 threads (FFmpeg sizes its thread pools by the host's 48 CPUs): with a test or a render at the same time that went over the 1,000-thread limit. Second, when a recording failed it left browsers running (its cleanup stopped at a browser that had failed to start, and lanes still recording started new browsers after the cleanup), so every graphic and render after it failed too. Now: one browser limit for the whole worker (`BROWSER_SLOTS`), encoders on one decode thread and one filter thread, a failed recording stops and closes everything it started, Python's maths libraries use the container's CPUs, and running out of threads says the server is busy. Test: `apps/worker/test/graphic-cleanup.test.ts`.
- **Through the connector on the smoke project:** one apply_edits graded two clips, copied the grade, matched a third clip to the first (measured), masked one and pixelated an area of another. render_preview took 22 s. Its Looks line reads back all of it.
- **get_preview_frames:**
  - 15 s: graded (brighter, warmer)
  - 40 s: the feathered ellipse mask over black
  - 55 s: the matched clip
  - 66 s: the pixelated area
- **LUT import through the API:**
  - A broken file is refused with its reason, and nothing is stored.
  - A real .cube is stored and read back.
  - set_grade with that LUT moved the frame at 2 s from RGB 130,129,112 to 143,129,101; the LUT predicts about 145,129,99.
- **The live editor** in real Chrome (Browserless; Playwright's Chromium cannot play H.264):
  - The proxy loads with CORS from the bucket (also checked for app.rendrr.live).
  - The look canvas draws: plain at 5 s, graded at 15 s, masked at 40 s (screenshot matches the rendered frame), matched at 55 s, pixelated at 66 s.
  - One exposure step and its undo: back to 0.00. The test edits were undone through the connector, and the project's content is as it was.
- **Found and fixed while testing:**
  - Timeline clicks and drags landed at 0.8x the time under the pointer. The page is drawn at CSS zoom 0.8, and the timeline mixed screen pixels with CSS pixels. This had been wrong since the V2 design.
  - Unknown tool arguments were dropped silently: apply_edits with `ops` instead of `edits` only posted the note. A misspelled field inside an edit saved a version that changed nothing. Both are errors now, naming what the tool or op takes.
  - The check named an imported LUT by its id; now by its name.
- **Not testable live:** HDR. No HDR footage is in the account, and adding footage is not allowed in live tests. HDR is covered by the worker test (a real PQ clip rendered and read back).

## Phase 7: graphics and export

- **Export settings**, in a new Export window before a final and through `set_export`:
  - Resolution: 720p, 1080p or 4K in the edit's shape. The shape (9:16, 16:9, 1:1) is now in that window too.
  - Codec: H.264 or HEVC (Apple's `hvc1` tag).
  - HDR footage: keep HDR (always HEVC 10-bit) or convert to SDR.
- **Frame rate kept:**
  - A final plays at the footage's own rate (23.976, 25, 29.97, 50, 60…; above 60 it is capped at 60, and the check says so). Every part is whole frames at that rate, so sound and picture stay together across any number of cuts.
  - Previews stay 30 fps, like the preview copy the editor plays. Their FFmpeg commands are byte for byte what they were.
- **Time left** while rendering: in the render window ("About 3 min left · 45%"), and in render_final and get_render ("at 45% (Encoding), about 3 min left").
  - It comes from this user's past renders of the same quality, then from the encode's own speed. It says "Estimating" until there is something to go on.
  - Time limits grow for 4K and HEVC, and the app now waits as long as the server does. Before, it gave up after 17 minutes even when the server allowed more.
- **Graphics as long as the video** (up to 4 hours):
  - Built-in graphics are drawn for the clip's real length in the render and in the player.
  - `create_graphic` takes up to 4 hours. Over 15 s a graphic is recorded by sampling every 0.5 s: still stretches are held, and real changes are recorded frame by frame. A 60 s progress bar records in about 12 s.
  - A custom graphic placed longer than its recording holds its last frame, in the render and the player.
  - A graphic that fails is named in the check instead of disappearing silently.
- **Check and get_project:** `Export (final): 1080p 1920x1080 16:9, H.264, 23.976 fps (the footage's)`, plus "scaled up from…" when the final is bigger than the footage.
- **Found and fixed:**
  - A built-in graphic placed for longer than 15 s vanished from the render at 15 s, while the editor kept showing it.
  - The app gave up waiting for a final after a fixed 17 minutes.
  - The done message always said 1080p.
  - The live progress stream did not carry the time left.

### Phase 7 tests

| What | Result |
|---|---|
| Shared: rates snap to the nearest standard one (a phone's 29.92 is 29.97, 120 is capped at 60, previews stay 30), parts aligned to whole frames at 25, 23.976, 29.97 and 60 fps with the graph and encoder on that rate, previews unchanged, set_export, sizes in every shape, HEVC arguments, 4K scaled-up note, time limits and quality labels, Export line, graphics held to the clip | 12 new, 169 pass |
| Previews and 30 fps finals before vs after (the live smoke edit, every shape): same arguments and graph, byte for byte | identical |
| Worker, rendered and read back (FFmpeg 6.1 and 7.1): 25 fps and 23.976 fps finals have every frame the right source frame across four cuts on no particular grid; the picture-sound offset is constant at 5-7 ms (the measuring window), no drift; HEVC 9:16 720p (hvc1, 720x1280, 25 fps); 4K (3840x2160, 38 frames for 1.5 s at 25 fps) | 4 new, pass |
| Worker, long graphics: a 40 s custom graphic (slow bar, 0.6 s flash at 20 s, text changed by JS at 30 s) recorded in 7.4 s from 102 pictures and read back (flash on 20.05-20.55 s and off at 19.9/20.65 s, text change exactly at 30 s, bar within half a second); a 60 s progress-bar template over a 60 s edit is on screen and growing at 10, 30 and 55 s; the editor's player HTML against the recording: bar within 5 px, mean difference 3.5-5.9/255 | 3 new, pass; worker 46 in all |
| Editor, demo build: Export window (defaults, 4K + HEVC + 9:16 update the summary, three undos restore it), phone width | works, no page errors |
| Browser tests after the player change (colour, motion, captions, ruler) | pass |

### Phase 7 live (24 October)

- get_project gives `Export (final): 1080p 1920x1080 16:9, H.264, 23.976 fps (the footage's)`. The smoke footage's original is 23.976 fps, so its final keeps that; the editor plays the 30 fps preview copy.
- set_export 720p HEVC through the connector; render_preview's check gives `Export (final): 720p 1280x720 16:9, HEVC, 23.976 fps (the footage's)`.
- The live editor in real Chrome: the Export window shows 16:9, 720p and HEVC selected, with "1280x720 · HEVC · 23.976 fps, kept from your footage". It was closed without changes, and the edit was set back to 1080p H.264.
- Time left, seen during the Phase 8 renders: "at 61% (Burning captions), about 45 s left" (preview) and "at 83% (Encoding 1080p), about 35 s left" (final). When done, the connector says how long it took: "final 1080p rendered in 209.4 s".

## Phase 8: a 20-minute talking head, edited through the connector only (24 October, live)

**The footage.** The smoke account's talking head, joined 16 times into one file: 20 min 33 s, 1920x1080, 30 fps, 414 MB.
- Videos from the internet could not be downloaded from here (the network blocks them).
- It was added the way the app adds a file from a computer: the browser's preview copy and audio settings, byte for byte. It was ready 65 s after the upload started.
- The original was then uploaded once for the final. That upload is the one step outside the connector, and it is outside on purpose: the original stays on the user's computer until a final needs it.

| | |
|---|---|
| Calls | **8**: list_footage, get_footage, create_project, apply_edits (all 13 changes in one call), render_preview, get_render, render_final, get_render. **No images.** |
| Tokens | Sent: 1.4k characters (about 0.4k tokens). Back: 26.9k characters (about 6.7k tokens). Of that, 24k is get_footage, almost all of it the 20-minute transcript the AI needs to choose cuts. The list of tools is 20 KB (about 5k tokens), sent once per chat. |
| The edit | 231 pauses over 0.4 s cut (105.9 s), 25 fillers removed, bold captions on 100% of spoken words, 8 B-roll cutaways, lo-fi music at -20 dB that drops 12 dB under speech, voice cleanup at -14 LUFS / -1 dBTP. 1233.1 s became 1116.4 s, with 170 cuts. |
| Preview | 540p, 106 MB, **rendered in 93.7 s** (its limit for this length: 6.2 min) |
| Final | 1080p 1920x1080, H.264, 30 fps (the footage's), 351 MB, **rendered in 209.4 s** (limit: 30.8 min) |
| Timeouts, failures | None |
| The file, measured | Picture 1116.43 s and sound 1116.43 s. No black and no silence. -14 LUFS, true peak -1.7 dBTP. |
| Check flag | 37 clips under 0.5 s. Cutting every pause over 0.4 s leaves single words between pauses. The check reports them; whether to keep them is the AI's call (a longer `overSeconds`, or joining them). |

**Editor = render.** The live editor in real Chrome (Browserless), moved by clicking the ruler at 0:30, 5:00, 9:17, 13:22 and 16:43:
- At each moment, the footage time the editor's player was showing equals the render plan's within 0.2 ms.
- Each picture was compared with the rendered preview's frame. Mean difference 2.2-3.5 out of 255, which is the preview's compression. On a still talking head, neighbouring frames differ by about as much as that.
- The player was running the live edit, not the rendered file. No page errors.
- The editor's timeline and the final are the same length to the frame: 1116.467 s, 33,494 frames.
- The preview is one frame (33 ms) shorter, at the very end only. The browser's preview copy ends one frame before the original because the copy stops where its sound stops. The editor shows the copy's last frame for that final 33 ms; the final shows the original's last frame.

The test footage and the edit stay in the smoke account. The original is deleted automatically on 25 October at 20:29 UTC.

## After the 8 phases (25 October, live)

- **Google Drive is on.** The Google keys are on `api` and `worker`, and the app's Google sign-in is set to External. Videos can be added from Drive.
- **A new edit is the raw footage.** It used to apply the default style (Clean Podcast Clip) straight away, cutting pauses and adding captions. Now every new edit, from the app or the connector, is version 1 only: the footage as recorded, captions off, no style, nothing cut (except words removed on the footage page). Checked live: v1 "Footage as recorded", 77.16 s of 77.16 s, no automatic steps.
- **References are attached, never applied.** New edit and the editor's Reference tab attach a style or a reference video; Recreate attaches the gallery video. `get_project` shows it to the AI ("Reference the user attached, not applied: style s1 …"). A style counts as the edit's only when the AI applies it with `apply_style`.
- **Edit cards show the edit itself**: a frame of its latest render, else its footage's thumbnail (before: the style's drawing on every card).
- **Cuts to the millisecond.**
  - Cut points, trims and J/L offsets are kept to 1 ms (they were 10 ms), and so are the word times of new transcripts.
  - `cut_silences` takes pauses from 1 ms, with `keep`: the pause left next to the speech (default 80 ms as before; 0 = tight).
  - A cut range can be 1 ms. A short word between two cuts is no longer dropped (the leftover limit went from 150 ms to 40 ms).
  - The sound is cut exactly there. The picture goes on the nearest frame and shows the frame its sound is playing, at most half a frame off at a cut, never adding up.
  - Live: 39 pauses over 50 ms cut, keeping 20 ms, plus a range cut at 30.1234-30.4567 s. The preview's picture and sound are both 66.23 s; one pause over 0.15 s is left.
  - Tests: 7 new shared tests (60 cuts on no grid at 30, 25 and 23.976 fps: every frame the right footage frame, no drift). The worker's frame-rate tests measure each cut's picture-sound offset against the exact edit: a constant 5 ms at every cut (the measuring window).
- **Deleting videos.** The library cards and the footage page have Delete. It asks first, and the raw file stays where it is. Footage that edits use is refused with their names; the app then offers to delete the video and those edits together.
- **Library is in the top bar**, next to Projects.
- **Drive picker, like Google Drive.** Places on the left (My Drive, Shared with me, Recent videos, shared drives), a path to click back along, folders first then videos with modified / size / length, and a search over the whole Drive. Videos in folders at any depth can be reached (before: only top folders and one level down). Names stay on one line; the footer no longer overlaps the list.
- **New design system.** Lime #bde816 as the one colour, page / top bar / card darks, white-wash quiet controls, Space Grotesk uppercase titles, 3D-edged primary buttons, segmented controls, 36x16 toggles, borderless inputs with a lime focus ring.
- **Motion graphics.** A 393 s full-length graphic failed live ("did not finish recording within 257 s: it changes on 3633 of the 11790 frames"). What was wrong, and what changed:
  - *Speed.* One browser recorded every graphic, and every half second decoded two full-size PNGs to look for changes. Now 5 browsers record time ranges at once (the worker has 6 CPUs), changes are spotted on a quarter-size picture, and pictures are encoded in pieces while recording, then joined. 20 s of full-screen 1080x1920 motion: 75 s before, 31 s now on a 4-CPU machine (3 browsers).
  - *Limits.* The time limit comes from measured cost (about 1 s per second of full-screen motion at 1080x1920 with 5 browsers), at most 25 min. Graphics up to 15 s at 1080x1920 were captured at 12 fps; now always 30 fps.
  - *Timing.* Animations started mid-way (a class added at 5 s, `element.animate()` later) jumped to their end, and `setTimeout`/`setInterval` ran on the wall clock. Now every animation runs from the moment it appears and timers follow the graphic's clock. The encoder also snapped pictures to a 25 fps grid (up to 20 ms early or late); it uses the 30 fps grid now.
  - *Fonts.* Every font name (Montserrat, Open Sans, Kalam, even Arial) drew as Noto Sans. The worker image now has 82 Google Fonts families (pinned, open licences) and metric-compatible stand-ins for Arial, Helvetica, Times, Georgia, Calibri, Courier and Impact; the build stops if they are missing. `create_graphic` lists them.
  - *Progress.* `create_graphic` and `list_graphics` say how far a recording is and the time left. Code can be 1 MB (was 200 KB). The graphics browser has no WebGL (it never had); the tool now says so, so the AI uses CSS, SVG or canvas 2D.
  - Tests: the graphic clock (timers, a transition started by setTimeout, element.animate, a transition crossing two browsers' ranges), all 82 fonts drawing as themselves, and the existing long-graphic tests.
  - Live (smoke-test account): the worker runs 5 graphics browsers; a 20 s 1080x1920 graphic with Montserrat, Open Sans, Kalam and Arial text and two timer-started transitions recorded in 3.4 s, its check frames showing the real fonts and each transition where its timer put it. The image build fetched all 315 font files and passed its font check.

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
| Google Drive | The Drive tab says Google Drive is not set up yet (the fake Drive with demo folders is gone) | `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` (Google Cloud → OAuth client, Drive API on, redirect URI `https://api-production-2428.up.railway.app/drive/callback`) | Railway → `api2` and `worker` → Variables |
| Billing | **Built** (7-day trial, $5 Starter, pay as you go, Usage & billing page, admin panel). Usage and our costs are measured now; nothing is charged or blocked until a Stripe key is set | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` and the $5 product (steps in `docs/billing.md`) | Railway → `api2` |
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

## Rendrr for Mac (v1) and the logo icons

- Web app icons: the lime Rendrr mark on the dark square is the tab icon (icon.svg, favicon.ico), the Apple icon and
  the home-screen icons (manifest.ts); the review page shows it too. Test: apps/web/demo/brand-desktop.mjs.
- The app icon alone, no word, like Higgsfield's (logo.js AppIcon, the same drawing as icon.svg): the top bar (36 px,
  26 on phones), the login window, the Mac app's browser-login page, the Google Drive connected page and the review
  page header. The wordmark is gone. Tests: brand-desktop.mjs, desktop-login.mjs, review-folder.mjs.
- desktop/: an Electron app that opens app.rendrr.live in a window with no title bar (the web app makes room for the
  window buttons when html.desktop is set), Mac menus and shortcuts, downloads straight to ~/Downloads, Google and
  Drive sign-in inside the app, other links in the browser, an offline page, full speed when hidden. Link rules in
  desktop/links.js, tested with `npm test` (9 tests).
- .github/workflows/desktop-mac.yml builds Apple Silicon and Intel .dmg files on a GitHub Mac, opens the app and checks
  it loads Rendrr, then publishes a Release `mac-v0.1.<build>`. Signed ad hoc (no Apple Developer account yet).
- Not yet: rendering on the Mac. Exports still render on the servers. That is the next part (a job API the app can
  pull renders from, plus FFmpeg in the app).

### Mac app login through the browser

- Google blocks sign-in inside apps ("This browser or app may not be secure"). In the Mac app the login shows
  "Log in with your browser" instead of Google: it opens app.rendrr.live/desktop-login?c=<challenge> in the default
  browser; there, logged in, Allow makes a 5-minute one-time grant (API POST /auth/desktop/approve) and hands it back
  with rendrr://auth?grant=…; the app opens /desktop-login?grant=… and trades grant + its secret (PKCE S256) for a Clerk
  sign-in ticket (POST /auth/desktop/redeem). A link someone else made is useless to them: the grant goes to the
  approver's own Mac and needs the secret that made the challenge.
- Drive connect in the app opens Google's consent in the browser; /drive-done there finishes it, the app polls status.
- Tests: apps/api/test/desktop-login.test.ts (5), apps/web/demo/desktop-login.mjs (18 checks), desktop npm test (11).

### Finals stuck at 78% (frozen FFmpeg)

- A heavy final (43 inputs, 224 scalers, made in 9 pieces) sat at 78% for 30 minutes with the worker's CPU idle,
  then hit the job limit; the retry froze at the same place. FFmpeg was waiting on itself, not working.
- run() now has a freeze watch (stallMs): no output-time progress and under a fifth of a core of CPU for 60 s
  (RENDER_STALL_MS) stops FFmpeg and reports where it stood and what each of its threads was doing (/proc names,
  states, wait channels), for the logs.
- A frozen piece is made again with one filter thread and one thread per decoder; frozen again, in halves down to
  2 s; still frozen, the export stops with "The export froze at m:ss" instead of waiting out the limit. A frozen
  one-pass export is made in pieces.
- Music shorter than its part was looped by FFmpeg inside the edit's graph (-stream_loop), and the freeze came about
  where a song would come round; the loop is now made first in a small pass of its own (a plain WAV).
- Tests: apps/worker/test/stall.test.ts (7, including a real FFmpeg frozen on a pipe).
- Root cause, seen live with the freeze watch: the part from 1:48 froze at its very first frame, every FFmpeg thread
  waiting on another, with one thread each too. Each part made its own sound by running the whole mix from 0 and
  dropping what came before the part: the picture waited for that sound and the sound for the picture. Now the
  sound is made once for the whole edit on its own (ffmpegArgs sound: "only", no picture read) and each part is
  picture only (sound: "none"); joinPieces puts the one sound track under the joined picture. Same frames and the
  same sound as the one-pass render (pieces-render.test.ts: correlation 1.0000, no gap at the joins).

### Export window: the bar and Stop export

- While exporting, the window shows only the bar (percent and time left beside it) and a Stop export button; the list
  of steps and the explanation are gone.
- Stop export is real: API POST /renders/:id/stop takes a waiting render out of the queue or tells the worker
  (Redis "rendrr:stop", "render:<id>") to stop the running job where it stands (FFmpeg killed, no retry), marks the
  render failed with code "stopped", puts the edit back to its status, and tells the app on the live channel; the
  window closes with "Export stopped". While the original is still uploading, Stop ends the upload and throws the
  half-sent upload away.
- Tests: apps/api/test/stop-render.test.ts (3), apps/worker/test/stop-job.test.ts (3), apps/web/demo/export-stop.mjs.

### Overnight audit: backend

- Drive login return only goes to the web app's own addresses (origins.ts), never to a site named in the request.
- A stopped or timed-out render cannot come back as "done": every status write is conditional, a late finish deletes
  its files. Two exports of the same edit at once join one render (an advisory lock in startRender).
- Work lost with a dead worker is marked failed: BullMQ's stalled jobs, and a sweep every 10 minutes for renders,
  videos, style files and graphics past their limit. One time limit (renderLimitMs) for the API, worker and sweep.
- A second final of the same edit keeps the original file it needs. Review links rate-limit the previews they start.
- Upload links (add_footage, add_audio) stop a body over the cap with a 413 (Fastify's bodyLimit does not cover a
  streamed body).
- Stray promise errors are logged instead of stopping the API or the worker.
- Drive saves: asking again for the same folder joins the running copy; GIF, sound and ProRes finals keep their real
  type and extension; the web's Save to Drive refuses a second copy while one uploads.
- Retry and Rebuild on a video run their job once (the status change is the claim).
- Captions and chapters files are deleted with their render (Delete all finals, deleted edits, preview retention).
- A review comment with a non-text projectId, a gallery like pressed twice at once and an upload whose parts S3 does
  not know get a clear answer, not a 500. The internal-address check reads every IPv6 spelling ([::ffff:7f00:1]).
  Reconnecting Drive to another account is used at once (the token cache is keyed by the stored connection).
- The freeze watch covers every render pass (out-of-threads retry, the transparent file's white pass, the sound pass).
- Projects, a project folder and the gallery load only the styles they show; the share links list returns the newest 200.
- Tests: upload-body, video-retry, render-files, drive-token, bad-input, drive-save (+2), fonts (IPv6), stall (+1).

### Rendrr icon in AI chats

- The MCP server's info carries the Rendrr icons (MCP `icons`: links on the connector's address and a small one
  inline), and the connector address serves /favicon.ico, /icon.png, /icon.svg and /apple-touch-icon.png, so Claude
  and other AI chats show the mark next to "Using Rendrr". Test: apps/mcp/test/icons.test.ts.

### Overnight audit: web app (loading, glitches, less text)

- Loading: pages remember what they loaded for the tab's life and show it at once on the way back, refreshed in the
  background; any write (or another account) forgets them. The skeleton is laid out from the first frame and fades in
  after a moment, so a quick load shows nothing and a slow one shows no blank box first.
- Skeletons in the real shapes: gallery tiles in masonry columns, Library folders and cards, project covers, the
  project page's full-width cards, Footage, Usage stat cards, Billing plans, Connect, the review page, the editor's
  own frame. The gallery's columns are measured before the first paint (no 5-column flash).
- A signed-in refresh draws the signed-in frame while the session is checked (no blank screen, no Log in buttons).
- Library waits for its folders too (no false "No footage matches"); the editor's media bin shows placeholders, not
  "0 videos", while it loads.
- Deleting a project asks first and says how many edits go; a deleted edit has Undo in its toast. The dead
  "Recently deleted", table view and sort code is gone.
- Windows fit the screen with the app's zoom, and their main button sticks to the bottom.
- Video cards line up (the picture at the top); the seek bar gets the room on phones (quality and snapshot only in
  the editor); the Usage legend dots show and match the bar; the phone heatmap shows the newest weeks; failed,
  missing and expired footage say so with Try again / Rebuild; error pages have a way back and no "Try again" for
  something that is gone; Connect loads its cards together; the gallery's buttons show on hover only.
- Less text: page subtitles, helper paragraphs, the storage pill, the Explore count and style tags, the info cards in
  the gallery window, the workspace line and New project card, the folder page's members, share links, size and
  author lines, the editable status select, the Library's badges and step counts, the Footage storage box, scene cuts
  and legend, the What your AI can do card, and the long editor notes. Rarer actions moved into "…" menus (folder
  Rename/Move/Delete, Footage/Reference, Export preview and Samples).

### Rendrr for Mac: a public download link

- app.rendrr.live/download (a redirect) opens api.rendrr.live/download/mac: a page with the Apple chip and Intel
  installers and the install steps. /download/mac/apple and /download/mac/intel always give the newest build (a
  fresh short-lived storage link per click). The repository is private, so GitHub's release links only work for its
  owner; this link works for anyone.
- The Mac build (desktop-mac.yml) puts each new installer there after publishing the release: PUT
  /download/mac/:chip signed in with the workflow's GitHub OIDC token. The API checks GitHub's signature (its keys),
  the audience "rendrr-downloads", the repository and the workflow file, and the expiry; no secret is stored.
- Test: apps/api/test/mac-download.test.ts (3; a stand-in GitHub key server).

### Explore plays the real video

- A published video showed the style's drawn preview, not the edit. Publishing now copies the edit's best export (the
  current version's final, else its preview, else the newest; MP4 or MOV only) and a still from it to the gallery
  item's own keys (gallery/<id>.mp4, .jpg; GalleryItem.videoKey, posterKey, seconds), so it stays when previews
  expire or the edit is deleted. An edit with no export yet gets a preview rendered; the item takes it when the
  gallery is next loaded (a few per load; earlier published videos take theirs the same way). Removing a video
  deletes its copy.
- A video published with nothing to play (never rendered, or published before this) gets a preview started when the
  gallery loads (Render.by "gallery"), once per item every 6 hours, so a failed one is not retried on every load.
  It does not count toward the AI's one-preview rule. Checked live: "IMG_7692 edit" now plays its own 33.6 s video.
- The tile shows the still and plays muted while the pointer is on it; the window plays it with sound and controls.
- Tests: apps/api/test/gallery-media.test.ts (3), apps/web/demo/gallery-video.mjs.

### Recreate, a simpler editor, and Claude's layers on the timeline

- Recreate (Explore) opens the editor at once, with no window: the edit waits for its footage (a hidden placeholder,
  POST /projects {waiting: true}; GET shows waiting: true), the gallery video attached as its reference and playing in
  the monitor, in the gallery video's shape, nothing on the timeline, Export off. The player's place says Add your
  footage; the first videos added (that button, Add clips, or + on a bin video) become the edit's footage
  (POST /projects/:id/footage: version 1 made again from them, the placeholder deleted; name, shape and reference
  kept), and when the footage's shape is not the edit's the editor follows the speaker so it fills the frame. The New
  edit window can also add new footage itself (Drive or this computer) and waits for it to be prepared.
- The editor's monitor plays a gallery video reference. The reference dropdown under it and the Reference panel are
  gone (the reference is set when the edit is made, or by your AI).
- The right panel has tabs: Comments (open first), Your AI, and the selected clip's settings. Selecting a clip opens
  its settings; clearing the selection goes back to Comments. The left rail has the tools only.
- The Media panel's Project bin has a big Add clips button; it opens a big window with the Library as pictures,
  numbered in the order they play (the timeline's + opens the same window).
- The timeline: caption lines are no longer drawn on V3; every row is one black; a trim that makes the edit shorter
  brings the playhead back inside it, so the player's bar never runs past its edge.
- Layers your AI adds that are not track clips now show and can be changed, as in Premiere: your own sound file
  (set_voice) on a VO row under the dialogue (which shows muted), draggable, with its level, start and "Use the
  clips' own sound" in the right panel; the background behind V1 on a BG row (Change it in Color, Remove); and an
  fx badge on clips with effects (grade, masks, key, blur, no background, skin, stabilize) that opens Color. More
  rows than fit scroll, names with them.
- Tests: apps/api/test/recreate-waiting.test.ts, apps/web/demo/recreate.mjs, demo/layers.mjs (new); panel, comments-claude, comments-compose, multi-video,
  sweep updated.
- No internet: the web app and the Mac app show one calm screen, like Higgsfield's: the Rendrr icon (lime tile, dark
  "R") and "You're offline" under it. In the web app it covers the window while the connection is gone and goes away
  by itself when it is back, leaving the page as it was; the Mac app's page (when it cannot load at all) goes back to
  where it was as soon as it is online. Test: apps/web/demo/offline.mjs.
- Add clips (and Add your footage) is the Library as it is: its folders as cards (open one, Back and the path to go
  up, "Pick the whole folder"), the videos in no folder at the top, plus Google Drive and This computer tabs. New
  footage is picked at once and shown while it is prepared; Add waits for it, then adds everything in the order
  picked. Test: apps/web/demo/add-clips.mjs.
- Exports from your AI go to your Mac when the Rendrr Mac app is open: the app (a signed-in Rendrr window) pings
  every 20 s (POST /desktop/ping, open for 75 s); render_final then queues the final for it and says it is going to
  the Mac, and the app saves it to Downloads the moment it is done (GET /desktop/exports, one claim per final so two
  windows never save it twice; a failed one is said). With the app closed, render_final says it is switching to
  Rendrr's cloud server and to ask which Google Drive folder, then save_to_drive. to: "drive" always goes to Drive.
  The render itself runs on Rendrr's servers either way. Tests: apps/api/test/mac-export.test.ts,
  apps/web/demo/mac-export.mjs.
- The connector has a Rendrr address: https://mcp.rendrr.live/mcp (Railway custom domain on the mcp service; CNAME
  and _railway-verify TXT at GoDaddy). PUBLIC_MCP_URL on api2 and mcp is https://mcp.rendrr.live, so Settings shows
  that address and the server's icons are on it. The old mcp-production-7fa0.up.railway.app address still works.
  Claude's connector icon (checked 7 Nov 2026): Claude does not use the server's `icons` or its favicon. It asks
  Google's favicon service for the last two parts of the connector's host (github.com/anthropics/claude-ai-mcp
  issue 152). The old address gives railway.app, so Railway's logo; mcp.rendrr.live gives rendrr.live. Google has
  the black "R" saved for rendrr.live (the web app's icon from 25 Oct to 6 Nov) and changes to the lime mark when it
  next reads the site (rendrr.live forwards to app.rendrr.live, whose favicon.ico has 16, 32 and 48 px). Asking for
  indexing of rendrr.live in Google Search Console makes that sooner. The user must re-add the connector with the
  new address for any of this to apply (done 7 Nov: Claude shows the "R" now).
  To help Google: the web app has robots.txt and sitemap.xml (app/robots.ts, app/sitemap.ts: public pages open,
  private ones closed) and names a 192 px PNG icon. Test: apps/web/demo/seo-files.mjs (npx tsx). In Search Console
  (only the owner can): add the Domain property rendrr.live (TXT at GoDaddy), submit
  https://app.rendrr.live/sitemap.xml, and Request indexing for https://app.rendrr.live/ and https://rendrr.live/.
- open_projects opens whatever the AI gives it: an edit's id or name, a project (folder) by id or name (folderId too),
  and an id that names nothing shows the list with a line saying so, instead of failing (Claude had passed a
  project's id and the call showed "Failed"). Tests: apps/api/test/claude-app.test.ts, apps/mcp/test/app-browser.mjs.

## Plans, billing, cost tracking and the admin panel (7 November)

- Plans: a 7-day free trial (10 export minutes, 30 footage minutes, 60 preview minutes, 5 GB, up to 1080p: about 10
  one-minute videos or one 10-minute video) and Starter at $5 a month (25 export minutes, 60 footage minutes, 10 GB,
  previews free, 4K counts double), then pay as you go: $0.10 an export minute, $1 an hour of footage, $0.10 a GB over
  10 GB. Each Starter account has a spending limit ($20 to start). Admins (`ADMIN_EMAILS`) get complimentary access.
- Cost tracking: the worker measures the container's CPU and memory every 2 s and shares them among the jobs running
  by weight; transcription seconds, bytes sent out and storage per day are noted too. Every job's cost is saved
  (JobCost), and idle time hourly. Each export, preview and footage upload is a usage record (one per render or
  video, never twice).
- Usage & billing page (`/usage`, `/billing`) like Railway's: money so far, estimated bill, spending limit, meters,
  day-by-day chart, pay-as-you-go lines, by project, storage, plans, card (Stripe's page) and invoices.
- Admin panel (`/admin`, admins only): overview (MRR, money in, our cost, margin, users, cost by day, usage, problems,
  queues), users (open one to give trial days, comp, bonus minutes, a limit; logged), costs per kind of job and per
  export minute, storage, issues (grouped errors, stuck work, AI tool errors, browser errors) and the job log.
- Limits: a render or upload past the plan gets a 402 with a plain reason; the web app shows a dialog and the AI the
  same text. Blocking is on only once `STRIPE_SECRET_KEY` is set (or `BILLING_ENFORCE=on`).
- Everyone already signed up starts a 7-day trial at deploy. Nothing is blocked until payments are switched on.
- Owner steps (Stripe product, webhook, keys): `docs/billing.md`.
- Tests: packages/shared/test/billing.test.ts, apps/worker/test/cost-meter.test.ts, apps/api/test/billing.test.ts
  (fake Stripe, real webhook signatures), apps/web/demo/usage-billing.mjs, apps/web/demo/admin-panel.mjs, sweep.

## The database moved to Supabase (8 November)

- The app's database is now Supabase, project "Rendrr US" in East US (North Virginia), Pro plan, Postgres 17. Before it
  was Railway Postgres 18 in US West, 64-69 ms from the servers in US East; Supabase is 2-3 ms away, so every page and
  AI tool call that reads the database is faster.
- How the app connects: `DATABASE_URL` on `api2` and `worker` is `${{shared.SUPABASE_DATABASE_URL}}` (Supabase's
  Transaction pooler, port 6543; the code adds pgbouncer=true and a pool of 8 per service, `DB_CONNECTION_LIMIT`).
  Migrations run through `DIRECT_URL` = `${{shared.SUPABASE_DIRECT_URL}}` (Session pooler, port 5432). The two values
  are Railway Shared Variables the owner set; nobody else has read them.
- Safety: Supabase's Data API is off; public tables are closed to its `anon` and `authenticated` roles (now and for
  tables made later) and row level security is on for every table. The app connects as the owner, which RLS does not
  limit.
- The move: maintenance mode (`MAINTENANCE=1` on api2 and worker: health stays up, every other request gets a plain
  503, the worker takes no jobs, nothing writes), a one-off Railway service `supabase-move`
  (scripts/supabase-move: pg_dump 18, pg_restore, row counts compared table by table, then the lock-down), then the
  switch. Every table matched (4 users, 44 projects, 715 videos, 491 renders, 8,793 job logs). Down about 6 minutes
  (08:25-08:31 UTC). A first try went to a project in Mumbai (207 ms away): stopped before the switch, app put back.
- Still to do by the owner: delete the Mumbai Supabase project ("Rendrr", ap-south-1; it holds an old locked copy);
  delete the `supabase-move` service in Railway (disarmed: its addresses are set to "disabled"); after a week with no
  problems, delete the old Railway Postgres service (kept as a fallback: set `DATABASE_URL` back to
  `${{Postgres.DATABASE_URL}}` on api2 and worker and remove `DIRECT_URL` to go back).
- Video files stay in the Railway bucket and Redis stays on Railway.
- Tests: apps/api/test/maintenance.test.ts (maintenance mode, pooler address), the copy job dry-run locally (first
  copy, refusal on a non-empty target, reset of an older copy, refusal to empty a target newer than the source).

## Where a render runs and where finals go, shown everywhere (9 November)

- Every render, preview or final, runs on Rendrr's cloud server (the worker, US East). The Mac app never renders: when
  it is open, it only receives the AI's finished finals and saves them to Downloads. This is now said everywhere:
  - AI tool answers: a "Where:" line on render_final, get_render and finished previews ("Rendering on Rendrr's cloud
    server (US East), not on your computer. Goes to the Rendrr Mac app on "Studio Mac": it saves the file to Downloads
    the moment it is done", then "Sent to ... saved in its Downloads folder" once the app took it). get_project ends
    with "Exports:" (where the next final goes). The connector's instructions and tool text say the same.
  - Claude card: chips on the version line: "Cloud render" (or "Cloud → Saved to "Studio Mac"" when watching a final)
    and "● Mac connected" while the Mac app is open; a final being made shows where it is going.
  - Web app: the Export window says "Rendering on Rendrr's cloud server, not on this computer" and the finished final
    "Made on Rendrr's cloud server"; Connect AI has a "Where exports go" card (Mac connected or closed, by name).
- How: Render.delivery (migration 20261109060000_render_delivery) records a final going to the Mac and when the app
  took it; GET /desktop/status (open, which Mac, version); the Mac app sends its Computer Name with its ping (new in
  the desktop code: shows by name after the next Mac app build; until then "your Mac").
- Tests: packages/shared/test/where.test.ts, apps/api/test/mac-export.test.ts, apps/mcp/test/app-browser.mjs,
  apps/web/demo/render-where.mjs, desktop/test/links.test.js.

## Send comments to Claude from the Rendrr app (10 November)

- The editor's Comments panel has a lime **Send N comments to Claude** button (web and Mac app). It sends the open
  comments shown to the AI the user connected: Claude, else ChatGPT; with both connected a small menu picks one, and
  the choice is remembered. Nothing connected: the button leads to Connect AI.
- MCP cannot push into a chat, so a click does two things:
  1. Opens the AI's chat with the message typed in (`claude.ai/new?q=…` or `chatgpt.com/?q=…`, the same words as the
     Claude card's button). In the Mac app the link opens in the default browser.
  2. Records the send (`AiHandoff` table). That AI's next Rendrr tool call, in any chat, ends with one line saying the
     user sent N comments on the edit and to fix them after the current request. `get_project` says comments are
     waiting; `get_comments` names the ones sent and marks them read.
- Each sent comment shows "Sent to Claude · 2m ago".
- Code: `packages/shared/src/aiHandoff.ts` (message, chat link, which AI), `apps/api/src/services/handoff.ts`, route
  `POST /projects/:id/comments/send`, the notice in `apps/api/src/routes/internal.ts`. Migration
  `20261110090000_ai_handoff`. Tests: `packages/shared/test/aiHandoff.test.ts`, `apps/api/test/ai-handoff.test.ts`,
  `apps/web/demo/send-to-ai.mjs`.

## Assets page (once Library): Videos, Images, Elements, Audio, Favorites, Trash (10 November)

- Top bar and menu say **Assets** (`/assets`, `/assets/<section>`; old `/library` links open Videos). A side bar like
  Higgsfield's: All assets, Favorites, Trash, then Types: Videos, Images, Elements, Audio, each with a count. On a phone
  the side bar is a row of chips.
- **Videos**: the library as it was (folders, Drive sync, references, Select, Edit this folder). Pictures moved to Images.
- **Images**: pictures (stills). They can now be uploaded from the web (they become still clips, as from the AI).
- **Elements**: logos and overlays. PNG keeps its transparency; an SVG is drawn to a PNG in the browser first. Stored as
  a graphic of kind `element`: the worker (`apps/worker/src/jobs/element.ts`) makes a 1 s transparent VP9 WebM plus a
  thumbnail, and the graphics layer holds it for as long as it is placed, so it moves, scales, fades and blends like any
  graphic. Shown on a see-through checkerboard. In the editor's Media panel one click puts an element on V3 at the
  playhead, 5 s, top right at about a fifth of the frame (`elementKeys`).
- **Audio**: the user's own music and voice files (Sound), with play, rename and upload from the web.
- **Favorites**: a heart on every card (videos too).
- **Trash**: delete now moves things to the Trash (Undo in the toast). Restore, Delete for good (videos ask about edits
  using them, as before), Empty trash. The nightly cleanup deletes what was trashed 30 days ago, except what an edit
  still uses. Trashed items are hidden from the library, search, list_footage and new edits.
- AI: `add_footage as: "element"` keeps a logo as an element; `list_graphics` lists the user's elements with how to
  place them (add_graphic, then set_keyframes).
- Code: `packages/shared/src/assets.ts`, `packages/core/src/assets.ts` (purge), `apps/api/src/routes/assets.ts`,
  `apps/api/src/services/elements.ts`, `apps/web/src/rendrr/assets.js`. Migration `20261110120000_assets`.
- Tests: `packages/shared/test/assets.test.ts`, `apps/api/test/assets.test.ts`, `apps/worker/test/element-render.test.ts`
  (a real render: transparent half shows the picture, held past 1 s), `apps/web/demo/assets.mjs`; library-delete and
  library-folders updated for the Trash and the Videos name.

## Login moving from Clerk to Supabase Auth (10 November)

- Built in both modes: Clerk stays the login until `AUTH_PROVIDER=supabase` (a Railway shared variable). Owner steps
  (Supabase keys into Railway, URL configuration, Google provider, new JWT signing keys, OAuth Server with
  `/oauth/consent`, then the switch) are in `docs/supabase-auth.md`.
- A Supabase login is stored as `sb:<id>` and opens the account with the same verified email, so nothing is lost;
  at the switch every account gets a Supabase login with its email (Forgot password then works for Clerk users).
- The AI connector logs in through Supabase's OAuth 2.1 server (dynamic client registration; Rendrr's consent page);
  the Mac app logs in through the browser with a one-time magic link token. Invite-only sign ups (`SIGNUP_ALLOWLIST`)
  are now enforced for every new account.

## Renders on the user's Mac (11 November)

While Rendrr for Mac is open (and can render), previews, finals and samples are made on that Mac with the app's own
FFmpeg; the cloud still prepares them (graphics, the person's cut-out, loudness) and checks the result. A final made
on the Mac goes to its Downloads and Rendrr keeps a copy (download elsewhere, Drive, review links, the Claude card).
Not taken within 20 s, quiet for 60 s, or failed: the cloud makes it. Settings > Where renders run says where, with an
on/off switch in the Mac app; the Export window, the Claude card and the AI's answers say where each render was made.
Details: docs/mac-render.md. Needs the new Mac app (built by the Mac workflow with FFmpeg for each chip).

Originals stay on the Mac: footage added in the Mac app is never uploaded (only the small preview copy). The app
remembers where the file is; Rendrr knows its size, picture and sound (`Video.macOriginal`, never the path). A final
then starts with no upload while that Mac is open and can render, and is made there from the file on disk; with the
app closed, or on another Mac, the original is asked for once, as before, and the AI is told which Mac has it.
The Mac app's FFmpeg 9 reads a graph from a file with `-/filter_complex`; the app adapts the cloud's runs to it.

## Rendrr for Windows (11 November)

The desktop app now builds for Windows too, from the same code: one-click installers for most PCs (x64) and Windows
on Arm, made and checked on GitHub (`.github/workflows/desktop-windows.yml`: FFmpeg from BtbN/FFmpeg-Builds, its
features checked, a real render in the tests, the app opened and its login checked) and published as a Release
`win-v0.1.<build>` and on app.rendrr.live/download, which now picks the Mac or Windows page by the computer
(`/download/mac`, `/download/windows`). Everything the Mac app does works on Windows: login through the browser, files
to Downloads, renders made on the PC while the app is open (the cloud otherwise), originals kept on the PC. Rendrr says
"PC" and "Rendrr Windows app" for a Windows PC everywhere it said Mac (Settings, the Export window, the Claude card,
the AI's answers). Not signed with a certificate yet: Windows SmartScreen asks once (More info > Run anyway).

## Several computers on one account (11 November)

Logged in on several Macs or PCs at once, Rendrr sees every computer with the app open and online. When two or more can
render, Claude asks which one before rendering (for example "M1" or "M3", or Rendrr's cloud server) and passes the
answer as `device`; the pick is kept for the next 6 hours, so Claude asks again only after that or when the user wants
a switch. The render goes to that computer alone. A final made from an original kept on one computer always goes to
that computer. In the web app: Settings > Where renders run lists every computer (ready, rendering now, or why not)
with "Ask each time / a computer / Rendrr's cloud server", and the Export window has "Render on". Needs the newest
Mac or Windows app (it sends the computer's id). Details: docs/mac-render.md.

## Log in with a code from email (15 November)

The login window has "Log in with a code from email instead": type your email, get a code, type it, logged in (no
password; only existing accounts; works inside the Mac and Windows apps too). Forgot password stays as it was (a reset
email with a link and a code). Errors are said plainly: no account with that email, a wrong or expired code, too
many emails, or an address Rendrr cannot email yet. Owner step (docs/supabase-auth.md step 7): Supabase only emails
its own team until it sends through your own sender (Resend with rendrr.live), and the email templates need the code line.

## Claude can delete and restore (16 November)

New connector tool `delete_items` (marked as deleting to the AI app): footage (videos and pictures), edits, project
folders, library folders, elements, audio, fonts, LUTs and saved styles, several at once, only when the user asks.
Footage, elements and audio go to the Trash first (Assets > Trash, 30 days; edits using them keep working) and edits are
marked deleted; `restore: true` brings them back. `permanent: true` deletes for good; anything in use (footage or an
element in edits, a project folder with edits) is named and left alone unless `force: true`. `trash: "list"` and
`"empty"`. The web app's video delete uses the same code (`apps/api/src/services/deleting.ts`). Test:
`apps/api/test/delete-items.test.ts`.

## Project cards show their videos (16 November)

On the Projects page each project's card shows the pictures of its newest edits (the latest render's first frame, else
the footage's): one fills the card, two side by side, three or four as a 2x2 grid, never more than four, with the name on
a shade at the bottom. A project with no edits keeps its grey cover. The Claude card's project cards do the same.
Tests: `apps/web/demo/project-cards.mjs`, `apps/api/test/folder-cards.test.ts`, `apps/mcp/test/app-browser.mjs`.

## Claude can move videos into any project (17 November)

New connector tool `move_to_project`: edits (kind `edit`) move into another project with their versions, renders,
comments and their own share links; footage from the Library (kind `video`) goes into a project as a new edit of it
(version 1 is the raw footage) and stays in the Library. The project is named by id or name; a new name makes it, and
two projects with the same name are refused (the ids are listed). Several at once; each item is answered on its own (a
footage id sent as an edit says which edits it has, a deleted edit is left alone, another user's things are "not
found"). A whole-project share link shows the edits in that project now. On the web, a project's page has "Move to
project" in each video's menu and Move for the selected ones: pick a project or make one, and Undo puts them back.
Code: `moveToFolder` and `findOrMakeFolder` in `apps/api/src/services/projects.ts`, `POST /projects/move`. Tests:
`apps/api/test/move-to-project.test.ts`, `apps/web/demo/move-edits.mjs`.

## Claude exports the sound only (17 November)

`render_final` takes `format`: `"audio"` (AAC .m4a) or `"wav"` makes a sound-only final for that export alone; the
edit's own export settings and versions stay as they are, so its next video export is still a video. The file goes
where a video would: the Mac or PC's Downloads while the Rendrr app is open, else Google Drive (`driveFolder`, or
`save_to_drive format "audio"`, which finds the sound-only final even after a newer video final). It is named `.m4a`
or `.wav` everywhere and the answer says "Sound-only final ... (no picture)". A video final and a sound-only final of
the same version are two renders (asking again joins the one of the same kind); sound is never billed as a best or 4K
export. A review link never tries to play a sound-only file (or a GIF or ProRes overlay): it shows the version's video.
New column `Render.format` (migration `20261117120000_render_format`). Tests: `apps/api/test/sound-export.test.ts`,
`apps/worker/test/deliver-render.test.ts` (a real .m4a from a video edit), `packages/shared/test/deliverables.test.ts`.

## Older Mac and Windows apps offer the new one (17 November)

The desktop apps have no auto-update, so an old install stays old: one from before rendering on the computer has no
render engine, and every export it asks for goes to Rendrr's cloud ("this Mac app cannot render yet: update it"). The
app's window loads the live web app, so the web app now shows a bar inside an older app: with no render engine it says
"Update the Rendrr Mac app to render exports on this Mac. This version sends them to Rendrr's cloud."; an app that
renders but is older than the newest build says a new one is out. "Get the new app" opens the download page in the
browser (every app version may open rendrr.live links). Closing it keeps it closed until a newer version comes out. The
newest version comes from the new public `GET /downloads/latest` ({ mac, windows }: version and download link).
Tests: `apps/web/demo/update-bar.mjs`, `apps/api/test/mac-download.test.ts`.

## Claude asks for files on your computer (17 November)

`add_footage from: "computer"` gives the AI a one-hour link (`/add/<pick>`) to hand the user: they open it where they
are signed in to Rendrr and drop or choose videos and pictures from their computer (any size, so files too big to attach
to the chat get in too). A video stays on their computer and its preview is made in that tab, as from the Library; a
picture is uploaded. What arrives is recorded on the pick and goes in the edit's Media panel when the link was made for
one; `add_footage pickId` (with `wait_seconds`) tells the AI exactly which videos arrived and their state. The link
belongs to one account: opened in another it says so and takes nothing; after an hour it says it expired. Code:
`apps/api/src/services/picks.ts`, `apps/api/src/routes/picks.ts`, `apps/web/src/rendrr/addPick.js`. Tests:
`apps/api/test/picks.test.ts`, `apps/web/demo/add-pick.mjs`.

## Videos and pictures from Dropbox (17 November)

The Library's Add footage window, the editor's Add clips window and the page an AI's link opens
(`add_footage from: "dropbox"`) each have a Dropbox tab. The user pastes a Dropbox share link, or, once the Dropbox app
key is set, picks files in Dropbox's own window (Chooser; not inside the Mac or Windows app, whose popups open in the
browser). Rendrr downloads them in the background (`POST /picks/:id/links`), so a big video does not hold the page: the
tab shows what is coming in, what arrived and what could not be brought in. A folder link says to share each file. What
arrives goes in the library, is picked in Add clips, and goes in the edit when the link was made for one;
`add_footage pickId` tells the AI what arrived, what is still coming in and what failed. Code:
`apps/api/src/services/picks.ts` (`importLinks`), `apps/web/src/rendrr/cloudSources.js`. Tests:
`apps/api/test/dropbox.test.ts`, `apps/web/demo/dropbox.mjs`.

**Owner step for the Dropbox window (the link box works without it):** create an app at dropbox.com/developers (Chooser),
add `app.rendrr.live` to its Chooser domains, and set its app key (public, not a secret) as
`NEXT_PUBLIC_DROPBOX_APP_KEY` on the web service.

## Videos and pictures from Google Photos (17 November)

The Library's Add footage window, the editor's Add clips window and the page an AI's link opens
(`add_footage from: "google_photos"`) each have a Google Photos tab, through Google's Photos Picker API: Rendrr sees
only what the user chooses. The first time, the tab asks to connect Google Photos (the Google sign-in Rendrr already
uses for Drive, with one more permission; Drive's own permissions are always kept). Then Choose from Google Photos opens
Google Photos' own page (a window opened on the click, so browsers do not block it; in the Mac or Windows app, in the
browser). Rendrr asks Google whether the user is done, no more often than Google says, and both the page and the AI's
`add_footage pickId` ask, so closing Rendrr right after choosing still works. What was chosen is brought in once, two
at a time, each with the user's Google token: a photo as a JPEG at its own size (so an iPhone HEIC comes in too), a video
as its file. A video Google is still processing says so; a file link Google refuses (they last about an hour) is fetched
again from a fresh listing; an expired choice says so and offers to choose again. Code:
`apps/api/src/services/googlePhotos.ts` (Google's addresses and link forms), `apps/api/src/services/picks.ts`
(`startPhotos`, `checkPhotos`), `apps/web/src/rendrr/cloudSources.js` (`GooglePhotosPanel`). Tests:
`apps/api/test/google-photos.test.ts`, `apps/web/demo/google-photos.mjs`. To check live: an iPhone (HEIC) photo comes in.

**Owner steps (Google Cloud project of the Rendrr Google sign-in):** enable the Photos Picker API; add the scope
`https://www.googleapis.com/auth/photospicker.mediaitems.readonly` to the OAuth consent screen (Google may ask to verify
it before people outside the test users can use it).
