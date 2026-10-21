# Rendrr web app

Next.js 15 (App Router) port of `ui/rendrr-ui.html`. Same components, class names and CSS; the fake `api` is
replaced by a real client that talks to the API server (`apps/api`).

## Run it

```bash
pnpm install                      # from the repo root
cd apps/web
cp .env.example .env.local        # then fill in the values
pnpm dev                          # http://localhost:3000 (copies the ffmpeg.wasm wrapper into public/ first)
pnpm build && pnpm start          # production build
```

## Environment variables

| Name | What | Example |
|---|---|---|
| `NEXT_PUBLIC_API_URL` | The API server | `https://api-production-2428.up.railway.app` |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | Clerk publishable key (needed at build time) | `pk_test_…` |

Nothing secret lives in the web app: login goes through Clerk, and every call carries the Clerk session token.

## Deploy (Vercel)

Project root directory `apps/web`, framework Next.js. Vercel installs from the pnpm workspace root.
`pnpm build` runs `scripts/copy-ffmpeg.mjs` first (copies `@ffmpeg/ffmpeg`'s small ES module wrapper into
`public/ffmpeg/` so its worker is same-origin; the 30 MB core is fetched from unpkg/jsdelivr at runtime).

The storage bucket must allow browser uploads (CORS): `PUT`, `GET`, `HEAD` from the web origin, any header,
and expose `ETag` (needed to finish multipart uploads of originals).

## How the port is laid out

| File | From the HTML | Changes |
|---|---|---|
| `src/rendrr/styles.css` | both `<style>` blocks | none |
| `src/rendrr/ui.js` | shared UI script | imports/exports; app contexts moved here; `Player` takes `src` (real `<video>`, the video is the playback clock), `videoFit`, `onVideoError`; `Thumb` shows a real frame or the gradient art; snapshot draws the real frame when the browser allows it |
| `src/rendrr/screens.js` | screens script | see "UI changes" |
| `src/rendrr/editor.js` | editor script | see "UI changes" |
| `src/rendrr/app.js` | app script | route = real URL (Next router), Clerk session skips /login, phone scaling in an effect |
| `src/rendrr/api.ts` | the fake `api` | real HTTP client, same function names, arguments and return shapes |
| `src/rendrr/http.ts` | | fetch helpers, friendly errors (`.friendly`, `.code`), SSE over fetch |
| `src/rendrr/local.ts` | | footage from this computer: ffmpeg.wasm preview, uploads, remembered file handles, multipart originals |
| `src/app/**/page.tsx` | | one file per route so the URLs are real; the client root renders the screen |

Every route is client-rendered (`ssr: false`) because the UI touches `window`, `document` and `localStorage`.

## UI changes (all deliberate, everything else is unchanged)

- Real video in the player: footage page (preview copy), editor (preview copy in source time, still skips cut words and draws captions and zooms on top, filled to the project shape), review page and "Watch preview" (the rendered file, no drawn captions because they are burned in).
- Real thumbnails and key frames where the API has them.
- Real lengths (no 32 s / 60 s caps). Folder asset lengths show "—" until the API sends an output length.
- Review page: a "Rendering the preview… refresh in a minute" state when nothing is rendered yet; password unlock reloads the page data; Download opens the signed file; comments on a shared folder are tied to the video on screen.
- Share links use the address the app runs on (not rendrr.live).
- Login: "Forgot password?" sends a Clerk code; the same card then asks for the code and a new password.
- Connect page sentence: "Your AI will ask you to log in to Rendrr the first time."
- Render modal: "540p, quick check only"; final Download opens the file and is labelled with its name.
- Editor: reloads when your AI changes the edit; AI Undo and "Restore this version" go through the API; autosave conflicts reload the new version.
- "Open in Drive" and "Restore" (recently deleted) work.
- The "Demo states" menu only shows in development.
