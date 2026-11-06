/* ===================== app: routes + root ===================== */
// Ported from ui/rendrr-ui-v2.html (app script). The route is the real URL (Next.js); `go` pushes it.
// Screen paths:
//   /explore (public)  /create/:cat (public, actions gated)  /styles (public)  /library  /library/:id  /projects  /projects/:id
//   /editor/:id  /review/:token  /connect  /usage  /billing  /settings
//   Login is a modal over Explore (Higgsfield-style): browse free, act after logging in. /login opens that modal.
import { usePathname, useRouter } from "next/navigation";
import { useState, useEffect, useCallback, html, ToastHost, useToast, readTheme, applyTheme, NavCtx, AppCtx, EmptyState, Btn, useNav, useApp } from "./ui";
import { Mark } from "./logo";
import { appLink, isChallenge } from "./desktopLogin";
import { LoginPage, HomePage, CreatePage, LibraryPage, FootagePage, ProjectsPage, FolderPage, StylesPage, ClientReviewPage, ConnectPage, UsagePage, BillingPage, SettingsPage, Shell } from "./screens";
import { EditorPage } from "./editor";
import { api } from "./api";
const ROUTES = [
  [/^\/(explore|home)?$/, () => html`<${HomePage} />`, { pub: true }],
  [/^\/create\/([^/]+)$/, (m) => html`<${CreatePage} cat=${m[1]} />`, { pub: true }],
  [/^\/styles$/, () => html`<${StylesPage} />`, { pub: true }],
  [/^\/library$/, () => html`<${LibraryPage} />`],
  [/^\/library\/([^/]+)$/, (m) => html`<${FootagePage} id=${m[1]} />`],
  [/^\/projects$/, () => html`<${ProjectsPage} />`],
  [/^\/projects\/([^/]+)$/, (m) => html`<${FolderPage} id=${m[1]} />`],
  [/^\/editor\/([^/]+)$/, (m) => html`<${EditorPage} id=${m[1]} />`, { full: true }],
  [/^\/review\/([^/]+)$/, (m) => html`<${ClientReviewPage} token=${m[1]} />`, { bare: true }],
  [/^\/connect$/, () => html`<${ConnectPage} />`],
  [/^\/usage$/, () => html`<${UsagePage} />`],
  [/^\/billing$/, () => html`<${BillingPage} />`],
  [/^\/settings$/, () => html`<${SettingsPage} />`],
  [/^\/sso-callback$/, () => null, { bare: true }], // Clerk finishes Google sign-in here (src/app/sso-callback)
  [/^\/drive-done$/, () => html`<${DriveDone} />`, { bare: true }],
  [/^\/desktop-login$/, () => html`<${DesktopLogin} />`, { bare: true }],
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
  const card = (body) => html`<div class="dl-wrap"><div class="dl-card" id="desktop-login"><${Mark} size=${44} />${body}</div></div>`;
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
    <p>You are logged in as <b>${user.email || user.name}</b>. Allow the Rendrr app on this Mac to log in to the same account.</p>
    <div class="dl-row"><${Btn} id="dl-allow" disabled=${state === "allowing"} onClick=${allow}>${state === "allowing" ? "One moment…" : "Allow"}<//><${Btn} kind="secondary" id="dl-cancel" onClick=${() => setState("cancelled")}>Cancel<//></div>
    <p class="dl-note">Only click Allow if you just clicked <b>Log in with your browser</b> in the Rendrr app.</p>`);
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
  return html`<div style="font:15px system-ui;padding:40px"><p>${msg}</p></div>`;
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
  const [user, setUser] = useState(null);
  const [auth, setAuth] = useState("checking"); // checking | in | out
  const [usage, setUsage] = useState(null);
  const [uploads, setUploads] = useState([]);
  const [theme, setThemeState] = useState(readTheme);
  useEffect(() => { applyTheme(theme); }, []);
  const toast = useToast();
  const go = useCallback((path, force) => { if (path !== window.location.pathname) router.push(path); if (force) setNonce((n) => n + 1); document.querySelector(".main")?.scrollTo?.(0, 0); }, [router]);
  const refreshUsage = useCallback(() => api.getUsage().then(setUsage).catch(() => {}), []);
  useEffect(() => { if (user) refreshUsage(); }, [user]);
  // Signed in with Clerk already (or just back from Google)? Load the profile instead of showing /login.
  useEffect(() => {
    if (user) { setAuth("in"); return; }
    let on = true;
    setAuth("checking");
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
  const page = guarded ? (auth === "checking" ? null : html`<${HomePage} />`) : match[1](m);
  const ctx = { user, setUser, usage, refreshUsage, uploads, startUpload, addFromDrive, importDriveFolder, importDriveFolders, theme, setTheme, addOpen, openAdd: (kind, folder) => requireUser(() => setAddOpen({ kind: typeof kind === "string" ? kind : "footage", folder: folder && folder.id ? folder : null })), closeAdd: () => setAddOpen(false), openLogin, closeLogin, requireUser, auth };
  // Closing the login on a private page goes back to Explore.
  const onCloseLogin = () => { const leave = login?.leave; setLogin(null); if (leave || pathname === "/login") go("/explore"); };
  return html`<${NavCtx.Provider} value=${{ route, go }}><${AppCtx.Provider} value=${ctx}>
    ${!page ? null : !guarded && (opts.bare || opts.full) ? page : html`<${Shell} key=${nonce}>${page}<//>`}
    ${login && !user && html`<${LoginPage} key=${login.mode} initialMode=${login.mode} onClose=${onCloseLogin} after=${(u) => { const f = login.after; setLogin(null); if (pathname === "/login") go("/explore"); if (f) f(u); }} />`}
  <//><//>`;
}

// Desktop (1024px and wider) renders the 1280px design at 80%. Narrower screens get the phone layout (styles.css, "Phone and tablet").
export function Root() {
  return html`<div id="root"><${ToastHost}><${App} /><//></div>`;
}
