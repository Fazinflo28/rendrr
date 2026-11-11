// Demo api: the design's own in-browser fake backend (from ui/rendrr-ui-v2.html), plus the few functions the
// wired-up app calls that the design file did not have. Nothing leaves the browser.
import { api } from "rendrr-fake-api";
import { breakdownAsText, buildBreakdown } from "../../../packages/shared/src/breakdown.ts";
import { notOriginalMessage, sameOriginal } from "../../../packages/shared/src/original.ts";
import { aiName, handoffPrompt, handoffUrl } from "../../../packages/shared/src/aiHandoff.ts";
import { desktopApp, forgetVerifier, newChallenge, s256, savedVerifier } from "../src/rendrr/desktopLogin.ts";
import { demoBillingApi } from "./billingDemo.js";
import { demoAssetsApi } from "./assetsDemo.js";

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const waitingEdits = new Set(); // Recreate's edits still waiting for their footage
const playable = {}; // videoId -> blob URL of the file picked in this tab, so the editor can play it

const getProject = api.getProject, createProject = api.createProject;
const getVideo = api.getVideo, listVideos = api.listVideos, addFromDrive = api.addFromDrive, addFromComputer = api.addFromComputer;
const kinds = {}; // videoId -> "footage" | "reference" (the design's fake backend has no references)
const inFolder = {}; // videoId -> library folder id (the design's fake backend has no library folders)
const libFolders = []; // { id, name, updated }
// A test can start the Library with a folder ("Shoot day": Founder story take 3 and Office tour).
const seedFolders = () => { if (globalThis.__demoLibSeed && !libFolders.some((f) => f.id === "fd-seed")) { libFolders.push({ id: "fd-seed", name: "Shoot day", parentId: null, updated: Date.now() }); inFolder.v3 = "fd-seed"; inFolder.v5 = "fd-seed"; } };
const withKind = (v) => (v ? (seedFolders(), { ...v, kind: kinds[v.id] || "footage", libraryFolderId: inFolder[v.id] || null }) : v);
const libFolderIn = (name, parentId) => {
  const same = libFolders.find((x) => (x.parentId || null) === (parentId || null) && x.name.toLowerCase() === name.toLowerCase());
  if (same) return same;
  const nf = { id: "lf" + Math.random().toString(36).slice(2, 8), name, parentId: parentId || null, updated: Date.now() }; libFolders.push(nf); return nf;
};
const folderErr = (msg) => Object.assign(new Error(msg), { code: "invalid-input" });

// "What Claude sees" for demo footage: drawn contact sheets and a breakdown made by the real shared code.
const COLOURS = ["#3b3f52", "#5a4648", "#2f4a44", "#4b3f5c", "#53483a", "#334455"];
function sheetImage(times, shotOf) {
  const c = document.createElement("canvas"); c.width = 1292; c.height = 732;
  const g = c.getContext("2d"); g.fillStyle = "#181818"; g.fillRect(0, 0, c.width, c.height);
  times.forEach((t, i) => {
    const x = (i % 4) * 324, y = Math.floor(i / 4) * 184;
    g.fillStyle = COLOURS[shotOf(t) % COLOURS.length]; g.fillRect(x, y, 320, 180);
    g.fillStyle = "rgba(255,220,200,.85)"; g.beginPath(); g.arc(x + 160, y + 70, 24, 0, 7); g.fill(); g.fillRect(x + 118, y + 104, 84, 76);
    g.fillStyle = "#000"; g.fillRect(x, y, 58, 22); g.fillStyle = "#fff"; g.font = "13px sans-serif";
    g.fillText(Math.floor(t / 60) + ":" + (t % 60).toFixed(1).padStart(4, "0"), x + 6, y + 15);
  });
  return c.toDataURL("image/jpeg", 0.8);
}
function demoBreakdown(v) {
  const seconds = Math.max(5, v.seconds || 30), cuts = v.sceneCuts.filter((t) => t < seconds - 0.5);
  const shotOf = (t) => cuts.filter((c) => c <= t).length;
  const step = [0.5, 1, 2, 3].find((x) => seconds / x <= 64) || 5; // same spacing as the real analyzer
  const times = Array.from({ length: Math.min(400, Math.floor(seconds / step)) }, (_, i) => i * step);
  const sheets = []; for (let i = 0; i < times.length; i += 16) sheets.push({ file: "s" + i, times: times.slice(i, i + 16), cols: 4, rows: Math.ceil(times.slice(i, i + 16).length / 4), tile: [320, 180] });
  const measured = { interval: step, size: [1280, 720], samples: times.map((t) => ({ t, shot: shotOf(t), b: 0.32, s: 0.2, m: 0.004, c: [COLOURS[shotOf(t) % COLOURS.length], "#a89fac"] })), sheets, loudness: times.map((t) => -15 - (t % 4)), tempo: null };
  const b = buildBreakdown({ video: { id: v.id, name: v.name, kind: kinds[v.id] || "footage", seconds, width: 1280, height: 720, orientation: v.orientation || "Landscape", fps: 30, hasAudio: true }, transcript: v.transcript || [], silences: [], sceneCuts: cuts, measured, sheetKeys: sheets.map((s) => s.file) });
  return { pacing: b.pacing, hook: b.hook, shots: b.shots, beat: null, musicLikely: false, frames: { interval: step, count: times.length },
    sheets: b.frames.sheets.map((s) => ({ ...s, url: sheetImage(s.times, shotOf) })), text: breakdownAsText(b) };
}
const getReview = api.getReview;
const renderFinal0 = api.renderFinal;
const hasLocalFile0 = api.hasLocalFile;
const uploadOriginal0 = api.uploadOriginalForExport;
const listDriveFiles = api.listDriveFiles;
// The design's fake Drive is flat; the demo nests it (folders in folders, Shared with me, a shared drive) like a real one.
const DEMO_TREE = { root: ["fd1", "fd2", "fd3"], fd2: ["fdB"], fdB: ["fdC"], shared: ["fdS"] };
const DEMO_FOLDERS = { fd1: "Podcast raw", fd2: "Client footage", fd3: "B-roll", fdB: "BFS Health", fdC: "Shoot day 2", fdS: "From Sam" };
const DEMO_FILES = { root: ["df7"], fd1: ["df1"], fdB: ["df3", "df8"], fdC: ["df4", "df6"], fd3: ["df5"], fdS: ["df2"] };
// Samples: the preview has no renderer, so each sample is a picture saying what it shows (a frame or a clip).
const demoSamples = {};
const clockT = (x) => { const d = Math.round(Math.max(0, x) * 10); return Math.floor(d / 600) + ":" + String(Math.floor((d % 600) / 10)).padStart(2, "0") + "." + (d % 10); };
const sampleStill = (label, k) => "data:image/svg+xml," + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="960" height="540"><defs><linearGradient id="g" x1="0" x2="1"><stop offset="0" stop-color="${["#2b3a55", "#3c2f4f", "#24463b", "#4a3a26"][k % 4]}"/><stop offset="1" stop-color="#111"/></linearGradient></defs><rect width="960" height="540" fill="url(#g)"/><text x="480" y="290" fill="#fff" font-family="Inter, sans-serif" font-size="56" text-anchor="middle">${label}</text></svg>`);
const logout = api.logout;
let demoRun = null; // the final being made (demo), so Stop export can end it
let signedIn = false;
const track = (fn) => async (...a) => { const r = await fn(...a); signedIn = true; return r; };

