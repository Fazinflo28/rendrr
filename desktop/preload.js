// Runs in each Rendrr page before the site's own code. It tells the web app it is inside the desktop app (html.desktop
// moves the top bar clear of the window buttons, on the left on a Mac and on the right on Windows: html.desktop-win;
// styles.css) and lets it open its login page in the browser.
// The page gets no Node or file access.
const { contextBridge, ipcRenderer, webUtils } = require("electron");

const arg = (name) => (process.argv.find((a) => a.startsWith("--" + name + "=")) || "").slice(name.length + 3);
contextBridge.exposeInMainWorld("rendrrDesktop", Object.freeze({
  app: process.platform === "win32" ? "windows" : "mac", platform: process.platform, version: arg("rendrr-version"),
  // This computer's name, so Rendrr can say which Mac or PC your AI's finals go to.
  device: (() => { try { return decodeURIComponent(arg("rendrr-device")); } catch { return ""; } })(),
  // This computer's own id (one account can be open on several computers: Rendrr tells them apart by it).
  deviceId: arg("rendrr-device-id"),
  // Google refuses to sign in inside apps: the login Allow page and Drive consent open in the default browser.
  openInBrowser: (url) => ipcRenderer.send("rendrr:open-browser", String(url)),
  // Footage added here keeps its original on this Mac: the app remembers where the file is (by its video) and reads
  // what it is; finals made on this Mac use it, so it is never uploaded. Only the file the user picked or dropped.
  keepOriginal: (videoId, file) => { let p = ""; try { p = webUtils.getPathForFile(file); } catch { /* not a file from this Mac */ } return p ? ipcRenderer.invoke("rendrr:keep-original", String(videoId), p) : Promise.resolve(null); },
  // Renders on this Mac: what it can make, turning it on or off, making one Rendrr handed it, and hearing when it
  // starts or finishes one. The page never touches the files or FFmpeg itself.
  render: Object.freeze({
    info: () => ipcRenderer.invoke("rendrr:render-info"),
    setEnabled: (on) => ipcRenderer.invoke("rendrr:render-enable", !!on),
    run: (task) => ipcRenderer.invoke("rendrr:render-run", task),
    onState: (cb) => { const f = (_e, info) => cb(info); ipcRenderer.on("rendrr:render-state", f); return () => ipcRenderer.removeListener("rendrr:render-state", f); },
  }),
}));

const mark = () => document.documentElement && document.documentElement.classList.add("desktop", process.platform === "win32" ? "desktop-win" : "desktop-mac");
mark();
document.addEventListener("DOMContentLoaded", mark);
// In full screen the window buttons hide, so the top bar can use the space again.
ipcRenderer.on("rendrr:fullscreen", (_e, on) => document.documentElement && document.documentElement.classList.toggle("desktop-full", !!on));
