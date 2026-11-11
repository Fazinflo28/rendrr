/* ===================== app: routes + root ===================== */
// Ported from ui/rendrr-ui-v2.html (app script). The route is the real URL (Next.js); `go` pushes it.
// Screen paths:
//   /explore (public)  /create/:cat (public, actions gated)  /styles (public)  /library  /library/:id  /projects  /projects/:id
//   /editor/:id  /review/:token  /connect  /usage (Usage & billing)  /billing (its Billing tab)  /admin (team)  /settings
//   Login is a modal over Explore (Higgsfield-style): browse free, act after logging in. /login opens that modal.
import { usePathname, useRouter } from "next/navigation";
import { useState, useEffect, useCallback, html, ToastHost, useToast, readTheme, applyTheme, NavCtx, AppCtx, EmptyState, Btn, useNav, useApp, forgetPages } from "./ui";
import { AppIcon, Mark } from "./logo";
import { appLink, isChallenge } from "./desktopLogin";
import { AssetsPage } from "./assets";
import { LoginPage, HomePage, CreatePage, LibraryPage, FootagePage, ProjectsPage, FolderPage, StylesPage, ClientReviewPage, ConnectPage, SettingsPage, Shell } from "./screens";
import { UsageBillingPage, LimitDialog } from "./billing";
import { AdminPage } from "./admin";
import { EditorPage } from "./editor";
import { api } from "./api";
const ROUTES = [
  [/^\/(explore|home)?$/, () => html`<${HomePage} />`, { pub: true }],
  [/^\/create\/([^/]+)$/, (m) => html`<${CreatePage} cat=${m[1]} />`, { pub: true }],
  [/^\/styles$/, () => html`<${StylesPage} />`, { pub: true }],
  [/^\/library$/, () => html`<${AssetsPage} section="videos" />`],
  [/^\/assets$/, () => html`<${AssetsPage} section="all" />`],
  [/^\/assets\/(videos|images|elements|audio|favorites|trash)$/, (m) => html`<${AssetsPage} key=${m[1]} section=${m[1]} />`],
  [/^\/library\/([^/]+)$/, (m) => html`<${FootagePage} id=${m[1]} />`],
  [/^\/projects$/, () => html`<${ProjectsPage} />`],
  [/^\/projects\/([^/]+)$/, (m) => html`<${FolderPage} id=${m[1]} />`],
  [/^\/editor\/([^/]+)$/, (m) => html`<${EditorPage} id=${m[1]} />`, { full: true }],
  [/^\/review\/([^/]+)$/, (m) => html`<${ClientReviewPage} token=${m[1]} />`, { bare: true }],
  [/^\/connect$/, () => html`<${ConnectPage} />`],
  [/^\/usage$/, () => html`<${UsageBillingPage} key="usage" />`],
  [/^\/billing$/, () => html`<${UsageBillingPage} key="billing" initialTab="billing" />`],
  [/^\/admin$/, () => html`<${AdminPage} />`],
  [/^\/settings$/, () => html`<${SettingsPage} />`],
  [/^\/sso-callback$/, () => null, { bare: true }], // Clerk finishes Google sign-in here (src/app/sso-callback)
  [/^\/drive-done$/, () => html`<${DriveDone} />`, { bare: true }],
  [/^\/desktop-login$/, () => html`<${DesktopLogin} />`, { bare: true }],
  // Supabase Auth: Google (and confirm-email links) come back here; the reset link; the AI connector's consent.
  [/^\/auth\/callback$/, () => html`<${AuthCallback} />`, { bare: true }],
  [/^\/reset-password$/, () => html`<${ResetPassword} />`, { bare: true }],
  [/^\/oauth\/consent$/, () => html`<${OAuthConsent} />`, { bare: true }],
];

// Any other address: say so instead of quietly showing Explore.
function NotFound() {
  const { go } = useNav();
  return html`<div class="page"><${EmptyState} icon="search" title="That page does not exist" text="The link may be old or mistyped." action=${html`<${Btn} onClick=${() => go("/explore")}>Go to Explore<//>`} /></div>`;
}
const NOT_FOUND = [/^/, () => html`<${NotFound} />`, { pub: true }];

