# Renders on the user's Mac

While Rendrr for Mac is open, signed in and able to render, previews, finals and samples are made on that Mac. With
the app closed, or when the Mac cannot take a render, Rendrr's cloud server makes it as before. Nothing ever waits on a
Mac that has gone.

## Who does what

- **Cloud worker** (`apps/worker/src/jobs/render.ts`): prepares the render as always (footage, graphics recording, the
  person's cut-out, stabilizing, the sound's loudness), then builds the encode's FFmpeg runs with the Mac's own thread
  count and hands them over (`lib/macTask.ts`: every path made relative to the job's folder; files from storage go
  by their key, small generated ones inline, larger ones under `mac/<render>/`, the caption fonts under `mac/fonts/`).
  It waits: not taken in 20 s, quiet for 60 s, or failed: it makes the render itself (`plan.operations` says why).
- **Task protocol** (`packages/core/src/macRender.ts`, Redis): create, list, claim (once), report (progress, stop),
  done (every output's size), failed. Reports carry a per-task token only the claiming Mac gets.
- **API** (`apps/api/src/routes/macRender.ts`): `GET /desktop/tasks` and `POST /desktop/tasks/:id/claim` (signed in);
  `POST /desktop/tasks/:id/progress|done|failed` (task token). The Mac app's ping says what it can render
  (`render: { protocol, ready, enabled, busy, cpus, have, ffmpeg }`).
- **Mac app** (`desktop/render.js`, plain Node): checks a task (names inside its folder, no absolute path, protocol or
  `..` in arguments or the graph, https links), fetches files (footage cached in `~/Library/Caches/Rendrr`, 20 GB),
  runs FFmpeg in a fresh folder, reports every second, uploads to the render's own key, keeps a final in Downloads.
  `main.js` runs one task at a time; the web app (`app.js` `useMacRenders`) takes the next waiting one every 3 s.
- **FFmpeg**: a static build per chip in the app's Resources (`.github/workflows/desktop-mac.yml` downloads it,
  `scripts/check-ffmpeg.js` checks it, `test/render.test.js` renders with it on the Mac build machine). GPL, ffmpeg.org.

## Where it says so

`Render.made` (`{ on: "mac" | "cloud", device, why }`), the live progress (`on`, `device`), and `packages/shared/src/where.ts`
for every text: the editor's Export window, Settings > Where renders run (with the Mac app's on/off switch), the
Claude card's chip, and the AI's tool answers.

## Turning it off

In the Mac app: Settings > Where renders run > Render on this Mac. On the server: `MAC_RENDER=off`.

## Tests

`desktop/test/render.test.js` (the Mac's code against a stand-in Rendrr), `apps/api/test/mac-render.test.ts` (worker,
API, storage and the Mac's code end to end; the Mac's file matches the cloud's own render), `apps/api/test/mac-export.test.ts`,
`apps/web/demo/render-where.mjs`, `apps/mcp/test/app-browser.mjs`, `packages/shared/test/where.test.ts`.
