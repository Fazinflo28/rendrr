# Status

Last updated: 28 October 2026 (UTC). New: Rendrr is the engine, Part 6: a real waveform on the timeline from the 10 ms peaks with deeper zoom, marks as thin coloured lines with notes and a toggle, and the measurements taken off the footage page (see "Engine Part 6" below). Part 4: a hidden library for the AI (48 ready animations, 5,844 icons, all font weights) and analyze_reference, which measures a reference video into a style file (see "Engine Part 4" below). Before that: Part 5: test_graphic (a few seconds of a graphic over the footage in under 10 s), and long busy graphics record in 90 s chunks without running out of memory (see "Engine Part 5" below). Before that: Part 3: the preview check reads the preview file's own sound (gaps placed at the joins, clicks at the joins), names the words a cut goes through in ms, says how much of the face each graphic covers, and the preview is transcribed again so "Transcript as it plays" is what a viewer hears (see "Engine Part 3" below). Before that: reference-edit blockers fixed (cards, backgrounds, sideways footage, the op list). Before that: Rendrr is the engine, Part 2: every video measured more deeply (the sound every 10 ms, where each word starts and ends in the sound, faces and the picture), with four new tools (see "Engine Part 2" below). Before that: one edit from several videos (see "Several videos in one edit" below). Before that: Rendrr is the engine, the AI is the editor. Part 1: marks instead of automatic edits (see "Rendrr is the engine" below). Before that: long graphics, reusable graphics, fonts, quick tool calls, the graphic check and face framing (see "Faster graphics and framing" below). Before that: Phases 6-8 of the editor plan. Phase 6: colour and compositing. Phase 7: export settings, the footage's frame rate kept, time left while rendering, and graphics as long as the video. Phase 8: a 20-minute talking head edited live through the connector only, in 8 calls with no images (see "Phase 8" below). Earlier phases are described in their own sections.

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
| **Remove the background (Premiere parity, phase 1).** remove_background (Claude, and Color > Remove background in the editor) cuts the person out of each V1 clip; what shows behind them is the edit's background (set_background: a colour, the footage blurred, a gradient or a pattern; the editor's Behind menu). Edge (-20 to 20: shrink or grow the cut-out), soft (0-100: feather), invert (keep the room, remove the person), off. The cut-out is an AI matte from MediaPipe's selfie segmenter (Apache-2.0, in the worker image): tall or wide frames read as overlapping squares, gated by the whole frame so floor and walls do not leak, smoothed over time where nothing moves, its edge refined on the picture's own edges (a fast guided filter). Made once per 10 s block of footage from the preview copy and kept, so the preview, the final and the editor share it: an edit with it queues the blocks at once (one job each), a render makes any still missing (about 2.5 s of work a second of footage), and the editor's player shows the cut-out live as blocks arrive. In the render the matte goes through the clip's own trim, speed, freeze, turn and fit, into the alpha. People only for now (the model finds people, not objects). A reversed clip keeps its background. | `worker/python/matte.py`, `worker/src/lib/matte.ts`, `worker/src/jobs/matte.ts`, `core/src/matte.ts`, `shared/src/look.ts` (SubjectSchema, matteBlocks), `ops.ts`, `renderPlan.ts`, `api/src/routes/projects.ts` (GET /projects/:id/matte), `web/src/rendrr/color.js` (BackgroundSection), `look-gl.js`, `editor.js` (useMattes), `mcpTools.ts`, `editingSkill.ts`, `worker/Dockerfile` | Done, tested (shared `subject.test.ts` 10; worker `subject-render.test.ts` 3: a box moving 30 px a frame stays red to its edges with the background right outside, across the blocks' join, at 2x, inverted; `subject-matte.test.ts`: the real model on a person, the room's corners become the background, the face stays, kept blocks read again in 0 s; API `subject.test.ts` 5: one job per block, the measured turn, kept blocks not queued, the editor's links; browser `matte-match.mjs`: the editor's player matches the render at every frame checked; `background.mjs`: the editor's controls) |
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