// Log the Mac app in through the browser (api.startBrowserLogin). Two halves on one page:
//  ?c=<challenge>  in the browser: the logged-in person allows it, and the page hands a grant to the app (rendrr://).
//  ?grant=<grant>  in the app (it opens this page with the grant): trade it for a login, then go to Projects.
function DesktopLogin() {
  const { user, setUser, auth, openLogin } = useApp(); const { go } = useNav();
  const q = typeof window !== "undefined" ? new URLSearchParams(window.location.search) : new URLSearchParams();
  const c = q.get("c") || "", grant = q.get("grant") || "";
  const [state, setState] = useState(grant ? "finishing" : "ask"); // ask | allowing | done | cancelled | error | finishing
  const [msg, setMsg] = useState(""); const [openLink, setOpenLink] = useState("");
  useEffect(() => {
    if (!grant) return;
    (async () => {
      try { const u = await api.finishDesktopLogin(grant); setUser(u); go("/projects"); }
      catch (e) { setState("error"); setMsg(e.message); }
    })();
  }, []);
  const allow = async () => {
    setState("allowing");
    try {
      const r = await api.approveDesktopLogin(c);
      const link = appLink(r.grant);
      setOpenLink(link); setState("done");
      window.location.href = link;
    } catch (e) { setState("error"); setMsg(e.message); }
  };
  const card = (body) => html`<div class="dl-wrap"><div class="dl-card" id="desktop-login"><${AppIcon} size=${56} />${body}</div></div>`;
  if (grant) return card(state === "error"
    ? html`<h1>Not logged in</h1><p>${msg}</p><div class="dl-row"><${Btn} id="dl-again" onClick=${() => go("/login")}>Try again<//></div>`
    : html`<h1>Logging you in…</h1><p>One moment.</p>`);
  if (!isChallenge(c)) return card(html`<h1>This link is not right</h1><p>Open the Rendrr app and click <b>Log in with your browser</b> again.</p>`);
  if (!user) return card(auth === "checking" ? html`<h1>One moment…</h1>`
    : html`<h1>Log in to the Rendrr app</h1><p>First log in to Rendrr in this browser. Then you can allow the app.</p><div class="dl-row"><${Btn} id="dl-login" onClick=${() => openLogin()}>Log in<//></div>`);
  if (state === "done") return card(html`<h1>You're logged in</h1><p>Go back to the Rendrr app. If it did not open, click below.</p><div class="dl-row"><a class="btn" id="dl-open" href=${openLink}>Open Rendrr<//></div><p class="dl-note">You can close this tab.</p>`);
  if (state === "cancelled") return card(html`<h1>Cancelled</h1><p>The app was not logged in. You can close this tab.</p>`);
  if (state === "error") return card(html`<h1>That did not work</h1><p>${msg}</p><p class="dl-note">Open the Rendrr app and click <b>Log in with your browser</b> again.</p>`);
  return card(html`<h1>Log in to the Rendrr app?</h1>
    <p>You are logged in as <b>${user.email || user.name}</b>. Allow the Rendrr app on this computer to log in to the same account.</p>
    <div class="dl-row"><${Btn} id="dl-allow" disabled=${state === "allowing"} onClick=${allow}>${state === "allowing" ? "One moment…" : "Allow"}<//><${Btn} kind="secondary" id="dl-cancel" onClick=${() => setState("cancelled")}>Cancel<//></div>
    <p class="dl-note">Only click Allow if you just clicked <b>Log in with your browser</b> in the Rendrr app.</p>`);
}

