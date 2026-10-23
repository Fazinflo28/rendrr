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

  Music and sound effects play only in the rendered preview. When the preview is of the current version and nothing has changed since, the player plays that file instead. "Render preview" sits in the editor's top bar.
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
