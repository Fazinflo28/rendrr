/* eslint-disable @typescript-eslint/no-explicit-any */
// The real api. Same function names, arguments and return shapes as the fake `api` in ui/rendrr-ui.html.
// Everything goes to the Rendrr API server; errors are plain-English Errors with `.friendly` and `.code`.
import { filesFromDrop, folderOfFile, localJobs } from "./local";
import { filesToAdd } from "./localPick";
import { notOriginalMessage, sameOriginal } from "@rendrr/shared";
import { BASE, DEV, NETWORK_MSG, clerk, del, demo, emptyIf, enc, fail, get, patch, post, readEvents, req, setTokenSource, wait } from "./http";
import { SUPABASE_AUTH, lastSupaToken, supa, supaMessage, supaToken } from "./supa";
import { desktopApp, forgetVerifier, newChallenge, savedVerifier } from "./desktopLogin";

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
/** When the editor last had each edit (its `updated`, ms): sent with autosaves (an AI change folded into the same
 *  version since is not overwritten). */
const stamps: Record<string, number> = {};
const videoMeta: Record<string, any> = {};
let resetSignIn: any = null;
const reviewKey = (t: string) => { try { return sessionStorage.getItem("rendrr-review-" + t) || ""; } catch { return ""; } };
const reviewHeaders = (t: string): Record<string, string> => (reviewKey(t) ? { "x-review-key": reviewKey(t) } : {});
import { keepThumb } from "./thumbs";
import { assetFile } from "./svgPng";
const remember = (v: any) => { if (v && v.id) videoMeta[v.id] = v; return keepThumb(v); };


async function finishSignIn(ticket: string) {
  const c = await clerk();
  const si = await c.client.signIn.create({ strategy: "ticket", ticket });
  if (si.status !== "complete" || !si.createdSessionId) throw fail("We could not finish logging you in. Try again.", "auth");
  await c.setActive({ session: si.createdSessionId });
  return api.getProfile();
}
const clerkMsg = (e: any, fallback: string) => fail(e?.errors?.[0]?.longMessage || e?.errors?.[0]?.message || e?.message || fallback);
// Supabase Auth (NEXT_PUBLIC_AUTH_PROVIDER=supabase): the API gets the Supabase session's token instead of Clerk's.
if (SUPABASE_AUTH) setTokenSource(supaToken);
const sbFail = (e: unknown, fallback: string, code?: string) => fail(supaMessage(e, fallback), code);
const here = () => (typeof window !== "undefined" ? window.location.origin : "");
let resetEmail = "";
let codeEmail = ""; // the email a login code was sent to

// ---------------- render: start, follow live progress, resolve with the result ----------------
// A route the server does not have (it answers "That page does not exist."): the server is an older version.
const isMissingRoute = (e: any) => e?.status === 404 && e?.message === "That page does not exist.";
const folderRoute = async <T,>(fn: () => Promise<T>): Promise<T> => {
  try { return await fn(); }
  catch (e: any) { if (isMissingRoute(e)) throw fail("Folders are not on the server yet: it is still being updated. Try again in a few minutes.", "server-old"); throw e; }
};

async function runRender(kind: "preview" | "final", projectId: string, onProgress?: (p: any) => void, opts: { best?: boolean; device?: string } = {}) {
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
  const started = await post(`/projects/${enc(projectId)}/renders`, { kind, ...(kind === "final" && opts.best ? { best: true } : {}), ...(opts.device ? { device: opts.device } : {}) });
  return followRender(started, kind === "preview" ? "Preview render" : "Final render", kind === "final" ? 17 : 5, onProgress);
}

/** Follows a started render (its live events, else polling) to its end; its result once done. */
async function followRender(started: any, label: string, minutes: number, onProgress?: (p: any) => void) {
  const id = started.renderId as string;
  const steps = started.steps || [];
  // Every progress update carries the render's id: the export window's Stop button stops it with that.
  const report = onProgress ? (p: any) => onProgress({ ...p, renderId: id }) : undefined;
  report?.({ step: 0, steps, percent: 0, etaSec: null, quality: started.quality });
  let final: any = null;
  // Phase 7: as long as the server's own limit for this render (it fails loudly when that passes), plus a margin. A
  // long or 4K final can take far longer than the old fixed 17 minutes.
  const deadline = Date.now() + (Number(started.limitMs) || minutes * 60_000) + 3 * 60_000;
  // Live stream first; if it drops, fall back to polling until the render ends.
  try {
    await readEvents(`/renders/${enc(id)}/events`, (ev, data) => {
      if (ev === "progress") report?.({ step: data.step, steps: data.steps?.length ? data.steps : steps, percent: data.percent, etaSec: data.etaSec ?? null, ahead: data.ahead ?? null, quality: started.quality, on: data.on || "cloud", device: data.device ?? null, platform: data.platform || null, next: data.next ?? null });
      if (ev === "done" || ev === "failed") { final = data; return true; }
    });
  } catch { /* poll below */ }
  let wait0 = deadline;
  while (!final && Date.now() < wait0) {
    await wait(2000);
    const s = await get(`/renders/${enc(id)}`).catch(() => null);
    if (!s) continue;
    // Still waiting its turn behind other renders: its own limit starts when it starts, so the app keeps waiting.
    if (s.status === "queued") wait0 = Math.max(wait0, Date.now() + (Number(started.limitMs) || minutes * 60_000));
    if (s.status === "done" || s.status === "failed") final = s;
    else report?.({ step: s.step, steps: s.steps?.length ? s.steps : steps, percent: s.percent, etaSec: s.etaSec ?? null, ahead: s.ahead ?? null, quality: started.quality, on: s.where?.renders || "cloud", device: s.where?.device ?? null, platform: s.where?.platform || null, next: s.where?.next ?? null });
  }
  if (!final) throw fail(label + " took too long. Try again.", "timeout");
  if (final.status === "failed") throw fail(final.error || "Render did not finish. Nothing was lost. Try again.", final.code);
  const st = final.steps?.length ? final.steps : steps;
  report?.({ step: st.length, steps: st, percent: 100 });
  // Where it was made (the user's Mac or Rendrr's cloud server), for the line under the result.
  return final.result && final.where ? { ...final.result, where: final.where } : final.result;
}