// Supabase Auth sends the browser back here after Google (or a confirm-email link): the code in the URL becomes this
// browser's session (supabase-js trades it), then on to where the person was going.
function AuthCallback() {
  const { setUser } = useApp(); const { go } = useNav();
  const [msg, setMsg] = useState("");
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const next = q.get("next") || "/explore";
    const safe = next.startsWith("/") && !next.startsWith("//") ? next : "/explore";
    (async () => {
      try {
        if (q.get("error_description")) throw new Error(q.get("error_description"));
        for (let i = 0; i < 40 && !(await api.hasSession()); i++) await new Promise((r) => setTimeout(r, 150));
        if (!(await api.hasSession())) throw new Error("We could not log you in. Try again.");
        const u = await api.getProfile(); setUser(u);
        window.location.replace(safe);
      } catch (e) { setMsg(e.message || "We could not log you in. Try again."); }
    })();
  }, []);
  return html`<div class="dl-wrap"><div class="dl-card" id="auth-callback"><${AppIcon} size=${56} />${msg
    ? html`<h1>Not logged in</h1><p>${msg}</p><div class="dl-row"><${Btn} onClick=${() => go("/login")}>Try again<//></div>`
    : html`<h1>Logging you in…</h1><p>One moment.</p>`}</div></div>`;
}

// The reset link from the email lands here (it logs this browser in for the change): pick a new password.
function ResetPassword() {
  const { setUser } = useApp();
  const [pw, setPw] = useState(""); const [busy, setBusy] = useState(false); const [msg, setMsg] = useState(""); const [ready, setReady] = useState(null);
  useEffect(() => { (async () => { for (let i = 0; i < 40 && !(await api.hasSession()); i++) await new Promise((r) => setTimeout(r, 150)); setReady(await api.hasSession()); })(); }, []);
  const save = async (e) => { e.preventDefault(); setBusy(true); setMsg(""); try { const u = await api.completeReset("", pw); setUser(u); window.location.replace("/explore"); } catch (er) { setMsg(er.message); setBusy(false); } };
  return html`<div class="dl-wrap"><div class="dl-card" id="reset-password"><${AppIcon} size=${56} />${ready === false
    ? html`<h1>This link has expired</h1><p>Ask for a new reset email from the login window (Forgot password).</p>`
    : html`<h1>Set a new password</h1><form class="col" style="gap:10px;width:100%" onSubmit=${save}><input class="input" id="new-password" type="password" autocomplete="new-password" placeholder="New password (8+ characters)" value=${pw} onInput=${(e) => setPw(e.target.value)} />
        ${msg && html`<p role="alert" class="t-small">${msg}</p>`}<div class="dl-row"><${Btn} id="save-password" type="submit" disabled=${busy || ready == null || pw.length < 8}>${busy ? "Saving…" : "Save and log in"}<//></div></form>`}</div></div>`;
}

// The AI connector logging in (Supabase's OAuth server sends Claude or ChatGPT here): log in if needed, then allow it.
function OAuthConsent() {
  const { user, auth, openLogin } = useApp();
  const id = typeof window !== "undefined" ? new URLSearchParams(window.location.search).get("authorization_id") || "" : "";
  const [d, setD] = useState(null); const [err, setErr] = useState(""); const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!user || !id) return;
    api.oauthDetails(id).then((x) => { if (x?.redirect_url && !x.authorization_id) window.location.replace(x.redirect_url); else setD(x); }).catch((e) => setErr(e.message));
  }, [user, id]);
  const decide = async (allow) => { setBusy(true); try { const r = await api.oauthDecide(id, allow); window.location.replace(r.redirect_url); } catch (e) { setErr(e.message); setBusy(false); } };
  const card = (body) => html`<div class="dl-wrap"><div class="dl-card" id="oauth-consent"><${AppIcon} size=${56} />${body}</div></div>`;
  if (!id) return card(html`<h1>This link is not right</h1><p>Start again from Claude or ChatGPT: add the Rendrr connector, then Connect.</p>`);
  if (!user) return card(auth === "checking" ? html`<h1>One moment…</h1>` : html`<h1>Log in to connect</h1><p>Log in to Rendrr, then allow the connection.</p><div class="dl-row"><${Btn} id="oauth-login" onClick=${() => openLogin()}>Log in<//></div>`);
  if (err) return card(html`<h1>That did not work</h1><p>${err}</p>`);
  if (!d) return card(html`<h1>One moment…</h1>`);
  const app = d.client?.client_name || d.client?.name || "This app";
  return card(html`<h1>Connect ${app} to Rendrr?</h1>
    <p><b>${app}</b> will be able to see your footage and edits and make changes in your account (<b>${d.user?.email || user.email}</b>).</p>
    <div class="dl-row"><${Btn} id="oauth-allow" disabled=${busy} onClick=${() => decide(true)}>${busy ? "One moment…" : "Allow"}<//><${Btn} kind="secondary" id="oauth-deny" disabled=${busy} onClick=${() => decide(false)}>Deny<//></div>
    <p class="dl-note">You can turn it off any time in Rendrr › Connect AI.</p>`);
}

