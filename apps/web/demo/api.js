// Demo api: the design's own in-browser fake backend (from ui/rendrr-ui-v2.html), plus the few functions the
// wired-up app calls that the design file did not have. Nothing leaves the browser.
import { api } from "rendrr-fake-api";
import { breakdownAsText, buildBreakdown } from "../../../packages/shared/src/breakdown.ts";

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const playable = {}; // videoId -> blob URL of the file picked in this tab, so the editor can play it

const getProject = api.getProject, createProject = api.createProject;
const getVideo = api.getVideo, listVideos = api.listVideos, addFromDrive = api.addFromDrive, addFromComputer = api.addFromComputer;
const kinds = {}; // videoId -> "footage" | "reference" (the design's fake backend has no references)
const withKind = (v) => (v ? { ...v, kind: kinds[v.id] || "footage" } : v);

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
const listDriveFiles = api.listDriveFiles;
// The design's fake Drive is flat; the demo nests it (folders in folders, Shared with me, a shared drive) like a real one.
const DEMO_TREE = { root: ["fd1", "fd2", "fd3"], fd2: ["fdB"], fdB: ["fdC"], shared: ["fdS"] };
const DEMO_FOLDERS = { fd1: "Podcast raw", fd2: "Client footage", fd3: "B-roll", fdB: "BFS Health", fdC: "Shoot day 2", fdS: "From Sam" };
const DEMO_FILES = { root: ["df7"], fd1: ["df1"], fdB: ["df3", "df8"], fdC: ["df4", "df6"], fd3: ["df5"], fdS: ["df2"] };
const logout = api.logout;
let signedIn = false;
const track = (fn) => async (...a) => { const r = await fn(...a); signedIn = true; return r; };

Object.assign(api, {
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
  // The review page plays a rendered file; the demo has none, so it draws the design's preview instead.
  getReview: async (t) => {
    const r = await getReview(t);
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
  createProject: async ({ videoIds, videoId, ...rest }) => createProject({ ...rest, videoId: (Array.isArray(videoIds) && videoIds[0]) || videoId }),
  updateVideo: async (id, body) => { await wait(300); if (body.kind) kinds[id] = body.kind; return withKind(await getVideo(id)); },
  addFromDrive: async (ids, kind) => { const out = await addFromDrive(ids); if (kind) out.forEach((v) => { kinds[v.id] = kind; }); return out.map(withKind); },
  addFromComputer: async (files, onProgress, kind) => { const out = await addFromComputer(files, onProgress); if (kind) (out || []).forEach((v) => { kinds[v.id] = kind; }); return (out || []).map(withKind); },
  getProject: async (id) => {
    const p = await getProject(id);
    const src = playable[p.videoId];
    // The design's music clips name no catalog track: give them one, as add_music does, so they play and render.
    const a2 = (p.timeline?.tracks?.a2 || []).map((c) => (c.trackId || c.assetKey ? c : { ...c, trackId: "m_lofi" }));
    // Its caption clips (cap0, cap1, ...) name no transcript line: give each its line, as the real timeline does.
    const v3 = (p.timeline?.tracks?.v3 || []).map((c) => (c.kind === "caption" && !c.lineId && /^cap\d+$/.test(c.id) ? { ...c, lineId: p.transcript?.[Number(c.id.slice(3))]?.id } : c));
    const q = p.timeline ? { ...p, timeline: { ...p.timeline, tracks: { ...p.timeline.tracks, a2, v3 } } } : p;
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
});

// Comments: a note made in the Rendrr app in Claude (a drawing on the picture, a picture, a link) on the demo edit
// p5; the user's own notes can be edited, any comment deleted.
const demoPicture = (() => { try { const c = document.createElement("canvas"); c.width = 160; c.height = 90; const g = c.getContext("2d"); g.fillStyle = "#3366ff"; g.fillRect(0, 0, 160, 90); g.fillStyle = "#fff"; g.font = "20px sans-serif"; g.fillText("ref", 60, 52); return c.toDataURL("image/png"); } catch { return ""; } })();
const fromClaude = { id: "cm_claude", time: 2.5, text: "Logo smaller, like https://example.com/ref", author: "You", mine: true, resolved: false, at: Date.now() - 600000, edited: false,
  drawing: { w: 1920, h: 1080, strokes: [{ c: "#ffd60a", w: 0.004, p: [0.3, 0.3, 0.45, 0.32, 0.6, 0.5] }] }, images: [{ id: "im1", url: demoPicture, w: 160, h: 90, name: "ref.png" }] };
const deleted = new Set(), edits = {};
const getProjectBefore = api.getProject; // the wrapper above, kept
Object.assign(api, {
  getProject: async (id, ...rest) => {
    const p = await getProjectBefore(id, ...rest);
    if (!p || id !== "p5") return p;
    const comments = [...(p.comments || []).filter((c) => c.id !== fromClaude.id), fromClaude].filter((c) => !deleted.has(c.id)).map((c) => (edits[c.id] ? { ...c, text: edits[c.id], edited: true } : c));
    return { ...p, comments: comments.sort((a, b) => a.time - b.time) };
  },
  editComment: async (id, text) => { if (!text?.trim()) throw Object.assign(new Error("Write the comment first."), { friendly: true }); edits[id] = text.trim(); return { id, text: text.trim(), edited: true }; },
  deleteComment: async (id) => { deleted.add(id); return { ok: true }; },
});

// Music and sound effect files for the live player, by catalog key (the real API sends signed URLs).
const sounds = {};
globalThis.__rendrrDemoSound = (key, f) => { if (f) sounds[key] = URL.createObjectURL(f); };

export { api };
export const API_BASE = "";
