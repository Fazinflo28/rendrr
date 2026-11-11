// Rendrr for Mac and Windows. A native window on the Rendrr web app (app.rendrr.live): the editor is the web app
// itself, so every UI change on the site shows up here on the next launch or reload, with no new download.
// The app adds: a Dock or taskbar icon, menus and shortcuts, files saved straight to Downloads, login through the
// browser, links to other sites in the default browser, an offline page, full speed while the window is hidden, and
// renders made on this computer (render.js: Rendrr hands the app each render's encode while it is open; its own FFmpeg
// makes it).
const { app, BrowserWindow, Menu, Notification, ipcMain, screen, session, shell } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { START_URL, linkKind, cleanUserAgent, uniquePath, fitBounds, authGrant, browserMayOpen, macName } = require("./links");
const os = require("node:os");
const { execFileSync } = require("node:child_process");
const render = require("./render");
const IS_WIN = process.platform === "win32";
// "Mac" or "PC", for what the app says ("Made on this PC").
const MACHINE = IS_WIN ? "PC" : "Mac";
// This computer's name (a Mac's System Settings › General › About; a PC's name), sent with the app's ping so Rendrr can
// say which computer a final went to.
const deviceName = (() => {
  let cn = "";
  if (IS_WIN) cn = process.env.COMPUTERNAME || "";
  else try { cn = execFileSync("scutil", ["--get", "ComputerName"], { timeout: 1500 }).toString(); } catch { /* not macOS */ }
  return macName(cn, os.hostname());
})();

const DARK = "#0b0c0e";
const SMOKE_OUT = process.env.RENDRR_SMOKE_OUT; // set by the build check on GitHub: load the app, report, quit

app.setName("Rendrr");
// Windows: notifications and the taskbar know the app by the id its installer gave its shortcut (electron-builder's appId).
if (IS_WIN) app.setAppUserModelId("live.rendrr.mac");
// Google refuses to sign in apps whose user agent says "Electron"; to Google this is plain Chrome.
app.userAgentFallback = cleanUserAgent(app.userAgentFallback);

if (!SMOKE_OUT && !app.requestSingleInstanceLock()) app.quit();