// Google Drive consent without a popup comes back here; finish it with this browser's own login.
function DriveDone() {
  const [msg, setMsg] = useState("Connecting Google Drive…");
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    (async () => {
      try {
        if (!(await api.hasSession())) throw new Error("Log in to Rendrr first, then connect Google Drive again.");
        await api.completeDrive(q.get("code") || "", q.get("state") || "");
        setMsg("Google Drive connected.");
        if (window.opener) setTimeout(() => window.close(), 800);
        else setTimeout(() => window.location.replace("/library"), 800);
      } catch (e) { setMsg(e.message || "Google Drive was not connected. Try again."); }
    })();
  }, []);
  return html`<div class="dl-wrap"><div class="dl-card" id="drive-done"><${AppIcon} size=${56} /><p>${msg}</p></div></div>`;
}

function App() {
  const pathname = usePathname() || "/";
  const router = useRouter();
  const route = pathname === "/" || pathname === "/login" ? "/explore" : pathname;
  // Login modal: `after` runs once the user is in (the action they tried, or the page they wanted).
  const [login, setLogin] = useState(null); // null | { after, mode }
  const openLogin = useCallback((after, mode) => setLogin({ after: after || null, mode: mode || "login" }), []);
  const closeLogin = useCallback(() => setLogin(null), []);
  const [nonce, setNonce] = useState(0);
  const [user, setUser0] = useState(null);
  // A different account (or none): the pages remembered for the last one are forgotten before anything renders.
  const setUser = useCallback((u) => setUser0((prev) => { const next = typeof u === "function" ? u(prev) : u; if ((prev?.id || null) !== (next?.id || null)) forgetPages(); return next; }), []);
  const [auth, setAuth] = useState("checking"); // checking | in | out
  // Signed in last time on this browser: while the session is checked the page is drawn as signed in (tab bar, no
  // Log in buttons), so a refresh does not flash the logged-out header.
  const [wasIn] = useState(() => { try { return localStorage.getItem("rendrr:in") === "1"; } catch { return false; } });
  useEffect(() => { try { if (auth === "in") localStorage.setItem("rendrr:in", "1"); else if (auth === "out") localStorage.removeItem("rendrr:in"); } catch { /* private window */ } }, [auth]);
  const [usage, setUsage] = useState(null);
  const [uploads, setUploads] = useState([]);
  const [theme, setThemeState] = useState(readTheme);
  useEffect(() => { applyTheme(theme); }, []);
  const toast = useToast();
  useMacExports(user, toast);
  useMacRenders(user, toast);
  useClientErrors(user);
  // A plan limit reached anywhere (a render, an upload): one dialog says what ran out and where to top up.
  const [limit, setLimit] = useState(null);
  useEffect(() => { const on = (e) => setLimit(e.detail?.message || "Your plan's allowance is used up."); window.addEventListener("rendrr:billing", on); return () => window.removeEventListener("rendrr:billing", on); }, []);
  const go = useCallback((path, force) => { if (path !== window.location.pathname) router.push(path); if (force) setNonce((n) => n + 1); document.querySelector(".main")?.scrollTo?.(0, 0); }, [router]);
  const refreshUsage = useCallback(() => api.getUsage().then(setUsage).catch(() => {}), []);
  useEffect(() => { if (user) refreshUsage(); }, [user]);
  // Signed in with Clerk already (or just back from Google)? Load the profile instead of showing /login.
  useEffect(() => {
    if (user) { setAuth("in"); return; }
    let on = true;
    // Known to be logged out: stays so while it is checked again (no Log in buttons blinking on every page change).
    setAuth((a) => (a === "out" ? "out" : "checking"));
    (async () => {
      try { if (await api.hasSession()) { const u = await api.getProfile(); if (on) { setUser(u); setAuth("in"); return; } } } catch { /* fall through */ }
      if (on) setAuth("out");
    })();
    return () => { on = false; };
  }, [pathname, !!user]);
  useEffect(() => { if (pathname === "/login" && user) router.replace("/explore"); }, [pathname, user]);
  const setTheme = (t) => { setThemeState(t); applyTheme(t); };
  // Upload from the top bar or the library: always lands in /library and finishes on its own.
  const [addOpen, setAddOpen] = useState(false);
  const ping = () => window.dispatchEvent(new Event("rendrr:library"));
  // From your computer: the file stays on the machine, we make a light preview in the browser.
  const startUpload = useCallback(async (files, kind, libraryFolderId) => {
    go("/library"); setAddOpen(false); const list = files ? (files.length != null ? Array.from(files) : [files]) : null;
    if (!list?.length) return;
    // A folder picked or dropped whole: the Library makes the same folders and opens the top one.
    const top = list.map((f) => f.rendrrFolder ?? (f.webkitRelativePath && f.webkitRelativePath.includes("/") ? f.webkitRelativePath.split("/")[0] : "")).find(Boolean)?.split("/")[0];
    toast("Preparing " + (top ? `the folder "${top}"` : list.length === 1 ? list[0].name : list.length + " files") + (kind === "reference" ? " as a reference" : ""), { icon: "laptop" });
    const job = api.addFromComputer(list, undefined, kind, libraryFolderId); setTimeout(ping, 50);
    try {
      const made = await job;
      if (top) {
        const fs = await api.listLibraryFolders().catch(() => []);
        const f = fs.find((x) => (x.parentId || null) === (libraryFolderId || null) && x.name.toLowerCase() === top.toLowerCase());
        if (f) { try { sessionStorage.setItem("rendrr:libfolder", f.id); } catch { /* private window */ } window.dispatchEvent(new CustomEvent("rendrr:openfolder", { detail: f.id })); }
      }
      toast(`${top ? `${made.length} ${made.length === 1 ? "video" : "videos"} from "${top}". ` : ""}Keep this tab open while we prepare your preview${made.length > 1 ? "s, two at a time" : ""}.`, { icon: "clock", ms: 4000 });
    }
    catch (e) { toast(e.message, { icon: "alert", ms: 4000 }); }
    ping();
  }, [go]);
  // A whole Drive folder: the Library opens on the folder it made.
  // Several Drive folders picked at once (and any videos picked with them): each folder is imported in turn; one that
  // fails (no videos in it) does not stop the others. One folder alone: the Library opens on it; several: on the
  // folder they went into (or the Library's top).
  const importDriveFolders = useCallback(async (list, kind, libraryFolderId, subfolders, fileIds = []) => {
    const done = [], failed = [];
    // The videos first: one of them in a folder picked too is then moved into that folder, not linked twice.
    let files = 0;
    if (fileIds.length) { try { files = (await api.addFromDrive(fileIds, kind, libraryFolderId)).length; } catch (e) { failed.push(e); } }
    for (const f of list) {
      try { done.push(await api.importDriveFolder(f, { kind, libraryFolderId, subfolders })); }
      catch (e) { failed.push(e); if (e?.code === "server-old") break; }
    }
    if (!done.length && !files) { toast(failed[0]?.message || "Nothing came in.", { icon: "alert" }); return; }
    setAddOpen(false);
    const openId = done.length === 1 && !files ? done[0].folder.id : libraryFolderId || "";
    try { if (openId) sessionStorage.setItem("rendrr:libfolder", openId); else sessionStorage.removeItem("rendrr:libfolder"); } catch { /* private window */ }
    go("/library"); window.dispatchEvent(new CustomEvent("rendrr:openfolder", { detail: openId }));
    const vids = (n) => `${n} ${n === 1 ? "video" : "videos"}`;
    const added = done.reduce((s, r) => s + r.added, 0), moved = done.reduce((s, r) => s + r.moved, 0), made = done.reduce((s, r) => s + r.folders, 0);
    const parts = [added && `${vids(added)} linked`, moved && `${moved} already in your library moved in`, made > done.length && `${made} folders made`, files && `${vids(files)} added`].filter(Boolean);
    const what = done.length === 1 ? `"${done[0].folder.name}"` : done.length ? `${done.length} folders` : vids(files);
    const cut = done.some((r) => r.truncated) ? " Only the first 200 videos of a folder came in." : "";
    const why = failed.length ? ` ${failed.length === 1 ? "One" : failed.length} did not: ${failed.map((e) => e.message).join(" ")}` : "";
    toast(`Imported ${what}: ${parts.join(", ") || "nothing new"}.${cut}${why}`, { icon: failed.length ? "alert" : "drive", tone: failed.length ? undefined : "brand", ms: failed.length ? 7000 : 4500 });
    ping();
  }, [go]);
  const importDriveFolder = useCallback((f, kind, libraryFolderId, subfolders) => importDriveFolders([f], kind, libraryFolderId, subfolders), [importDriveFolders]);
  const addFromDrive = useCallback(async (ids, kind, libraryFolderId) => { try { const out = await api.addFromDrive(ids, kind, libraryFolderId); setAddOpen(false); go("/library"); toast(out.length + (out.length === 1 ? " video" : " videos") + " linked from Drive" + (kind === "reference" ? " as references" : ""), { icon: "drive", tone: "brand" }); ping(); } catch (e) { toast(e.message, { icon: "alert" }); } }, [go]);

  const match = ROUTES.find(([re]) => re.test(route)) || NOT_FOUND;
  const m = route.match(match[0]) || []; const opts = match[2] || {};
  // Logged out on a private page: show Explore underneath and ask to log in; after login, the page they wanted appears.
  const guarded = !user && !opts.bare && !opts.pub;
  useEffect(() => { if (guarded && auth === "out") setLogin({ after: null, mode: "login", leave: true }); }, [guarded, auth]);
  useEffect(() => { if (pathname === "/login" && auth === "out") setLogin({ after: null, mode: "login" }); }, [pathname, auth]);
  const requireUser = useCallback((fn) => { if (user) fn(); else setLogin({ after: () => setTimeout(fn, 0), mode: "login" }); }, [user]);
  // A private page while the session is checked: the app's frame with a quiet placeholder, never a blank screen.
  const page = guarded ? (auth === "checking" ? html`<div class="page" aria-busy="true"><div class="sk-wrap"><div class="skeleton sk-pill" style="width:180px;height:28px" /><div class="grid" style="margin-top:24px">${[0, 1, 2].map((i) => html`<div key=${i} class="skeleton" style="aspect-ratio:16/10;border-radius:16px" />`)}</div></div></div>` : html`<${HomePage} />`) : match[1](m);
  const ctx = { user, setUser, usage, refreshUsage, uploads, startUpload, addFromDrive, importDriveFolder, importDriveFolders, theme, setTheme, addOpen, openAdd: (kind, folder) => requireUser(() => setAddOpen({ kind: typeof kind === "string" ? kind : "footage", folder: folder && folder.id ? folder : null })), closeAdd: () => setAddOpen(false), openLogin, closeLogin, requireUser, auth, wasIn };
  // Closing the login on a private page goes back to Explore.
  const onCloseLogin = () => { const leave = login?.leave; setLogin(null); if (leave || pathname === "/login") go("/explore"); };
  return html`<${NavCtx.Provider} value=${{ route, go }}><${AppCtx.Provider} value=${ctx}>
    ${!page ? null : !guarded && (opts.bare || opts.full) ? page : html`<${Shell} key=${nonce}>${page}<//>`}
    ${limit && html`<${LimitDialog} message=${limit} onClose=${() => setLimit(null)} />`}
    ${login && !user && html`<${LoginPage} key=${login.mode} initialMode=${login.mode} onClose=${onCloseLogin} after=${(u) => { const f = login.after; setLogin(null); if (pathname === "/login") go("/explore"); if (f) f(u); }} />`}
  <//><//>`;
}

