/* eslint-disable @typescript-eslint/no-explicit-any */
// The real api. Same function names, arguments and return shapes as the fake `api` in ui/rendrr-ui.html.
// Everything goes to the Rendrr API server; errors are plain-English Errors with `.friendly` and `.code`.
import { localJobs } from "./local";
import { BASE, DEV, NETWORK_MSG, clerk, del, demo, emptyIf, enc, fail, get, patch, post, readEvents, req, wait } from "./http";

const PROC_STEPS = ["Transcribing", "Finding silences", "Finding scene cuts", "Reading the frames"];
const DRIVE_STEPS = ["Linking", "Making preview", ...PROC_STEPS];
const LOCAL_STEPS = ["Making preview in your browser", "Uploading preview", ...PROC_STEPS];

// Top bar categories: each groups a few style types (same list as the design).
const CATEGORIES = [
  { slug: "clipping", label: "Clipping", types: ["clipping", "listicle", "tier-ranking"], blurb: "Long video in, the best moments out. Silences gone, captions on." },
  { slug: "talking-head", label: "Talking head", types: ["talking-head", "greenscreen", "split-screen"], blurb: "One person, one camera. Punchy cuts, zooms and bold captions." },
  { slug: "ads", label: "Ads", types: ["cinematic", "before-after"], blurb: "Hooks in the first second. Built for paid placements." },
  { slug: "brainrot", label: "Brainrot", types: ["brainrot", "split-screen"], blurb: "Stacked gameplay, fast captions, zero dead air." },
  { slug: "ugc", label: "UGC", types: ["ugc-ad", "text-story"], blurb: "Phone-shot and honest. Light captions, quick pace." },
  { slug: "podcast", label: "Podcast", types: ["podcast-clip"], blurb: "Clean clips from long talks. Speaker switches, lower thirds." },
  { slug: "motion-graphics", label: "Motion graphics", types: ["motion-graphics", "slideshow"], blurb: "Kinetic type, shapes and slides that move with the voice." },
  { slug: "documentary", label: "Documentary", types: ["documentary", "news"], blurb: "Slow, cinematic b-roll with calm captions and a story arc." },
  { slug: "screen-tutorials", label: "Screen tutorials", types: ["tutorial"], blurb: "Screen recordings with zooms on the cursor and clear steps." },
];

// ---------------- caches the UI needs synchronously ----------------
const versions: Record<string, number> = {};
const videoMeta: Record<string, any> = {};
let resetSignIn: any = null;
const reviewKey = (t: string) => { try { return sessionStorage.getItem("rendrr-review-" + t) || ""; } catch { return ""; } };
const reviewHeaders = (t: string): Record<string, string> => (reviewKey(t) ? { "x-review-key": reviewKey(t) } : {});
const remember = (v: any) => { if (v && v.id) videoMeta[v.id] = v; return v; };

async function finishSignIn(ticket: string) {
  const c = await clerk();
  const si = await c.client.signIn.create({ strategy: "ticket", ticket });
  if (si.status !== "complete" || !si.createdSessionId) throw fail("We could not finish logging you in. Try again.", "auth");
  await c.setActive({ session: si.createdSessionId });
  return api.getProfile();
}
const clerkMsg = (e: any, fallback: string) => fail(e?.errors?.[0]?.longMessage || e?.errors?.[0]?.message || e?.message || fallback);

