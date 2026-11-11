# Rendrr for Mac and Windows

A desktop app around the Rendrr web app, for Macs and Windows PCs (the same code; `main.js` picks the platform's ways). The window opens https://app.rendrr.live, so the editor, Claude edits and
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

- Renders on this computer while the app is open (`render.js`, docs/mac-render.md), with its own FFmpeg, and footage
  added here keeps its original on this computer.

On Windows: the minimise, maximise and close buttons sit over the top-right of Rendrr's top bar (`html.desktop-win`),
the menu bar is hidden (its shortcuts work: Ctrl+N, Ctrl+1, Ctrl+2, Ctrl+, , Alt+Left / Alt+Right), progress shows on
the taskbar icon, the browser hands the login back by starting the app with `rendrr://auth?grant=…` (second-instance),
and the footage cache is in `%LOCALAPPDATA%\Rendrr\Cache`.

## Build

The installers are built on GitHub on every change to `desktop/`:
- Mac (`.github/workflows/desktop-mac.yml`): a Release `mac-v0.1.<build>` with `Rendrr-Mac-AppleSilicon.dmg` and
  `Rendrr-Mac-Intel.dmg` (FFmpeg from martin-riedl.de).
- Windows (`.github/workflows/desktop-windows.yml`): a Release `win-v0.1.<build>` with `Rendrr-Windows-x64.exe` (most
  PCs) and `Rendrr-Windows-Arm.exe` (Windows on Arm), one-click per-user installers (FFmpeg from BtbN/FFmpeg-Builds).

Each build checks its FFmpeg, renders with it in the tests, opens the app and checks it loads Rendrr before it
publishes, then puts the installers on Rendrr's download link (app.rendrr.live/download picks the page by computer).

On a Mac you can also run it yourself:

    cd desktop
    npm ci
    npm test
    npm start                 # run without building (RENDRR_URL=http://localhost:3000 for a local web app)
    npm run dist:mac          # dist/Rendrr-<version>-arm64.dmg and -x64.dmg
    npm run dist:win          # on Windows: dist/Rendrr-<version>-x64-setup.exe

The app is signed ad hoc (no Apple Developer account), so the first open needs System Settings > Privacy & Security >
Open Anyway (see RELEASE_NOTES.md). With a Developer ID later: set `mac.identity`, turn on `hardenedRuntime` and notarize.
The Windows installer is not signed either, so SmartScreen asks once (More info > Run anyway); a code signing
certificate later goes in `win.signtoolOptions`.

The icon is `build/icon.png` (1024 px, the lime mark on the dark rounded square).