// In the Mac or Windows app: tell Rendrr the app is open (so your AI exports finals to this computer), and save each final your AI
// exported here to Downloads as soon as it is done (the app saves file links straight to Downloads, with the Dock's
// progress). One window takes each final, so two windows do not save it twice.
function useMacExports(user, toast) {
  useEffect(() => {
    const d = typeof window !== "undefined" ? window.rendrrDesktop : null;
    if (!d || !user) return;
    let live = true;
    const tick = async () => {
      try {
        await api.macPing(d.version || "", d.device || "", d.render ? await d.render.info().catch(() => null) : null, d.app === "windows" ? "windows" : "mac");
        for (const x of await api.macExports()) {
          if (!live || (!x.url && !x.failed)) continue;
          const { claimed } = await api.macClaim(x.renderId);
          if (!claimed) continue;
          if (x.url) { window.open(x.url, "_blank"); toast(`Your AI's export "${x.fileName}" is saving to Downloads`, { icon: "download", tone: "brand" }); }
          else toast(`Your AI's export "${x.fileName}" did not finish: ${x.failed}`, { icon: "alert" });
        }
      } catch { /* offline or signed out: the next tick tries again */ }
    };
    tick();
    const t = setInterval(tick, 20_000);
    // The Mac starting or finishing a render (or rendering turned on or off) is told to Rendrr at once.
    const off = d.render?.onState ? d.render.onState((info) => { api.macPing(d.version || "", d.device || "", info || null, d.app === "windows" ? "windows" : "mac").catch(() => {}); }) : null;
    return () => { live = false; clearInterval(t); if (off) off(); };
  }, [user?.id]);
}

