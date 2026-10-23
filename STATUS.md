# Status

Last updated: 23 October 2026 (UTC). Live on Railway with the new design (V2). New: every video is broken down into text and frames for the AI, and reference videos.

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

## Every video as text and frames

Rendrr does the seeing and rendering; Claude only does the thinking. Right after the transcript, every video is read once ("Reading the frames", the last processing step). That covers footage and reference videos, from Google Drive, a computer or the sample:

- **Breakdown ("video code")**: every shot with its times, light, colour, motion, loudness and what is said; pacing (cuts per minute, words per minute, speech and silence share); the hook (first 3 seconds); loudness per second; the music beat. Claude reads it as a few lines of text.
- **Contact sheets**: frames every 0.5 to 5 seconds plus one in the middle of every shot, 16 to an image, with the time printed on each frame. A 40-second clip is 3 images.
- **Exact moments**: Claude can ask for any frame (`get_frames`), and Rendrr takes it from the preview copy.
- **Reference videos**: in Library › Add footage, switch on "Add as a reference" for a video whose style to copy. The Library has a References filter, and any video can be switched on its page. Claude finds references with `list_references` and reads them with `get_reference`.
- **Where Claude gets it**: the connector's `get_footage` and `get_reference` return the breakdown with its contact sheets. The editor's AI chat has the same tools, and now receives the images too.
- **Where you see it**: every footage page has a **What Claude sees** section with the pacing, a shot strip, the contact sheets (click a frame to jump there) and the video code, plus Copy as text.
- Videos added before this got their breakdown automatically when the worker started. Videos added from a computer now also get key frames and a thumbnail; before, they had none.

## New design (V2)

The web app now uses `ui/rendrr-ui-v2.html`, wired to the real backend:

- **Explore** (the new start page), **Create** pages per category (Clipping, Talking head, Ads, …) and **Styles** work without logging in. Liking, recreating, adding footage or using a style opens the login window first, then carries on.
- Explore starts with **example videos posted by Rendrr** (two per style). Real videos appear once you publish edits.
- **Editor**: the new AI tab is a chat. You type a change, Claude makes it with the same editing tools as the AI connector, and shows the steps it took. Every change is a new version you can undo. Changes made through the Claude or ChatGPT connector show up in the same thread.
- **Editor notes**: leave a note at any moment of the video; it sits next to your client's review comments.
- **Billing** page: plans, card and invoices (payments are not switched on yet, see below).
- **Final ready** popup: Save to this computer, or Save to Google Drive.

### Phones and tablets

Under 1024px wide the app has its own touch layout (the desktop design above that is unchanged): the top bar wraps with the categories scrolling underneath, a bottom tab bar (Explore, Projects, Add, Library, Account) when logged in, dialogs and the login window as bottom sheets, one- or two-column grids, and an editor that stacks the player, the Comments/AI/Style/Transcript panel and the timeline. Checked on every screen at 360px, 390px, 820px and 1440px wide.

### Preview without the backend

A clickable preview of the whole UI runs in the browser with the design's demo data (no server, no real login): https://claude.ai/artifact/KduyKRPmudMLzg9L7fBZF5 (private to you until you share it from its Share menu). Rebuild it with `pnpm --filter @rendrr/web preview:build`.

In the preview you can log in with any email and password, browse Explore and the categories, add footage (sample, the fake Drive, or a video from your phone or computer, which then plays in the editor), make an edit, cut words, leave notes, use the AI chat (canned replies), render a final, share a review link and open the client page, publish to the gallery, and change plan or settings. Nothing is saved: a reload starts fresh. Downloads and "Save image" do nothing inside the preview window.

## 2. What works end to end

**On the live Railway servers (23 October)**: smoke test 17/17 (transcript by AssemblyAI in 12–25 s, 540p preview in 4.5 s, 1080p final in 13.5 s). The AI connector logs in like Claude does and lists 36 tools; apply_style, cut_silences, cut_words, add_zoom and add_music each save a new version. The web app loads Explore (29 examples) and the login window on desktop and phone.

