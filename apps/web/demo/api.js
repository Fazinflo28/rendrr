// Demo api: the design's own in-browser fake backend (from ui/rendrr-ui-v2.html), plus the few functions the
// wired-up app calls that the design file did not have. Nothing leaves the browser.
import { api } from "rendrr-fake-api";
import { breakdownAsText, buildBreakdown } from "../../../packages/shared/src/breakdown.ts";

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const playable = {}; // videoId -> blob URL of the file picked in this tab, so the editor can play it

const getProject = api.getProject;
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
    return { ...(src ? { ...q, video: { ...q.video, proxyUrl: src } } : q), audioMedia: { ...sounds } };
  },
});

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

// Imported LUTs (Phase 6) live in this tab; shot matching needs the server's frames.
const demoLuts = [];
Object.assign(api, {
  listLuts: async () => demoLuts.map(({ text, ...l }) => l),
  uploadLut: async (name, text) => { const l = { id: "lut_" + Math.random().toString(36).slice(2, 8), name: name.replace(/\.cube$/i, ""), kind: /LUT_1D_SIZE/.test(text) ? "1d" : "3d", size: 0, text }; demoLuts.unshift(l); return l; },
  lutText: async (id) => demoLuts.find((l) => l.id === id)?.text || "",
  deleteLut: async (id) => { const i = demoLuts.findIndex((l) => l.id === id); if (i >= 0) demoLuts.splice(i, 1); return { ok: true }; },
  colorSamples: async () => { await wait(200); throw Object.assign(new Error("Matching measures frames on the server; the preview has no server."), { friendly: true }); },
});

// Music and sound effect files for the live player, by catalog key (the real API sends signed URLs).
const sounds = {};
globalThis.__rendrrDemoSound = (key, f) => { if (f) sounds[key] = URL.createObjectURL(f); };

export { api };
export const API_BASE = "";
