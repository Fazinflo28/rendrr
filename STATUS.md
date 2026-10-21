# Status

Last updated: 21 October 2026, morning (UTC).

## 1. Links

| What | Address | Live? |
|---|---|---|
| Web app | https://web-production-9ef14.up.railway.app | Not yet (see "One thing you need to do") |
| API health | https://api-production-2428.up.railway.app/health | Not yet |
| AI connector (MCP) | https://mcp-production-7fa0.up.railway.app/mcp | Not yet |

The Railway project `rendrr` is fully set up: Postgres, Redis, a private file bucket, the four services (`web`, `api`, `worker`, `mcp`), their settings, domains and health checks, all in **US East** next to the bucket.
What is missing is the code: Railway is not allowed to read the GitHub repo yet, so nothing has been built there.

### One thing you need to do

1. Open https://github.com/settings/installations.
2. Find **Railway** and press **Configure**.
3. Under "Repository access", add **rendrr** (or pick "All repositories") and **Save**.
4. Tell me (or any Claude session with the Railway connector) "Railway can see the repo now". The four services then get connected to the branch `claude/rendrr-backend-mcp-1vbkgg` and build by themselves (about 5 minutes). Every later push redeploys automatically.

If you prefer to do it yourself in the Railway dashboard: for each of `api`, `worker`, `mcp`, `web` → Settings → Source → Connect repo `Fazinflo28/rendrr`, branch `claude/rendrr-backend-mcp-1vbkgg`. The Dockerfile paths and everything else are already set.

## 2. What works end to end

Checked tonight on a full local copy of the system (Postgres, Redis, S3-compatible storage, real Clerk login, real AssemblyAI), and again **from the exact Docker images Railway will build**:

- **Smoke test: 17/17 steps pass** (log in → add footage → transcript, silences, scene cuts, key frames → create an edit with a style → AI edits → autosave → preview render with live progress → 1080p final → password review link → client comment → resolve → approve → usage).
- **AI connector**: log in like Claude does (dynamic client registration, PKCE, Clerk login, consent screen), then every main tool: list and read footage, apply a style, cut silences, add zooms, music, graphics, captions, render a preview and look at its frames, make a custom animated graphic, create a review link, read comments, undo.
- Footage: built-in sample, local files (preview copy made in the browser, original uploaded once for a full-quality export), Drive (fake Drive until Google keys exist).
- Editing: every change goes through one function with version history, AI changes are undoable, the editor pulls AI changes in live and refuses to overwrite them.
- Rendering: 540p previews in about 6–12 s and 1080p finals in about 13–17 s for a 30 s edit; captions in three looks, zooms, b-roll, graphics with transparency, music ducked under speech, sound effects.
- Reviews: password, expiry, download on/off, comments at a time, approve, request changes, folder reviews.
- Daily cleanup at 03:15 UTC (expired preview copies, raw originals after 24 h, old preview renders, stuck jobs).
- 22 unit tests for the timeline maths and the render plan.

## 3. What is stubbed, and the key that turns each one on

| Stub | What happens now | Key that unblocks it | Where it goes |
|---|---|---|---|
| Google Drive | A fake Drive shows the UI's demo folders, backed by the built-in sample videos | `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` (Google Cloud → OAuth client, Drive API on, redirect URI `https://api-production-2428.up.railway.app/drive/callback`) | Railway → `api` and `worker` → Variables |
| Billing | Everyone is on the Studio plan, 100 GB, no render limits | `STRIPE_SECRET_KEY` (plus product setup, not built yet) | Railway → `api` |
| Transcription | **Real** (your AssemblyAI key is set). Without a key every video would get the sample transcript | `ASSEMBLYAI_API_KEY` | already set on `api` and `worker` |
| Login | **Real** Clerk (development instance `mature-joey-7879`; Google login uses Clerk's shared test credentials) | For a public launch: a Clerk production instance and your own Google OAuth app | Railway → `api`, `mcp`, `web` |

Keys live only in Railway's settings and in a local `.env` that is never committed.

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
| Connect page: the sentence about a private URL now says it is one URL for everyone with a login | The connector uses OAuth (Phase 0 answer) |
| "720p preview" text now says 540p | Previews render at 540p (Phase 0 answer) |
| Password reset gained a "code + new password" step | Clerk sends a code by email; the fake API had no real reset |
| Changing your email asks for the 6-digit code Clerk emails to the new address | Otherwise anyone could claim an address they do not own |
| New `/drive-done` page (only seen if the Google popup is blocked) | Finishes the Drive connection safely in your own logged-in tab |
| Demo state switches (profile menu) only exist in development builds | They fake errors; real users should never see them |

Everything else is the UI from `ui/rendrr-ui.html`, wired to the real API.

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
- Smaller: short music clips went silent early, cutting the last word left its tail, the graphics sandbox could send network traffic through WebRTC, frames taken for the AI were never deleted.

## Known limits (not blocking a test)

- The web app runs on Railway, not Vercel: the Vercel connector here may read projects but not create them. Moving later is described in [DECISIONS.md](DECISIONS.md).
- Login says whether an email has an account (friendlier messages; fine for a private app, change before a public launch).
- One worker renders one video at a time (`CONCURRENCY_RENDER`); raise it or add replicas when more people use it.