// Mac app login through the browser. The fake server's grants live in localStorage, so the "browser" tab and the
// "app" tab of a test share them, like the real API's Redis.
const demoGrants = () => { try { return JSON.parse(localStorage.getItem("demo:desktop-grants") || "{}"); } catch { return {}; } };
const keepGrants = (g) => localStorage.setItem("demo:desktop-grants", JSON.stringify(g));
const friendly = (msg) => Object.assign(new Error(msg), { friendly: true });
globalThis.__desktopLogin = { s256, approve: (c) => api.approveDesktopLogin(c) };

Object.assign(api, {
  desktopApp,
  startBrowserLogin: async () => {
    const d = desktopApp();
    if (!d?.openInBrowser) throw Object.assign(friendly("Download the latest Rendrr app to log in with your browser, or log in with email."), { code: "desktop-old" });
    const challenge = await newChallenge();
    const link = window.location.origin + "/desktop-login?c=" + challenge;
    d.openInBrowser(link);
    return { challenge, link };
  },
  approveDesktopLogin: async (challenge) => {
    await wait(150);
    if (!signedIn) throw friendly("Log in to Rendrr in your browser first.");
    const grant = Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"[b % 64]).join("");
    keepGrants({ ...demoGrants(), [grant]: challenge });
    return { grant, expiresInMinutes: 5 };
  },
  finishDesktopLogin: async (grant) => {
    await wait(150);
    const v = savedVerifier();
    if (!v) throw friendly("This login was started too long ago or in another app. Click 'Log in with your browser' again.");
    const g = demoGrants(); const c = g[grant]; delete g[grant]; keepGrants(g);
    if (!c || (await s256(v)) !== c) throw friendly("This login has expired or was already used. Start again from the Rendrr app.");
    forgetVerifier();
    return track(api.login)("you@example.com", "x");
  },
  login: track(api.login), signup: track(api.signup), loginWithGoogle: track(api.loginWithGoogle),
  logout: async () => { signedIn = false; return logout(); },
  hasSession: async () => signedIn,
  completeReset: async (code, password) => {
    await wait(500);
    if (!code) throw Object.assign(new Error("Enter the code from the email."), { friendly: true });
    return track(api.login)("you@example.com", password);
  },
  completeDrive: async () => ({ connected: true }),
  listDriveFiles: async (folderId = "root", o = {}) => {
    const all = (await Promise.all(["root", "fd1", "fd2", "fd3"].map((f) => listDriveFiles(f)))).flatMap((r) => r.files);
    const byId = Object.fromEntries(all.map((f) => [f.id, f]));
    const fold = (id) => ({ id, name: DEMO_FOLDERS[id], date: Date.now() - 86400_000 * 3 });
    const file = (id) => ({ ...byId[id], folderId: Object.keys(DEMO_FILES).find((k) => DEMO_FILES[k].includes(id)) });
    const view = o.view || "folder", q = (o.q || "").toLowerCase();
    let folders = [], files = [];
    if (view === "search") { folders = q ? Object.keys(DEMO_FOLDERS).filter((id) => DEMO_FOLDERS[id].toLowerCase().includes(q)).map(fold) : []; files = q ? all.filter((f) => f.name.toLowerCase().includes(q)).map((f) => file(f.id)) : []; }
    else if (view === "recent") files = [...all].sort((a, b) => b.date - a.date).map((f) => file(f.id));
    else { const k = view === "shared" ? "shared" : folderId; folders = (DEMO_TREE[k] || []).map(fold); files = (DEMO_FILES[k] || []).filter((id) => byId[id]).map(file); }
    return { folders, files, truncated: false, ...(o.drives ? { drives: [{ id: "sd1", name: "Team edits" }] } : {}) };
  },
  captureDrop: () => {},
  restoreAsset: async () => ({ ok: true }),
  restoreVersion: async () => { await wait(400); return { ok: true }; },
  renderSamples: async (projectId, ask, onProgress) => {
    const steps = ["Reading timeline", "Measuring loudness", "Rendering samples", "Packing samples"];
    for (let i = 0; i < steps.length; i++) { onProgress?.({ step: i, steps, percent: Math.round((i / steps.length) * 100) }); await wait(250); }
    const items = [...(ask.frames || []).map((f) => ({ kind: "frame", at: f.at, end: null, note: f.note || null })), ...(ask.clips || []).map((c) => ({ kind: "clip", at: c.start, end: c.end ?? c.start + 4, note: c.note || null }))].sort((a, b) => a.at - b.at)
      .map((x, k) => ({ ...x, still: sampleStill(x.kind === "frame" ? "Frame " + clockT(x.at) : "Clip " + clockT(x.at) + "-" + clockT(x.end), k), clip: null }));
    const set = { renderId: "rs_" + Math.random().toString(36).slice(2, 8), project: { id: projectId, name: "", aspect: "16:9", version: 1, editorUrl: null }, version: 1, status: "done", percent: 100, step: null, etaSec: null, error: null, width: 960, height: 540, items, comments: [] };
    (demoSamples[projectId] ||= []).unshift(set);
    onProgress?.({ step: steps.length, steps, percent: 100 });
    return set;
  },
  listSamples: async (projectId) => (demoSamples[projectId] || []).slice(0, 4),
  // The Export window's choice for this export (Best quality) is kept where the page's checks can read it.
  // Each final has an id in its progress (the export window's Stop button uses it); stopRender ends it as "stopped".
  renderFinal: async (projectId, onProgress, opts) => {
    globalThis.__lastRenderOpts = opts || {};
    const id = "rd" + Math.random().toString(36).slice(2, 8);
    return new Promise((resolve, reject) => {
      demoRun = { id, reject };
      renderFinal0(projectId, (p) => { if (demoRun?.id === id) onProgress?.({ ...p, renderId: id }); })
        .then((r) => { if (demoRun?.id === id) { demoRun = null; resolve(r); } }, (e) => { if (demoRun?.id === id) { demoRun = null; reject(e); } });
    });
  },
  stopRender: async (renderId) => {
    await wait(200);
    if (demoRun?.id === renderId) { const r = demoRun; demoRun = null; r.reject(Object.assign(new Error("You stopped this export."), { friendly: true, code: "stopped" })); }
    globalThis.__stopped = (globalThis.__stopped || 0) + 1;
    return { stopped: true, status: "failed" };
  },
  // A file the browser remembers from a drop (globalThis.__demoRemembered[videoId]: a File, or "denied" when the
  // browser can no longer open it). The real app opens it in the click; this one hands it over the same way.
  hasLocalFile: (videoId) => hasLocalFile0(videoId) || !!globalThis.__demoRemembered?.[videoId],
  // As the real app: the same name and size, else the same length (globalThis.__demoLengths[name]: a picked file's
  // length, as the browser reads it). The design's fake then gets its own file (it checks name and size strictly).
  uploadOriginalForExport: async (projectId, file, onProgress) => {
    const v = (await getProject(projectId)).video || {};
    const f = file || globalThis.__demoRemembered?.[v.id];
    if (!f || f === "denied") throw Object.assign(new Error("Pick the original file to continue."), { code: "need-original" });
    const want = { originalName: v.originalName, originalSize: v.originalSize, seconds: v.seconds };
    if (!sameOriginal({ name: f.name, size: f.size }, want).ok) {
      const seconds = globalThis.__demoLengths?.[f.name] ?? null;
      if (!sameOriginal({ name: f.name, size: f.size, seconds }, want).ok) throw Object.assign(new Error(notOriginalMessage({ name: f.name, size: f.size, seconds }, want)), { code: "wrong-file" });
    }
    const own = new File([""], v.originalName); Object.defineProperty(own, "size", { value: v.originalSize });
    return uploadOriginal0(projectId, own, onProgress);
  },
  ensureLocalFile: async (videoId) => {
    const f = globalThis.__demoRemembered?.[videoId];
    if (f && f !== "denied") return f;
    throw Object.assign(new Error("Pick the original file to continue."), { code: "need-original", friendly: true });
  },
  // The review page plays a rendered file; the demo has none, so it draws the design's preview instead.
  getReview: async (t) => {
    // globalThis.__demoVersions: as many versions as a long-running edit has; __demoLocked: a password on it (the page's checks set them).
    const r = { ...(await getReview(t)) }; if (globalThis.__demoVersions) r.version = globalThis.__demoVersions; if (globalThis.__demoLocked) r.locked = true;
    const clip = { url: null, poster: null, download: null, kind: "preview", quality: "540p", seconds: 32 };
    const versions = Object.fromEntries(Array.from({ length: Math.max(1, r.version || 1) }, (_, i) => [i + 1, clip]));
    const ids = r.folder ? (r.items || []).map((i) => i.id) : [r.project?.id];
    return { ...r, media: Object.fromEntries(ids.filter(Boolean).map((id) => [id, { latest: clip, versions }])) };
  },
  getReviewMedia: async (t) => (await api.getReview(t)).media,
  watchProject: () => () => {},
  getLogins: async () => ({ logins: [{ id: "demo", email: "you@example.com", main: true }], current: "demo" }),
  deleteStyle: async () => ({ ok: true }),
  createLinkCode: async () => { await wait(300); return { code: "DEMO42", expiresInMinutes: 15 }; },
  unlinkLogin: async () => ({ logins: [{ id: "demo", email: "you@example.com", main: true }], current: "demo" }),
  saveFinalToDrive: async () => { await wait(900); return { ok: true, message: "Saved to your Google Drive (demo)." }; },
  getVideo: async (id) => { const v = withKind(await getVideo(id)); return { ...v, proxyUrl: playable[id] || null, breakdown: v.status === "ready" ? demoBreakdown(v) : null }; },
  listVideos: async () => { const vs = await listVideos(); return Array.isArray(vs) ? vs.map(withKind) : vs; },
  // The design's fake backend makes an edit of one video: several (videoIds) start from the first in the preview.
  // The reference (a style, a gallery video, a reference video) is kept with the edit, as the server does.
  // waiting (Recreate): an edit with no footage yet; the first video added becomes it (useFootage).
  createProject: async ({ videoIds, videoId, reference, waiting, ...rest }) => {
    let vid = (Array.isArray(videoIds) && videoIds[0]) || videoId;
    if (waiting) { const vs = await listVideos(); vid = (Array.isArray(vs) ? vs : []).find((v) => v.status === "ready")?.id; }
    const p = await createProject({ ...rest, videoId: vid });
    if (waiting) waitingEdits.add(p.id);
    return reference ? api.updateProject(p.id, { reference }) : p;
  },
  // The Mac app's exports (a test fills globalThis.__demoMacExports): one claim per final.
  macPing: async (version, device, render) => { globalThis.__demoMacPings = (globalThis.__demoMacPings || 0) + 1; globalThis.__demoMacPing = { version, device, render: render || null }; return { ok: true }; },
  macStatus: async () => globalThis.__demoMac || { online: false, device: null, version: null, seenAt: null, renders: false, why: null },
  // Renders waiting for this Mac (a test fills globalThis.__demoMacTasks); a claim hands back the task once.
  macTasks: async () => (globalThis.__demoMacTasks || []).filter((t) => !t.claimed),
  macClaimTask: async (id, device) => { const t = (globalThis.__demoMacTasks || []).find((x) => x.id === id && !x.claimed); if (!t) return { task: null }; t.claimed = device || true; return { task: t.task }; },
  // "Send to Claude" (a test sets globalThis.__demoConnect): the message and chat link come from the shared helper.
  getConnectStatus: ((before) => async () => (globalThis.__demoConnect ? { ...(await before()), ...globalThis.__demoConnect } : before()))(api.getConnectStatus),
  sendComments: async (projectId, ai, ids) => {
    const p = await api.getProject(projectId);
    const all = [...(p.comments || []), ...(globalThis.__demoPosted || [])].sort((a, b) => a.time - b.time);
    const open = all.filter((c) => !c.resolved && (!ids?.length || ids.includes(c.id)));
    if (!open.length) throw new Error("There are no open comments to send.");
    const prompt = handoffPrompt({ name: p.name, projectId, comments: open });
    const r = { id: "h" + Date.now(), ai, name: aiName(ai), count: open.length, commentIds: open.map((c) => c.id), at: Date.now(), prompt, url: handoffUrl(ai, prompt), connected: true };
    (globalThis.__demoSent ||= []).push(r);
    return r;
  },
  macExports: async () => (globalThis.__demoMacExports || []).slice(),
  macClaim: async (id) => { const q = globalThis.__demoMacExports || []; const i = q.findIndex((x) => x.renderId === id); if (i < 0) return { claimed: false }; q.splice(i, 1); return { claimed: true }; },
  useFootage: async (id, ids) => {
    await wait(300);
    const p = await getProject(id);
    const t = await createProject({ videoId: ids[0], name: p.name, aspect: p.aspect, folderId: p.folderId });
    const made = await getProject(t.id);
    await api.updateProject(id, { videoId: ids[0], timeline: made.timeline, art: made.art });
    await api.deleteAsset(t.id);
    waitingEdits.delete(id);
    return api.getProject(id);
  },
  updateVideo: async (id, body) => { await wait(300); if (body.kind) kinds[id] = body.kind; if (body.libraryFolderId !== undefined) { if (body.libraryFolderId) inFolder[id] = body.libraryFolderId; else delete inFolder[id]; } return withKind(await getVideo(id)); },
  addFromDrive: async (ids, kind, fid) => { const out = await addFromDrive(ids); out.forEach((v) => { if (kind) kinds[v.id] = kind; if (fid) inFolder[v.id] = fid; }); return out.map(withKind); },
  // A folder picked or dropped whole: its videos only, each in a library folder like the one it sat in.
  addFromComputer: async (files, onProgress, kind, fid) => {
    const list = Array.from(files || []);
    const where = (f) => f.rendrrFolder ?? (f.webkitRelativePath && f.webkitRelativePath.includes("/") ? f.webkitRelativePath.slice(0, f.webkitRelativePath.lastIndexOf("/")) : "");
    const fromFolder = list.some((f) => where(f));
    const vids = fromFolder ? list.filter((f) => (f.type ? f.type.startsWith("video/") : /\.(mp4|mov|m4v|webm|mkv)$/i.test(f.name)) && !f.name.startsWith(".")) : list;
    if (!vids.length) throw folderErr("There are no videos in that folder.");
    const out = await addFromComputer(vids, onProgress);
    (out || []).forEach((v, i) => {
      if (kind) kinds[v.id] = kind;
      let parent = fid || null;
      for (const part of (where(vids[i] || {}) || "").split("/").filter(Boolean)) parent = libFolderIn(part, parent).id;
      if (parent) inFolder[v.id] = parent;
    });
    return (out || []).map(withKind);
  },
  // Library folders, kept in this tab (folders inside folders too).
  listLibraryFolders: async () => {
    seedFolders();
    const vs = await listVideos(); const all = Array.isArray(vs) ? vs : [];
    const cmp = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
    const path = (f) => { const out = [f.name]; let p = libFolders.find((x) => x.id === f.parentId); while (p) { out.unshift(p.name); p = libFolders.find((x) => x.id === p.parentId); } return out.join(" / "); };
    const sub = (f) => [f, ...libFolders.filter((x) => x.parentId === f.id).flatMap(sub)];
    const stat = (ids) => { const mine = all.filter((v) => ids.includes(inFolder[v.id])); return { count: mine.length, seconds: mine.reduce((a, v) => a + (v.seconds || 0), 0) }; };
    return libFolders.map((f) => { const own = stat([f.id]), tot = stat(sub(f).map((x) => x.id)); return { ...f, parentId: f.parentId || null, path: path(f), count: own.count, seconds: own.seconds, total: tot.count, totalSeconds: tot.seconds, folders: libFolders.filter((x) => x.parentId === f.id).length }; })
      .sort((a, b) => cmp(a.path, b.path));
  },
  createLibraryFolder: async (name, parentId) => {
    await wait(150); const n = String(name || "").trim();
    if (!n) throw folderErr("Give the folder a name.");
    if (n.includes("/")) throw folderErr("A folder name cannot have a / in it.");
    const same = libFolders.find((f) => (f.parentId || null) === (parentId || null) && f.name.toLowerCase() === n.toLowerCase());
    if (same) throw folderErr(`${parentId ? "That folder already has a folder" : "You already have a folder"} called "${same.name}".`);
    const f = { id: "lf" + Math.random().toString(36).slice(2, 8), name: n, parentId: parentId || null, updated: Date.now() }; libFolders.push(f);
    return { ...f, count: 0, seconds: 0, total: 0, totalSeconds: 0, folders: 0, path: n };
  },
  renameLibraryFolder: async (id, name) => { await wait(150); const f = libFolders.find((x) => x.id === id); if (!f) throw folderErr("That folder is not in your library any more."); f.name = String(name || "").trim() || f.name; return { ...f }; },
  moveLibraryFolder: async (id, parentId) => {
    await wait(150); const f = libFolders.find((x) => x.id === id); if (!f) throw folderErr("That folder is not in your library any more.");
    for (let p = libFolders.find((x) => x.id === parentId); p; p = libFolders.find((x) => x.id === p.parentId)) if (p.id === id) throw folderErr(`"${f.name}" cannot go inside a folder that is inside it.`);
    f.parentId = parentId || null; return { ...f };
  },
  deleteLibraryFolder: async (id) => {
    await wait(150); const i = libFolders.findIndex((x) => x.id === id); if (i < 0) return { ok: true };
    const up = libFolders[i].parentId || null; libFolders.splice(i, 1);
    for (const k of Object.keys(inFolder)) if (inFolder[k] === id) { if (up) inFolder[k] = up; else delete inFolder[k]; }
    for (const f of libFolders) if (f.parentId === id) f.parentId = up;
    return { ok: true };
  },
  moveVideos: async (ids, fid) => { await wait(150); ids.forEach((id) => { if (fid) inFolder[id] = fid; else delete inFolder[id]; }); return { moved: ids.length }; },
  getProject: async (id) => {
    const p = await getProject(id);
    // A test can give every demo video a file to play (globalThis.__rendrrDemoMedia: a blob URL).
    const src = playable[p.videoId] || globalThis.__rendrrDemoMedia;
    // The design's music clips name no catalog track: give them one, as add_music does, so they play and render.
    const a2 = (p.timeline?.tracks?.a2 || []).map((c) => (c.trackId || c.assetKey ? c : { ...c, trackId: "m_lofi" }));
    // Its caption clips (cap0, cap1, ...) name no transcript line: give each its line, as the real timeline does.
    const v3 = (p.timeline?.tracks?.v3 || []).map((c) => (c.kind === "caption" && !c.lineId && /^cap\d+$/.test(c.id) ? { ...c, lineId: p.transcript?.[Number(c.id.slice(3))]?.id } : c));
    // Its b-roll clip names no video: one of the demo videos (the real API sends kind and videoId), playable when a test
    // gives the demo a file (globalThis.__rendrrDemoMedia).
    const v2 = (p.timeline?.tracks?.v2 || []).map((c) => (!c.kind && !c.zoom && /b-roll/i.test(c.label || "") ? { ...c, kind: "broll", videoId: "v5", sourceStart: 0 } : c));
    const brollMedia = src && v2.some((c) => c.videoId === "v5") ? { v5: { url: src, seconds: 330 } } : undefined;
    const q0 = p.timeline ? { ...p, timeline: { ...p.timeline, tracks: { ...p.timeline.tracks, a2, v2, v3 } } } : p;
    const q = brollMedia ? { ...q0, brollMedia: { ...(q0.brollMedia || {}), ...brollMedia } } : q0;
    // A check can mark the footage as measured sideways (the real API sends what the deeper measurements found).
    const side = globalThis.__rendrrDemoSideways ? { sideways: { [p.videoId]: globalThis.__rendrrDemoSideways } } : {};
    return { ...(src ? { ...q, video: { ...q.video, proxyUrl: src } } : q), audioMedia: { ...sounds }, ...side, peaks: { [p.videoId]: demoPeaks(p) } };
  },
  // Rendrr's marks where they play (the real API measures them): pauses between lines, a filler, and an AI's note.
  getProjectMarks: async (id) => {
    const p = await getProject(id);
    const ws = (p.transcript || []).flatMap((l) => l.words || []);
    const out = [];
    for (let i = 1; i < ws.length; i++) { const gap = ws[i].t - (ws[i - 1].end ?? ws[i - 1].t + 0.3); if (gap > 0.35) out.push({ id: "sil_" + i, kind: "silence", source: "rendrr", label: null, note: null, start: ws[i - 1].end ?? ws[i - 1].t + 0.3, end: ws[i].t }); }
    const um = ws.find((w) => /^(um|uh)/i.test(w.text)) || ws[3];
    if (um) out.push({ id: "fil_1", kind: "filler", source: "rendrr", label: um.text, note: null, start: um.t, end: um.end ?? um.t + 0.3 });
    if (ws[8]) out.push({ id: "mk_1", kind: "custom", source: "ai", label: "Hook ends", note: "Cut here for the short version", start: ws[8].t, end: ws[8].t });
    return out;
  },
});