Earlier, on a full local copy of the system (Postgres, Redis, S3-compatible storage, real Clerk login, real AssemblyAI), and again **from the exact Docker images Railway will build**:

- **First start on an empty database and empty bucket** (what Railway will do): migrations, seed, built-in media generation and the full smoke test all pass from the Docker images.
- **Smoke test: 17/17 steps pass** (log in → add footage → transcript, silences, scene cuts, key frames → create an edit with a style → AI edits → autosave → preview render with live progress → 1080p final → password review link → client comment → resolve → approve → usage).
- **AI connector**: log in like Claude does (dynamic client registration, PKCE, Clerk login, consent screen), then every main tool: list and read footage, apply a style, cut silences, add zooms, music, graphics, captions, render a preview and look at its frames, make a custom animated graphic, create a review link, read comments, undo.
- Footage: built-in sample, local files (preview copy made in the browser, original uploaded once for a full-quality export), Drive (fake Drive until Google keys exist).
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
| Google Drive | A fake Drive shows the UI's demo folders, backed by the built-in sample videos | `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` (Google Cloud → OAuth client, Drive API on, redirect URI `https://api-production-2428.up.railway.app/drive/callback`) | Railway → `api` and `worker` → Variables |
| Billing | The Billing page shows Free / Pro / Studio. Switching changes the plan name and storage figure only; there is no card, no invoices and no limits | `STRIPE_SECRET_KEY` (plus product setup, not built yet) | Railway → `api` |
| Editor AI chat | Replies that it needs a key, and points to the Connect AI page | `ANTHROPIC_API_KEY` (console.anthropic.com → API keys). Optional: `AI_CHAT_EFFORT` = low, medium (default), high | Railway → `api` |
| Save final to Google Drive | Says it is not switched on yet; Save to this computer works | Same Google keys as Drive (above) | Railway → `api` |
| Transcription | **Real** (your AssemblyAI key is set). Without a key every video would get the sample transcript | `ASSEMBLYAI_API_KEY` | already set on `api` and `worker` |
| Login | **Real** Clerk (development instance `mature-joey-7879`; Google login uses Clerk's shared test credentials) | For a public launch: a Clerk production instance and your own Google OAuth app | Railway → `api`, `mcp`, `web` |

Keys live only in Railway's settings and in a local `.env` that is never committed.

With `ANTHROPIC_API_KEY` set, the chat uses Claude Opus 5.5. If Claude's safety filter declines a request, Anthropic automatically retries it on its recommended fallback model ("server-side fallbacks"), so the chat answers instead of failing.

## 4. The one command to test it

After the services are live (step 1 above):

```bash
API_URL=https://api-production-2428.up.railway.app CLERK_SECRET_KEY=sk_test_... pnpm smoke
```

It prints PASS or FAIL for each of the 17 steps. Details and the AI connector test: [SMOKE_TEST.md](SMOKE_TEST.md).
To try it by hand: open the web app, sign up, press "Add sample footage" in the Library, wait for Ready, then make an edit.
To try the AI: in Claude, Settings → Connectors → Add custom connector → `https://mcp-production-7fa0.up.railway.app/mcp`.

## 5. Changes to the UI, and why

| Change | Why |
|---|---|
| Phone and tablet layout (bottom tab bar, bottom sheets, stacked editor) | The design was desktop only; on a phone it was shrunk to a tiny page |
| Explore shows example videos posted by "Rendrr" instead of the design's invented creators, likes and views | No made-up people or numbers in a real app |
| Billing: "No card on file. Payments are not switched on yet…", "No invoices yet.", PDF button only for a real invoice | Payments are stubbed |
| The editor's AI chat is real Claude; without a key it says what to set | The design's chat gave canned replies |
| Changes made through the Claude/ChatGPT connector appear in the editor's AI thread | So you see in the editor what an outside AI changed |
| The hint on "Preview up to date" now says the player shows changes live and a preview render burns in captions, zooms and music | Previews are not rendered after every change |
| "Save to Google Drive" says it is not switched on until the Google keys are set | Drive is the fake Drive for now |
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
