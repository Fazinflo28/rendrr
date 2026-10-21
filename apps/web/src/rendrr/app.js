/* ===================== app: routes + root ===================== */
// Ported from ui/rendrr-ui.html (app script). The route is the real URL (Next.js); `go` pushes it.
// A Clerk session on load skips /login. The phone scaling runs in an effect instead of at load.
import { usePathname, useRouter } from "next/navigation";
import { useState, useEffect, useCallback, html, ToastHost, useToast, readTheme, applyTheme, NavCtx, AppCtx } from "./ui";
import { LoginPage, HomePage, LibraryPage, FootagePage, ProjectsPage, FolderPage, StylesPage, ClientReviewPage, ConnectPage, UsagePage, SettingsPage, Shell } from "./screens";
import { EditorPage } from "./editor";
import { api } from "./api";

// Screen paths:
//   /login  /home  /library  /library/:id  /projects  /projects/:id  /editor/:id  /styles  /review/:token  /connect  /usage  /settings
const ROUTES = [
  [/^\/login$/, () => html`<${LoginPage} />`, { bare: true }],
  [/^\/home$/, () => html`<${HomePage} />`],
  [/^\/library$/, () => html`<${LibraryPage} />`],
  [/^\/library\/([^/]+)$/, (m) => html`<${FootagePage} id=${m[1]} />`],
  [/^\/projects$/, () => html`<${ProjectsPage} />`],
  [/^\/projects\/([^/]+)$/, (m) => html`<${FolderPage} id=${m[1]} />`],
  [/^\/editor\/([^/]+)$/, (m) => html`<${EditorPage} id=${m[1]} />`, { full: true }],
  [/^\/styles$/, () => html`<${StylesPage} />`],
  [/^\/review\/([^/]+)$/, (m) => html`<${ClientReviewPage} token=${m[1]} />`, { bare: true }],
  [/^\/connect$/, () => html`<${ConnectPage} />`],
  [/^\/usage$/, () => html`<${UsagePage} />`],
  [/^\/settings$/, () => html`<${SettingsPage} />`],
  [/^\/sso-callback$/, () => null, { bare: true }], // Clerk finishes Google sign-in here (src/app/sso-callback)
  [/^\/drive-done$/, () => html`<${DriveDone} />`, { bare: true }],
];

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
  const route = pathname;
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
  useEffect(() => { if (pathname === "/" && auth !== "checking") router.replace(user ? "/home" : "/login"); else if (pathname === "/login" && user) router.replace("/home"); }, [pathname, auth, user]);
  const setTheme = (t) => { setThemeState(t); applyTheme(t); };
  // Upload from the top bar or the library: always lands in /library and finishes on its own.
  const [addOpen, setAddOpen] = useState(false);
  const ping = () => window.dispatchEvent(new Event("rendrr:library"));
  // From your computer: the file stays on the machine, we make a light preview in the browser.
  const startUpload = useCallback(async (files) => {
    go("/library"); setAddOpen(false); const list = files ? (files.length != null ? Array.from(files) : [files]) : null;
    toast(list ? "Preparing " + (list.length === 1 ? list[0].name : list.length + " files") : "Preparing sample footage", { icon: "laptop" });
    const job = api.addFromComputer(list); setTimeout(ping, 50);
    try { await job; toast("Keep this tab open while we prepare your preview.", { icon: "clock", ms: 3500 }); }
    catch (e) { toast(e.message, { icon: "alert", ms: 4000 }); }
    ping();
  }, [go]);
  const addFromDrive = useCallback(async (ids) => { try { const out = await api.addFromDrive(ids); setAddOpen(false); go("/library"); toast(out.length + (out.length === 1 ? " video" : " videos") + " linked from Drive", { icon: "drive", tone: "brand" }); ping(); } catch (e) { toast(e.message, { icon: "alert" }); } }, [go]);
  const addSample = useCallback(() => startUpload(null), [startUpload]);

  const match = ROUTES.find(([re]) => re.test(route)) || ROUTES[1];
  const m = route.match(match[0]) || []; const opts = match[2] || {};
  const guarded = !user && !opts.bare;
  useEffect(() => { if (guarded && auth === "out") router.replace("/login"); }, [guarded, auth]);
  const page = guarded || pathname === "/" ? null : match[1](m);
  const ctx = { user, setUser, usage, refreshUsage, uploads, startUpload, addSample, addFromDrive, theme, setTheme, addOpen, openAdd: () => setAddOpen(true), closeAdd: () => setAddOpen(false) };
  return html`<${NavCtx.Provider} value=${{ route, go }}><${AppCtx.Provider} value=${ctx}>
    ${guarded || !page ? null : opts.bare || opts.full ? page : html`<${Shell} key=${nonce}>${page}<//>`}
  <//><//>`;
}

// Desktop-only layout (1280px). On a narrower screen (a phone), scale the whole app down to fit so it can still be viewed and tapped.
function fitToScreen() {
  const root = document.getElementById("root"); const DESIGN = 1280;
  if (!root) return () => {};
  const fit = () => {
    const w = window.innerWidth, hgt = window.innerHeight;
    if (w < DESIGN) { const k = w / DESIGN; root.style.transform = "scale(" + k + ")"; root.style.transformOrigin = "0 0"; root.style.width = DESIGN + "px"; root.style.height = Math.round(hgt / k) + "px"; document.documentElement.classList.add("scaled"); }
    else { root.style.transform = ""; root.style.width = ""; root.style.height = ""; document.documentElement.classList.remove("scaled"); }
  };
  fit(); window.addEventListener("resize", fit); window.visualViewport?.addEventListener("resize", fit);
  return () => { window.removeEventListener("resize", fit); window.visualViewport?.removeEventListener("resize", fit); };
}

export function Root() {
  useEffect(() => fitToScreen(), []);
  return html`<div id="root"><${ToastHost}><${App} /><//></div>`;
}