// ---------------- the api ----------------
export const api: any = {
  demo, PROC_STEPS, DRIVE_STEPS, LOCAL_STEPS, CATEGORIES,

  // ---- auth ----
  login: async (email: string, password: string) => {
    if (!email) throw fail("Enter your email to continue.");
    if (SUPABASE_AUTH) {
      if (!password) throw fail("Enter your password.");
      const { error } = await supa().auth.signInWithPassword({ email: email.trim(), password });
      if (error) throw sbFail(error, "We could not log you in. Try again.", "auth");
      return api.getProfile();
    }
    const { ticket } = await post("/auth/login", { email, password }, { auth: false });
    return finishSignIn(ticket);
  },
  signup: async (name: string, email: string, password: string) => {
    if (!email) throw fail("Enter your email to continue.");
    if (SUPABASE_AUTH) {
      if (!password || password.length < 8) throw fail("Pick a password of at least 8 characters.");
      await post("/auth/signup-check", { email: email.trim() }, { auth: false }); // invite only while the list is set
      const { data, error } = await supa().auth.signUp({ email: email.trim(), password, options: { data: { full_name: (name || "").trim() || undefined }, emailRedirectTo: here() + "/auth/callback" } });
      if (error) throw sbFail(error, "We could not create your account. Try again.", "signup");
      if (!data.session) throw fail(`Almost there: open the link we sent to ${email.trim()} to confirm your email, then log in.`, "confirm-email");
      return api.getProfile();
    }
    const { ticket } = await post("/auth/signup", { name, email, password }, { auth: false });
    return finishSignIn(ticket);
  },
  // Inside the Mac app: null in a browser. openInBrowser is there from app 0.1.2 on.
  desktopApp,
  startBrowserLogin: async () => {
    const d = desktopApp();
    if (!d?.openInBrowser) throw fail("Download the latest Rendrr app to log in with your browser, or log in with email.", "desktop-old");
    let challenge = "";
    try { challenge = await newChallenge(); } catch { throw fail("We could not start the login. Try again.", "desktop-login"); }
    const link = window.location.origin + "/desktop-login?c=" + challenge;
    d.openInBrowser(link);
    return { challenge, link };
  },
  approveDesktopLogin: (challenge: string) => post("/auth/desktop/approve", { challenge }),
  finishDesktopLogin: async (grant: string) => {
    const verifier = savedVerifier();
    if (!verifier) throw fail("This login was started too long ago or in another app. Click 'Log in with your browser' again.", "desktop-login");
    const r = await post("/auth/desktop/redeem", { grant, verifier }, { auth: false });
    forgetVerifier();
    if (r.tokenHash) {
      // Supabase: the browser's approval became a one-time magic link token, traded here for this app's own session.
      const { error } = await supa().auth.verifyOtp({ token_hash: r.tokenHash, type: "magiclink" });
      if (error) throw sbFail(error, "We could not log the app in. Click 'Log in with your browser' again.", "desktop-login");
      return api.getProfile();
    }
    return finishSignIn(r.ticket);
  },
  loginWithGoogle: async (next?: string) => {
    if (SUPABASE_AUTH) {
      const back = next || (window.location.pathname === "/login" ? "/explore" : window.location.pathname + window.location.search);
      const { error } = await supa().auth.signInWithOAuth({ provider: "google", options: { redirectTo: here() + "/auth/callback?next=" + encodeURIComponent(back) } });
      if (error) throw sbFail(error, "Google login did not start. Try again.");
      return new Promise(() => {}); // the page is leaving for Google
    }
    const c = await clerk();
    try {
      await c.client.signIn.authenticateWithRedirect({ strategy: "oauth_google", redirectUrl: "/sso-callback", redirectUrlComplete: "/explore" });
    } catch (e) { throw clerkMsg(e, "Google login did not start. Try again."); }
    return new Promise(() => {}); // the page is leaving for Google
  },
  sendReset: async (email: string) => {
    if (!email) throw fail("Enter your email and we will send a link.");
    if (SUPABASE_AUTH) {
      const { error } = await supa().auth.resetPasswordForEmail(email.trim(), { redirectTo: here() + "/reset-password" });
      if (error) throw sbFail(error, "We could not send a reset email. Try again.");
      resetEmail = email.trim();
      return { sent: true, link: true };
    }
    const c = await clerk();
    try {
      resetSignIn = await c.client.signIn.create({ strategy: "reset_password_email_code", identifier: email });
    } catch (e) { throw clerkMsg(e, "We could not send a reset code to that email."); }
    return { sent: true };
  },
  // Log in with a one-time code from email, no password (Supabase login only). Only an existing account: a code never
  // makes one. The email also has a link that logs in this browser; the code works on any device.
  codeLogin: SUPABASE_AUTH,
  sendLoginCode: async (email: string) => {
    if (!email?.trim()) throw fail("Enter your email and we will send a code.");
    if (!SUPABASE_AUTH) throw fail("Email codes are not on yet. Log in with your password or Google.");
    const { error } = await supa().auth.signInWithOtp({ email: email.trim(), options: { shouldCreateUser: false, emailRedirectTo: here() + "/auth/callback" } });
    if (error) throw sbFail(error, "We could not send a code. Try again.", "code");
    codeEmail = email.trim();
    return { sent: true };
  },
  loginWithCode: async (code: string) => {
    if (!codeEmail) throw fail("Ask for a code first.");
    const token = String(code || "").replace(/\s+/g, "");
    if (!/^\d{6,10}$/.test(token)) throw fail("Enter the code from the email.");
    const { error } = await supa().auth.verifyOtp({ email: codeEmail, token, type: "email" });
    if (error) throw sbFail(error, "That code did not work. Check the email and try again.", "code");
    return api.getProfile();
  },
  completeReset: async (code: string, password: string) => {
    if (SUPABASE_AUTH) {
      if (!password || password.length < 8) throw fail("Pick a new password of at least 8 characters.");
      // The code from the email (when the email shows one); else the reset link already gave this page a session.
      if (code?.trim()) {
        if (!resetEmail) throw fail("Ask for a new reset email first.");
        const { error } = await supa().auth.verifyOtp({ email: resetEmail, token: code.trim(), type: "recovery" });
        if (error) throw sbFail(error, "That code did not work. Check the email and try again.");
      }
      const { error } = await supa().auth.updateUser({ password });
      if (error) throw sbFail(error, "Open the link in the reset email first, then set your new password.");
      return api.getProfile();
    }
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
  logout: async () => {
    if (SUPABASE_AUTH) { await supa().auth.signOut().catch(() => {}); return { ok: true }; }
    try { const c = await clerk(); await c.signOut(); } catch { /* already out */ } return { ok: true };
  },
  hasSession: async () => { if (SUPABASE_AUTH) return !!(await supaToken()); const c = await clerk(); return !!c.session; },
  // The AI connector's login (Supabase's OAuth server): which app asks, then Allow or Deny. Each answer is where the
  // browser goes next (back to Claude or ChatGPT).
  oauthDetails: async (authorizationId: string) => {
    const { data, error } = await (supa().auth as any).oauth.getAuthorizationDetails(authorizationId);
    if (error) throw sbFail(error, "This connection request has expired. Start again from Claude or ChatGPT.", "oauth");
    return data;
  },
  oauthDecide: async (authorizationId: string, allow: boolean) => {
    const o = (supa().auth as any).oauth;
    const { data, error } = await (allow ? o.approveAuthorization(authorizationId) : o.denyAuthorization(authorizationId));
    if (error) throw sbFail(error, "That did not go through. Start again from Claude or ChatGPT.", "oauth");
    return data;
  },
  authProvider: SUPABASE_AUTH ? "supabase" : "clerk",

  // ---- library ----
  listVideos: async () => emptyIf((await get("/videos")).map(remember)),
  getVideo: async (id: string) => remember(await get(`/videos/${enc(id)}`)),
  updateVideo: async (id: string, body: { kind?: string; name?: string; libraryFolderId?: string | null }) => remember(await patch(`/videos/${enc(id)}`, body)),
  // Library folders: videos of one kind kept together, folders inside folders; a whole folder can become one edit.
  // An older server (still being updated) has no folder routes: the list is empty and the rest says so plainly.
  /** A folder imported from Google Drive brought up to date: the videos put in the Drive folder since come in. */
  syncLibraryFolder: (id: string) => post(`/library/folders/${enc(id)}/sync`, {}) as Promise<{ folderId: string; added: number; folders: number; truncated: boolean; skipped?: string; error?: string; folder: any }>,
  listLibraryFolders: async () => { try { return await get("/library/folders"); } catch (e: any) { if (isMissingRoute(e)) return []; throw e; } },
  createLibraryFolder: async (name: string, parentId?: string | null) => folderRoute(() => post("/library/folders", { name, ...(parentId ? { parentId } : {}) })),
  renameLibraryFolder: async (id: string, name: string) => folderRoute(() => patch(`/library/folders/${enc(id)}`, { name })),
  moveLibraryFolder: async (id: string, parentId: string | null) => folderRoute(() => patch(`/library/folders/${enc(id)}`, { parentId })),
  deleteLibraryFolder: async (id: string) => folderRoute(() => del(`/library/folders/${enc(id)}`)),
  moveVideos: async (videoIds: string[], libraryFolderId: string | null) => folderRoute(() => post("/videos/move", { videoIds, libraryFolderId })),
  projectFromLibraryFolder: async (id: string, o: { name?: string; folderId?: string; aspect?: string } = {}) => {
    const r = await folderRoute(() => post(`/library/folders/${enc(id)}/project`, o));
    versions[r.project.id] = r.project.version;
    return r;
  },
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

  // ---- Assets page: videos, images, elements (logos, overlays), audio, favourites, the Trash ----
  assetsSummary: () => get("/assets/summary"),
  listElements: () => get("/elements"),
  listSounds: () => get("/sounds"),
  listTrash: () => get("/trash"),
  favoriteAsset: (type: string, id: string, favorite: boolean) => patch(`/assets/${enc(type)}/${enc(id)}`, { favorite }),
  renameAsset: (type: string, id: string, name: string) => {
    if (!name?.trim()) throw fail("Give it a name.");
    return patch(`/assets/${enc(type)}/${enc(id)}`, { name: name.trim() });
  },
  trashAsset: (type: string, id: string) => post(`/assets/${enc(type)}/${enc(id)}/trash`),
  restoreTrashed: (type: string, id: string) => post(`/assets/${enc(type)}/${enc(id)}/restore`),
  // For good: elements and audio here; videos and pictures through removeVideo (it asks about edits using them).
  deleteAssetForever: (type: string, id: string, keepEdits = false) => del(`/assets/${enc(type)}/${enc(id)}${keepEdits ? "?edits=keep" : ""}`),
  emptyTrash: () => post("/trash/empty"),
  // One file into the assets: as "image" (a picture), "element" (a logo or overlay, transparent; an SVG is drawn to a
  // PNG here first) or "audio". The file goes straight to Rendrr through a one-time link.
  uploadAsset: async (file: File, as: "image" | "element" | "audio") => {
    const { body, name } = await assetFile(file, as);
    const link = await post("/assets/upload-link", { as, name });
    let r: Response;
    try { r = await fetch(`${link.url}?filename=${encodeURIComponent(name)}`, { method: "POST", body, headers: { "content-type": "application/octet-stream" } }); }
    catch { throw fail("The upload did not go through. Check your connection and try again.", "network"); }
    const out = await r.json().catch(() => null);
    if (!r.ok) throw fail(out?.error?.message || "Rendrr could not take that file.", out?.error?.code);
    return out;
  },

  // ---- Google Drive ----
  getDriveStatus: () => get("/drive/status"),
  // write: also allow saving into the user's own Drive folders (finals saved where they tell their AI).
  connectDrive: async (write = false, photos = false) => {
    const r = await post("/drive/connect", write || photos ? { ...(write ? { write: true } : {}), ...(photos ? { photos: true } : {}) } : undefined);
    if (!r.authUrl) return r;
    // Real Google consent in a popup; the API's callback page tells us when it is done.
    // The popup hands the Google code back here and we finish with our own login (see /drive/complete).
    // Without a popup the whole tab goes to Google and comes back to /drive-done, which finishes it.
    // In the Mac app Google consent happens in the browser (Google refuses app windows); /drive-done there finishes
    // it with the browser's login, and this window sees the connection appear.
    const d = desktopApp();
    if (d?.openInBrowser) {
      const before = JSON.stringify(await api.getDriveStatus().catch(() => null));
      d.openInBrowser(r.authUrl);
      for (const end = Date.now() + 5 * 60_000; Date.now() < end; ) {
        await wait(2500);
        const s = await api.getDriveStatus().catch(() => null);
        if (s?.connected && JSON.stringify(s) !== before) return s;
      }
      const s = await api.getDriveStatus();
      if (!s.connected) throw fail("Google Drive was not connected. Finish in your browser, then try again.", "drive");
      return s;
    }
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
  // libraryFolderId: the library folder the new videos go in.
  addFromDrive: async (fileIds: string[], kind?: string, libraryFolderId?: string) => (await post("/videos/drive", { fileIds, ...(kind ? { kind } : {}), ...(libraryFolderId ? { libraryFolderId } : {}) })).map(remember),
  // A whole Drive folder (and its folders): a library folder named after it with every video linked.
  importDriveFolder: async (f: { id: string; name?: string; driveId?: string }, o: { kind?: string; libraryFolderId?: string; subfolders?: boolean } = {}) => {
    const r = await post("/videos/drive-folder", { folderId: f.id, ...(f.name ? { name: f.name } : {}), ...(f.driveId ? { driveId: f.driveId } : {}), ...(o.kind ? { kind: o.kind } : {}), ...(o.libraryFolderId ? { libraryFolderId: o.libraryFolderId } : {}), ...(o.subfolders === false ? { subfolders: false } : {}) })
      .catch((e: any) => { if (isMissingRoute(e)) throw fail("Importing a Drive folder is not on the server yet: it is still being updated. Pick the videos for now, or try again in a few minutes.", "server-old"); throw e; });
    return r;
  },
  addFromComputer: async (files: File[] | null, onProgress?: (p: any) => void, kind?: string, libraryFolderId?: string) => {
    const picked = files && files.length ? Array.from(files) : null;
    if (!picked) throw fail("Pick a video file first.");
    if (DEV && (demo.failNextUpload || picked.some((f) => /fail/i.test(f.name)))) { demo.failNextUpload = false; throw fail("One of the files could not be read."); }
    // From a folder: each file keeps the folders it sat in, and the Library makes the same folders. (The list sent is a
    // new one: emptying the picked list in place once emptied it altogether, and every upload failed.)
    const { files: chosen, fromFolder } = filesToAdd(picked);
    if (!chosen.length) throw fail(fromFolder ? "There are no videos in that folder." : "Pick a video file first.");
    if (chosen.length > 200) throw fail(`That folder has ${chosen.length} videos; add up to 200 at once (a folder inside it, for example).`);
    const list = chosen;
    const made = (await post("/videos/local", { files: list.map((f) => ({ name: f.name, size: f.size, type: f.type, ...(folderOfFile(f) ? { folder: folderOfFile(f) } : {}) })), ...(kind ? { kind } : {}), ...(libraryFolderId ? { libraryFolderId } : {}) })
      .catch((e: any) => { if (fromFolder && e?.status === 400 && /files|20/i.test(e?.message || "")) throw fail("Adding a whole folder is not on the server yet: it is still being updated. Pick up to 20 videos for now.", "server-old"); throw e; })).map(remember);
    made.forEach((v: any, i: number) => { localJobs.hold(v.id, list[i]); localJobs.start(v.id); });
    onProgress?.({ percent: 5 });
    return made;
  },
  hasLocalFile: (videoId: string) => localJobs.has(videoId),
  /** The original of local footage: held by this tab, else the file this browser remembers (Chrome asks to allow it),
   *  else a file picker. Call from a click. */
  ensureLocalFile: (videoId: string) => localJobs.ensureFile(videoId),
  captureDrop: (dt: DataTransfer | null) => localJobs.capture(dt),
  /** A drop's files, a dropped folder's videos included (call inside the drop event). */
  filesFromDrop: (dt: DataTransfer | null) => filesFromDrop(dt),
  // Only a page that is really going away pauses: a hidden tab keeps making its preview.
  pauseLocalPreviews: (ev?: Event) => {
    if (!ev || ev.type !== "pagehide") return;
    const ids = localJobs.running();
    if (!ids.length) return;
    const t = SUPABASE_AUTH ? lastSupaToken() : (window as any).Clerk?.session?.lastActiveToken?.getRawString?.();
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
  // Edits into another project: { folder, moved: [{ id, from }], skipped: [{ id, why }] }.
  moveEdits: (ids: string[], folderId: string) => post("/projects/move", { ids, folderId }),
  deleteAsset: (id: string) => del(`/projects/${enc(id)}`),
  restoreAsset: (id: string) => post(`/projects/${enc(id)}/restore`),

  // ---- projects (assets inside folders) ----
  listProjects: async () => emptyIf(await get("/projects")),
  getProject: async (id: string) => { const p = await get(`/projects/${enc(id)}`); versions[id] = p.version; if (typeof p.updated === "number") stamps[id] = p.updated; return p; },
  // Engine Part 6: the marks on the edit's footage where they play (thin lines on the timeline).
  getProjectMarks: async (id: string) => emptyIf(await get(`/projects/${enc(id)}/marks`)),
  // A new edit is the raw footage. `reference` ({ kind: style | recipe | video, id }) is attached for the AI, never applied.
  // videoIds: several videos in order (a video filmed in parts); the first is the edit's footage.
  createProject: async ({ videoId, videoIds, reference, name, folderId, cut, aspect, blank, waiting }: any) => {
    const ids = Array.isArray(videoIds) && videoIds.length ? videoIds : videoId ? [videoId] : [];
    if (!ids.length && !blank && !waiting) throw fail("Pick footage first.");
    // waiting (Recreate): the edit opens at once and waits for its footage.
    const p = await post("/projects", { ...(waiting ? { waiting: true } : blank ? { blank } : ids.length > 1 ? { videoIds: ids } : { videoId: ids[0] }), reference: reference ? { kind: reference.kind, id: reference.id } : undefined, name: name || undefined, folderId: folderId || undefined, cut: Array.isArray(cut) ? cut : undefined, aspect: aspect || undefined });
    versions[p.id] = p.version;
    return p;
  },
  // The Rendrr Mac app: it is open (every 20 s, with what it can render), the finals your AI exported to it, and
  // taking one to save.
  // platform: "windows" from the Rendrr Windows app (a Mac app sends "mac").
  // deviceId: this computer's own id (one account can be open on several computers).
  macPing: (version: string, device = "", render: any = null, platform = "mac", deviceId = "") => post("/desktop/ping", { version, device, platform, ...(deviceId ? { deviceId } : {}), ...(render ? { render } : {}) }),
  // Renders waiting for this Mac, and taking one (its files, runs and token come back for the Mac app to make it).
  macTasks: async (deviceId = "") => { try { return ((await get(`/desktop/tasks${deviceId ? `?device=${enc(deviceId)}` : ""}`)) as any).tasks || []; } catch (e: any) { if (isMissingRoute(e)) return []; throw e; } },
  macClaimTask: (id: string, device = "", platform = "mac", deviceId = "") => post(`/desktop/tasks/${enc(id)}/claim`, { device, platform, ...(deviceId ? { deviceId } : {}) }) as Promise<{ task: any }>,
  // The computer to render on, picked in the web app (its id, or "cloud"): remembered as Claude's pick is.
  setRenderChoice: (device: string) => post("/desktop/choice", { device }),
  // Whether the Rendrr Mac app is open (on which Mac), whether renders are made on it, and where the AI's finals go.
  macStatus: async () => { try { return await get("/desktop/status"); } catch (e: any) { if (isMissingRoute(e)) return { online: false, device: null, version: null, seenAt: null }; throw e; } },
  macExports: async (deviceId = "") => { try { return await get(`/desktop/exports${deviceId ? `?device=${enc(deviceId)}` : ""}`); } catch (e: any) { if (isMissingRoute(e)) return []; throw e; } },
  macClaim: (renderId: string, deviceId = "") => post(`/desktop/exports/${enc(renderId)}/claim`, deviceId ? { deviceId } : {}) as Promise<{ claimed: boolean }>,
  // The footage of an edit that was waiting for it (Recreate): the first videos the user adds.
  useFootage: async (id: string, videoIds: string[]) => post(`/projects/${id}/footage`, { videoIds }),
  updateProject: async (id: string, p: any) => {
    const body = p.timeline ? { ...p, baseVersion: versions[id], ...(stamps[id] ? { baseAt: stamps[id] } : {}) } : p;
    const r = await patch(`/projects/${enc(id)}`, body);
    if (r && typeof r.version === "number") versions[id] = r.version;
    if (r && typeof r.updated === "number") stamps[id] = r.updated;
    return r;
  },
  restoreVersion: (projectId: string, v: number) => post(`/projects/${enc(projectId)}/versions/${v}/restore`),
  /** Auto reframe: where the speaker's face is in these clips (shares of the picture as turned), null where none. */
  /** remove_background: the links of a video's matte blocks over footage from..to (null: still being made). */
  matte: (projectId: string, videoId: string, from: number, to: number, rotate = 0) => get(`/projects/${enc(projectId)}/matte?video=${enc(videoId)}&from=${from}&to=${to}&rotate=${rotate}`) as Promise<{ turn: number; block: number; blocks: Record<string, string | null> }>,
  skinAreas: (projectId: string, clips: { id: string; videoId: string; srcIn: number; srcOut: number; rotate: number; focus: { x: number; y: number } | null }[], aspect?: string) => post(`/projects/${enc(projectId)}/skin-areas`, { clips, aspect }) as Promise<{ areas: Record<string, { shape: "ellipse"; x: number; y: number; w: number; h: number; feather?: number } | null> }>,
  // Phase 3: each clip's face over it ([footage second, x0, y0, x1, y1] on screen), for a shape that follows the face.
  /** Phase 10: a camera synced to the edit's main video by their sound (offset: its second at the main video's 0). */
  // Phase 13: who speaks when, from each camera's own sound; the plan goes in a multicam_auto op.
  multicamAuto: (projectId: string, o: { cameras?: string[]; wide?: string; minShot?: number; start?: number; end?: number } = {}) => post(`/projects/${enc(projectId)}/multicam-auto`, o) as Promise<{ plan: { start: number; end: number; angle: string }[] }>,
  multicamSync: (projectId: string, videoId: string) => post(`/projects/${enc(projectId)}/multicam-sync`, { videoId }) as Promise<{ videoId: string; name: string; offset: number; score: number; margin: number; overlap: number; sure: boolean; rotate?: 0 | 90 | 180 | 270; by?: "timecode" | "sound"; note?: string; checked?: boolean }>,
  faceTracks: (projectId: string, clips: { id: string; videoId: string; srcIn: number; srcOut: number; rotate: number; focus: { x: number; y: number } | null }[], aspect?: string) => post(`/projects/${enc(projectId)}/face-tracks`, { clips, aspect }) as Promise<{ tracks: Record<string, [number, number, number, number, number][] | null> }>,
  /** Object tracking: the box drawn on a clip (its footage second `at`) followed through its footage [from, to]. */
  trackObject: (projectId: string, b: { videoId: string; from: number; to: number; at: number; box: { x: number; y: number; w: number; h: number }; rotate?: number; fitY?: number; focus?: { x: number; y: number } | null; shift?: number; aspect?: string }) => post(`/projects/${enc(projectId)}/track`, b) as Promise<{ rows: [number, number, number, number, number, number][] }>,
  speakerCentres: (projectId: string, clips: { id: string; videoId: string; srcIn: number; srcOut: number; rotate: number }[]) => post(`/projects/${enc(projectId)}/speaker`, { clips }) as Promise<{ centers: Record<string, { x: number; y: number } | null> }>,
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
  galleryBreakdown: (id: string) => get(`/gallery/${enc(id)}/breakdown`),
  makeGalleryBreakdown: (id: string) => post(`/gallery/${enc(id)}/breakdown`),

  // ---- render ----
  renderPreview: (projectId: string, onProgress?: (p: any) => void, opts?: { device?: string }) => runRender("preview", projectId, onProgress, opts),
  // device: which of the user's computers renders it (its id), or "cloud"; none: the best one free.
  renderFinal: (projectId: string, onProgress?: (p: any) => void, opts?: { best?: boolean; device?: string }) => runRender("final", projectId, onProgress, opts),
  // Samples: a few frames and short clips drawn as the export draws them; the set once done (its pictures and clips).
  renderSamples: async (projectId: string, ask: { frames?: { at: number; note?: string }[]; clips?: { start: number; end?: number; note?: string }[] }, onProgress?: (p: any) => void) => {
    const started = await post(`/projects/${enc(projectId)}/samples`, ask);
    return (await followRender(started, "Samples", 5, onProgress))?.samples ?? null;
  },
  listSamples: async (projectId: string) => (await get(`/projects/${enc(projectId)}/samples`)).sets || [],
  // Storyboard mode: a board of panels and the style sheet, made from the edit (panels left out: Rendrr picks them);
  // the board once drawn.
  renderStoryboard: async (projectId: string, req: { title?: string; panels?: any[]; rules?: string[]; palette?: { hex: string; name?: string }[] } = {}, onProgress?: (p: any) => void) => {
    const started = await post(`/projects/${enc(projectId)}/storyboards`, req);
    return (await followRender(started, "The storyboard", 10, onProgress))?.samples ?? null;
  },
  listStoryboards: async (projectId: string) => (await get(`/projects/${enc(projectId)}/storyboards`)).boards || [],
  getStoryboard: (renderId: string) => get(`/storyboards/${enc(renderId)}`),
  approveStoryboard: (renderId: string, approved = true) => post(`/storyboards/${enc(renderId)}/approve`, { approved }),
  // Local source only: the original is uploaded once for the export and deleted within 24h.
  uploadOriginalForExport: async (projectId: string, file: File | null, onProgress?: (p: any) => void, signal?: AbortSignal) => {
    const p = await get(`/projects/${enc(projectId)}`);
    const v = p.video || {};
    // A file this browser only remembers (no File in this tab yet) is opened here, not given up on.
    const f = file || localJobs.file(p.videoId) || (await localJobs.ensureFile(p.videoId));
    if (!f) throw fail("Pick the original file to continue.", "need-original");
    // The same name and size; else a renamed or re-saved copy of the same video (its length matches).
    const want = { originalName: v.originalName, originalSize: v.originalSize, seconds: v.seconds };
    let seconds: number | null = null;
    if (!sameOriginal({ name: f.name, size: f.size }, want).ok) {
      seconds = await localJobs.length(f);
      if (!sameOriginal({ name: f.name, size: f.size, seconds }, want).ok) throw fail(notOriginalMessage({ name: f.name, size: f.size, seconds }, want), "wrong-file");
    }
    // Keep the picked file in this tab: the next export uploads it without asking again.
    if (file) localJobs.hold(p.videoId, f);
    const steps = ["Uploading original"];
    onProgress?.({ step: 0, steps, percent: 0 });
    const up = await post(`/projects/${enc(projectId)}/original`, { name: f.name, size: f.size, ...(seconds != null ? { seconds } : {}) });
    let parts;
    try { parts = await localJobs.uploadParts(f, up.urls, up.partSize, (pct, eta) => onProgress?.({ step: 0, steps, percent: Math.min(99, Math.round(pct)), etaSec: eta ?? null }), signal); }
    catch (e: any) {
      // Stopped (Stop export) or failed: the half-sent upload is thrown away on the storage too.
      post(`/projects/${enc(projectId)}/original/abort`, { uploadId: up.uploadId }).catch(() => {});
      if (signal?.aborted) throw fail("You stopped this export.", "stopped");
      throw e;
    }
    const done = await post(`/projects/${enc(projectId)}/original/complete`, { uploadId: up.uploadId, parts });
    onProgress?.({ step: 1, steps, percent: 100 });
    return done;
  },
  deleteAllFinals: () => post("/account/delete-finals"),
  // "Stop export": the render ends at once (failed, code "stopped"); the export window closes on that.
  stopRender: (renderId: string) => post(`/renders/${enc(renderId)}/stop`),
  saveFinalToDrive: (renderId: string) => post(`/renders/${enc(renderId)}/save-to-drive`),

  // ---- reviews ----
  listReviews: async () => emptyIf(await get("/reviews")),
  createReviewLink: (opts: any) => {
    if (!opts.projectId && !opts.folderId) throw fail("Pick a project or a folder to share.");
    return post("/reviews", opts);
  },
  listFoldersLite: () => get("/folders?lite=1"),
  // A link the user's AI made (/add/<pick>): what it asked for, the files that arrived, and adding to it.
  getPick: (id: string) => get(`/picks/${enc(id)}`),
  reportPick: (id: string, videoIds: string[]) => post(`/picks/${enc(id)}/items`, { videoIds }),
  finishPick: (id: string) => post(`/picks/${enc(id)}/done`, {}),
  // The Library's and the editor's Dropbox tab: a pick to track its files, and share links brought in in the background.
  createPick: (source: string, projectId?: string | null, kind?: string | null) => post("/picks", { source, ...(projectId ? { projectId } : {}), ...(kind ? { kind } : {}) }),
  importLinks: (id: string, urls: string[]) => post(`/picks/${enc(id)}/links`, { urls }),
  startPhotos: (id: string) => post(`/picks/${enc(id)}/photos`),
  // The newest Mac and Windows apps ({ mac: { version, link }, windows: { version, link } }): an older app is offered the update.
  latestDesktop: () => get("/downloads/latest", { auth: false }),
  getReview: (t: string) => get(`/public/reviews/${enc(t)}`, { auth: false, headers: reviewHeaders(t) }),
  getReviewMedia: (t: string, v?: number) => get(`/public/reviews/${enc(t)}/media${v ? `?v=${v}` : ""}`, { auth: false, headers: reviewHeaders(t) }),
  checkReviewPassword: async (t: string, pw: string) => {
    const r = await post(`/public/reviews/${enc(t)}/unlock`, { password: pw || "" }, { auth: false });
    try { sessionStorage.setItem("rendrr-review-" + t, r.key); } catch { /* private mode: unlock lasts this page only */ }
    return { ok: true };
  },
  addReviewComment: (t: string, { time, text, projectId, x, y, name }: any) => post(`/public/reviews/${enc(t)}/comments`, { time, text, projectId, ...(name ? { name } : {}), ...(x != null && y != null ? { x, y } : {}) }, { auth: false, headers: reviewHeaders(t) }),
  resolveComment: (commentId: string, resolved = true) => patch(`/comments/${enc(commentId)}`, { resolved }),
  // "Send to Claude": the edit's open comments (or `ids`) go to the connected AI; returns its chat link with them ready.
  sendComments: (projectId: string, ai: "claude" | "chatgpt", ids?: string[]) => post(`/projects/${enc(projectId)}/comments/send`, { ai, ...(ids?.length ? { ids } : {}) }),
  editComment: (commentId: string, text: string) => {
    if (!text?.trim()) throw fail("Write the comment first.");
    return patch(`/comments/${enc(commentId)}`, { text: text.trim() });
  },
  deleteComment: (commentId: string) => del(`/comments/${enc(commentId)}`),
  /** drawing: strokes on the picture ({w, h, strokes}); images: [{type, data (base64), name, w, h}] (up to 4). */
  // renderId: the render it is on (a storyboard's panel).
  // x, y: a pin, the spot on the picture it was left on (0-1 of the frame).
  addProjectComment: (projectId: string, { time, text, drawing, images, renderId, x, y }: any) => {
    if (!text?.trim() && !drawing?.strokes?.length && !images?.length) throw fail("Write a comment, draw on the picture or add a picture first.");
    return post(`/projects/${enc(projectId)}/comments`, { time: Math.max(0, Number(time) || 0), text: (text || "").trim(), ...(drawing?.strokes?.length ? { drawing } : {}), ...(images?.length ? { images } : {}), ...(renderId ? { renderId } : {}), ...(x != null && y != null ? { x, y } : {}) });
  },
  approveReview: (t: string) => post(`/public/reviews/${enc(t)}/approve`, {}, { auth: false, headers: reviewHeaders(t) }),
  requestChanges: (t: string, note: string, name?: string) => post(`/public/reviews/${enc(t)}/changes`, { note, ...(name ? { name } : {}) }, { auth: false, headers: reviewHeaders(t) }),

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
    if (SUPABASE_AUTH && want) {
      // Supabase emails a link to the new address; the API copies it once that link is opened.
      const { data } = await supa().auth.getUser();
      if (data.user?.email?.toLowerCase() !== want) {
        const { error } = await supa().auth.updateUser({ email: want }, { emailRedirectTo: here() + "/settings" });
        if (error) throw sbFail(error, "We could not change your email. Try again.", "email");
        const { email: _e, ...rest } = p;
        if (Object.keys(rest).length) await patch("/account/profile", rest);
        throw fail(`We sent a link to ${want}. Open it, then save again to finish changing your email.`, "email-unverified");
      }
      return patch("/account/profile", p);
    }
    const c = want && !SUPABASE_AUTH ? await clerk() : null;
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
  // Usage & billing: the page, Stripe checkout for Starter, Stripe's card page, the spending limit.
  getBillingOverview: () => get("/billing/overview"),
  startCheckout: () => post("/billing/checkout", {}),
  openBillingPortal: () => post("/billing/portal", {}),
  setSpendLimit: (cents: number) => post("/billing/limit", { cents }),
  // Admin panel (Rendrr's team).
  adminMe: () => get("/admin/me"),
  adminOverview: () => get("/admin/overview"),
  adminUsers: (o: { q?: string; sort?: string; plan?: string } = {}) => get(`/admin/users?${new URLSearchParams(Object.entries(o).filter(([, v]) => v) as [string, string][]).toString()}`),
  adminUser: (id: string) => get(`/admin/users/${enc(id)}`),
  adminChangeUser: (id: string, change: Record<string, unknown>) => post(`/admin/users/${enc(id)}`, change),
  adminCosts: (days = 30) => get(`/admin/costs?days=${days}`),
  adminStorage: () => get("/admin/storage"),
  adminIssues: (days = 7) => get(`/admin/issues?days=${days}`),
  adminResolveClientError: (id: string) => post(`/admin/issues/client/${enc(id)}/resolve`, {}),
  adminJobs: (o: { queue?: string; event?: string } = {}) => get(`/admin/jobs?${new URLSearchParams(Object.entries(o).filter(([, v]) => v) as [string, string][]).toString()}`),
  reportClientError: (e: { message: string; stack?: string; url?: string; userId?: string | null }) => post("/telemetry/client-error", e).catch(() => {}),
  getSettings: () => get("/account/settings"),
  updateSettings: (p: any) => patch("/account/settings", p),
  search: async (q: string) => (q.trim() ? get(`/search?q=${enc(q.trim())}`) : []),
};

export const API_BASE = BASE;
export { req, fail };
void NETWORK_MSG;