// ---- Log in through the browser: the Allow page hands the login back with rendrr://auth?grant=… ----
app.setAsDefaultProtocolClient("rendrr");
let pendingLink = null; // a link that opened the app before it was ready
function openAuthLink(url) {
  const grant = authGrant(url);
  if (!grant) return;
  const target = new URL("/desktop-login?grant=" + encodeURIComponent(grant), START_URL).toString();
  if (!app.isReady()) { pendingLink = target; return; }
  const w = BrowserWindow.getAllWindows().find((x) => !x.isDestroyed() && linkKind(x.webContents.getURL()) !== "auth");
  if (!w) { createWindow(target); return; }
  if (w.isMinimized()) w.restore();
  w.webContents.loadURL(target);
  w.show(); w.focus(); app.focus({ steal: true });
}
// A Mac hands the link to the open app; Windows starts the app again with the link as an argument (second-instance
// below), or starts it with the link when it was closed.
app.on("open-url", (e, url) => { e.preventDefault(); openAuthLink(url); });
const linkIn = (argv) => (argv || []).find((a) => typeof a === "string" && /^rendrr:\/\//i.test(a)) || null;
if (IS_WIN && linkIn(process.argv)) openAuthLink(linkIn(process.argv));
const browserOpened = []; // the build check records instead of opening a browser
ipcMain.on("rendrr:open-browser", (e, url) => {
  // Only Rendrr's own pages may ask, and only for Rendrr or sign-in pages.
  if (linkKind(e.senderFrame?.url || "") !== "app" || !browserMayOpen(url)) return;
  if (SMOKE_OUT) browserOpened.push(url);
  else shell.openExternal(url).catch(() => {});
});

// ---- Renders on this computer (render.js) ----
// The app's own FFmpeg (in its Resources; RENDRR_FFMPEG or the one on the PATH when run from source), checked at start:
// its version and features go with the web app's ping, so Rendrr only hands this computer renders it can make.
const ffmpegPath = () => process.env.RENDRR_FFMPEG || (app.isPackaged ? path.join(process.resourcesPath, "ffmpeg", IS_WIN ? "ffmpeg.exe" : "ffmpeg") : "ffmpeg");
// Footage this computer fetched, kept for the next render (up to 20 GB): ~/Library/Caches/Rendrr on a Mac, the local
// (not roaming) app data on Windows.
const cacheDir = () => {
  if (IS_WIN) return path.join(process.env.LOCALAPPDATA || app.getPath("userData"), "Rendrr", "Cache");
  try { return path.join(app.getPath("cache"), "Rendrr"); } catch { return path.join(app.getPath("userData"), "Cache"); }
};
const renderFile = () => path.join(app.getPath("userData"), "render.json");
const renders = { ready: false, busy: false, version: null, have: [], why: `Checking this ${MACHINE}'s FFmpeg`, enabled: true, current: null };
try { renders.enabled = JSON.parse(fs.readFileSync(renderFile(), "utf8")).enabled !== false; } catch { /* first run: on */ }
const renderInfo = () => ({ protocol: render.PROTOCOL, ready: renders.ready, enabled: renders.enabled, busy: renders.busy, cpus: os.availableParallelism ? os.availableParallelism() : os.cpus().length, have: renders.have, ffmpeg: renders.version, why: renders.why, label: renders.current });
// Every Rendrr window hears when this Mac starts or finishes a render (it tells Rendrr straight away).
const tellWindows = () => { for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send("rendrr:render-state", renderInfo()); };
async function checkFfmpeg() {
  const p = await render.probeFfmpeg(ffmpegPath());
  Object.assign(renders, { ready: p.ok && p.have.includes("libx264"), version: p.version, have: p.have, why: p.ok ? (p.have.includes("libx264") ? null : `this ${MACHINE}'s FFmpeg cannot make H.264`) : p.why });
  tellWindows();
}
const fromApp = (e) => linkKind(e.senderFrame?.url || "") === "app";
ipcMain.handle("rendrr:render-info", (e) => (fromApp(e) ? renderInfo() : null));
ipcMain.handle("rendrr:render-enable", (e, on) => {
  if (!fromApp(e)) return null;
  renders.enabled = !!on;
  try { fs.writeFileSync(renderFile(), JSON.stringify({ enabled: renders.enabled })); } catch { /* kept for this run */ }
  tellWindows();
  return renderInfo();
});
// Originals kept on this computer: footage added in the app stays here (never uploaded); Rendrr knows it by its video and
// size, and a final made here reads the file where it is. Kept in originals.json; one that moved or changed is not used.
const originalsFile = () => path.join(app.getPath("userData"), "originals.json");
let originals = {};
try { originals = JSON.parse(fs.readFileSync(originalsFile(), "utf8")) || {}; } catch { /* none yet */ }
const saveOriginals = () => { try { fs.writeFileSync(originalsFile(), JSON.stringify(originals)); } catch { /* kept for this run */ } };
ipcMain.handle("rendrr:keep-original", async (e, videoId, file) => {
  if (!fromApp(e) || !/^[A-Za-z0-9_-]{1,64}$/.test(String(videoId)) || typeof file !== "string" || !path.isAbsolute(file)) return null;
  const st = await fs.promises.stat(file).catch(() => null);
  if (!st || !st.isFile()) return null;
  const info = await render.probeFile(ffmpegPath(), file);
  if (!info) return null;
  originals[videoId] = { path: file, size: st.size, mtimeMs: st.mtimeMs, name: path.basename(file) };
  saveOriginals();
  return { size: st.size, name: path.basename(file), ...info };
});
const localFile = async (videoId, size) => {
  const o = originals[videoId];
  if (!o) return null;
  const st = await fs.promises.stat(o.path).catch(() => null);
  return st && st.isFile() && st.size === o.size && st.size === size ? o.path : null;
};

// A render Rendrr handed this computer (the web app took it for this user): made in the background, one at a time.
ipcMain.handle("rendrr:render-run", (e, task) => {
  if (!fromApp(e) || !renders.ready || !renders.enabled || renders.busy) return { started: false };
  try { render.checkTask(task); } catch (err) { return { started: false, error: String(err.message || err) }; }
  renders.busy = true; renders.current = String(task.label || "A render").slice(0, 120);
  tellWindows();
  const progress = (st) => {
    const v = st.phase === "download" ? 0.1 * (st.frac || 0) : st.phase === "render" ? 0.1 + 0.85 * (st.frac || 0) : 0.95 + 0.05 * (st.frac || 0);
    for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.setProgressBar(Math.max(0, Math.min(1, v)));
  };
  render.runTask(task, { ffmpeg: ffmpegPath(), cacheDir: cacheDir(), workDir: os.tmpdir(), saveDir: app.getPath("downloads"), onState: progress, localFile })
    .then((r) => {
      if (r.ok && r.savedPath) {
        if (app.dock) app.dock.downloadFinished(r.savedPath);
        notify(`Made on this ${MACHINE}`, `${path.basename(r.savedPath)} is in Downloads`, () => shell.showItemInFolder(r.savedPath));
      } else if (!r.ok && !r.stopped) notify("Made on Rendrr's cloud instead", `This ${MACHINE} could not make it, so Rendrr's cloud server is making it.`);
    })
    .catch(() => { /* runTask reports its own failures */ })
    .finally(() => {
      renders.busy = false; renders.current = null;
      for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.setProgressBar(-1);
      tellWindows();
    });
  return { started: true };
});

// ---- Windows ----
const boundsFile = () => path.join(app.getPath("userData"), "window.json");
const readBounds = () => { try { return JSON.parse(fs.readFileSync(boundsFile(), "utf8")); } catch { return null; } };
function saveBounds(win) {
  if (win.isDestroyed() || win.isFullScreen()) return;
  try { fs.writeFileSync(boundsFile(), JSON.stringify({ ...win.getNormalBounds(), maximized: win.isMaximized() })); } catch { /* not important */ }
}

// No title bar: on a Mac the three window buttons sit in the top-left of Rendrr's top bar; on Windows the minimise,
// maximise and close buttons sit over its top-right (the web app leaves room for either: html.desktop-win).
const titleBar = IS_WIN
  ? { titleBarStyle: "hidden", titleBarOverlay: { color: "#131517", symbolColor: "#f7f7f8", height: 47 }, autoHideMenuBar: true }
  : { titleBarStyle: "hiddenInset", trafficLightPosition: { x: 18, y: 17 } };
const appWindowOptions = (extra = {}) => ({
  width: 1440, height: 900, minWidth: 1024, minHeight: 640,
  title: "Rendrr",
  ...titleBar,
  backgroundColor: DARK,
  webPreferences: {
    preload: path.join(__dirname, "preload.js"),
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
    spellcheck: true,
    // Uploads and the browser-side proxy keep going at full speed while the window is hidden or minimised.
    backgroundThrottling: false,
    additionalArguments: ["--rendrr-version=" + app.getVersion(), "--rendrr-device=" + encodeURIComponent(deviceName)],
  },
  ...extra,
});

// Google and Drive sign-in popups: a small plain window that closes itself when done.
const popupOptions = (parent) => ({
  width: 520, height: 680, parent, modal: false, title: "Sign in", backgroundColor: "#ffffff",
  webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
});

function createWindow(url = START_URL) {
  const saved = readBounds();
  const place = fitBounds(saved, screen.getAllDisplays().map((d) => d.workArea));
  const win = new BrowserWindow(appWindowOptions({ ...(place || {}), show: false }));
  if (saved?.maximized) win.maximize();
  win.once("ready-to-show", () => win.show());
  win.on("close", () => saveBounds(win));
  watchAppWindow(win);
  win.loadURL(url);
  return win;
}

function watchAppWindow(win) {
  const wc = win.webContents;
  // The web app moves its top bar out of the way of the window buttons, except in full screen where they hide.
  const sendFull = () => !wc.isDestroyed() && wc.send("rendrr:fullscreen", win.isFullScreen());
  win.on("enter-full-screen", sendFull);
  win.on("leave-full-screen", sendFull);
  wc.on("did-finish-load", sendFull);
  // No internet, or the site is down: a calm page that tries again by itself.
  wc.on("did-fail-load", (_e, code, desc, url, isMainFrame) => {
    if (!isMainFrame || code === -3 || linkKind(url) !== "app") return; // -3: a newer navigation replaced it
    wc.loadFile(path.join(__dirname, "offline.html"), { query: { u: url, why: desc || "" } });
  });
}

const openOutside = (url) => { if (/^(https?|mailto|tel):/i.test(url)) shell.openExternal(url); };

// Every page in the app (windows, popups) follows the same link rules (links.js).
app.on("web-contents-created", (_e, wc) => {
  wc.setWindowOpenHandler(({ url, frameName }) => {
    const kind = linkKind(url);
    if (kind === "file") { wc.downloadURL(url); return { action: "deny" }; }
    const parent = BrowserWindow.fromWebContents(wc);
    if (kind === "auth" || frameName === "rendrr-drive") return { action: "allow", overrideBrowserWindowOptions: popupOptions(parent) };
    if (kind === "app") return { action: "allow", overrideBrowserWindowOptions: appWindowOptions() };
    if (kind === "web") openOutside(url);
    return { action: "deny" };
  });
  wc.on("did-create-window", (child, d) => { if (linkKind(d.url) === "app" && d.frameName !== "rendrr-drive") watchAppWindow(child); });
  wc.on("will-navigate", (e, url) => {
    const to = linkKind(url);
    if (to === "file") { e.preventDefault(); wc.downloadURL(url); return; }
    // Sign-in can pass through other sites (a company's own login page), so only a link clicked inside Rendrr
    // itself leaves the app for the browser.
    if (to === "web" && linkKind(wc.getURL()) === "app") { e.preventDefault(); openOutside(url); }
  });
  wc.on("context-menu", (_e, p) => {
    const items = [];
    if (p.isEditable) {
      for (const s of (p.dictionarySuggestions || []).slice(0, 4)) items.push({ label: s, click: () => wc.replaceMisspelling(s) });
      if (items.length) items.push({ type: "separator" });
      items.push({ role: "undo" }, { role: "redo" }, { type: "separator" }, { role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "selectAll" });
    } else if (p.selectionText && p.selectionText.trim()) items.push({ role: "copy" });
    if (p.linkURL && /^https?:/.test(p.linkURL)) {
      if (items.length) items.push({ type: "separator" });
      items.push({ label: "Open Link in Browser", click: () => openOutside(p.linkURL) }, { label: "Copy Link", click: () => require("electron").clipboard.writeText(p.linkURL) });
    }
    if (p.mediaType === "image" && p.srcURL && /^https?:/.test(p.srcURL)) {
      if (items.length) items.push({ type: "separator" });
      items.push({ label: "Copy Image", click: () => wc.copyImageAt(p.x, p.y) }, { label: "Save Image to Downloads", click: () => wc.downloadURL(p.srcURL) });
    }
    if (items.length) Menu.buildFromTemplate(items).popup({ window: BrowserWindow.fromWebContents(wc) || undefined });
  });
});

// ---- Downloads: straight to Downloads, progress on the Dock or taskbar icon, a bounce on the Downloads stack when done ----
const downloads = new Set();
function showProgress() {
  let got = 0, total = 0;
  for (const d of downloads) { got += d.getReceivedBytes(); total += d.getTotalBytes(); }
  const value = downloads.size ? (total > 0 ? got / total : 2) : -1; // 2 = still starting (no size yet)
  for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.setProgressBar(value);
}
function notify(title, body, onClick) {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title, body, silent: true });
  if (onClick) n.on("click", onClick);
  n.show();
}
function watchDownloads(ses) {
  ses.on("will-download", (_e, item) => {
    const target = uniquePath(app.getPath("downloads"), item.getFilename(), fs.existsSync, path.sep);
    item.setSavePath(target);
    downloads.add(item);
    item.on("updated", showProgress);
    item.once("done", (_d, state) => {
      downloads.delete(item);
      showProgress();
      if (state === "completed") {
        if (app.dock) app.dock.downloadFinished(target);
        notify("Saved to Downloads", path.basename(target), () => shell.showItemInFolder(target));
      } else if (state === "interrupted") notify("Download stopped", path.basename(target) + " did not finish. Try again.");
    });
  });
}