// The sound's 10 ms peaks for the waveform, as the deep measurements store them (4 bytes per 10 ms: min, max, dB,
// speech): louder where the transcript has words, a soft room tone between, as a data URL.
function demoPeaks(p) {
  const secs = Math.max(5, p.timeline?.duration || 30), n = Math.ceil(secs * 100), b = new Uint8Array(n * 4);
  const ws = (p.transcript || []).flatMap((l) => l.words || []);
  let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < n; i++) {
    const t = i / 100, w = ws.find((x) => t >= x.t && t < (x.end ?? x.t + 0.3));
    const env = w ? 0.25 + 0.55 * Math.sin(Math.PI * Math.min(1, (t - w.t) / Math.max(0.05, (w.end ?? w.t + 0.3) - w.t))) : 0.02;
    const a = Math.min(1, env * (0.6 + 0.4 * rnd()));
    b[i * 4] = (-Math.round(a * 127)) & 255; b[i * 4 + 1] = Math.round(a * 127); b[i * 4 + 2] = (Math.round(20 * Math.log10(a + 1e-4))) & 255; b[i * 4 + 3] = w ? 220 : 10;
  }
  let bin = ""; for (let i = 0; i < b.length; i += 0x8000) bin += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
  return "data:application/octet-stream;base64," + btoa(bin);
}