// ---------------- render: start, follow live progress, resolve with the result ----------------
async function runRender(kind: "preview" | "final", projectId: string, onProgress?: (p: any) => void) {
  if (DEV && demo.failNextRender) {
    demo.failNextRender = false;
    const steps = kind === "preview" ? ["Reading timeline", "Cutting clips", "Burning captions", "Packing preview"] : ["Reading timeline", "Cutting clips", "Adding zooms", "Mixing music", "Burning captions", "Encoding 1080p", "Cleaning up raw file"];
    for (let i = 0; i <= 2; i++) { onProgress?.({ step: i, steps, percent: Math.round((i / steps.length) * 100) }); await wait(400); }
    throw fail("Render failed at '" + steps[2] + "'. Nothing was lost. Try again.");
  }
  if (DEV && kind === "final" && demo.failNextDrive) {
    demo.failNextDrive = false;
    onProgress?.({ step: 0, steps: ["Fetching raw from Drive"], percent: 10 }); await wait(700);
    throw fail("We could not reach your Drive file. Reconnect it and try again.", "drive");
  }
  const started = await post(`/projects/${enc(projectId)}/renders`, { kind });
  const id = started.renderId as string;
  const steps = started.steps || [];
  onProgress?.({ step: 0, steps, percent: 0, etaSec: null, quality: started.quality });
  let final: any = null;
  // Phase 7: as long as the server's own limit for this render (it fails loudly when that passes), plus a margin. A
  // long or 4K final can take far longer than the old fixed 17 minutes.
  const deadline = Date.now() + (Number(started.limitMs) || (kind === "final" ? 17 : 5) * 60_000) + 3 * 60_000;
  // Live stream first; if it drops, fall back to polling until the render ends.
  try {
    await readEvents(`/renders/${enc(id)}/events`, (ev, data) => {
      if (ev === "progress") onProgress?.({ step: data.step, steps: data.steps?.length ? data.steps : steps, percent: data.percent, etaSec: data.etaSec ?? null, quality: started.quality });
      if (ev === "done" || ev === "failed") { final = data; return true; }
    });
  } catch { /* poll below */ }
  while (!final && Date.now() < deadline) {
    await wait(2000);
    const s = await get(`/renders/${enc(id)}`).catch(() => null);
    if (!s) continue;
    if (s.status === "done" || s.status === "failed") final = s;
    else onProgress?.({ step: s.step, steps: s.steps?.length ? s.steps : steps, percent: s.percent, etaSec: s.etaSec ?? null, quality: started.quality });
  }
  if (!final) throw fail((kind === "preview" ? "Preview render" : "Final render") + " took too long. Try again.", "timeout");
  if (final.status === "failed") throw fail(final.error || "Render did not finish. Nothing was lost. Try again.", final.code);
  const st = final.steps?.length ? final.steps : steps;
  onProgress?.({ step: st.length, steps: st, percent: 100 });
  return final.result;
}

