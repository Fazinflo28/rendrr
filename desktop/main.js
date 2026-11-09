// Rendrr for Mac. A native window on the Rendrr web app (app.rendrr.live): the editor is the web app itself, so every
// UI change on the site shows up here on the next launch or reload, with no new download.
// The app adds: a Dock icon, Mac menus and shortcuts, files saved straight to Downloads, login through the browser,
// links to other sites in the default browser, an offline page, and full speed while the window is hidden.
const { app, BrowserWindow, Menu, Notification, ipcMain, screen, session, shell } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { START_URL, linkKind, cleanUserAgent, uniquePath, fitBounds, authGrant, browserMayOpen, macName } = require("./links");
const os = require("node:os");
const { execFileSync } = require("node:child_process");
// This Mac's name (System Settings › General › About), sent with the app's ping so Rendrr can say which Mac a final went to.
const deviceName = (() => { let cn = ""; try { cn = execFileSync("scutil", ["--get", "ComputerName"], { timeout: 1500 }).toString(); } catch { /* not macOS */ } return macName(cn, os.hostname()); })();

const DARK = "#0b0c0e";
const SMOKE_OUT = process.env.RENDRR_SMOKE_OUT; // set by the build check on GitHub: load the app, report, quit

app.setName("Rendrr");
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
app.on("open-url", (e, url) => { e.preventDefault(); openAuthLink(url); });
const browserOpened = []; // the build check records instead of opening a browser
ipcMain.on("rendrr:open-browser", (e, url) => {
  // Only Rendrr's own pages may ask, and only for Rendrr or sign-in pages.
  if (linkKind(e.senderFrame?.url || "") !== "app" || !browserMayOpen(url)) return;
  if (SMOKE_OUT) browserOpened.push(url);
  else shell.openExternal(url).catch(() => {});
});

// ---- Windows ----
const boundsFile = () => path.join(app.getPath("userData"), "window.json");
const readBounds = () => { try { return JSON.parse(fs.readFileSync(boundsFile(), "utf8")); } catch { return null; } };
function saveBounds(win) {
  if (win.isDestroyed() || win.isFullScreen()) return;
  try { fs.writeFileSync(boundsFile(), JSON.stringify({ ...win.getNormalBounds(), maximized: win.isMaximized() })); } catch { /* not important */ }
}

const appWindowOptions = (extra = {}) => ({
  width: 1440, height: 900, minWidth: 1024, minHeight: 640,
  title: "Rendrr",
  titleBarStyle: "hiddenInset",
  trafficLightPosition: { x: 18, y: 17 },
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

// ---- Downloads: straight to ~/Downloads, progress on the Dock icon, a bounce on the Downloads stack when done ----
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

// ---- Menus (the Edit menu is what makes Cmd+C / Cmd+V work in text boxes on a Mac) ----
function focused() { return BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0] || null; }
function go(p) {
  const w = focused();
  if (!w) return createWindow(new URL(p, START_URL).toString());
  w.webContents.loadURL(new URL(p, START_URL).toString());
}
function buildMenu() {
  const template = [
    { label: "Rendrr", submenu: [{ role: "about" }, { type: "separator" }, { role: "services" }, { type: "separator" }, { role: "hide" }, { role: "hideOthers" }, { role: "unhide" }, { type: "separator" }, { role: "quit" }] },
    { label: "File", submenu: [
      { label: "New Window", accelerator: "CmdOrCtrl+N", click: () => createWindow() },
      { label: "Open in Browser", click: () => { const w = focused(); if (w) openOutside(w.webContents.getURL()); } },
      { type: "separator" },
      { role: "close" },
    ] },
    { role: "editMenu" },
    { label: "View", submenu: [{ role: "reload" }, { role: "forceReload" }, { role: "toggleDevTools" }, { type: "separator" }, { role: "resetZoom" }, { role: "zoomIn" }, { role: "zoomOut" }, { type: "separator" }, { role: "togglefullscreen" }] },
    { label: "Go", submenu: [
      { label: "Back", accelerator: "CmdOrCtrl+[", click: () => { const h = focused()?.webContents.navigationHistory; if (h?.canGoBack()) h.goBack(); } },
      { label: "Forward", accelerator: "CmdOrCtrl+]", click: () => { const h = focused()?.webContents.navigationHistory; if (h?.canGoForward()) h.goForward(); } },
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

// ---- Build check on GitHub: open the real app, see that it loaded and knows it is in the Mac app, that its login
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

app.on("second-instance", () => { const w = focused(); if (w) { if (w.isMinimized()) w.restore(); w.focus(); } });
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
