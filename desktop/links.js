// Where each link opens in the Mac app. Pure functions, so they are tested without Electron (npm test).
//   app   - Rendrr itself (app.rendrr.live and the API): stays in the app.
//   auth  - Google and Clerk sign-in pages: stay in the app, so the login comes back to it.
//   file  - a file to save (a final, an invoice): saved to Downloads.
//   web   - anything else: opens in the default browser.

const START_URL = process.env.RENDRR_URL || "https://app.rendrr.live";

// Hosts are matched with their subdomains: "rendrr.live" covers app.rendrr.live, api.rendrr.live, clerk.rendrr.live.
const APP_HOSTS = ["rendrr.live", "up.railway.app", "localhost", "127.0.0.1"];
const AUTH_HOSTS = ["accounts.google.com", "accounts.youtube.com", "clerk.accounts.dev", "accounts.dev", "clerk.com", "clerk.dev", "clerkstage.dev"];
const FILE_EXT = /\.(mp4|mov|m4v|webm|mkv|mp3|wav|m4a|aac|flac|zip|srt|vtt|xml|fcpxml|edl|aaf|pdf|cube)$/i;

function parse(url) {
  try { return new URL(url); } catch { return null; }
}

function hostIn(host, list) {
  const h = String(host || "").toLowerCase();
  return list.some((d) => h === d || h.endsWith("." + d));
}

// A signed storage link that asks to be saved (Content-Disposition: attachment), or a media/project file by name.
function isDownload(url) {
  const u = parse(url);
  if (!u || !/^https?:$/.test(u.protocol)) return false;
  const disp = u.searchParams.get("response-content-disposition") || "";
  if (/attachment/i.test(disp)) return true;
  return FILE_EXT.test(decodeURIComponent(u.pathname));
}

function linkKind(url, start = START_URL) {
  const u = parse(url);
  if (!u) return "none";
  if (u.protocol === "mailto:" || u.protocol === "tel:") return "web";
  if (!/^https?:$/.test(u.protocol)) return "none";
  if (isDownload(url)) return "file";
  const s = parse(start);
  if ((s && u.host === s.host) || hostIn(u.hostname, APP_HOSTS)) return "app";
  if (hostIn(u.hostname, AUTH_HOSTS)) return "auth";
  return "web";
}

// Google refuses sign-in inside apps that say "Electron" in their user agent; Rendrr's window is a normal Chrome.
function cleanUserAgent(ua) {
  return String(ua || "")
    .replace(/\sElectron\/\S+/g, "")
    .replace(/\s(rendrr|Rendrr)\/\S+/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

// "final.mp4" -> "final 2.mp4" when the first is taken (like Safari and Finder). `taken` says if a path exists.
function uniquePath(dir, name, taken, sep = "/") {
  const clean = String(name || "download").replace(/[\/\\:]/g, "_").replace(/^\.+/, "") || "download";
  const dot = clean.lastIndexOf(".");
  const base = dot > 0 ? clean.slice(0, dot) : clean;
  const ext = dot > 0 ? clean.slice(dot) : "";
  let p = dir + sep + clean;
  for (let n = 2; taken(p) && n < 1000; n++) p = dir + sep + base + " " + n + ext;
  return p;
}

// Saved window size and place, kept only when it is still on a screen (a monitor may have been unplugged).
function fitBounds(saved, displays) {
  if (!saved || !(saved.width > 0) || !(saved.height > 0)) return null;
  const { x, y, width, height } = saved;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return { width, height };
  const onScreen = displays.some(({ x: dx, y: dy, width: dw, height: dh }) => x + 80 <= dx + dw && x + width - 80 >= dx && y >= dy - 10 && y + 40 <= dy + dh);
  return onScreen ? { x, y, width, height } : { width, height };
}

// The browser hands a login back with rendrr://auth?grant=<32 characters> (web app /desktop-login). Anything else: null.
function authGrant(url) {
  const u = parse(url);
  if (!u || u.protocol !== "rendrr:" || u.hostname !== "auth") return null;
  const g = u.searchParams.get("grant") || "";
  return /^[A-Za-z0-9_-]{32}$/.test(g) ? g : null;
}

// What the web app may open in the default browser: Rendrr pages (the login Allow page) and sign-in pages (Drive).
const browserMayOpen = (url) => ["app", "auth"].includes(linkKind(url));

/** This Mac's name for Rendrr to show ("Finals go to Ronnii's MacBook Pro"): its Computer Name, else the host name. */
function macName(computerName, hostname) {
  const pick = String(computerName || "").trim() || String(hostname || "").replace(/\.local$/i, "").replace(/[-_]+/g, " ").trim();
  return pick.replace(/[\u0000-\u001f]/g, "").slice(0, 40);
}

// Kept awake while the app is open (Mac): a Mac that dozed off while the app sat open stopped hearing from Rendrr, so
// every render asked for then went to Rendrr's cloud. While rendering here is on and this Mac's FFmpeg can make
// renders, the app holds one "prevent-app-suspension" blocker (the screen can still turn off; closing the lid still
// sleeps the Mac); it lets go when rendering is turned off or the app quits.
const shouldKeepAwake = (r) => !!(r && r.enabled && r.ready);
/** One blocker at most, started and stopped as sync(want) says. blocker: Electron's powerSaveBlocker. */
function awakeKeeper(blocker) {
  let id = null;
  const held = () => id != null && blocker.isStarted(id);
  return {
    held,
    sync(want) {
      if (want && !held()) { try { id = blocker.start("prevent-app-suspension"); } catch { id = null; /* not on this system */ } }
      else if (!want && id != null) { try { if (blocker.isStarted(id)) blocker.stop(id); } catch { /* already gone */ } id = null; }
      return held();
    },
  };
}

module.exports = { START_URL, APP_HOSTS, AUTH_HOSTS, isDownload, linkKind, cleanUserAgent, uniquePath, fitBounds, authGrant, browserMayOpen, macName, shouldKeepAwake, awakeKeeper };