// Rendrr and sign-in pages may use the clipboard, notifications, full screen and files you pick; other sites may not.
function allowFor(url) { const k = linkKind(url || ""); return k === "app" || k === "auth"; }

// ---- Menus (the Edit menu is what makes Cmd+C / Cmd+V work in text boxes on a Mac; on Windows the menu bar is hidden
// and its shortcuts still work) ----
function focused() { return BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0] || null; }
function go(p) {
  const w = focused();
  if (!w) return createWindow(new URL(p, START_URL).toString());
  w.webContents.loadURL(new URL(p, START_URL).toString());
}
function buildMenu() {
  const template = [
    ...(IS_WIN ? [] : [{ label: "Rendrr", submenu: [{ role: "about" }, { type: "separator" }, { role: "services" }, { type: "separator" }, { role: "hide" }, { role: "hideOthers" }, { role: "unhide" }, { type: "separator" }, { role: "quit" }] }]),
    { label: "File", submenu: [
      { label: "New Window", accelerator: "CmdOrCtrl+N", click: () => createWindow() },
      { label: "Open in Browser", click: () => { const w = focused(); if (w) openOutside(w.webContents.getURL()); } },
      { type: "separator" },
      { role: "close" },
      ...(IS_WIN ? [{ type: "separator" }, { role: "about" }, { role: "quit" }] : []),
    ] },
    { role: "editMenu" },
    { label: "View", submenu: [{ role: "reload" }, { role: "forceReload" }, { role: "toggleDevTools" }, { type: "separator" }, { role: "resetZoom" }, { role: "zoomIn" }, { role: "zoomOut" }, { type: "separator" }, { role: "togglefullscreen" }] },
    { label: "Go", submenu: [
      { label: "Back", accelerator: IS_WIN ? "Alt+Left" : "CmdOrCtrl+[", click: () => { const h = focused()?.webContents.navigationHistory; if (h?.canGoBack()) h.goBack(); } },
      { label: "Forward", accelerator: IS_WIN ? "Alt+Right" : "CmdOrCtrl+]", click: () => { const h = focused()?.webContents.navigationHistory; if (h?.canGoForward()) h.goForward(); } },
      { type: "separator" },
      { label: "Projects", accelerator: "CmdOrCtrl+1", click: () => go("/projects") },
      { label: "Library", accelerator: "CmdOrCtrl+2", click: () => go("/library") },
      { label: "Settings", accelerator: "CmdOrCtrl+,", click: () => go("/settings") },
    ] },
    { role: "windowMenu" },
    { role: "help", submenu: [{ label: "Rendrr Website", click: () => openOutside("https://rendrr.live") }] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---- Build check on GitHub: open the real app, see that it loaded and knows it is in the desktop app, that its login
// offers the browser (not Google), then quit ----
function smokeTest(win) {
  const finish = (result) => { try { fs.writeFileSync(SMOKE_OUT, JSON.stringify(result, null, 2)); } catch { /* ignore */ } app.exit(result.ok ? 0 : 1); };
  const timer = setTimeout(() => finish({ ok: false, error: "timed out loading " + START_URL }), 120000);
  const js = (code) => win.webContents.executeJavaScript(code);
  win.webContents.once("did-finish-load", () => setTimeout(async () => {
    try {
      // Only plain values come back (the bridge's openInBrowser is a function, which cannot be copied out).
      const page = await js(`({ url: location.href, title: document.title,
        desktopClass: document.documentElement.classList.contains("desktop"),
        bridge: window.rendrrDesktop ? { app: rendrrDesktop.app, version: rendrrDesktop.version, openInBrowser: typeof rendrrDesktop.openInBrowser } : null,
        ua: navigator.userAgent, icon: !!document.querySelector('link[rel~="icon"]') })`);
      await win.webContents.loadURL(new URL("/login", START_URL).toString());
      let login = null;
      for (let i = 0; i < 30 && !login?.browserButton; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        login = await js(`({ browserButton: !!document.querySelector("#browser-login"), google: !!document.querySelector("#google") })`);
      }
      // Click "Log in with your browser": the app must be asked to open the Allow page in the browser.
      await js(`document.querySelector("#browser-login")?.click()`);
      for (let i = 0; i < 10 && !browserOpened.length; i++) await new Promise((r) => setTimeout(r, 500));
      clearTimeout(timer);
      const opens = /^https:\/\/[^/]+\/desktop-login\?c=[A-Za-z0-9_-]{43}$/.test(browserOpened[0] || "");
      const ok = linkKind(page.url) === "app" && page.desktopClass && page.bridge?.openInBrowser === "function" && !/Electron/.test(page.ua) && login?.browserButton && !login?.google && opens;
      finish({ ok, version: app.getVersion(), ...page, login, browserOpened, protocol: app.isDefaultProtocolClient("rendrr") });
    } catch (e) { clearTimeout(timer); finish({ ok: false, error: String(e) }); }
  }, 4000));
}

app.whenReady().then(() => {
  checkFfmpeg().catch(() => { renders.why = "FFmpeg could not be checked"; });
  app.setAboutPanelOptions({ applicationName: "Rendrr", applicationVersion: app.getVersion(), copyright: "Edit videos with Claude." });
  buildMenu();
  watchDownloads(session.defaultSession);
  session.defaultSession.setPermissionRequestHandler((wc, _perm, done, details) => done(allowFor(details.requestingUrl || wc.getURL())));
  session.defaultSession.setPermissionCheckHandler((wc, _perm, origin) => allowFor(origin || wc?.getURL()));
  const win = createWindow(pendingLink || START_URL);
  pendingLink = null;
  if (SMOKE_OUT) smokeTest(win);
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on("second-instance", (_e, argv) => {
  if (linkIn(argv)) { openAuthLink(linkIn(argv)); return; } // Windows: the browser handing a login back
  const w = focused(); if (w) { if (w.isMinimized()) w.restore(); w.focus(); }
});
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