// Files you pick play in the editor (the transcript and timeline stay demo data). The build adds this hook
// where the design's fake backend stores a picked file, so the real length and shape can be filled in.
globalThis.__rendrrDemoFile = (v, f) => {
  if (!f || !/^video\//.test(f.type || "")) return;
  const url = URL.createObjectURL(f);
  playable[v.id] = url;
  const probe = document.createElement("video");
  probe.preload = "metadata";
  probe.onloadedmetadata = () => {
    if (probe.duration && isFinite(probe.duration)) v.seconds = Math.max(5, Math.round(probe.duration));
    v.orientation = probe.videoHeight > probe.videoWidth ? "Portrait" : probe.videoHeight === probe.videoWidth ? "Square" : "Landscape";
  };
  probe.src = url;
};

// Fonts added in the preview live in this tab.
const demoFonts = [];
Object.assign(api, {
  listFonts: async () => demoFonts.slice(),
  uploadFont: async ({ family, weight, style, data }) => { const f = { id: "font_" + Math.random().toString(36).slice(2, 8), family, weight, style, format: "ttf", size: Math.round((data.length * 3) / 4) }; const i = demoFonts.findIndex((x) => x.family === family && x.weight === weight && x.style === style); if (i >= 0) demoFonts.splice(i, 1, f); else demoFonts.push(f); return f; },
  deleteFont: async (id) => { const i = demoFonts.findIndex((f) => f.id === id); if (i >= 0) demoFonts.splice(i, 1); return { ok: true }; },
});

// Imported LUTs (Phase 6) live in this tab; shot matching needs the server's frames.
const demoLuts = [];
Object.assign(api, {
  listLuts: async () => demoLuts.map(({ text, ...l }) => l),
  uploadLut: async (name, text) => { const l = { id: "lut_" + Math.random().toString(36).slice(2, 8), name: name.replace(/\.cube$/i, ""), kind: /LUT_1D_SIZE/.test(text) ? "1d" : "3d", size: 0, text }; demoLuts.unshift(l); return l; },
  lutText: async (id) => demoLuts.find((l) => l.id === id)?.text || "",
  deleteLut: async (id) => { const i = demoLuts.findIndex((l) => l.id === id); if (i >= 0) demoLuts.splice(i, 1); return { ok: true }; },
  colorSamples: async () => { await wait(200); throw Object.assign(new Error("Matching measures frames on the server; the preview has no server."), { friendly: true }); },
  // Auto reframe: the demo's speaker sits a little left of centre in every clip.
  // The demo has no matte (no worker): the editor says it is being made.
  matte: async (_id, _v, from, to) => ({ turn: 0, block: 10, blocks: Object.fromEntries(Array.from({ length: Math.floor(to / 10) - Math.floor(from / 10) + 1 }, (_, i) => [Math.floor(from / 10) + i, null])) }),
  skinAreas: async (_id, clips) => { await wait(150); return { areas: Object.fromEntries(clips.map((c) => [c.id, { shape: "ellipse", x: 0.36, y: 0.08, w: 0.28, h: 0.62, feather: 0.04 }])) }; },
  // Phase 3: a face that drifts right over each clip ([footage second, x0, y0, x1, y1] on screen).
  // The demo has no measured sound: the two people take turns every few seconds over the main footage.
  multicamAuto: async (id, o = {}) => {
    await wait(250);
    const p = await getProjectBefore(id);
    const tl = p.timeline || {}; const main = tl.mainVideoId || p.videoId;
    const v1 = (tl.tracks?.v1 || []).filter((c) => (c.sourceVideoId || main) === main);
    const from = Math.min(...v1.map((c) => c.sourceIn ?? c.start ?? 0)), to = Math.max(...v1.map((c) => c.sourceOut ?? c.end ?? 10));
    const cams = ["main", ...(tl.multicam?.angles || []).map((a) => a.videoId)].filter((a) => a !== o.wide);
    const shot = Math.max(o.minShot || 2, 3), plan = [];
    for (let t = from, i = 0; t < to - 0.01; t += shot, i++) plan.push({ start: Math.round(t * 1000) / 1000, end: Math.round(Math.min(to, t + shot) * 1000) / 1000, angle: o.wide && i % 3 === 2 ? o.wide : cams[i % cams.length] });
    return { plan };
  },
  // Phase 22: the demo's cameras carry timecode (the sound agrees), as jammed cameras do.
  multicamSync: async (_id, videoId) => { await wait(200); const v = await getVideo(videoId).catch(() => null); return { videoId, name: v?.name || videoId, offset: 1.2, score: 0.87, margin: 3.1, overlap: 120, sure: true, by: "timecode", checked: true, note: "by timecode; the sound agrees (within 34 ms)" }; },
  // Object tracking in the preview: the box drawn slides right 4% of the width a second and grows a little, from the
  // moment it was drawn (forward and back), lost for 0.3 s a second after it.
  trackObject: async (_id, b) => { await wait(300); const n = Math.max(2, Math.round((b.to - b.from) * 10) + 1); return { rows: Array.from({ length: n }, (_, i) => { const t = Math.round((b.from + i / 10) * 1000) / 1000, d = t - b.at, g = 1 + d * 0.02, w = b.box.w * g, h = b.box.h * g, cx = b.box.x + b.box.w / 2 + d * 0.04, cy = b.box.y + b.box.h / 2; return [t, cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2, d > 1 && d < 1.3 ? 0 : 0.9]; }) }; },
  faceTracks: async (_id, clips) => { await wait(150); return { tracks: Object.fromEntries(clips.map((c) => [c.id, Array.from({ length: Math.max(2, Math.round((c.srcOut - c.srcIn) * 10) + 1) }, (_, i) => { const t = c.srcIn + i / 10, x = 0.38 + Math.min(0.2, i * 0.004); return [Math.round(t * 1000) / 1000, x, 0.12, x + 0.24, 0.6]; })])) }; },
  speakerCentres: async (_id, clips) => { await wait(150); return { centers: Object.fromEntries(clips.map((c) => [c.id, { x: 0.38, y: 0.42 }])) }; },
});

// Comments: a note made in the Rendrr app in Claude (a drawing on the picture, a picture, a link) on the demo edit
// p5; the user's own notes can be edited, resolved, any comment deleted.
const demoPicture = (() => { try { const c = document.createElement("canvas"); c.width = 160; c.height = 90; const g = c.getContext("2d"); g.fillStyle = "#3366ff"; g.fillRect(0, 0, 160, 90); g.fillStyle = "#fff"; g.font = "20px sans-serif"; g.fillText("ref", 60, 52); return c.toDataURL("image/png"); } catch { return ""; } })();
const fromClaude = { id: "cm_claude", time: 2.5, text: "Logo smaller, like https://example.com/ref", author: "You", mine: true, resolved: false, at: Date.now() - 600000, edited: false,
  drawing: { w: 1920, h: 1080, strokes: [{ c: "#ffd60a", w: 0.004, p: [0.3, 0.3, 0.45, 0.32, 0.6, 0.5] }] }, images: [{ id: "im1", url: demoPicture, w: 160, h: 90, name: "ref.png" }] };
const deleted = new Set(), edits = {};
const getProjectBefore = api.getProject; // the wrapper above, kept
Object.assign(api, {
  getProject: async (id, ...rest) => {
    let p = await getProjectBefore(id, ...rest);
    // A test can give the edit one of your own sound files playing in place of the clips' sound (set_voice), once.
    if (p && globalThis.__demoVoice) {
      p = { ...p, sounds: { ...(p.sounds || {}), snd1: { name: "Voiceover", seconds: 20 } } };
      if (!globalThis.__demoVoiceUsed) { globalThis.__demoVoiceUsed = true; p.timeline = { ...p.timeline, voice: { soundId: "snd1", start: 0, editSeconds: 30 } }; }
    }
    if (p && waitingEdits.has(id)) p = { ...p, waiting: true };
    if (!p || id !== "p5") return p;
    const comments = [...(p.comments || []).filter((c) => c.id !== fromClaude.id), fromClaude].filter((c) => !deleted.has(c.id)).map((c) => (edits[c.id] ? { ...c, text: edits[c.id], edited: true } : c));
    return { ...p, comments: comments.sort((a, b) => a.time - b.time) };
  },
  editComment: async (id, text) => { if (!text?.trim()) throw Object.assign(new Error("Write the comment first."), { friendly: true }); edits[id] = text.trim(); return { id, text: text.trim(), edited: true }; },
  deleteComment: async (id) => { deleted.add(id); return { ok: true }; },
  // A note with its drawing and pictures (kept in this tab).
  addProjectComment: async (_projectId, { time, text, drawing, images }) => {
    if (!text?.trim() && !drawing?.strokes?.length && !images?.length) throw Object.assign(new Error("Write a comment, draw on the picture or add a picture first."), { friendly: true });
    await new Promise((r) => setTimeout(r, 120));
    globalThis.__rendrrLastComment = { time, drawing }; // what the editor sent (the browser tests read it)
    const c = { id: "cm_" + Math.random().toString(36).slice(2, 8), time: Math.max(0, Number(time) || 0), text: (text || "").trim(), author: "You", mine: true, resolved: false, at: Date.now(), edited: false,
      drawing: drawing?.strokes?.length ? { w: drawing.w, h: drawing.h, strokes: drawing.strokes } : null, images: (images || []).map((im, i) => ({ id: "im" + i + Math.random().toString(36).slice(2, 5), url: `data:${im.type};base64,${im.data}`, w: im.w, h: im.h, name: im.name })) };
    (globalThis.__demoPosted ||= []).push(c); // for Send to Claude
    return c;
  },
  resolveComment: ((before) => async (id, resolved = true) => (id === fromClaude.id ? (fromClaude.resolved = resolved, { id, resolved }) : before(id, resolved)))(api.resolveComment),
});

// Music and sound effect files for the live player, by catalog key (the real API sends signed URLs).
const sounds = {};
globalThis.__rendrrDemoSound = (key, f) => { if (f) sounds[key] = URL.createObjectURL(f); };

// A whole demo Drive folder: library folders named after it and its folders, its videos linked into them.
Object.assign(api, {
  importDriveFolder: async (f, o = {}) => {
    await wait(400);
    const all = (await Promise.all(["root", "fd1", "fd2", "fd3"].map((x) => listDriveFiles(x)))).flatMap((r) => r.files);
    const known = new Set(all.map((x) => x.id));
    let added = 0, made = 0;
    const folderIn = (name, parentId) => {
      const same = libFolders.find((x) => (x.parentId || null) === (parentId || null) && x.name.toLowerCase() === name.toLowerCase());
      if (same) return same;
      const nf = { id: "lf" + Math.random().toString(36).slice(2, 8), name, parentId: parentId || null, updated: Date.now() }; libFolders.push(nf); made++; return nf;
    };
    const put = async (id, name, parentId, depth) => {
      const lf = folderIn(name, parentId);
      const ids = (DEMO_FILES[id] || []).filter((x) => known.has(x));
      if (ids.length) { const out = await addFromDrive(ids); out.forEach((v) => { inFolder[v.id] = lf.id; if (o.kind) kinds[v.id] = o.kind; }); added += out.length; }
      if (o.subfolders !== false && depth < 6) for (const sub of DEMO_TREE[id] || []) await put(sub, DEMO_FOLDERS[sub], lf.id, depth + 1);
      return lf;
    };
    const top = await put(f.id, f.name || DEMO_FOLDERS[f.id] || "Drive folder", o.libraryFolderId || null, 1);
    if (!added) throw folderErr(`"${top.name}" has no videos.`);
    // Linked to Drive: its folders know it, and the top one says when it was last looked at.
    const mark = (lf, isTop) => { lf.drive = { top: isTop, syncedAt: isTop ? Date.now() : null }; libFolders.filter((x) => x.parentId === lf.id).forEach((x) => mark(x, false)); };
    mark(top, true);
    return { folder: (await api.listLibraryFolders()).find((x) => x.id === top.id), added, moved: 0, folders: made, truncated: false };
  },
  // A linked folder synced: a video "put in the Drive folder since" comes in (the browser test sets which one).
  syncLibraryFolder: async (id) => {
    await wait(300);
    let top = libFolders.find((x) => x.id === id);
    while (top && !top.drive?.top) top = libFolders.find((x) => x.id === top.parentId);
    if (!top) throw folderErr("That folder is not linked to a Google Drive folder (only folders imported from Drive are).");
    top.drive = { ...top.drive, syncedAt: Date.now() };
    const fresh = globalThis.__rendrrDriveNew; globalThis.__rendrrDriveNew = null;
    if (!fresh) return { folderId: top.id, added: 0, folders: 0, truncated: false };
    const out = await addFromDrive([fresh]); out.forEach((v) => { inFolder[v.id] = top.id; });
    return { folderId: top.id, added: out.length, folders: 0, truncated: false };
  },
});

// Usage & billing and the admin panel (billingDemo.js); a test makes the demo user an admin with __demoAdmin.
const getProfile0 = api.getProfile;
const login0 = api.login, signup0 = api.signup;
const asAdmin = (u) => (u ? { ...u, admin: !!globalThis.__demoAdmin } : u);
Object.assign(api, demoBillingApi, { getProfile: async (...a) => asAdmin(await getProfile0(...a)), login: async (...a) => asAdmin(await login0(...a)), signup: async (...a) => asAdmin(await signup0(...a)) });

demoAssetsApi(api); // the Assets page: favourites, the Trash, elements and audio
// The AI connector's consent page (Supabase's OAuth server): a test sets globalThis.__demoOAuth.
Object.assign(api, {
  oauthDetails: async (id) => { const o = globalThis.__demoOAuth || {}; if (o.done) return { redirect_url: o.redirect }; if (!id || id === "bad") throw Object.assign(new Error("This connection request has expired. Start again from Claude or ChatGPT."), { friendly: true }); return { authorization_id: id, client: { client_name: o.name || "Claude" }, user: { email: "you@example.com" }, scope: "openid email", redirect_uri: "https://claude.ai/api/mcp/auth_callback" }; },
  oauthDecide: async (id, allow) => { (globalThis.__demoOAuthDecisions ||= []).push({ id, allow }); return { redirect_url: (globalThis.__demoOAuth?.redirect || "https://claude.ai/api/mcp/auth_callback") + (allow ? "?code=demo" : "?error=access_denied") }; },
});

export { api };
export const API_BASE = "";

// The real server refuses to delete a video that edits use until the user says the edits go too (409 in-use); a
// page's check names which videos are in use.
const removeVideo = api.removeVideo;
Object.assign(api, {
  removeVideo: async (id, withEdits) => {
    if (!withEdits && (globalThis.__demoInUse || []).includes(id)) { await wait(150); throw Object.assign(new Error(`It is used by 1 edit: "Promo cut". Deleting it deletes that edit too.`), { code: "in-use", status: 409, friendly: true }); }
    return removeVideo(id, withEdits);
  },
});

// Writes in the demo forget the pages remembered in memory, as the real API's writes do (http.ts).
for (const [name, fn] of Object.entries(api)) {
  if (typeof fn !== "function" || /^(get|list|has|is|read|follow|desktopApp|captureDrop)/.test(name)) continue;
  api[name] = function (...a) { globalThis.__rendrrWrites = (globalThis.__rendrrWrites || 0) + 1; return fn.apply(this, a); };
}

// Published videos with their real export (tests set globalThis.__demoGalleryVideo = { video, poster }): the demo's
// fake gallery has none, so its tiles show the style preview otherwise.
const listGallery0 = api.listGallery;
api.listGallery = async (...a) => {
  const list = await listGallery0(...a);
  const m = globalThis.__demoGalleryVideo;
  return m ? list.map((g, i) => (i === 0 ? { ...g, ori: "9:16", video: m.video, poster: m.poster ?? null } : g)) : list;
};

// Where a demo render is made (a test sets globalThis.__demoMadeOn = { on: "mac", device }): its progress and result say so.
for (const name of ["renderPreview", "renderFinal"]) {
  const run0 = api[name];
  api[name] = async (projectId, onProgress, opts) => {
    const m = globalThis.__demoMadeOn || null;
    const r = await run0(projectId, (p) => onProgress?.(m ? { ...p, on: m.on, device: m.device ?? null } : p), opts);
    return m && r ? { ...r, where: { renders: m.on, device: m.device ?? null, region: "US East", delivery: { to: m.on === "mac" && name === "renderFinal" ? "mac" : "download", device: m.device ?? null, state: m.on === "mac" ? "sent" : null, folder: null, at: null } } } : r;
  };
}