// In the Mac or Windows app: renders are made on this computer. Every few seconds, while it can render and is free, this takes the
// next render Rendrr is holding for it (the cloud prepared it) and hands it to the app, which fetches the files, runs
// FFmpeg, uploads the result and reports to Rendrr itself. One window takes each (the claim); one at a time.
function useMacRenders(user, toast) {
  useEffect(() => {
    const d = typeof window !== "undefined" ? window.rendrrDesktop : null;
    if (!d?.render || !user) return;
    let busy = false;
    const tick = async () => {
      if (busy) return;
      busy = true;
      try {
        const info = await d.render.info();
        if (!info || !info.ready || !info.enabled || info.busy) return;
        const next = (await api.macTasks())[0];
        if (!next) return;
        const { task } = await api.macClaimTask(next.id, d.device || "", d.app === "windows" ? "windows" : "mac");
        if (!task) return;
        const r = await d.render.run(task);
        if (r?.started) toast(`Making ${next.label} on this ${d.app === "windows" ? "PC" : "Mac"}`, { icon: "laptop", tone: "brand" });
      } catch { /* offline or signed out: the next tick tries again */ }
      finally { busy = false; }
    };
    tick();
    const t = setInterval(tick, 3000);
    return () => clearInterval(t);
  }, [user?.id]);
}

