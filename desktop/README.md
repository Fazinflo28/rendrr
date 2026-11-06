# Rendrr for Mac

A Mac app around the Rendrr web app. The window opens https://app.rendrr.live, so the editor, Claude edits and
renders are the same as in the browser, and every web update shows up here without a new download.

What the app adds:
- Rendrr's icon in the Dock and Launchpad, Mac menus (Edit, View, Go, Window) and shortcuts (Cmd+N new window,
  Cmd+1 Projects, Cmd+2 Library, Cmd+, Settings, Cmd+[ / Cmd+] back and forward).
- No title bar: the window buttons sit in Rendrr's top bar (the web app adds room for them when `html.desktop` is set).
- Finals and other files save straight to ~/Downloads, with progress on the Dock icon.
- Login through the browser: Google refuses to sign in inside apps, so "Log in with your browser" opens Rendrr in the
  default browser, where the person (already logged in there) clicks Allow; the browser hands a one-time grant back
  through `rendrr://auth?grant=…` and the app trades it, with a secret only it holds, for a login
  (web: `src/rendrr/desktopLogin.ts`, `/desktop-login`; API: `services/desktopLogin.ts`). Google Drive consent opens in
  the browser too, and the app sees the connection appear.
- Links to other sites open in the default browser (rules in `links.js`, tested by `npm test`).
- Uploads keep full speed while the window is hidden.
- A calm offline page that reconnects by itself.

Not yet: rendering on the Mac itself. Exports still render on Rendrr's servers.

## Build

The installers are built on GitHub (`.github/workflows/desktop-mac.yml`) on every change to `desktop/`, and published
as a Release named `mac-v0.1.<build>` with `Rendrr-Mac-AppleSilicon.dmg` and `Rendrr-Mac-Intel.dmg`. The build opens the
app on the Mac runner and checks it loads Rendrr before it publishes.

On a Mac you can also run it yourself:

    cd desktop
    npm ci
    npm test
    npm start                 # run without building (RENDRR_URL=http://localhost:3000 for a local web app)
    npm run dist:mac          # dist/Rendrr-<version>-arm64.dmg and -x64.dmg

The app is signed ad hoc (no Apple Developer account), so the first open needs System Settings > Privacy & Security >
Open Anyway (see RELEASE_NOTES.md). With a Developer ID later: set `mac.identity`, turn on `hardenedRuntime` and notarize.

The icon is `build/icon.png` (1024 px, the lime mark on the dark rounded square).
