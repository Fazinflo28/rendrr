// Demo api: the design's own in-browser fake backend (from ui/rendrr-ui-v2.html), plus the few functions the
// wired-up app calls that the design file did not have. Nothing leaves the browser.
import { api } from "rendrr-fake-api";

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const playable = {}; // videoId -> blob URL of the file picked in this tab, so the editor can play it

const getProject = api.getProject;
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
  saveFinalToDrive: async () => { await wait(900); return { ok: true, message: "Saved to your Google Drive (demo)." }; },
  getProject: async (id) => {
    const p = await getProject(id);
    const src = playable[p.videoId];
    return src ? { ...p, video: { ...p.video, proxyUrl: src } } : p;
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

export { api };
export const API_BASE = "";