// Errors in this browser go to Rendrr's admin panel (grouped there), a few per page load at most, never in the demo.
function useClientErrors(user) {
  useEffect(() => {
    if (typeof window === "undefined" || process.env.NODE_ENV !== "production") return;
    let sent = 0;
    const report = (message, stack) => {
      if (!message || sent >= 5 || /ResizeObserver loop|Script error\.?$|NetworkError|Failed to fetch|Load failed|AbortError/i.test(message)) return;
      sent++;
      api.reportClientError({ message: String(message).slice(0, 1000), stack: stack ? String(stack).slice(0, 4000) : undefined, url: window.location.href, userId: user?.id || null });
    };
    const onErr = (e) => report(e.message, e.error?.stack);
    const onRej = (e) => { const r = e.reason; if (r && r.friendly) return; report(r?.message || String(r || ""), r?.stack); };
    window.addEventListener("error", onErr); window.addEventListener("unhandledrejection", onRej);
    return () => { window.removeEventListener("error", onErr); window.removeEventListener("unhandledrejection", onRej); };
  }, [user?.id]);
}

// No internet: the whole window says so, as the Mac app's offline page does (the Rendrr icon and "You're offline"),
// and goes away by itself when the connection is back. What is open stays as it was underneath.
function OfflineScreen() {
  const [off, setOff] = useState(() => typeof navigator !== "undefined" && navigator.onLine === false);
  useEffect(() => {
    const on = () => setOff(false), gone = () => setOff(true);
    window.addEventListener("online", on); window.addEventListener("offline", gone);
    return () => { window.removeEventListener("online", on); window.removeEventListener("offline", gone); };
  }, []);
  if (!off) return null;
  return html`<div class="offline" id="offline" role="alert" aria-live="assertive">
    <div class="offline-tile"><${Mark} size=${78} color="#0b0c0e" /></div>
    <p class="offline-say"><svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8.5 18H17a4 4 0 0 0 1.2-7.8" /><path d="M15.6 7.1A6 6 0 0 0 5.2 10.4 4 4 0 0 0 6 18" /><path d="M3 3l18 18" /></svg>You're offline</p>
  </div>`;
}

// Desktop (1024px and wider) renders the 1280px design at 80%. Narrower screens get the phone layout (styles.css, "Phone and tablet").
export function Root() {
  return html`<div id="root"><${ToastHost}><${App} /><//><${OfflineScreen} /></div>`;
}