// ---------------- the api ----------------
export const api: any = {
  demo, PROC_STEPS, DRIVE_STEPS, LOCAL_STEPS, CATEGORIES,

  // ---- auth ----
  login: async (email: string, password: string) => {
    if (!email) throw fail("Enter your email to continue.");
    const { ticket } = await post("/auth/login", { email, password }, { auth: false });
    return finishSignIn(ticket);
  },
  signup: async (name: string, email: string, password: string) => {
    if (!email) throw fail("Enter your email to continue.");
    const { ticket } = await post("/auth/signup", { name, email, password }, { auth: false });
    return finishSignIn(ticket);
  },
  loginWithGoogle: async () => {
    const c = await clerk();
    try {
      await c.client.signIn.authenticateWithRedirect({ strategy: "oauth_google", redirectUrl: "/sso-callback", redirectUrlComplete: "/explore" });
    } catch (e) { throw clerkMsg(e, "Google login did not start. Try again."); }
    return new Promise(() => {}); // the page is leaving for Google
  },
  sendReset: async (email: string) => {
    if (!email) throw fail("Enter your email and we will send a link.");
    const c = await clerk();
    try {
      resetSignIn = await c.client.signIn.create({ strategy: "reset_password_email_code", identifier: email });
    } catch (e) { throw clerkMsg(e, "We could not send a reset code to that email."); }
    return { sent: true };
  },
  completeReset: async (code: string, password: string) => {
    if (!resetSignIn) throw fail("Ask for a new reset code first.");
    if (!code) throw fail("Enter the code from the email.");
    if (!password) throw fail("Enter a new password.");
    let si;
    try { si = await resetSignIn.attemptFirstFactor({ strategy: "reset_password_email_code", code, password }); }
    catch (e) { throw clerkMsg(e, "That code did not work. Check the email and try again."); }
    if (si.status !== "complete" || !si.createdSessionId) throw fail("Your password changed. Log in with the new password.");
    const c = await clerk();
    await c.setActive({ session: si.createdSessionId });
    resetSignIn = null;
    return api.getProfile();
  },
  logout: async () => { try { const c = await clerk(); await c.signOut(); } catch { /* already out */ } return { ok: true }; },
  hasSession: async () => { const c = await clerk(); return !!c.session; },

  // ---- library ----
  listVideos: async () => emptyIf((await get("/videos")).map(remember)),
  getVideo: async (id: string) => remember(await get(`/videos/${enc(id)}`)),
  updateVideo: async (id: string, body: { kind?: string; name?: string }) => remember(await patch(`/videos/${enc(id)}`, body)),
  retryVideo: async (id: string) => {
    const v = remember(await post(`/videos/${enc(id)}/retry`));
    if (v.source === "local" && !v.sample && v.status === "previewing") {
      // The browser has to make the preview again: it needs the file in this tab (asks with a picker).
      try { await localJobs.ensureFile(v.id, v.originalName); }
      catch (e) { await post(`/videos/${enc(v.id)}/local/progress`, { status: "paused" }).catch(() => {}); throw e; }
      localJobs.start(v.id);
    }
    return v;
  },
  // withEdits: the edits made from it are deleted too (after the user said yes to that).
  removeVideo: (id: string, withEdits = false) => del(`/videos/${enc(id)}${withEdits ? "?edits=delete" : ""}`),

  // ---- Google Drive ----
  getDriveStatus: () => get("/drive/status"),
  connectDrive: async () => {
    const r = await post("/drive/connect");
    if (!r.authUrl) return r;
    // Real Google consent in a popup; the API's callback page tells us when it is done.
    // The popup hands the Google code back here and we finish with our own login (see /drive/complete).
    // Without a popup the whole tab goes to Google and comes back to /drive-done, which finishes it.
    const w = window.open(r.authUrl, "rendrr-drive", "width=520,height=680");
    if (!w) { window.location.href = r.authUrl; return new Promise(() => {}); }
    const apiOrigin = new URL(BASE).origin;
    let finishing: Promise<unknown> | null = null;
    await new Promise<void>((resolve) => {
      const done = () => { window.removeEventListener("message", onMsg); clearInterval(t); resolve(); };
      const onMsg = (e: MessageEvent) => {
        if (e.origin !== apiOrigin || !e.data || !e.data.rendrrDrive) return;
        if (e.data.code && e.data.state) finishing = post("/drive/complete", { code: e.data.code, state: e.data.state });
        done();
      };
      window.addEventListener("message", onMsg);
      const t = setInterval(() => { if (w.closed) done(); }, 500);
    });
    if (finishing) await finishing;
    const s = await api.getDriveStatus();
    if (!s.connected) throw fail("Google Drive was not connected. Try again.", "drive");
    return s;
  },
  completeDrive: (code: string, state: string) => post("/drive/complete", { code, state }),
  disconnectDrive: () => post("/drive/disconnect"),
  // One folder (any depth; a shared drive's folders carry its driveId), or a view: shared | recent | search (q).
  listDriveFiles: (folderId = "root", o: { view?: string; driveId?: string; q?: string; drives?: boolean } = {}) =>
    get(`/drive/files?folderId=${enc(folderId)}` + (o.view ? `&view=${enc(o.view)}` : "") + (o.driveId ? `&driveId=${enc(o.driveId)}` : "") + (o.q ? `&q=${enc(o.q)}` : "") + (o.drives ? "&drives=1" : "")),
  // kind "reference": a video whose style to copy (Rendrr reads it like footage; the AI matches it).
  addFromDrive: async (fileIds: string[], kind?: string) => (await post("/videos/drive", { fileIds, ...(kind ? { kind } : {}) })).map(remember),
  addFromComputer: async (files: File[] | null, onProgress?: (p: any) => void, kind?: string) => {
    const list = files && files.length ? Array.from(files) : null;
    if (!list) throw fail("Pick a video file first.");
    if (DEV && (demo.failNextUpload || list.some((f) => /fail/i.test(f.name)))) { demo.failNextUpload = false; throw fail("One of the files could not be read."); }
    const made = (await post("/videos/local", { files: list.map((f) => ({ name: f.name, size: f.size, type: f.type })), ...(kind ? { kind } : {}) })).map(remember);
    made.forEach((v: any, i: number) => { localJobs.hold(v.id, list[i]); localJobs.start(v.id); });
    onProgress?.({ percent: 5 });
    return made;
  },
  hasLocalFile: (videoId: string) => localJobs.has(videoId),
  captureDrop: (dt: DataTransfer | null) => localJobs.capture(dt),
  // Only a page that is really going away pauses: a hidden tab keeps making its preview.
  pauseLocalPreviews: (ev?: Event) => {
    if (!ev || ev.type !== "pagehide") return;
    const ids = localJobs.running();
    if (!ids.length) return;
    const t = (window as any).Clerk?.session?.lastActiveToken?.getRawString?.();
    try { fetch(BASE + "/videos/pause", { method: "POST", keepalive: true, headers: { "content-type": "application/json", ...(t ? { authorization: "Bearer " + t } : {}) }, body: JSON.stringify({ ids }) }); } catch { /* best effort */ }
  },
  resumeLocalPreview: async (videoId: string) => {
    await localJobs.ensureFile(videoId, videoMeta[videoId]?.originalName); // may open a file picker (click = user gesture)
    const v = remember(await post(`/videos/${enc(videoId)}/resume`));
    localJobs.start(videoId);
    return v;
  },
  reconnectDriveFile: async (videoId: string, fileId: string) => {
    if (!fileId) throw fail("Pick the file in Drive to reconnect it.");
    return remember(await post(`/videos/${enc(videoId)}/reconnect`, { fileId }));
  },
  rebuildPreview: async (videoId: string) => {
    const meta = videoMeta[videoId];
    if (meta && meta.source === "local" && !meta.sample) await localJobs.ensureFile(videoId, meta.originalName);
    const v = remember(await post(`/videos/${enc(videoId)}/rebuild`));
    if (v.source === "local" && !v.sample) localJobs.start(videoId);
    return v;
  },

  // ---- folders (client projects) ----
  listFolders: async () => emptyIf(await get("/folders")),
  getFolder: (id: string) => get(`/folders/${enc(id)}`),
  createFolder: async (name: string) => { if (!name?.trim()) throw fail("Give the project a name."); return post("/folders", { name: name.trim() }); },
  renameFolder: (id: string, name: string) => patch(`/folders/${enc(id)}`, { name }),
  deleteFolder: (id: string) => del(`/folders/${enc(id)}`),
  deleteAsset: (id: string) => del(`/projects/${enc(id)}`),
  restoreAsset: (id: string) => post(`/projects/${enc(id)}/restore`),

  // ---- projects (assets inside folders) ----
  listProjects: async () => emptyIf(await get("/projects")),
  getProject: async (id: string) => { const p = await get(`/projects/${enc(id)}`); versions[id] = p.version; return p; },
  // A new edit is the raw footage. `reference` ({ kind: style | recipe | video, id }) is attached for the AI, never applied.
  createProject: async ({ videoId, reference, name, folderId, cut, aspect }: any) => {
    if (!videoId) throw fail("Pick footage first.");
    const p = await post("/projects", { videoId, reference: reference ? { kind: reference.kind, id: reference.id } : undefined, name: name || undefined, folderId: folderId || undefined, cut: Array.isArray(cut) ? cut : undefined, aspect: aspect || undefined });
    versions[p.id] = p.version;
    return p;
  },
  updateProject: async (id: string, p: any) => {
    const body = p.timeline ? { ...p, baseVersion: versions[id] } : p;
    const r = await patch(`/projects/${enc(id)}`, body);
    if (r && typeof r.version === "number") versions[id] = r.version;
    return r;
  },
  restoreVersion: (projectId: string, v: number) => post(`/projects/${enc(projectId)}/versions/${v}/restore`),
  /** Live changes to a project (AI edits). Returns a function that stops listening. */
  watchProject: (projectId: string, onChange: (msg: any) => void) => {
    const ctl = new AbortController();
    let stopped = false;
    (async () => {
      while (!stopped) {
        try {
          await readEvents(`/projects/${enc(projectId)}/events`, (ev, data) => { if (ev === "change") onChange(data); }, ctl.signal);
        } catch { /* reconnect below */ }
        if (!stopped) await wait(3000);
      }
    })();
    return () => { stopped = true; ctl.abort(); };
  },

  // ---- styles (open to everyone; a login adds your own styles) ----
  getCategories: async () => CATEGORIES,
  listStyles: async () => emptyIf(await get("/styles")),

  // ---- colour (Phase 6): imported LUTs, measured frames for shot matching ----
  listLuts: async () => (await get("/luts"))?.luts || [],
  uploadLut: (name: string, text: string) => post("/luts", { name, text }),
  lutText: async (id: string) => (await get(`/luts/${enc(id)}/cube`))?.text || "",
  deleteLut: (id: string) => del(`/luts/${enc(id)}`),
  // ---- fonts: added once, used by name in graphics ----
  listFonts: async () => (await get("/fonts"))?.fonts || [],
  uploadFont: (f: { family: string; weight: number; style: string; data: string }) => post("/fonts", f),
  deleteFont: (id: string) => del(`/fonts/${enc(id)}`),
  colorSamples: async (projectId: string, clipIds: string[]) => (await post(`/projects/${enc(projectId)}/color-samples`, { clipIds }))?.measured || {},
  getStyleFilters: () => get("/styles/filters"),
  getStyle: (id: string) => get(`/styles/${enc(id)}`),

  // ---- community gallery ----
  listGallery: async () => emptyIf(await get("/gallery")),
  publishToGallery: ({ projectId, title, platforms, allowRecreate }: any) => {
    if (!projectId) throw fail("Pick a project to publish.");
    return post("/gallery", { projectId, title, platforms, allowRecreate });
  },
  unpublishFromGallery: (id: string) => del(`/gallery/${enc(id)}`),
  likeGalleryItem: (id: string) => post(`/gallery/${enc(id)}/like`),
  countRecreate: (id: string) => post(`/gallery/${enc(id)}/recreate`),

  // ---- render ----
  renderPreview: (projectId: string, onProgress?: (p: any) => void) => runRender("preview", projectId, onProgress),
  renderFinal: (projectId: string, onProgress?: (p: any) => void) => runRender("final", projectId, onProgress),
  // Local source only: the original is uploaded once for the export and deleted within 24h.
  uploadOriginalForExport: async (projectId: string, file: File | null, onProgress?: (p: any) => void) => {
    const p = await get(`/projects/${enc(projectId)}`);
    const f = file || localJobs.file(p.videoId);
    if (!f) throw fail("Pick the original file to continue.", "need-original");
    const v = p.video || {};
    if (v.originalName && (f.name !== v.originalName || (v.originalSize && f.size !== v.originalSize))) {
      throw fail("That is not the same file. We need '" + v.originalName + "'" + (v.originalSize ? " (" + (v.originalSize / 1e6).toFixed(0) + " MB)" : "") + ".");
    }
    // Keep the picked file in this tab: the next export uploads it without asking again.
    if (file) localJobs.hold(p.videoId, f);
    const steps = ["Uploading original"];
    onProgress?.({ step: 0, steps, percent: 0 });
    const up = await post(`/projects/${enc(projectId)}/original`, { name: f.name, size: f.size });
    const parts = await localJobs.uploadParts(f, up.urls, up.partSize, (pct) => onProgress?.({ step: 0, steps, percent: Math.min(99, Math.round(pct)) }));
    const done = await post(`/projects/${enc(projectId)}/original/complete`, { uploadId: up.uploadId, parts });
    onProgress?.({ step: 1, steps, percent: 100 });
    return done;
  },
  deleteAllFinals: () => post("/account/delete-finals"),
  saveFinalToDrive: (renderId: string) => post(`/renders/${enc(renderId)}/save-to-drive`),

  // ---- reviews ----
  listReviews: async () => emptyIf(await get("/reviews")),
  createReviewLink: (opts: any) => {
    if (!opts.projectId && !opts.folderId) throw fail("Pick a project or a folder to share.");
    return post("/reviews", opts);
  },
  listFoldersLite: () => get("/folders?lite=1"),
  getReview: (t: string) => get(`/public/reviews/${enc(t)}`, { auth: false, headers: reviewHeaders(t) }),
  getReviewMedia: (t: string, v?: number) => get(`/public/reviews/${enc(t)}/media${v ? `?v=${v}` : ""}`, { auth: false, headers: reviewHeaders(t) }),
  checkReviewPassword: async (t: string, pw: string) => {
    const r = await post(`/public/reviews/${enc(t)}/unlock`, { password: pw || "" }, { auth: false });
    try { sessionStorage.setItem("rendrr-review-" + t, r.key); } catch { /* private mode: unlock lasts this page only */ }
    return { ok: true };
  },
  addReviewComment: (t: string, { time, text, projectId }: any) => post(`/public/reviews/${enc(t)}/comments`, { time, text, projectId }, { auth: false, headers: reviewHeaders(t) }),
  resolveComment: (commentId: string, resolved = true) => patch(`/comments/${enc(commentId)}`, { resolved }),
  addProjectComment: (projectId: string, { time, text }: any) => {
    if (!text?.trim()) throw fail("Write a comment first.");
    return post(`/projects/${enc(projectId)}/comments`, { time: Math.max(0, Number(time) || 0), text: text.trim() });
  },
  approveReview: (t: string) => post(`/public/reviews/${enc(t)}/approve`, {}, { auth: false, headers: reviewHeaders(t) }),
  requestChanges: (t: string, note: string) => post(`/public/reviews/${enc(t)}/changes`, { note }, { auth: false, headers: reviewHeaders(t) }),

  // ---- ai ----
  getConnectStatus: () => get("/connect"),
  testConnection: (which: string) => post(`/connect/${enc(which)}/test`),
  disconnect: (which: string) => post(`/connect/${enc(which)}/disconnect`),
  getAiActivity: async (projectId?: string) => emptyIf(await get("/ai/activity" + (projectId ? `?projectId=${enc(projectId)}` : ""))),
  undoAiAction: (id: string) => post(`/ai/activity/${enc(id)}/undo`),
  /** The editor's AI tab (read only): what a connected AI did to this edit, with its notes. */
  getAiChat: (projectId: string) => get(`/projects/${enc(projectId)}/ai-chat`),
  /** Logins that open this account: { logins: [{ id, email, main }], current }. */
  getLogins: () => get("/account/logins"),
  /** A 6-letter code (15 minutes) the user gives their AI, which calls link_account with it. */
  createLinkCode: () => post("/account/link-code"),
  unlinkLogin: (clerkId: string) => del(`/account/logins/${enc(clerkId)}`),
  /** Deletes a style the user or their AI saved (built-in styles cannot be deleted). */
  deleteStyle: (id: string) => del(`/styles/${enc(id)}`),

  // ---- account ----
  getUsage: () => get("/account/usage"),
  getUsageHistory: () => get("/account/usage/history"),
  getProfile: () => get("/account/profile"),
  // A new email is confirmed with Clerk first (it emails a code); the server only accepts a verified, primary address.
  updateProfile: async (p: any) => {
    const want = typeof p?.email === "string" ? p.email.trim().toLowerCase() : "";
    const c = want ? await clerk() : null;
    const u = c?.user;
    if (u && want && u.primaryEmailAddress?.emailAddress?.toLowerCase() !== want) {
      try {
        let ea = u.emailAddresses.find((x: any) => x.emailAddress.toLowerCase() === want) || (await u.createEmailAddress({ email: want }));
        if (ea.verification?.status !== "verified") {
          await ea.prepareVerification({ strategy: "email_code" });
          const code = window.prompt(`We sent a 6-digit code to ${want}. Enter it to confirm your new email.`);
          if (!code || !code.trim()) throw fail("Email not changed. Save again and enter the code we send.", "email-unverified");
          ea = await ea.attemptVerification({ code: code.trim() });
        }
        await u.update({ primaryEmailAddressId: ea.id });
      } catch (e: any) {
        if (e?.friendly) throw e;
        throw fail(e?.errors?.[0]?.longMessage || e?.errors?.[0]?.message || "We could not change your email. Try again.", "email");
      }
    }
    return patch("/account/profile", p);
  },
  uploadLogo: (dataUrl: string | null) => post("/account/logo", { dataUrl }),
  getBilling: () => get("/billing"),
  updatePlan: (plan: string) => post("/billing/plan", { plan }),
  getSettings: () => get("/account/settings"),
  updateSettings: (p: any) => patch("/account/settings", p),
  search: async (q: string) => (q.trim() ? get(`/search?q=${enc(q.trim())}`) : []),
};

export const API_BASE = BASE;
export { req, fail };
void NETWORK_MSG;
