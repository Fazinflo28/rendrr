/* ===================== screens ===================== */
// Ported from ui/rendrr-ui.html (screens script). Only the changes listed in apps/web/README.md.
import {
  useState, useEffect, useRef, useMemo, useCallback, html, fmtTime, fmtLen, fmtAgo, initials, Icon, Btn, Toggle, Seg, Chip, Field, StatusChip,
  useToast, Modal, useAsync, Skeleton, GridSkeleton, EmptyState, ErrorState, Async, usePlayback, Player, Art, Thumb, OriIcon, ThemeBtn, copyText,
  useNav, useApp,
} from "./ui";
import { api } from "./api";
const IS_PROD = process.env.NODE_ENV === "production";

/* ---------- login: a centred modal over Explore (Higgsfield layout: showcase left, form right) ---------- */
const SHOWCASE = [["s1", "TALKING HEAD", "Punchy cuts, big captions, zero dead air", "Talking"], ["s3", "LUXURY REEL", "Slow, cinematic, lets the footage breathe", "Luxury"], ["s6", "KINETIC TYPE", "Words that move with the voice", "Kinetic"], ["s17", "BRAINROT", "Stacked, fast, built for the scroll", "Brainrot"]];
const SOCIAL_ICON = { google: "M21.6 12.2c0-.7-.1-1.4-.2-2H12v3.9h5.4a4.6 4.6 0 0 1-2 3v2.5h3.2c1.9-1.7 3-4.3 3-7.4Z M12 22c2.7 0 5-.9 6.6-2.4l-3.2-2.5c-.9.6-2 1-3.4 1-2.6 0-4.8-1.8-5.6-4.1H3.1v2.6A10 10 0 0 0 12 22Z M6.4 14a6 6 0 0 1 0-3.9V7.5H3.1a10 10 0 0 0 0 9L6.4 14Z M12 5.9c1.5 0 2.8.5 3.8 1.5l2.8-2.8A10 10 0 0 0 3.1 7.5L6.4 10c.8-2.3 3-4.1 5.6-4.1Z", apple: "M16.4 12.6c0-2.4 2-3.6 2.1-3.7-1.1-1.7-2.9-1.9-3.5-1.9-1.5-.2-2.9.9-3.7.9-.8 0-1.9-.9-3.2-.8-1.6 0-3.1 1-4 2.4-1.7 3-.4 7.3 1.2 9.7.8 1.2 1.8 2.5 3 2.4 1.2 0 1.7-.8 3.2-.8s1.9.8 3.2.8 2.1-1.2 2.9-2.4c.9-1.3 1.3-2.6 1.3-2.7 0 0-2.5-1-2.5-3.9ZM14 5.6c.7-.8 1.1-1.9 1-3-1 0-2.1.6-2.8 1.4-.6.7-1.2 1.8-1 2.9 1.1.1 2.2-.5 2.8-1.3Z", ms: "M3 3h8.5v8.5H3z M12.5 3H21v8.5h-8.5z M3 12.5h8.5V21H3z M12.5 12.5H21V21h-8.5z" };
function LoginPage({ onClose, after, initialMode = "login" }) {
  const { setUser } = useApp();
  const [mode, setMode] = useState(initialMode); // login | signup | reset
  const [email, setEmail] = useState(""); const [pw, setPw] = useState(""); const [name, setName] = useState("");
  const [busy, setBusy] = useState(false); const [err, setErr] = useState(null); const [sent, setSent] = useState(false); const [slide, setSlide] = useState(0);
  const [code, setCode] = useState(""); const [newPw, setNewPw] = useState("");
  const sq = useAsync(() => api.listStyles(), []);
  useEffect(() => { const k = (e) => e.key === "Escape" && onClose?.(); window.addEventListener("keydown", k); return () => window.removeEventListener("keydown", k); }, [onClose]);
  useEffect(() => { const t = setInterval(() => setSlide((i) => (i + 1) % SHOWCASE.length), 4000); return () => clearInterval(t); }, []);
  // Reset is two steps with Clerk: the emailed code, then the code with a new password (which also logs you in).
  const run = async (fn, done) => { setBusy(true); setErr(null); try { const u = await fn(); if (mode === "reset" && !done) setSent(true); else { setUser(u); if (after) after(u); else onClose?.(); } } catch (e) { setErr(e.message); } finally { setBusy(false); } };
  const submit = (e) => { e.preventDefault(); if (mode === "reset") return sent ? run(() => api.completeReset(code, newPw), true) : run(() => api.sendReset(email)); run(() => (mode === "login" ? api.login(email, pw) : api.signup(name, email, pw))); };
  const title = mode === "login" ? "Welcome back" : mode === "signup" ? "Welcome to Rendrr" : "Reset your password";
  const social = (label, icon) => html`<${Btn} kind="secondary" type="button" id=${icon === "google" ? "google" : undefined} disabled=${busy} onClick=${() => run(() => api.loginWithGoogle())}><svg width="18" height="18" viewBox="0 0 24 24"><path fill="currentColor" d=${SOCIAL_ICON[icon]} /></svg>${label}<//>`;
  const sc = SHOWCASE[slide]; const st = sq.data?.find((x) => x.id === sc[0]);
  return html`<div class="scrim login-scrim" onMouseDown=${(e) => e.target === e.currentTarget && onClose?.()}>
    <div class="hmodal login" role="dialog" aria-modal="true" aria-label=${title}>
      <div class="hshow" aria-hidden="true">
        ${st && html`<${StyleVideo} key=${st.id} s=${st} ori="9:16" className="fill" />`}
        <div class="hshade" />
        <div class="htext"><span class="tag accent"><${Icon} name="film" size="12" /> 1080p export</span><h2>${sc[1]}</h2><p>${sc[2]}</p>
          <div class="hdots">${SHOWCASE.map((x, i) => html`<button key=${x[0]} type="button" class=${i === slide ? "on" : ""} aria-label=${x[1]} onClick=${() => setSlide(i)}><i /><span>${x[3]}</span></button>`)}</div></div>
      </div>
      <form class="hform" onSubmit=${submit} novalidate>
        <${Btn} kind="quiet" icon="x" id="login-close" aria-label="Close" type="button" onClick=${onClose} style="position:absolute;top:14px;right:14px;width:36px" />
        <div class="logo" style="padding:0;margin:0 auto 8px;justify-content:center"><span class="mark" style="width:40px;height:40px;border-radius:12px"><${Icon} name="logo" size="20" /></span></div>
        <h1 class="t-title" style="text-align:center;font-size:28px;line-height:34px">${title}</h1>
        <p class="muted" style="text-align:center;margin-bottom:6px">${mode === "login" ? html`Log in and keep editing. New here? <a href="#" onClick=${(e) => { e.preventDefault(); setMode("signup"); setErr(null); }}>Sign up</a>.` : mode === "signup" ? html`Sign up and edit for free. <a href="#" onClick=${(e) => { e.preventDefault(); setMode("login"); setErr(null); }}>Back to log in</a>` : html`<a href="#" onClick=${(e) => { e.preventDefault(); setMode("login"); setErr(null); setSent(false); }}>Back to log in</a>`}</p>
        ${mode !== "reset" && html`
          ${mode === "signup" && html`<div class="hpromo"><${Icon} name="spark" size="16" /> Sign up with work email and get 3 free renders</div>`}
          ${social("Continue with Google", "google")}
          <div class="or">or</div>`}
        ${mode === "signup" && html`<${Field} label="Name" id="name"><input id="name" class="input" value=${name} onInput=${(e) => setName(e.target.value)} placeholder="Ronnii K" /><//>`}
        <${Field} label="Work email" id="email"><input id="email" class="input" type="email" value=${email} onInput=${(e) => setEmail(e.target.value)} placeholder="name@company.com" autocomplete="email" /><//>
        ${mode !== "reset" && html`<${Field} label="Password" id="password" hint=${mode === "login" ? html`<a href="#" onClick=${(e) => { e.preventDefault(); setMode("reset"); setErr(null); }}>Forgot password?</a>` : null}><input id="password" class="input" type="password" value=${pw} onInput=${(e) => setPw(e.target.value)} placeholder="••••••••" autocomplete="current-password" /><//>`}
        ${err && html`<p role="alert" class="t-small" style="padding-left:4px">${err}</p>`}
        ${sent && mode === "reset" && html`<div class="card flat"><b>Check your inbox.</b><p class="muted t-small">We sent a reset code to ${email}. Type it below with your new password.</p></div>
        <${Field} label="Code" id="reset-code"><input id="reset-code" class="input" value=${code} onInput=${(e) => setCode(e.target.value)} placeholder="123456" autocomplete="one-time-code" inputmode="numeric" /><//>
        <${Field} label="New password" id="new-password"><input id="new-password" class="input" type="password" value=${newPw} onInput=${(e) => setNewPw(e.target.value)} placeholder="••••••••" autocomplete="new-password" /><//>`}
        <${Btn} type="submit" id="submit" disabled=${busy}>${busy ? "One moment…" : mode === "reset" ? (sent ? "Set new password" : "Send reset code") : "Continue"}<//>
        <p class="t-small muted" style="text-align:center;margin-top:4px">By continuing you agree to our <a href="#" onClick=${(e) => e.preventDefault()}>Terms</a> and <a href="#" onClick=${(e) => e.preventDefault()}>Privacy Policy</a>.</p>
      </form>
    </div>
  </div>`;
}

/* ---------- app shell: one top bar (Higgsfield-style), no side rail ---------- */
const TOP = [["/explore", "Explore"], ["/projects", "Projects"]];
const MENU = [["/library", "Library", "library"], ["/usage", "Usage", "usage"], ["/billing", "Billing", "key"], ["/settings", "Settings", "settings"], ["/connect", "Connect AI", "connect"]];
function Shell({ children }) {
  const { route, go } = useNav(); const { user, usage, setUser, openAdd, addOpen, closeAdd, openLogin, requireUser } = useApp(); const toast = useToast();
  const [q, setQ] = useState(""); const [hits, setHits] = useState(null); const [menu, setMenu] = useState(false); const [sOpen, setSOpen] = useState(false);
  const cq = useAsync(() => api.getCategories(), []);
  useEffect(() => { if (!q.trim()) { setHits(null); return; } let on = true; api.search(q).then((r) => on && setHits(r)).catch(() => on && setHits([])); return () => { on = false; }; }, [q]);
  useEffect(() => { const k = () => { setMenu(false); setHits(null); setSOpen(false); }; window.addEventListener("click", k); return () => window.removeEventListener("click", k); }, []);
  const setDemo = (m) => { api.demo.mode = m; toast(m === "ready" ? "Demo: normal data" : m === "empty" ? "Demo: empty states on" : "Demo: error states on"); go(route, true); };
  const isOn = (p) => (p === "/explore" ? route === "/explore" || route === "/home" : route.startsWith(p));
  return html`<div class="shell">
    <header class="top">
      <button class="logo" aria-label="Rendrr home" title="Rendrr" onClick=${() => go("/explore")}><span class="mark"><${Icon} name="logo" /></span></button>
      <nav class="topnav" aria-label="Main">
        ${TOP.map(([p, l]) => html`<button key=${p} class=${"nav" + (isOn(p) ? " on" : "")} data-tip=${l} onClick=${() => go(p)}>${l}</button>`)}
        <span class="navsep" aria-hidden="true" />
        ${(cq.data || api.CATEGORIES).map((c) => html`<button key=${c.slug} class=${"nav" + (route === "/create/" + c.slug ? " on" : "")} data-tip=${c.label} data-cat=${c.slug} onClick=${() => go("/create/" + c.slug)}>${c.label}</button>`)}
      </nav>
      <div class="grow" />
      <div class="search-wrap" onClick=${(e) => e.stopPropagation()}>
        <button class=${"nav icon" + (sOpen ? " on" : "")} id="search-btn" aria-label="Search" onClick=${() => setSOpen((o) => !o)}><${Icon} name="search" size="18" /></button>
        ${sOpen && html`<div class="search pop"><${Icon} name="search" /><input id="search" class="input sm" autoFocus placeholder="Search footage, projects, styles" value=${q} onInput=${(e) => setQ(e.target.value)} aria-label="Search" />
          ${hits && html`<div class="search-pop">${hits.length === 0 ? html`<p class="muted t-small" style="padding:8px 16px">Nothing matches "${q}"</p>` : hits.map((h) => html`<button key=${h.kind + h.id} onClick=${() => { requireUser(() => go(h.path)); setQ(""); setSOpen(false); }}><${Icon} name=${h.kind === "Footage" ? "film" : h.kind === "Project" ? "projects" : h.kind === "Edit" ? "scissors" : "styles"} size="16" />${h.name}<span class="kind">${h.kind}</span></button>`)}</div>`}</div>`}
      </div>
      ${user ? html`
        ${usage && html`<button class="storage" id="storage" title=${"Storage: " + usage.storageUsedGB + " GB of " + usage.storageTotalGB + " GB used"} onClick=${() => go("/usage")}><${Icon} name="layers" size="15" /><span>${Math.round(usage.storageTotalGB - usage.storageUsedGB)} GB free</span><i class="sbar"><b style=${{ width: Math.round((usage.storageUsedGB / usage.storageTotalGB) * 100) + "%" }} /></i></button>`}
        <${Btn} size="sm" icon="plus" id="upload" onClick=${openAdd}>Add footage<//>
        <div style="position:relative" onClick=${(e) => e.stopPropagation()}>
          <button class="avatar" id="profile" aria-label="Profile menu" onClick=${() => setMenu((m) => !m)}>${user?.photo ? html`<img src=${user.photo} alt="" />` : initials(user?.name)}</button>
          ${menu && html`<div class="menu">
            <div class="head">${user?.email}</div>
            ${MENU.map(([p, l, i]) => html`<button key=${p} class=${"item" + (route.startsWith(p) ? " on" : "")} data-menu=${l} onClick=${() => { go(p); setMenu(false); }}><${Icon} name=${i} />${l}</button>`)}
            ${!IS_PROD && html`<div class="sep" /><div class="head">Demo states</div>
            ${[["ready", "Normal data"], ["empty", "Empty states"], ["error", "Error states"]].map(([m, l]) => html`<button key=${m} class=${"item" + (api.demo.mode === m ? " on" : "")} onClick=${() => { setDemo(m); setMenu(false); }}><${Icon} name=${api.demo.mode === m ? "check" : "more"} />${l}</button>`)}
            <button class="item" id="fail-render" onClick=${() => { api.demo.failNextRender = true; toast("The next render will fail"); setMenu(false); }}><${Icon} name="alert" />Fail the next render</button>
            <button class="item" id="fail-drive" onClick=${() => { api.demo.failNextDrive = true; toast("The next Drive fetch will fail"); setMenu(false); }}><${Icon} name="drive" />Fail next Drive fetch</button>`}
            <div class="sep" />
            <button class="item" id="logout" onClick=${async () => { await api.logout(); setUser(null); setMenu(false); go("/explore"); toast("Logged out"); }}><${Icon} name="logout" />Log out</button>
          </div>`}
        </div>`
      : html`<${Btn} kind="secondary" size="sm" id="login-btn" onClick=${() => openLogin()}>Log in<//><${Btn} size="sm" id="signup-btn" onClick=${() => openLogin(null, "signup")}>Sign up<//>`}
    </header>
    <main class="main">${children}</main>
    ${addOpen && html`<${AddFootageModal} onClose=${closeAdd} />`}
  </div>`;
}

/* ---------- Add footage: Google Drive (recommended) or this computer ---------- */
const SourceBadge = ({ source, size = "sm" }) => html`<span class=${"tag src " + (source === "drive" ? "drive" : "local")} title=${source === "drive" ? "Raw file stays in your Google Drive" : "Raw file stays on your computer"}><${Icon} name=${source === "drive" ? "drive" : "laptop"} size="12" />${source === "drive" ? "Google Drive" : "This computer"}</span>`;
function DrivePicker({ onAdd, single, addLabel }) {
  const toast = useToast();
  const dq = useAsync(() => api.getDriveStatus(), []);
  const [folder, setFolder] = useState("root"); const [sel, setSel] = useState([]); const [busy, setBusy] = useState(false);
  const fq = useAsync(() => (dq.data?.connected ? api.listDriveFiles(folder) : Promise.resolve(null)), [folder, dq.data?.connected]);
  const connect = async () => { setBusy(true); try { const d = await api.connectDrive(); dq.setData(d); toast("Google Drive connected", { icon: "drive", tone: "brand" }); } catch (e) { toast(e.message); } finally { setBusy(false); } };
  const toggle = (id) => setSel((x) => (single ? [id] : x.includes(id) ? x.filter((i) => i !== id) : [...x, id]));
  if (dq.status === "loading") return html`<${Skeleton} rows=${3} card=${false} />`;
  if (!dq.data?.connected) return html`<div class="state" style="padding:32px 16px"><div class="ico"><${Icon} name="drive" /></div><b class="t-heading">Connect Google Drive</b><p>Pick videos straight from your Drive. We never copy the raw file.</p><${Btn} id="connect-drive" icon="drive" disabled=${busy} onClick=${connect}>${busy ? "Connecting…" : "Connect Google Drive"}<//></div>`;
  return html`<div class="col" style="gap:12px">
    <div class="row between"><span class="t-small muted"><${Icon} name="drive" size="13" /> Connected as <b style="color:var(--ink)">${dq.data.email}</b></span>${sel.length > 0 && html`<span class="t-small">${sel.length} selected</span>`}</div>
    <div class="dpick">
      <div class="dfold">${(fq.data?.folders || api.demo && [{ id: "root", name: "My Drive" }]).map((f) => html`<button key=${f.id} class=${"fnav" + (folder === f.id ? " on" : "")} data-folder-id=${f.id} onClick=${() => setFolder(f.id)}><${Icon} name="projects" size="16" />${f.name}</button>`)}</div>
      <div class="dfiles">${fq.status === "loading" ? html`<${Skeleton} rows=${3} card=${false} />` : (fq.data?.files || []).length === 0 ? html`<p class="t-small muted" style="padding:16px">No videos in this folder.</p>` : (fq.data.files).map((f) => html`<label key=${f.id} class=${"dfile" + (sel.includes(f.id) ? " on" : "") + (f.added && !single ? " dim" : "")}><input type=${single ? "radio" : "checkbox"} name="dfile" checked=${sel.includes(f.id)} disabled=${f.added && !single} onChange=${() => toggle(f.id)} data-file-id=${f.id} /><${Icon} name="film" size="16" /><span class="grow" style="min-width:0"><b class="t-label" style="display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${f.name}</b><span class="t-small muted">${f.size} · ${fmtLen(f.seconds)} · ${fmtAgo(f.date)}${f.added && !single ? " · already added" : ""}</span></span></label>`)}</div>
    </div>
    <div class="row between"><span class="t-small muted">Your raw files stay in your Drive. We only keep a light preview copy.</span><${Btn} id="drive-add" disabled=${sel.length === 0 || busy} onClick=${async () => { setBusy(true); try { await onAdd(sel); } finally { setBusy(false); } }}>${addLabel || ("Add " + (sel.length || "") + (sel.length === 1 ? " video" : " videos"))}<//></div>
  </div>`;
}
function AddFootageModal({ onClose }) {
  const { startUpload, addFromDrive, addSample } = useApp();
  const [tab, setTab] = useState("drive"); const [over, setOver] = useState(false); const fileRef = useRef();
  return html`<${Modal} title="Add footage" sub="Raw files never come to us. We only keep a light preview and your final exports." onClose=${onClose} wide>
    <div class="srcpick">
      <button class=${"srcopt" + (tab === "drive" ? " on" : "")} id="src-drive" onClick=${() => setTab("drive")}><${Icon} name="drive" size="20" /><span><b>Add from Google Drive</b><span class="t-small muted">Pick videos from your Drive</span></span><span class="tag accent">Recommended</span></button>
      <button class=${"srcopt" + (tab === "local" ? " on" : "")} id="src-local" onClick=${() => setTab("local")}><${Icon} name="laptop" size="20" /><span><b>From your computer</b><span class="t-small muted">Pick files or drag and drop</span></span></button>
    </div>
    ${tab === "drive" ? html`<${DrivePicker} onAdd=${addFromDrive} />` : html`<div class="col" style="gap:12px">
      <input type="file" accept="video/*" multiple ref=${fileRef} class="hide" onChange=${(e) => { const fs = e.target.files; if (fs?.length) startUpload(Array.from(fs)); e.target.value = ""; }} />
      <div class=${"drop" + (over ? " over" : "")} id="local-drop" style="padding:40px 24px" onClick=${() => fileRef.current.click()} onDragOver=${(e) => { e.preventDefault(); setOver(true); }} onDragLeave=${() => setOver(false)} onDrop=${(e) => { e.preventDefault(); setOver(false); api.captureDrop?.(e.dataTransfer); const fs = e.dataTransfer.files; if (fs?.length) startUpload(Array.from(fs)); else addSample(); }}>
        <div class="ico"><${Icon} name="laptop" /></div><b class="t-heading">Drop videos here</b><p class="muted t-small">Files stay on your computer. We make a light preview in your browser.</p>
        <div class="row"><${Btn} onClick=${(e) => { e.stopPropagation(); fileRef.current.click(); }}>Choose files<//><${Btn} kind="ghost" id="sample" onClick=${(e) => { e.stopPropagation(); addSample(); }}>Add sample footage<//></div></div>
      <div class="row" style="gap:8px"><${Icon} name="clock" size="14" /><span class="t-small muted">Keep this tab open while we prepare your preview.</span></div>
    </div>`}
  <//>`;
}

/* ---------- Recreate: pick footage (Drive or computer) > pick a project > straight into the editor ---------- */
function RecreateModal({ g, onClose }) {
  const { go } = useNav(); const toast = useToast();
  const [step, setStep] = useState("source"); const [tab, setTab] = useState("drive"); const [video, setVideo] = useState(null); const [busy, setBusy] = useState(false); const [over, setOver] = useState(false);
  const [folder, setFolder] = useState(""); const [newName, setNewName] = useState(""); const fileRef = useRef();
  const fq = useAsync(() => (step === "project" ? api.listFoldersLite() : Promise.resolve(null)), [step]);
  useEffect(() => { if (fq.data?.length && !folder) setFolder(fq.data[0].id); }, [fq.data]);
  const picked = (v) => { setVideo(v); setStep("project"); window.dispatchEvent(new Event("rendrr:library")); };
  const fromDrive = async (ids) => { const out = await api.addFromDrive(ids.slice(0, 1)); picked(out[0]); };
  const fromFiles = async (files) => { setBusy(true); try { const out = await api.addFromComputer(files ? [files[0]] : null); picked(out[0]); } catch (e) { toast(e.message, { icon: "alert" }); } finally { setBusy(false); } };
  const create = async () => {
    setBusy(true);
    try { let fid = folder; if (fid === "new") { const f = await api.createFolder(newName); fid = f.id; }
      const p = await api.createProject({ videoId: video.id, styleId: g.styleId, folderId: fid, name: "Recreate: " + g.title });
      api.countRecreate(g.id); toast("Project created. Opening the editor.", { icon: "spark", tone: "brand" }); onClose(); go("/editor/" + p.id);
    } catch (e) { toast(e.message); setBusy(false); }
  };
  return html`<${Modal} title="Recreate this video" sub=${"Same style (" + g.style.name + "), your own footage. The AI matches the cut."} onClose=${onClose} wide>
    <div class="steps-row"><span class=${"stp" + (step === "source" ? " on" : " done")}>1. Footage</span><span class="stp-sep" /><span class=${"stp" + (step === "project" ? " on" : "")}>2. Project</span></div>
    ${step === "source" ? html`
      <div class="srcpick">
        <button class=${"srcopt" + (tab === "drive" ? " on" : "")} id="rc-drive" onClick=${() => setTab("drive")}><${Icon} name="drive" size="20" /><span><b>Add from Google Drive</b><span class="t-small muted">Pick a video from your Drive</span></span><span class="tag accent">Recommended</span></button>
        <button class=${"srcopt" + (tab === "local" ? " on" : "")} id="rc-local" onClick=${() => setTab("local")}><${Icon} name="laptop" size="20" /><span><b>From your computer</b><span class="t-small muted">Pick a file or drag and drop</span></span></button>
      </div>
      ${tab === "drive" ? html`<${DrivePicker} single addLabel="Use this video" onAdd=${fromDrive} />` : html`<div class="col" style="gap:12px">
        <input type="file" accept="video/*" ref=${fileRef} class="hide" onChange=${(e) => { const fs = e.target.files; if (fs?.length) fromFiles(Array.from(fs)); e.target.value = ""; }} />
        <div class=${"drop" + (over ? " over" : "")} id="rc-drop" style="padding:36px 24px" onClick=${() => fileRef.current.click()} onDragOver=${(e) => { e.preventDefault(); setOver(true); }} onDragLeave=${() => setOver(false)} onDrop=${(e) => { e.preventDefault(); setOver(false); const fs = e.dataTransfer.files; fromFiles(fs?.length ? Array.from(fs) : null); }}>
          <div class="ico"><${Icon} name="laptop" /></div><b class="t-heading">Drop a video here</b><p class="muted t-small">Files stay on your computer. We make a light preview in your browser.</p>
          <div class="row"><${Btn} disabled=${busy} onClick=${(e) => { e.stopPropagation(); fileRef.current.click(); }}>Choose a file<//><${Btn} kind="ghost" id="rc-sample" disabled=${busy} onClick=${(e) => { e.stopPropagation(); fromFiles(null); }}>${busy ? "Preparing…" : "Use sample footage"}<//></div></div>
        <div class="row" style="gap:8px"><${Icon} name="clock" size="14" /><span class="t-small muted">Keep this tab open while we prepare your preview.</span></div>
      </div>`}`
    : html`
      <div class="card flat row" style="gap:12px"><${Icon} name=${video.source === "drive" ? "drive" : "laptop"} size="18" /><div class="grow"><b class="t-label">${video.name}</b><p class="t-small muted">${video.source === "drive" ? "Linked from Google Drive" : "From your computer"} · preview is being made in the background</p></div><${Btn} kind="ghost" size="xs" onClick=${() => setStep("source")}>Change<//></div>
      <div class="col" style="gap:8px"><span class="t-label">Which project should this go into?</span>
        <${Async} q=${fq} skeleton=${html`<${Skeleton} rows=${3} card=${false} />`} whenEmpty=${null}>${(fs) => html`<div class="plist" id="rc-folders">
          ${(fs || []).map((f) => html`<label key=${f.id} class=${"prow" + (folder === f.id ? " on" : "")}><input type="radio" name="rcf" value=${f.id} checked=${folder === f.id} onChange=${() => setFolder(f.id)} /><${Icon} name="projects" size="16" /><span class="grow">${f.name}</span></label>`)}
          <label class=${"prow" + (folder === "new" ? " on" : "")}><input type="radio" name="rcf" value="new" checked=${folder === "new"} onChange=${() => setFolder("new")} /><${Icon} name="plus" size="16" /><span class="grow">New project</span></label>
          ${folder === "new" && html`<input id="rc-newname" class="input" placeholder="Project name, like a client or a campaign" value=${newName} onInput=${(e) => setNewName(e.target.value)} autoFocus />`}
        </div>`}<//></div>
      <div class="row" style="justify-content:flex-end;gap:8px"><${Btn} kind="ghost" onClick=${onClose}>Cancel<//><${Btn} id="rc-create" icon="spark" disabled=${busy || !folder || (folder === "new" && !newName.trim())} onClick=${create}>${busy ? "Creating…" : "Create and open editor"}<//></div>`}
  <//>`;
}

/* ---------- /library ---------- */
const BUSY = ["linking", "preview", "previewing", "uploading", "processing"];
const ATTN = ["failed", "missing", "expired", "paused"];
function LibraryPage() {
  const { go } = useNav(); const { startUpload, addSample, openAdd } = useApp(); const toast = useToast();
  const q = useAsync(() => api.listVideos(), []);
  const [filter, setFilter] = useState("All"); const [search, setSearch] = useState(""); const [over, setOver] = useState(false); const [reconnect, setReconnect] = useState(null);
  useEffect(() => { const k = () => q.reload(); window.addEventListener("rendrr:library", k); return () => window.removeEventListener("rendrr:library", k); }, []);
  // Local previews are made in this tab: if it goes away mid preview, they pause until the user comes back.
  useEffect(() => { const vis = () => { if (document.hidden) { api.pauseLocalPreviews(); } q.reload(); }; document.addEventListener("visibilitychange", vis); window.addEventListener("pagehide", api.pauseLocalPreviews); return () => { document.removeEventListener("visibilitychange", vis); window.removeEventListener("pagehide", api.pauseLocalPreviews); }; }, []);
  // Poll while anything is in progress so cards move on their own.
  useEffect(() => { const busy = q.data?.some((v) => BUSY.includes(v.status)); if (!busy) return; const t = setTimeout(q.reload, 1000); return () => clearTimeout(t); }, [q.data]);
  const onDrop = (e) => { e.preventDefault(); setOver(false); api.captureDrop?.(e.dataTransfer); const fs = e.dataTransfer.files; if (fs?.length) startUpload(Array.from(fs)); else addSample(); };
  const dropProps = { onDragOver: (e) => { e.preventDefault(); setOver(true); }, onDragLeave: () => setOver(false), onDrop };
  const act = async (e, fn, msg) => { e.stopPropagation(); try { await fn(); if (msg) toast(msg); q.reload(); } catch (er) { toast(er.message); } };
  const filt = (v) => filter === "All" || (filter === "Ready" && v.status === "ready") || (filter === "In progress" && BUSY.includes(v.status)) || (filter === "Needs attention" && ATTN.includes(v.status));
  return html`<div class="page wide" ...${dropProps}>
    <div class="page-head"><div><h1 class="t-title">Library</h1><p class="muted">Raw files stay in your Drive or on your computer. We keep a light preview for 30 days.</p></div>
      <div class="row"><div class="search" style="width:240px"><${Icon} name="search" /><input class="input sm" placeholder="Find footage" value=${search} onInput=${(e) => setSearch(e.target.value)} aria-label="Find footage" /></div>
      <${Seg} size="sm" value=${filter} options=${["All", "Ready", "In progress", "Needs attention"]} onChange=${setFilter} /></div></div>
    <${Async} q=${q} skeleton=${html`<${GridSkeleton} />`} whenEmpty=${html`<div class=${"drop" + (over ? " over" : "")} id="drop" onClick=${openAdd}><div class="ico"><${Icon} name="plus" /></div><h2 class="t-heading">Add your first footage</h2><p class="muted">Link videos from Google Drive, or pick files from your computer. Raw files never come to us.</p><div class="row"><${Btn} onClick=${(e) => { e.stopPropagation(); openAdd(); }}>Add footage<//><${Btn} kind="ghost" id="sample" onClick=${(e) => { e.stopPropagation(); addSample(); }}>Add sample footage<//></div></div>`}>
      ${(videos) => {
        const list = videos.filter((v) => filt(v) && v.name.toLowerCase().includes(search.toLowerCase()));
        return html`<div class="col" style="gap:16px">
          ${over && html`<div class="drop over"><div class="ico"><${Icon} name="laptop" /></div><h2 class="t-heading">Drop to add from your computer</h2></div>`}
          ${list.length === 0 ? html`<${EmptyState} icon="search" title="No footage matches" text="Try another filter or clear the search." action=${html`<${Btn} kind="secondary" size="sm" onClick=${() => { setFilter("All"); setSearch(""); }}>Clear filters<//>`} />` : html`<div class="grid">
            ${list.map((v) => html`<button key=${v.id} class=${"vcard" + (v.status !== "ready" ? " busy" : "")} data-id=${v.id} data-status=${v.status} onClick=${() => v.status === "ready" && go("/library/" + v.id)} aria-label=${v.name}>
              <div class="thumb"><${Thumb} src=${v.thumb} art=${v.art} /><div class="ori"><${OriIcon} o=${v.orientation} /></div><div class="len"><${Chip} tone="neutral" size="sm" style="background:rgba(0,0,0,.5);color:#fff">${fmtLen(v.seconds)}<//></div>
                ${BUSY.includes(v.status) && html`<div class="veil"><span class="dot brand pulse" /><b class="t-small">${v.stepName}${v.progress != null && (v.status === "previewing" || v.status === "uploading") ? " " + v.progress + "%" : ""}</b>${(v.status === "previewing" || v.status === "uploading") && html`<div class="bar"><i style=${{ width: v.progress + "%" }} /></div>`}<span class="t-small" style="opacity:.7">Step ${v.idx + 1} of ${v.total}</span></div>`}
                ${v.status === "paused" && html`<div class="veil"><${Icon} name="clock" size="22" /><b class="t-small">Paused. Open this tab to continue</b></div>`}
                ${v.status === "failed" && html`<div class="veil"><${Icon} name="alert" size="22" /><b class="t-small">Failed</b></div>`}
                ${v.status === "missing" && html`<div class="veil"><${Icon} name="drive" size="22" /><b class="t-small">Source missing</b><span class="t-small" style="opacity:.7">Moved or deleted in Drive</span></div>`}
                ${v.status === "expired" && html`<div class="veil"><${Icon} name="clock" size="22" /><b class="t-small">Preview expired</b><span class="t-small" style="opacity:.7">30 days passed</span></div>`}
              </div>
              <div class="meta"><div class="row between"><b class="t-label" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${v.name}</b><${StatusChip} status=${v.status} /></div>
                <div class="row between" style="gap:8px"><${SourceBadge} source=${v.source} />
                  ${v.status === "failed" ? html`<${Btn} kind="ghost" size="xs" onClick=${(e) => act(e, () => api.retryVideo(v.id), "Trying again")}>Retry<//>`
                  : v.status === "paused" ? html`<${Btn} size="xs" icon="play" data-resume=${v.id} onClick=${(e) => act(e, () => api.resumeLocalPreview(v.id), "Resumed")}>Resume<//>`
                  : v.status === "missing" ? html`<${Btn} size="xs" icon="drive" data-reconnect=${v.id} onClick=${(e) => { e.stopPropagation(); setReconnect(v); }}>Reconnect file<//>`
                  : v.status === "expired" ? html`<${Btn} size="xs" icon="refresh" data-rebuild=${v.id} onClick=${(e) => act(e, () => api.rebuildPreview(v.id), "Rebuilding the preview")}>Rebuild preview<//>`
                  : html`<span class="t-small muted">${fmtAgo(v.date)} · ${v.size}</span>`}</div>
                ${v.status === "failed" && html`<span class="t-small muted">${v.error}</span>`}
              </div>
            </button>`)}
            <button class=${"drop" + (over ? " over" : "")} style="padding:32px;border-radius:12px" onClick=${openAdd} aria-label="Add footage"><div class="ico" style="width:48px;height:48px"><${Icon} name="plus" size="22" /></div><b class="t-label">Add footage</b><span class="t-small muted">Drive or this computer</span></button>
          </div>`}
        </div>`;
      }}
    <//>
    ${reconnect && html`<${Modal} title="Reconnect file" sub=${"Pick '" + reconnect.name + "' again in your Drive. The raw file was moved or deleted."} onClose=${() => setReconnect(null)} wide><${DrivePicker} single addLabel="Reconnect" onAdd=${async (ids) => { try { await api.reconnectDriveFile(reconnect.id, ids[0]); toast("Reconnected. Linking again.", { icon: "drive", tone: "brand" }); setReconnect(null); q.reload(); } catch (e) { toast(e.message); } }} /><//>`}
  </div>`;
}

/* ---------- /library/:id (footage) ---------- */
function FootagePage({ id }) {
  const { go } = useNav(); const toast = useToast();
  const q = useAsync(() => api.getVideo(id), [id]);
  const v = q.data; const dur = v ? Math.max(0.1, v.seconds) : 60;
  const pb = usePlayback(dur);
  const [busy, setBusy] = useState(false);
  const start = async () => { setBusy(true); try { const p = await api.createProject({ videoId: id }); toast("Project created", { icon: "check", tone: "brand" }); go("/editor/" + p.id); } catch (e) { toast(e.message); setBusy(false); } };
  const current = v?.transcript.flatMap((l) => l.words).filter((w) => w.t <= pb.time).pop();
  const line = v?.transcript.find((l) => l.words.includes(current));
  // Loom-style: drag over words, then start an edit with those words already removed.
  const words = v ? v.transcript.flatMap((l) => l.words) : [];
  const [wsel, setWsel] = useState(null); const dragRef = useRef(null);
  const onWordDown = (i) => (e) => { e.preventDefault(); dragRef.current = { a: i, moved: false }; setWsel({ a: i, b: i }); };
  const onWordEnter = (i) => () => { if (dragRef.current) { dragRef.current.moved = dragRef.current.moved || i !== dragRef.current.a; setWsel({ a: dragRef.current.a, b: i }); } };
  useEffect(() => { const up = () => { if (!dragRef.current) return; const d = dragRef.current; dragRef.current = null; if (!d.moved) { pb.seek(words[d.a].t); setWsel(null); } }; window.addEventListener("pointerup", up); return () => window.removeEventListener("pointerup", up); }, [words]);
  const selIds = wsel ? words.slice(Math.min(wsel.a, wsel.b), Math.max(wsel.a, wsel.b) + 1).map((w) => w.id) : [];
  const inWsel = (i) => wsel && i >= Math.min(wsel.a, wsel.b) && i <= Math.max(wsel.a, wsel.b);
  const startWithout = async () => { setBusy(true); try { const p = await api.createProject({ videoId: id, cut: selIds }); toast(selIds.length + " words removed. Opening the editor.", { icon: "scissors", tone: "brand" }); go("/editor/" + p.id); } catch (e) { toast(e.message); setBusy(false); } };
  return html`<div class="page">
    <div class="row"><${Btn} kind="quiet" size="sm" icon="back" onClick=${() => go("/library")}>Library<//></div>
    <${Async} q=${q} skeleton=${html`<div class="two"><div class="skeleton" style="aspect-ratio:16/9;border-radius:20px" /><${Skeleton} rows=${6} /></div>`}>${(v) => html`
      <div class="page-head" style="padding-top:0"><div><h1 class="t-title">${v.name}</h1><p class="muted row" style="gap:8px"><${SourceBadge} source=${v.source} /> ${fmtLen(v.seconds)} · ${v.size} · ${v.orientation} · Added ${fmtAgo(v.date)}</p></div>
        <${Btn} id="start-edit" icon="spark" disabled=${busy || v.status !== "ready"} onClick=${start}>${busy ? "Creating…" : "Start an edit"}<//></div>
      ${v.status !== "ready" && html`<div class="card flat row"><span class="dot brand pulse" />This footage is not ready yet (${v.stepName || v.status}). You can start an edit once it is ready.</div>`}
      <div class="card tight storagebox" id="storage-box"><div class="sb-cell"><span class="t-small muted">Raw file location</span><b class="t-label row" style="gap:6px"><${Icon} name=${v.source === "drive" ? "drive" : "laptop"} size="14" />${v.source === "drive" ? "Google Drive · " + (v.driveFile?.folder || "My Drive") : "This computer · " + (v.originalName || v.name)}</b></div>
        <div class="sb-cell"><span class="t-small muted">Preview copy</span><b class="t-label">${v.previewSize || "Not made yet"}${v.previewDays != null ? html` <span class="muted" style="font-weight:400">· Deletes in ${v.previewDays} days</span>` : ""}</b></div>
        <div class="sb-cell"><span class="t-small muted">We keep</span><b class="t-label">Only the preview. Raw never leaves ${v.source === "drive" ? "your Drive" : "your computer"}.</b></div>
        ${v.source === "drive" && html`<${Btn} kind="secondary" size="sm" icon="link" id="open-drive" onClick=${() => v.driveFile?.webViewLink ? window.open(v.driveFile.webViewLink, "_blank", "noopener") : toast("We could not find this file in Google Drive.", { icon: "drive" })}>Open in Drive<//>`}</div>
      <div class="two" style="grid-template-columns: 1.4fr 1fr; align-items:start">
        <div class="col" style="gap:16px">
          <${Player} pb=${pb} duration=${dur} src=${v.proxyUrl || undefined} aspect=${v.orientation === "Portrait" ? "9:16" : v.orientation === "Square" ? "1:1" : "16:9"} caption=${line ? line.words.map((w) => w.text).join(" ") : null} captionLook="clean" />
          <div class="card tight"><div class="row between" style="padding:0 8px 8px"><b class="t-label">Scene cuts</b><span class="t-small muted">${v.sceneCuts.length} found</span></div>
            <div style="position:relative;height:36px;background:var(--raised);border-radius:999px;overflow:hidden">
              ${v.sceneCuts.map((t) => html`<button key=${t} title=${"Jump to " + fmtTime(t)} aria-label=${"Scene cut at " + fmtTime(t)} onClick=${() => pb.seek(t)} style=${{ position: "absolute", left: (t / dur) * 100 + "%", top: 0, bottom: 0, width: 3, background: "var(--ink)" }} />`)}
              <div style=${{ position: "absolute", left: (pb.time / dur) * 100 + "%", top: 0, bottom: 0, width: 2, background: "var(--brand)" }} />
            </div></div>
          <div><div class="row between" style="padding:0 4px 10px"><b class="t-label">Key frames</b><span class="t-small muted">Click to jump</span></div><div class="frames">${v.keyFrames.map((f) => html`<div key=${f.t} class="thumb" role="button" tabindex="0" aria-label=${"Jump to " + fmtTime(f.t)} onClick=${() => pb.seek(f.t)}><${Thumb} src=${f.url} art=${f.art} /><div class="len"><${Chip} tone="neutral" size="sm" style="background:rgba(0,0,0,.5);color:#fff">${fmtTime(f.t)}<//></div></div>`)}</div></div>
        </div>
        <div class="panel" style="max-height:calc(100vh - 200px)"><div class="ph"><b class="t-heading">Transcript</b><div class="row" style="gap:8px"><${Chip} tone="neutral" size="sm"><span class="gap" style="height:16px;line-height:16px;padding:0 6px">1.4s</span> silence<//><${Chip} tone="neutral" size="sm"><u style="text-decoration:underline dotted;text-underline-offset:3px">um</u> filler<//></div></div>
          <div class="pb words" id="footage-words"><p class="t-small muted" style="line-height:18px;margin-bottom:12px">Click a word to jump. Drag over words to remove them from the video.</p>${v.transcript.map((l) => html`<p key=${l.id}>${l.gapBefore ? html`<span class="gap" title="Silence">${l.gapBefore}s silence</span>` : null}<span class="ts">${fmtTime(l.start)}</span>${l.words.map((w) => { const i = words.indexOf(w); return html`<span key=${w.id} data-w=${w.id} class=${"w" + (w.filler ? " filler" : "") + (w === current ? " now" : "") + (inWsel(i) ? " sel" : "")} onPointerDown=${onWordDown(i)} onPointerEnter=${onWordEnter(i)}>${w.text}</span>${" "}`; })}</p>`)}
            ${selIds.length > 0 && html`<div class="selpop" id="footage-selpop"><span class="t-small">${selIds.length} ${selIds.length === 1 ? "word" : "words"} selected</span><${Btn} size="xs" icon="scissors" id="start-without" disabled=${busy} onClick=${startWithout}>Remove and start an edit<//><${Btn} kind="quiet" size="xs" icon="x" aria-label="Clear selection" onClick=${() => setWsel(null)} /></div>`}
          </div></div>
      </div>`}<//>
  </div>`;
}

/* ---------- /projects ---------- */
function NewProjectModal({ onClose, onCreated, styleId, folderId, defaultName = "", title = "New edit", sub = "Pick footage and a style. The AI does the first pass." }) {
  const vq = useAsync(() => api.listVideos(), []); const sq = useAsync(() => api.listStyles(), []); const fq = useAsync(() => api.listFoldersLite(), []);
  const [videoId, setVideoId] = useState(""); const [style, setStyle] = useState(styleId || "s2"); const [name, setName] = useState(defaultName); const [folder, setFolder] = useState(folderId || ""); const [busy, setBusy] = useState(false); const [err, setErr] = useState(null);
  const ready = (vq.data || []).filter((v) => v.status === "ready");
  const create = async () => { setBusy(true); setErr(null); try { const p = await api.createProject({ videoId, styleId: style, name, folderId: folder || fq.data?.[0]?.id }); onCreated(p); } catch (e) { setErr(e.message); setBusy(false); } };
  return html`<${Modal} title=${title} sub=${sub} onClose=${onClose} footer=${html`<${Btn} kind="ghost" onClick=${onClose}>Cancel<//><${Btn} id="create-project" disabled=${busy || !videoId} onClick=${create}>${busy ? "Creating…" : "Create project"}<//>`}>
    <${Field} label="Footage" id="np-video"><select id="np-video" class="input" value=${videoId} onChange=${(e) => setVideoId(e.target.value)}><option value="">Choose footage…</option>${ready.map((v) => html`<option key=${v.id} value=${v.id}>${v.name} (${fmtLen(v.seconds)})</option>`)}</select><//>
    <${Field} label="Style" id="np-style"><select id="np-style" class="input" value=${style} onChange=${(e) => setStyle(e.target.value)}>${(sq.data || []).map((s) => html`<option key=${s.id} value=${s.id}>${s.name}</option>`)}</select><//>
    <${Field} label="Project folder" id="np-folder"><select id="np-folder" class="input" value=${folder || fq.data?.[0]?.id || ""} onChange=${(e) => setFolder(e.target.value)}>${(fq.data || []).map((f) => html`<option key=${f.id} value=${f.id}>${f.name}</option>`)}</select><//>
    <${Field} label="Name" id="np-name" hint="Optional. We will name it after the footage."><input id="np-name" class="input" value=${name} onInput=${(e) => setName(e.target.value)} placeholder="Podcast highlights" /><//>
    ${err && html`<p role="alert" class="t-small">${err}</p>`}
  <//>`;
}
function ProjectsPage() {
  const { go } = useNav(); const toast = useToast(); const q = useAsync(() => api.listFolders(), []);
  const [view, setView] = useState("grid"); const [sort, setSort] = useState("updated"); const [modal, setModal] = useState(false); const [name, setName] = useState(""); const [busy, setBusy] = useState(false); const [menu, setMenu] = useState(null); const [share, setShare] = useState(null); const [rename, setRename] = useState(null);
  useEffect(() => { const k = () => setMenu(null); window.addEventListener("click", k); return () => window.removeEventListener("click", k); }, []);
  const create = async () => { setBusy(true); try { const f = await api.createFolder(name); setModal(false); setName(""); toast("Project created", { icon: "check", tone: "brand" }); go("/projects/" + f.id); } catch (e) { toast(e.message); } finally { setBusy(false); } };
  const del = async (f) => { try { await api.deleteFolder(f.id); q.setData((d) => d.filter((x) => x.id !== f.id)); toast("Project deleted"); } catch (e) { toast(e.message); } };
  const doRename = async () => { try { const f = await api.renameFolder(rename.id, rename.name); q.setData((d) => d.map((x) => (x.id === f.id ? { ...x, ...f } : x))); setRename(null); toast("Renamed", { icon: "check", tone: "brand" }); } catch (e) { toast(e.message); } };
  return html`<div class="page wide">
    <div class="page-head"><div><h1 class="t-title">Projects</h1><p class="muted">One folder per client. Edits live inside.</p></div><${Btn} id="new-project" icon="plus" onClick=${() => setModal(true)}>New project<//></div>
    <${Async} q=${q} skeleton=${html`<${GridSkeleton} n=${6} />`} whenEmpty=${html`<${EmptyState} icon="projects" title="No projects yet" text="Make one folder per client, then add edits inside." action=${html`<${Btn} onClick=${() => setModal(true)}>New project<//>`} />`}>${(list) => { const sorted = [...list].sort((a, b) => sort === "name" ? a.name.localeCompare(b.name) : b.updated - a.updated); return view === "grid" ? html`
      <div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(230px,1fr))">
        ${sorted.map((f) => html`<div key=${f.id} class="fcard" role="button" tabindex="0" data-folder=${f.id} onClick=${() => go("/projects/" + f.id)} onKeyDown=${(e) => e.key === "Enter" && go("/projects/" + f.id)}>
          <div class=${"cover c" + f.cover}><div class="ftxt"><b>${f.name}</b><span>${f.workspace}</span></div>${f.shares > 0 && html`<span class="gtag" style="position:absolute;top:10px;right:10px"><${Icon} name="link" size="12" />${f.shares}</span>`}</div>
          <div class="row between" style="padding:8px 12px 10px"><span class="t-small muted">Updated ${fmtAgo(f.updated)} · ${f.count} ${f.count === 1 ? "edit" : "edits"}</span>
            <div style="position:relative" onClick=${(e) => e.stopPropagation()}><${Btn} kind="quiet" size="xs" icon="more" aria-label="More" onClick=${() => setMenu(menu === f.id ? null : f.id)} />
              ${menu === f.id && html`<div class="menu" style="top:32px"><button class="item" onClick=${() => { setShare(f); setMenu(null); }}><${Icon} name="link" />Share folder</button><button class="item" onClick=${() => { setRename({ id: f.id, name: f.name }); setMenu(null); }}><${Icon} name="more" />Rename</button><button class="item" onClick=${() => { del(f); setMenu(null); }}><${Icon} name="trash" />Delete</button></div>`}</div></div>
        </div>`)}
        <button class="fcard new" id="new-project-card" onClick=${() => setModal(true)}><div class="ico"><${Icon} name="plus" size="22" /></div><span class="t-label">New project</span></button>
      </div>` : html`<div class="card tight"><table><thead><tr><th>Project</th><th>Workspace</th><th>Edits</th><th>Share links</th><th>Updated</th></tr></thead><tbody>${sorted.map((f) => html`<tr key=${f.id} class="click" data-folder=${f.id} onClick=${() => go("/projects/" + f.id)}><td><div class="row"><div class=${"mini cover c" + f.cover} /><b class="t-label">${f.name}</b></div></td><td class="muted">${f.workspace}</td><td class="muted mono">${f.count}</td><td class="muted mono">${f.shares}</td><td class="muted">${fmtAgo(f.updated)}</td></tr>`)}</tbody></table></div>`; }}<//>
    ${modal && html`<${Modal} title="New project" sub="A folder for one client or one campaign." onClose=${() => setModal(false)} footer=${html`<${Btn} kind="ghost" onClick=${() => setModal(false)}>Cancel<//><${Btn} id="create-folder" disabled=${busy || !name.trim()} onClick=${create}>${busy ? "Creating…" : "Create project"}<//>`}><${Field} label="Project name" id="fname"><input id="fname" class="input" autoFocus value=${name} onInput=${(e) => setName(e.target.value)} onKeyDown=${(e) => e.key === "Enter" && name.trim() && create()} placeholder="BFS Health & Performance" /><//><//>`}
    ${rename && html`<${Modal} title="Rename project" onClose=${() => setRename(null)} footer=${html`<${Btn} kind="ghost" onClick=${() => setRename(null)}>Cancel<//><${Btn} onClick=${doRename}>Save<//>`}><input class="input" autoFocus value=${rename.name} onInput=${(e) => setRename({ ...rename, name: e.target.value })} aria-label="Project name" /><//>`}
    ${share && html`<${CreateLinkModal} folder=${share} onClose=${() => { setShare(null); q.reload(); }} />`}
  </div>`;
}

/* ---------- /projects/:id (folder: assets, collections, share links) ---------- */
function FolderPage({ id }) {
  const { go } = useNav(); const toast = useToast(); const q = useAsync(() => api.getFolder(id), [id]);
  const [section, setSection] = useState("assets"); const [view, setView] = useState("grid"); const [search, setSearch] = useState(""); const [sort, setSort] = useState("updated");
  const [sel, setSel] = useState([]); const [share, setShare] = useState(null); const [np, setNp] = useState(false); const [menu, setMenu] = useState(null); const [deleted, setDeleted] = useState([]);
  useEffect(() => { const k = () => setMenu(null); window.addEventListener("click", k); return () => window.removeEventListener("click", k); }, []);
  const toggleSel = (e, pid) => { e.stopPropagation(); setSel((x) => (x.includes(pid) ? x.filter((i) => i !== pid) : [...x, pid])); };
  const setStatus = async (p, status) => { q.setData((d) => ({ ...d, assets: d.assets.map((a) => (a.id === p.id ? { ...a, status } : a)) })); try { await api.updateProject(p.id, { status }); } catch (e) { toast(e.message); q.reload(); } };
  const del = async (p) => { try { await api.deleteAsset(p.id); setDeleted((x) => [p, ...x]); q.setData((d) => ({ ...d, assets: d.assets.filter((a) => a.id !== p.id) })); toast("Moved to Recently deleted"); } catch (e) { toast(e.message); } };
  const dur = (p) => (p.seconds ? fmtTime(p.seconds) : "—");
  return html`<${Async} q=${q} skeleton=${html`<div class="page"><${Skeleton} rows=${3} /><${GridSkeleton} n=${4} /></div>`}>${(f) => { const list = f.assets.filter((a) => a.name.toLowerCase().includes(search.toLowerCase())).sort((a, b) => sort === "name" ? a.name.localeCompare(b.name) : b.updated - a.updated); const size = f.assets.reduce((n, a) => n + parseInt(a.size || 0), 0); return html`
    <div class="folder">
      <div class="fmain">
        <div class="row" style="gap:12px;padding:0 0 12px"><div class=${"mini cover c" + f.cover} style="width:36px;height:36px;border-radius:10px" /><button class="crumb" onClick=${() => go("/projects")}>All projects</button><span class="muted">/</span><b class="t-label">${f.name}</b><span class="t-small muted">· ${f.members} ${f.members === 1 ? "member" : "members"}</span><div class="grow" />
          <div class="search" style="width:220px"><${Icon} name="search" /><input class="input sm" placeholder="Search this project" value=${search} onInput=${(e) => setSearch(e.target.value)} aria-label="Search this project" /></div>
          <${Btn} kind="secondary" size="sm" icon="plus" id="new-edit" onClick=${() => setNp(true)}>New edit<//>
          <${Btn} size="sm" icon="link" id="share-folder" onClick=${() => setShare({ folder: f })}>Share<//></div>
        ${f.shares.length > 0 && html`<div class="row" style="gap:6px;padding:0 0 12px" id="share-links"><span class="t-small muted">Share links</span>${f.shares.map((r) => html`<button key=${r.token} class="linkchip" onClick=${() => go("/review/" + r.token)}><${Icon} name="link" size="12" />${r.folderId ? "Whole folder" : (f.assets.find((a) => a.id === r.projectId)?.name || "Video")}${r.approved && html`<${Icon} name="check" size="12" />`}</button>`)}</div>`}
        ${section === "assets" && html`<div class="col" style="gap:16px">
          <div class="row"><span class="t-small muted">${f.assets.length} ${f.assets.length === 1 ? "asset" : "assets"} · ${size} MB</span></div>
          ${sel.length > 0 && html`<div class="bulk"><span class="t-label">${sel.length} selected</span><${Btn} size="xs" icon="link" id="share-selected" onClick=${() => setShare({ folder: f, projectId: sel[0], many: sel.length })}>Share ${sel.length === 1 ? "video" : sel.length + " videos"}<//><${Btn} kind="ghost" size="xs" onClick=${() => setSel([])}>Clear<//></div>`}
          ${list.length === 0 ? html`<${EmptyState} icon="scissors" title=${search ? "Nothing matches" : "No edits in this project yet"} text=${search ? "Try another name." : "Add footage from your library and the AI makes the first cut."} action=${!search && html`<${Btn} onClick=${() => setNp(true)}>New edit<//>`} />` : view === "grid" ? html`<div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(250px,1fr))">
            ${list.map((p) => html`<div key=${p.id} class=${"acard" + (sel.includes(p.id) ? " sel" : "")} data-asset=${p.id} role="button" tabindex="0" onClick=${() => go("/editor/" + p.id)} onKeyDown=${(e) => e.key === "Enter" && go("/editor/" + p.id)}>
              <div class="athumb"><${StyleVideo} s=${p.style} ori=${p.aspect} /><button class=${"acheck" + (sel.includes(p.id) ? " on" : "")} aria-label="Select" aria-pressed=${sel.includes(p.id)} onClick=${(e) => toggleSel(e, p.id)}>${sel.includes(p.id) && html`<${Icon} name="check" size="12" />`}</button>
                <div class="ainfo"><span><${Icon} name="comment" size="12" />${p.comments}</span><span class="mono">${dur(p)}</span></div></div>
              <div style="padding:12px 14px 14px" class="col" ><div class="row between"><b class="t-label" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${p.name}</b><div style="position:relative" onClick=${(e) => e.stopPropagation()}><${Btn} kind="quiet" size="xs" icon="more" aria-label="More" onClick=${() => setMenu(menu === p.id ? null : p.id)} />
                ${menu === p.id && html`<div class="menu" style="top:30px"><button class="item" onClick=${() => { setShare({ folder: f, projectId: p.id }); setMenu(null); }}><${Icon} name="link" />Share this video</button><button class="item" onClick=${() => { go("/editor/" + p.id); }}><${Icon} name="scissors" />Open in editor</button><button class="item" onClick=${() => { del(p); setMenu(null); }}><${Icon} name="trash" />Delete</button></div>`}</div></div>
                <span class="t-small muted">Fazinflo · ${fmtAgo(p.updated)} · ${p.style?.name}</span>
                <select class="input sm astatus" aria-label="Status" value=${p.status} onClick=${(e) => e.stopPropagation()} onChange=${(e) => setStatus(p, e.target.value)}>${["Draft", "Rendering", "Preview ready", "In review", "Changes requested", "Approved", "Final ready"].map((st) => html`<option key=${st} value=${st}>${st}</option>`)}</select></div>
            </div>`)}
          </div>` : html`<div class="card tight"><table><thead><tr><th></th><th>Name</th><th>Style</th><th>Status</th><th>Comments</th><th>Length</th><th>Updated</th><th></th></tr></thead><tbody>${list.map((p) => html`<tr key=${p.id} class="click" data-asset=${p.id} onClick=${() => go("/editor/" + p.id)}><td onClick=${(e) => e.stopPropagation()}><button class=${"acheck static" + (sel.includes(p.id) ? " on" : "")} aria-label="Select" onClick=${(e) => toggleSel(e, p.id)}>${sel.includes(p.id) && html`<${Icon} name="check" size="12" />`}</button></td><td><b class="t-label">${p.name}</b></td><td class="muted">${p.style?.name}</td><td><${StatusChip} status=${p.status} /></td><td class="muted mono">${p.comments}</td><td class="muted mono">${dur(p)}</td><td class="muted">${fmtAgo(p.updated)}</td><td onClick=${(e) => e.stopPropagation()}><${Btn} kind="ghost" size="xs" icon="link" onClick=${() => setShare({ folder: f, projectId: p.id })}>Share<//></td></tr>`)}</tbody></table></div>`}
        </div>`}
        ${section === "collections" && html`<${EmptyState} icon="projects" title="No collections yet" text="Collections group assets across folders, like 'Best hooks' or 'Client approved'." action=${html`<${Btn} kind="secondary" size="sm" onClick=${() => toast("Collections are coming in the next build")}>New collection<//>`} />`}
        ${section === "deleted" && (deleted.length === 0 ? html`<${EmptyState} icon="trash" title="Nothing deleted" text="Deleted edits stay here for 30 days." />` : html`<div class="card tight"><table><tbody>${deleted.map((p) => html`<tr key=${p.id}><td><b class="t-label">${p.name}</b></td><td class="muted">${p.style?.name}</td><td style="text-align:right"><${Btn} kind="ghost" size="xs" icon="refresh" onClick=${async () => { try { await api.restoreAsset(p.id); setDeleted((x) => x.filter((i) => i.id !== p.id)); toast("Restored", { icon: "check", tone: "brand" }); q.reload(); } catch (e) { toast(e.message); } }}>Restore<//></td></tr>`)}</tbody></table></div>`)}
      </div>
    </div>
    ${np && html`<${NewProjectModal} folderId=${f.id} onClose=${() => setNp(false)} onCreated=${(p) => { setNp(false); go("/editor/" + p.id); }} />`}
    ${share && html`<${CreateLinkModal} folder=${share.projectId ? null : share.folder} projectId=${share.projectId} onClose=${() => { setShare(null); setSel([]); q.reload(); }} />`}`; }}<//>`;
}

/* ---------- /styles ---------- */
// A looping "video" preview for a style pack: pure CSS animation, no media files.
function StyleVideo({ s, ori, className = "", style }) {
  const o = ori && s.ori.includes(ori) ? ori : (ori === "All" || !ori ? s.ori[0] : ori);
  const ar = { "9:16": "9 / 16", "16:9": "16 / 9", "1:1": "1 / 1" }[o];
  const person = (extra = "") => html`<div class=${"sv-person " + extra}><i class="sv-head" /><i class="sv-body" /></div>`;
  const cap = (words, look = s.captionLook) => html`<div class=${"sv-cap " + look}>${words.map((w, i) => html`<span key=${i} style=${{ animationDelay: (i * 1) + "s" }}>${w}</span>`)}</div>`;
  const scene = {
    "talking-head": () => html`<div class="sv-scene sv-punch">${person()}</div>${cap(["Nobody", "tells you", "this part"])}`,
    "podcast-clip": () => html`<div class="sv-two"><div class="sv-scene sv-spk a">${person("sm")}</div><div class="sv-scene sv-spk b">${person("sm")}</div></div><div class="sv-lower"><b>Ronnii K</b><span>Founder, Fazinflo</span></div>${cap(["The first", "ten clients", "are the hardest"], "clean")}`,
    "clipping": () => html`<div class="sv-scene sv-cutA">${person()}</div><div class="sv-scene sv-cutB">${person("left")}</div><div class="sv-rec">REC</div>`,
    "motion-graphics": () => html`<div class="sv-scene mg"><i class="sv-blob" /><div class="sv-kin"><b class="l1">COLD</b><b class="l2">OUTREACH</b><b class="l3">WORKS</b></div></div>`,
    "tier-ranking": () => html`<div class="sv-scene flat"><div class="sv-tier">${["S", "A", "B", "C"].map((t, i) => html`<div key=${t} class="row"><b class=${"t" + i}>${t}</b><div class="items">${[0, 1, 2].map((k) => html`<i key=${k} style=${{ animationDelay: (i * .7 + k * .25) + "s" }} />`)}</div></div>`)}</div></div>`,
    "listicle": () => html`<div class="sv-scene sv-punch">${person("left")}</div><div class="sv-count">${[5, 4, 3, 2, 1].map((n, i) => html`<b key=${n} style=${{ animationDelay: i + "s" }}>#${n}</b>`)}</div>${cap(["Stop", "chasing", "clients"])}`,
    "ugc-ad": () => html`<div class="sv-scene sv-wobble sv-punch">${person()}</div>${cap(["Wait", "for it", "insane"], "bold")}<div class="sv-hook">POV: you tried it</div>`,
    "cinematic": () => html`<div class="sv-scene sv-slow">${person("far")}</div><i class="sv-bar top" /><i class="sv-bar bot" />${cap(["quiet", "luxury", "only"], "outline")}`,
    "documentary": () => html`<div class="sv-scene sv-kenA" /><div class="sv-scene sv-kenB">${person("far")}</div>${cap(["in 2019", "we had", "two clients"], "outline")}`,
    "tutorial": () => html`<div class="sv-scene flat"><div class="sv-win"><div class="bar"><i /><i /><i /></div><div class="side" /><div class="main"><i /><i /><i /><b class="btn" /></div><div class="sv-cursor"><i /></div><div class="sv-step">Step 2 · Click Export</div></div></div>`,
    "split-screen": () => html`<div class="sv-half top"><div class="sv-scene sv-punch">${person("sm")}</div></div><div class="sv-half bot"><div class="sv-bars"><i /><i /><i /><i /><i /><i /></div></div>${cap(["this", "is how", "we scaled"], "bold")}`,
    "greenscreen": () => html`<div class="sv-scene flat"><div class="sv-gs-vis"><i class="v1" /><i class="v2" /><i class="v3" /></div><div class="sv-gs-person">${person("sm")}</div></div>${cap(["look at", "this chart", "right here"], "clean")}`,
    "before-after": () => html`<div class="sv-scene before">${person("sm")}<b class="sv-label">BEFORE</b></div><div class="sv-scene after sv-wipe">${person("sm")}<b class="sv-label">AFTER</b></div>`,
    "text-story": () => html`<div class="sv-scene flat"><div class="sv-chat"><i class="me" /><i class="them" /><i class="me" /><i class="them" /></div></div>`,
    "slideshow": () => html`<div class="sv-scene flat"><div class="sv-slides"><i class="p1" /><i class="p2" /><i class="p3" /></div></div>${cap(["day one", "day thirty", "day ninety"], "outline")}`,
    "news": () => html`<div class="sv-scene">${person("left")}</div><div class="sv-third"><b>Ronnii K</b><span>Fazinflo Ventures</span></div><div class="sv-ticker"><span>BREAKING: cold outreach still works in 2026 · 14 clients in 90 days · follow up five times ·</span></div>`,
    "brainrot": () => html`<div class="sv-half top"><div class="sv-scene sv-flick">${person("sm")}</div></div><div class="sv-half bot"><div class="sv-bars fast"><i /><i /><i /><i /><i /><i /></div></div><div class="sv-cap brain"><span>NO</span><span>DEAD</span><span>AIR</span></div>`,
  };
  return html`<div class=${"sv " + className} style=${{ ...(className.includes("fill") ? { aspectRatio: ar } : {}), ...style }} aria-hidden="true"><div class=${"sv-fr " + s.type} style=${{ aspectRatio: ar }}>${(scene[s.type] || scene["talking-head"])()}</div></div>`;
}
const StyleArt = ({ s }) => html`<div class="style-art"><${StyleVideo} s=${s} /></div>`;
const ORI_LABEL = { "9:16": "Vertical", "16:9": "Horizontal", "1:1": "Square" };
function StylesPage() { return html`<${CreatePage} cat="clipping" />`; }
/* ---------- /create/:cat: a full-width wall of community videos in that category (like, recreate) ---------- */
function CreatePage({ cat }) {
  const cq = useAsync(() => api.getCategories(), []); const c = (cq.data || api.CATEGORIES).find((x) => x.slug === cat) || api.CATEGORIES[0];
  return html`<${ExploreFeed} key=${c.slug} types=${c.types} title=${c.label} sub=${c.blurb} />`;
}
function StylePacks({ fixedTypes, hideFilters, onPick, cols = 4, wall }) {
  const { go } = useNav(); const { requireUser } = useApp(); const q = useAsync(() => api.listStyles(), []); const fq = useAsync(() => api.getStyleFilters(), []);
  const [open, setOpen] = useState(null); const [np, setNp] = useState(null);
  const [ori, setOri] = useState("All"); const [plat, setPlat] = useState("all"); const [types, setTypes] = useState([]); const [search, setSearch] = useState(""); const [mOri, setMOri] = useState(null);
  const types_ = fq.data?.types || []; const plats = fq.data?.platforms || [];
  const toggleType = (t) => setTypes((x) => (x.includes(t) ? x.filter((i) => i !== t) : [...x, t]));
  const active = ori !== "All" || plat !== "all" || types.length > 0 || search;
  const clear = () => { setOri("All"); setPlat("all"); setTypes([]); setSearch(""); };
  const label = (t) => (types_.find(([k]) => k === t) || [])[1] || t;
  return html`<div class="col" style="gap:24px">
    ${!hideFilters && html`<div class="filters">
      <div class="row wrap" style="gap:16px">
        <div class="search" style="width:240px"><${Icon} name="search" /><input id="style-search" class="input sm" placeholder="Find a style" value=${search} onInput=${(e) => setSearch(e.target.value)} aria-label="Find a style" /></div>
        <div class="row" style="gap:8px"><span class="t-small muted">Shape</span><${Seg} size="sm" value=${ori} options=${[{ value: "All", label: "All" }, { value: "9:16", label: "Vertical" }, { value: "16:9", label: "Horizontal" }, { value: "1:1", label: "Square" }]} onChange=${setOri} /></div>
        <div class="row" style="gap:8px"><span class="t-small muted">Platform</span><${Seg} size="sm" value=${plat} options=${[{ value: "all", label: "All" }, ...plats.map(([v, l]) => ({ value: v, label: l }))]} onChange=${setPlat} /></div>
        ${active && html`<${Btn} kind="ghost" size="xs" icon="x" id="clear-filters" onClick=${clear}>Clear<//>`}
      </div>
      <div class="chiprow" id="type-filters">
        <button class=${"chip sm " + (types.length === 0 ? "ink" : "neutral")} onClick=${() => setTypes([])}>All styles</button>
        ${types_.map(([k, l]) => html`<button key=${k} data-type=${k} class=${"chip sm " + (types.includes(k) ? "brand" : "neutral")} aria-pressed=${types.includes(k)} onClick=${() => toggleType(k)}>${types.includes(k) && html`<${Icon} name="check" />`}${l}</button>`)}
      </div>
    </div>`}
    <${Async} q=${q} skeleton=${html`<${GridSkeleton} n=${6} />`} whenEmpty=${html`<${EmptyState} icon="styles" title="No styles yet" text="Style packs will show up here once your team adds them." />`}>${(list) => {
      const shown = list.filter((s) => (!fixedTypes || fixedTypes.includes(s.type)) && (ori === "All" || s.ori.includes(ori)) && (plat === "all" || s.platforms.includes(plat)) && (types.length === 0 || types.includes(s.type)) && (s.name + " " + s.vibe + " " + label(s.type)).toLowerCase().includes(search.toLowerCase()));
      return html`<div class="col" style="gap:16px">
        ${!fixedTypes && html`<span class="t-small muted" id="style-count">${shown.length} of ${list.length} styles</span>`}
        ${shown.length === 0 ? html`<${EmptyState} icon="search" title="No style matches those filters" text="Try another shape or platform, or clear the filters." action=${html`<${Btn} kind="secondary" size="sm" onClick=${clear}>Clear filters<//>`} />` : wall ? html`<div class="masonry wall" id="style-wall">
          ${shown.flatMap((s) => s.ori.map((o) => ({ s, o }))).sort((a, b) => (a.o === b.o ? 0 : a.o === "9:16" ? -1 : 1) * ((a.s.id + b.s.id).length % 2 ? 1 : -1)).map(({ s, o }) => html`<div key=${s.id + o} class="gcard" role="button" tabindex="0" data-id=${s.id} data-type=${s.type} data-ori=${o} aria-label=${s.name} onClick=${() => { setMOri(o); setOpen(s); }} onKeyDown=${(e) => e.key === "Enter" && setOpen(s)}><${StyleVideo} s=${s} ori=${o} className="fill" /><span class="wname">${s.name} · ${ORI_LABEL[o]}</span></div>`)}
        </div>` : html`<div class="grid" style=${{ gridTemplateColumns: "repeat(" + cols + ",1fr)" }}>
          ${shown.map((s) => html`<div key=${s.id} class="card tight click" role="button" tabindex="0" data-id=${s.id} data-type=${s.type} onClick=${() => { setMOri(null); setOpen(s); }} onKeyDown=${(e) => e.key === "Enter" && setOpen(s)}>
            <${StyleVideo} s=${s} ori=${ori} className="card-sv" />
            <div style="padding:12px 8px 4px"><div class="row between"><b class="t-heading">${s.name}</b><${Chip} tone="neutral" size="sm">${label(s.type)}<//></div><p class="t-small muted" style="margin-top:2px">${s.vibe}</p>
              <div class="row wrap" style="gap:6px;margin-top:10px">${s.ori.map((o) => html`<span key=${o} class="tag">${ORI_LABEL[o]}</span>`)}<span class="tag-sep" />${s.platforms.map((pl) => html`<span key=${pl} class="tag brand">${(plats.find(([k]) => k === pl) || [])[1] || pl}</span>`)}</div></div>
          </div>`)}
        </div>`}
      </div>`; }}<//>
    ${open && html`<${Modal} title=${open.name} sub=${open.vibe} onClose=${() => setOpen(null)} wide footer=${html`<${Btn} kind="ghost" onClick=${() => setOpen(null)}>Close<//><${Btn} id="use-style" icon="spark" onClick=${() => { const id = open.id; setOpen(null); if (onPick) onPick(id); else requireUser(() => setNp(id)); }}>${onPick ? "Use this style" : "Use in a project"}<//>`}>
      <div class="row between"><${Chip} tone="neutral" size="sm">${label(open.type)}<//><${Seg} size="sm" value=${mOri || open.ori[0]} options=${open.ori.map((o) => ({ value: o, label: ORI_LABEL[o] }))} onChange=${setMOri} /></div>
      <${StyleVideo} s=${open} ori=${mOri || open.ori[0]} className="modal-sv" />
      <div class="rules"><div class="r"><b>Cut pace</b>${open.cutPace}</div><div class="r"><b>Caption look</b>${open.captionRule}</div><div class="r"><b>Zoom rules</b>${open.zoomRules}</div><div class="r"><b>Music vibe</b>${open.musicVibe}</div></div>
      <div class="row wrap" style="gap:6px"><span class="t-small muted">Best on</span>${open.platforms.map((pl) => html`<span key=${pl} class="tag brand">${(plats.find(([k]) => k === pl) || [])[1] || pl}</span>`)}<span class="t-small muted" style="margin-left:8px">Shapes</span>${open.ori.map((o) => html`<span key=${o} class="tag">${ORI_LABEL[o]}</span>`)}</div>
    <//>`}
    ${np && html`<${NewProjectModal} styleId=${np} onClose=${() => setNp(null)} onCreated=${(p) => { setNp(null); go("/editor/" + p.id); }} />`}
  </div>`;
}


/* ---------- /home: community gallery ---------- */
const fmtK = (n) => (n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1) + "k" : String(n));
function HomePage() { return html`<${ExploreFeed} />`; }
function ExploreFeed({ types, embedded, title = "Made with Rendrr by the community", sub = "Take any edit, recreate it with your own footage, keep the style." }) {
  const { go } = useNav(); const toast = useToast(); const { requireUser, user } = useApp();
  const q = useAsync(() => api.listGallery(), []); const fq = useAsync(() => api.getStyleFilters(), []);
  const [ori, setOri] = useState("All"); const [plat, setPlat] = useState("all"); const [sort, setSort] = useState("trending"); const [mine, setMine] = useState(false);
  const [open, setOpen] = useState(null); const [publish, setPublish] = useState(false); const [recreate, setRecreate] = useState(null); const [limit, setLimit] = useState(60);
  useEffect(() => { setLimit(60); }, [sort, mine, types]);
  const plats = fq.data?.platforms || []; const pl = (k) => (plats.find(([x]) => x === k) || [])[1] || k;
  const like = (e, g) => { e.stopPropagation(); requireUser(async () => { try { const u = await api.likeGalleryItem(g.id); q.setData((d) => d.map((i) => (i.id === g.id ? { ...i, ...u } : i))); if (open?.id === g.id) setOpen((o) => ({ ...o, ...u })); } catch (er) { toast(er.message); } }); };
  const startRecreate = (e, g) => { e?.stopPropagation(); if (!g.allowRecreate) { toast("The creator turned off recreate for this one."); return; } requireUser(() => { setOpen(null); setRecreate(g); }); };
  const unpublish = async (g) => { try { await api.unpublishFromGallery(g.id); q.setData((d) => d.filter((i) => i.id !== g.id)); setOpen(null); toast("Removed from the gallery"); } catch (er) { toast(er.message); } };
  const actions = html`<div class="row"><${Btn} kind=${mine ? "primary" : "secondary"} size="sm" icon="user" id="gallery-mine" aria-pressed=${mine} onClick=${() => requireUser(() => setMine((m) => !m))}>My videos<//><${Btn} size="sm" icon="globe" id="publish-video" onClick=${() => requireUser(() => setPublish(true))}>Publish a video<//></div>`;
  const sortSeg = html`<${Dropdown} id="sort-dd" left value=${sort} options=${[{ value: "trending", label: "Trending" }, { value: "newest", label: "Newest" }, { value: "recreated", label: "Most recreated" }]} onChange=${setSort} />`;
  return html`<div class=${embedded ? "col" : "page wide"} style=${embedded ? "gap:16px" : ""}>
    ${embedded ? html`<div class="row between">${sortSeg}${actions}</div>` : html`<div class="page-head"><div><h1 class="t-title">${title}</h1><p class="muted">${sub}</p></div>${!types && actions}</div>
    <div class="row">${sortSeg}</div>`}
    <${Async} q=${q} skeleton=${html`<${GridSkeleton} n=${8} />`} whenEmpty=${html`<${EmptyState} icon="globe" title="The gallery is empty" text="Be the first. Publish a finished project and others can recreate it." action=${html`<${Btn} onClick=${() => setPublish(true)}>Publish a video<//>`} />`}>${(list) => {
      let shown = list.filter((g) => (!types || types.includes(g.style?.type)) && (ori === "All" || g.ori === ori) && (plat === "all" || g.platforms.includes(plat)) && (!mine || g.mine));
      shown = [...shown].sort((a, b) => sort === "newest" ? b.at - a.at : sort === "recreated" ? b.recreates - a.recreates : (b.likes * 3 + b.views / 100) - (a.likes * 3 + a.views / 100));
      const all = shown; shown = shown.slice(0, limit);
      return html`<div class="col" style="gap:12px"><span class="t-small muted" id="gallery-count">${all.length} videos</span>
        ${shown.length === 0 ? html`<${EmptyState} icon="search" title="Nothing here yet" text=${mine ? "You have not published a video yet." : "Try another shape or platform."} action=${mine ? html`<${Btn} size="sm" onClick=${() => setPublish(true)}>Publish a video<//>` : null} />` : html`<${Masonry} items=${shown} oriOf=${(g) => g.ori} render=${(g) => html`<div key=${g.id} class="gcard" role="button" tabindex="0" data-g=${g.id} onClick=${() => setOpen(g)} onKeyDown=${(e) => e.key === "Enter" && setOpen(g)}>
            <${StyleVideo} s=${g.style} ori=${g.ori} className="fill" />
            <div class="gtop"><span class="gauthor" title=${g.title}><span class="gava">${initials(g.author)}</span><b>${g.mine && user ? "You" : g.author}</b></span><span class="gtag" title=${g.style.name}><${Icon} name="styles" size="11" /></span></div>
            <div class="gbot"><button class=${"glike" + (g.liked ? " on" : "")} aria-pressed=${g.liked} aria-label="Like" onClick=${(e) => like(e, g)}><${Icon} name="heart" size="14" />${fmtK(g.likes)}</button>
              <button class="grec" data-recreate=${g.id} onClick=${(e) => startRecreate(e, g)}><${Icon} name="refresh" size="14" />Recreate</button></div>
          </div>`} />`}
        ${all.length > shown.length && html`<div class="row" style="justify-content:center;padding:8px 0"><${Btn} kind="secondary" id="show-more" onClick=${() => setLimit((l) => l + 60)}>Show more (${all.length - shown.length} left)<//></div>`}
      </div>`; }}<//>
    ${open && html`<${Modal} title=${open.title} sub=${open.author + " · " + fmtAgo(open.at)} onClose=${() => setOpen(null)} wide footer=${html`${open.mine && html`<${Btn} kind="ghost" onClick=${() => unpublish(open)}>Remove from gallery<//>`}<${Btn} kind="secondary" icon="heart" onClick=${(e) => like(e, open)}>${open.liked ? "Liked" : "Like"} · ${fmtK(open.likes)}<//><${Btn} id="recreate-open" icon="refresh" disabled=${!open.allowRecreate} onClick=${(e) => startRecreate(e, open)}>Recreate this<//>`}>
      <${StyleVideo} s=${open.style} ori=${open.ori} className="modal-sv" />
      <div class="four" style="gap:12px">${[["Style", open.style.name], ["Shape", ORI_LABEL[open.ori]], ["Recreated", fmtK(open.recreates) + " times"], ["Best on", open.platforms.map(pl).join(", ")]].map(([k, v]) => html`<div key=${k} class="card flat tight"><div class="t-small muted">${k}</div><b class="t-label">${v}</b></div>`)}</div>
      ${!open.allowRecreate && html`<p class="t-small muted">The creator turned off recreate for this video.</p>`}
    <//>`}
    ${recreate && html`<${RecreateModal} g=${recreate} onClose=${() => setRecreate(null)} />`}
    ${publish && html`<${PublishModal} plats=${plats} onClose=${() => setPublish(false)} onPublished=${(g) => { q.setData((d) => [g, ...(d || [])]); setPublish(false); setMine(true); }} />`}
  </div>`;
}
function PublishModal({ plats, onClose, onPublished }) {
  const toast = useToast(); const pq = useAsync(() => api.listProjects(), []);
  const [projectId, setProjectId] = useState(""); const [title, setTitle] = useState(""); const [chosen, setChosen] = useState(["instagram"]); const [allow, setAllow] = useState(true); const [busy, setBusy] = useState(false); const [err, setErr] = useState(null);
  const proj = (pq.data || []).find((p) => p.id === projectId);
  const toggle = (k) => setChosen((x) => (x.includes(k) ? x.filter((i) => i !== k) : [...x, k]));
  const go_ = async () => { setBusy(true); setErr(null); try { const g = await api.publishToGallery({ projectId, title: title || proj?.name, platforms: chosen, allowRecreate: allow }); toast("Published to the gallery", { icon: "check", tone: "brand" }); onPublished(g); } catch (e) { setErr(e.message); setBusy(false); } };
  return html`<${Modal} title="Publish a video" sub="Share a project with the community. Others can like it and recreate the style with their footage." onClose=${onClose} footer=${html`<${Btn} kind="ghost" onClick=${onClose}>Cancel<//><${Btn} id="publish-go" icon="globe" disabled=${busy || !projectId} onClick=${go_}>${busy ? "Publishing…" : "Publish"}<//>`}>
    <${Field} label="Project" id="pb-project"><select id="pb-project" class="input" value=${projectId} onChange=${(e) => { setProjectId(e.target.value); const p = (pq.data || []).find((x) => x.id === e.target.value); if (p && !title) setTitle(p.name); }}><option value="">Choose a project…</option>${(pq.data || []).map((p) => html`<option key=${p.id} value=${p.id}>${p.name} · ${p.status}</option>`)}</select><//>
    ${proj && html`<div class="row" style="gap:12px"><div style="width:160px"><${StyleVideo} s=${proj.style} ori=${proj.aspect} className="fill" /></div><div class="col" style="gap:4px"><b class="t-label">${proj.style?.name}</b><span class="t-small muted">${ORI_LABEL[proj.aspect]} · v${proj.version}</span></div></div>`}
    <${Field} label="Title" id="pb-title"><input id="pb-title" class="input" value=${title} onInput=${(e) => setTitle(e.target.value)} placeholder="Give it a catchy title" /><//>
    <div class="col" style="gap:8px"><span class="t-small muted" style="padding-left:16px">Made for</span><div class="row wrap" style="gap:8px">${plats.map(([k, l]) => html`<button key=${k} type="button" class=${"chip sm " + (chosen.includes(k) ? "ink" : "neutral")} aria-pressed=${chosen.includes(k)} onClick=${() => toggle(k)}>${l}</button>`)}</div></div>
    <div class="row between"><div><b class="t-label">Let others recreate it</b><p class="t-small muted">They get the style, not your footage.</p></div><${Toggle} id="pb-allow" on=${allow} onChange=${setAllow} label="Allow recreate" /></div>
    ${err && html`<p role="alert" class="t-small">${err}</p>`}
  <//>`;
}

/* ---------- /reviews ---------- */
function CreateLinkModal({ projectId, folder, onClose, onCreated }) {
  const pq = useAsync(() => api.listProjects(), []); const toast = useToast();
  // version 0 = the latest one (the API shares its newest saved version). V1 is the raw footage, so it is never the default.
  const [form, setForm] = useState({ projectId: projectId || "", version: 0, password: false, pw: "", expires: "", allowDownload: false, showLogo: true });
  const [busy, setBusy] = useState(false); const [made, setMade] = useState(null); const [err, setErr] = useState(null);
  const f = (k) => (v) => setForm((x) => ({ ...x, [k]: v }));
  const link = made ? window.location.origin + "/review/" + made.token : null;
  const create = async () => { setBusy(true); setErr(null); try { const r = await api.createReviewLink({ projectId: folder ? null : form.projectId, folderId: folder?.id || null, version: +form.version || undefined, password: form.password ? form.pw || "rendrr" : null, expires: form.expires, allowDownload: form.allowDownload, showLogo: form.showLogo }); setMade(r); onCreated?.(r); } catch (e) { setErr(e.message); } finally { setBusy(false); } };
  const proj = (pq.data || []).find((p) => p.id === form.projectId);
  return html`<${Modal} title=${made ? "Your link is ready" : folder ? "Share the whole folder" : "Create review link"} sub=${made ? "Send it to your client. They do not need an account." : folder ? "Your client sees every video in " + folder.name + " on one page." : "Your client gets a page to watch, comment and approve."} onClose=${onClose}
    footer=${made ? html`<${Btn} kind="ghost" onClick=${onClose}>Done<//>` : html`<${Btn} kind="ghost" onClick=${onClose}>Cancel<//><${Btn} id="make-link" disabled=${busy || (!folder && !form.projectId)} onClick=${create}>${busy ? "Creating…" : "Create link"}<//>`}>
    ${made ? html`<div class="copybox" id="made-link"><code>${link}</code><${Btn} size="sm" icon="copy" onClick=${() => copyText(link, toast)}>Copy link<//></div>
      <div class="row"><${Chip} tone="neutral" size="sm">${made.password ? "Password on" : "No password"}<//><${Chip} tone="neutral" size="sm">Expires ${made.expires}<//><${Chip} tone="neutral" size="sm">${made.allowDownload ? "Download on" : "No download"}<//></div>
      ${made.password && html`<p class="t-small muted">Password: <b>${made.password}</b>. Share it separately.</p>`}` : html`
      ${folder ? html`<div class="row" style="gap:12px"><div class=${"mini cover c" + folder.cover} style="width:56px;height:40px" /><div><b class="t-label">${folder.name}</b><p class="t-small muted">${(folder.assets || []).length} videos, one link</p></div></div>` : html`<${Field} label="Video" id="rl-project"><select id="rl-project" class="input" value=${form.projectId} onChange=${(e) => setForm((x) => ({ ...x, projectId: e.target.value, version: 0 }))}><option value="">Choose a video…</option>${(pq.data || []).map((p) => html`<option key=${p.id} value=${p.id}>${p.folder?.name} / ${p.name}</option>`)}</select><//>`}
      ${!folder && html`<${Field} label="Version" id="rl-version"><select id="rl-version" class="input" value=${+form.version || proj?.version || 1} onChange=${(e) => f("version")(e.target.value)}>${Array.from({ length: proj?.version || 1 }).map((_, i) => html`<option key=${i} value=${i + 1}>v${i + 1}${i + 1 === (proj?.version || 1) ? " (latest)" : ""}</option>`)}</select><//>`}
      <div class="row between"><div><b class="t-label">Password</b><p class="t-small muted">Client types it before watching</p></div><${Toggle} id="rl-pw" on=${form.password} onChange=${f("password")} label="Password" /></div>
      ${form.password && html`<input class="input" placeholder="Password (default: rendrr)" value=${form.pw} onInput=${(e) => f("pw")(e.target.value)} aria-label="Password" />`}
      <${Field} label="Expiry date" id="rl-exp" hint="Leave empty for no expiry"><input id="rl-exp" class="input" type="date" value=${form.expires} onInput=${(e) => f("expires")(e.target.value)} /><//>
      <div class="row between"><div><b class="t-label">Allow download</b><p class="t-small muted">Client can save the video</p></div><${Toggle} id="rl-dl" on=${form.allowDownload} onChange=${f("allowDownload")} label="Allow download" /></div>
      <div class="row between"><div><b class="t-label">Show my logo</b><p class="t-small muted">From Settings › Brand</p></div><${Toggle} id="rl-logo" on=${form.showLogo} onChange=${f("showLogo")} label="Show my logo" /></div>
      ${err && html`<p role="alert" class="t-small">${err}</p>`}`}
  <//>`;
}
/* ---------- /review/:token (client view, no login) ---------- */
function ClientReviewPage({ token }) {
  const { go } = useNav(); const toast = useToast(); const { user } = useApp();
  const q = useAsync(() => api.getReview(token), [token]);
  const r = q.data;
  const backBtn = user ? html`<${Btn} kind="quiet" size="sm" icon="x" id="rv-back" onClick=${() => go("/projects")}>Back to app<//>` : null;
  const [unlocked, setUnlocked] = useState(false); const [pw, setPw] = useState(""); const [pwErr, setPwErr] = useState(null); const [pwBusy, setPwBusy] = useState(false);
  const [ver, setVer] = useState(null); const [compose, setCompose] = useState(null); const [pick, setPick] = useState(null); const [text, setText] = useState(""); const [busy, setBusy] = useState(""); const [changes, setChanges] = useState(false); const [note, setNote] = useState("");
  const version = ver || r?.version;
  // The rendered file for what is on screen: this version of the edit, or the picked video of a shared folder.
  const itemId = r ? (r.folder ? (pick || r.items?.[0]?.id) : r.project?.id) : null;
  const media = r?.media?.[itemId];
  const clip = media ? (r.folder ? media.latest : media.versions?.[version] || (version === r.version ? media.latest : null)) : null;
  const dur = clip?.seconds || 30;
  const pb = usePlayback(dur);
  // Video links last 10 minutes: fetch fresh ones when the browser says one stopped working.
  const refreshMedia = async () => { try { const m = await api.getReviewMedia(token); q.setData((d) => (d ? { ...d, media: m } : d)); } catch { /* keep the old one */ } };
  // Nothing to play yet (a version never rendered, or a render still going): ask for it, then look again every 5 s.
  useEffect(() => {
    if (!r || r.locked || clip || !itemId) return;
    let on = true, n = 0;
    const tick = async () => { try { const m = await api.getReviewMedia(token, r.folder ? undefined : version); if (on) q.setData((d) => (d ? { ...d, media: m } : d)); } catch { /* try again */ } };
    tick();
    const t = setInterval(() => { if (++n > 60) clearInterval(t); else tick(); }, 5000);
    return () => { on = false; clearInterval(t); };
  }, [r?.token, r?.locked, itemId, version, !!clip]);
  const unlock = async (e) => { e.preventDefault(); setPwBusy(true); setPwErr(null); try { await api.checkReviewPassword(token, pw); setUnlocked(true); q.reload(); } catch (er) { setPwErr(er.message); } finally { setPwBusy(false); } };
  const openCompose = () => { pb.setPlaying(false); setCompose(pb.time); setText(""); };
  const send = async () => { if (!text.trim()) return; setBusy("comment"); try { const c = await api.addReviewComment(token, { time: compose, text, projectId: r?.folder ? itemId : undefined }); q.setData((d) => ({ ...d, comments: [...d.comments, c] })); setCompose(null); toast("Comment added at " + fmtTime(compose), { icon: "check", tone: "brand" }); } catch (e) { toast(e.message); } finally { setBusy(""); } };
  const approve = async () => { setBusy("approve"); try { const d = await api.approveReview(token); q.setData(d); toast("Approved. Nice work.", { icon: "check", tone: "brand" }); } catch (e) { toast(e.message); } finally { setBusy(""); } };
  const request = async () => { setBusy("changes"); try { const d = await api.requestChanges(token, note); q.setData(d); setChanges(false); setNote(""); toast("Sent. The editor will see your note.", { icon: "check" }); } catch (e) { toast(e.message); } finally { setBusy(""); } };
  return html`<div class="rv">
    <${Async} q=${q} skeleton=${html`<div style="padding:48px"><${Skeleton} rows=${4} /></div>`}>${(r) => r.locked && !unlocked ? html`<div class="rv-pw" style="position:relative"><div style="position:absolute;top:16px;right:32px">${backBtn}</div><form class="card lg col" style="width:420px;gap:16px" onSubmit=${unlock}>
        <div class="state" style="padding:0;box-shadow:none;background:none"><div class="ico"><${Icon} name="lock" /></div><h2 class="t-title">This review is locked</h2><p>Enter the password ${r.brand} sent you.</p></div>
        <input id="rv-pw" class="input" type="password" placeholder="Password" value=${pw} onInput=${(e) => setPw(e.target.value)} aria-label="Password" />
        ${pwErr && html`<p role="alert" class="t-small" style="padding-left:16px">${pwErr}</p>`}
        <${Btn} type="submit" disabled=${pwBusy}>${pwBusy ? "Checking…" : "Watch the video"}<//>
      </form></div>` : html`
      <div class="rv-top"><div class="row" style="gap:16px">${r.showLogo && r.logo ? html`<img src=${r.logo} alt="Logo" style="height:36px;max-width:140px;object-fit:contain" />` : html`<div class="logo" style="padding:0;margin:0"><span class="mark" style="background:var(--ink);color:var(--bg)"><${Icon} name="logo" /></span>${r.showLogo ? r.brand : "Review"}</div>`}<span class="muted">${r.folder ? r.folder.name : r.project.name}</span></div>
        <div class="row"><${Seg} size="sm" value=${version} options=${Array.from({ length: r.version }).map((_, i) => ({ value: i + 1, label: "v" + (i + 1) }))} onChange=${setVer} />${r.allowDownload && html`<${Btn} kind="secondary" size="sm" icon="download" onClick=${() => (clip?.download ? window.open(clip.download, "_blank", "noopener") : toast("This version is still rendering. Try again in a minute."))}>Download<//>`}${backBtn}</div></div>
      ${r.folder && html`<div class="row wrap" style="gap:8px;padding:0 32px 16px" id="rv-items">${r.items.map((it) => html`<button key=${it.id} class=${"chip sm " + ((pick || r.items[0].id) === it.id ? "ink" : "neutral")} data-item=${it.id} onClick=${() => { setPick(it.id); pb.seek(0); }}>${it.name}</button>`)}</div>`}
      <div class="rv-body">
        <div class="col" style="gap:16px">
          <div style="height:68vh;display:flex;justify-content:center">${!clip ? html`<div class="state" style="width:100%"><div class="ico"><${Icon} name="clock" /></div><h3 class="t-heading">Rendering the preview…</h3><p>Refresh in a minute.</p><${Btn} kind="secondary" size="sm" icon="refresh" onClick=${q.reload}>Refresh<//></div>` : html`<${Player} key=${itemId + ":" + version} style=${{ height: "100%", maxWidth: "100%" }} pb=${pb} duration=${dur} src=${clip.url} onVideoError=${refreshMedia} aspect=${(r.folder ? (r.items.find((it) => it.id === pick) || r.items[0]).aspect : r.project.aspect)} marks=${r.comments.filter((c) => c.time > 0 && (!r.folder || !c.projectId || c.projectId === itemId))} onMark=${(c) => pb.seek(c.time)} onClickVideo=${openCompose}>
            ${compose !== null && html`<div class="compose" onClick=${(e) => e.stopPropagation()}><${Chip} tone="neutral" size="sm" class="mono">${fmtTime(compose)}<//><input id="rv-comment" class="input sm" autoFocus placeholder="What should change here?" value=${text} onInput=${(e) => setText(e.target.value)} onKeyDown=${(e) => e.key === "Enter" && send()} /><${Btn} size="sm" id="rv-send" disabled=${busy === "comment"} onClick=${send}>Add<//><${Btn} kind="quiet" size="sm" icon="x" aria-label="Cancel" onClick=${() => setCompose(null)} /></div>`}
          <//>`}</div>
          <p class="t-small muted" style="text-align:center">Click anywhere on the video to leave a comment at that second.</p>
          <div class="card lg" style="display:flex;align-items:center;justify-content:space-between;gap:24px">
            <div><h2 class="t-title">${r.approved ? "You approved this edit" : "Happy with this version?"}</h2><p class="muted">${r.approved ? "The editor will send the final file." : "Approve it, or tell us what to change."}</p></div>
            ${r.approved ? html`<${Chip}><${Icon} name="check" />Approved v${r.version}<//>` : html`<div class="row"><${Btn} kind="secondary" id="rv-changes" onClick=${() => setChanges(true)}>Request changes<//><${Btn} id="rv-approve" icon="check" disabled=${busy === "approve"} onClick=${approve}>${busy === "approve" ? "Saving…" : "Approve"}<//></div>`}
          </div>
          ${changes && html`<div class="card col" style="gap:12px"><b class="t-heading">What should change?</b><textarea id="rv-note" class="input" placeholder="Tell the editor in a few lines" value=${note} onInput=${(e) => setNote(e.target.value)} /><div class="row" style="justify-content:flex-end"><${Btn} kind="ghost" onClick=${() => setChanges(false)}>Cancel<//><${Btn} id="rv-send-changes" disabled=${busy === "changes" || !note.trim()} onClick=${request}>Send<//></div></div>`}
        </div>
        <div class="panel" style="max-height:calc(100vh - 140px)"><div class="ph"><b class="t-heading">Comments</b><${Chip} tone="neutral" size="sm">${r.comments.length}<//></div>
          <div class="pb list">${r.comments.length === 0 ? html`<div class="state" style="padding:40px 16px;box-shadow:none;background:var(--raised)"><div class="ico"><${Icon} name="comment" /></div><b class="t-label">No comments yet</b><p class="t-small">Click the video to add the first one.</p></div>` : r.comments.map((c) => html`<div key=${c.id} class=${"li click" + (c.resolved ? " done" : "")} onClick=${() => pb.seek(c.time)}>${c.time > 0 && html`<${Chip} tone="brand" size="sm" class="mono">${fmtTime(c.time)}<//>`}<div class="grow"><div class="t">${c.text}</div><div class="sub">${c.author} · ${fmtAgo(c.at)}${c.resolved ? " · Resolved" : ""}</div></div></div>`)}</div></div>
      </div>`}<//>
  </div>`;
}

/* ---------- /connect ---------- */
function ConnectPage() {
  const toast = useToast(); const q = useAsync(() => api.getConnectStatus(), []); const aq = useAsync(() => api.getAiActivity(), []);
  const [tab, setTab] = useState("claude"); const [busy, setBusy] = useState(false);
  const steps = { claude: ["Open Claude › Settings › Connectors › Add custom connector", "Paste your connector URL and name it Rendrr", "Say: 'Edit my latest footage in the Clean Podcast style'"], chatgpt: ["Open ChatGPT › Settings › Connectors › Create", "Paste your connector URL and allow all tools", "Say: 'Make a 30 second reel from my gym footage'"] };
  const test = async () => { setBusy(true); try { const d = await api.testConnection(tab); q.setData(d); toast((tab === "claude" ? "Claude" : "ChatGPT") + " is connected", { icon: "check", tone: "brand" }); } catch (e) { toast(e.message); } finally { setBusy(false); } };
  const disc = async () => { setBusy(true); try { const d = await api.disconnect(tab); q.setData(d); toast("Disconnected"); } catch (e) { toast(e.message); } finally { setBusy(false); } };
  return html`<div class="page">
    <div class="page-head"><div><h1 class="t-title">Connect AI</h1><p class="muted">Plug your own Claude or ChatGPT into Rendrr. It edits, you approve.</p></div></div>
    <${Async} q=${q} skeleton=${html`<${Skeleton} rows=${5} />`}>${(c) => { const on = c[tab] === "connected"; return html`
      <div class="two" style="align-items:start">
        <div class="col" style="gap:24px">
          <div class="card col" style="gap:16px"><b class="t-heading">Your connector URL</b><div class="copybox" id="mcp-url"><code>${c.url}</code><${Btn} size="sm" icon="copy" id="copy-url" onClick=${() => copyText(c.url, toast)}>Copy<//></div><p class="t-small muted">Your AI will ask you to log in to Rendrr the first time.</p></div>
          <div class="card col" style="gap:16px">
            <div class="row between"><${Seg} value=${tab} options=${[{ value: "claude", label: "Claude" }, { value: "chatgpt", label: "ChatGPT" }]} onChange=${setTab} />
              <${Chip} tone=${on ? "brand" : "neutral"} id="conn-status"><i class=${"dot " + (on ? "brand" : "")} />${on ? "Connected" : "Not connected"}<//></div>
            <div class="col" style="gap:16px">${steps[tab].map((s, i) => html`<div key=${i} class="step-card"><div class="n">${i + 1}</div><p>${s}</p></div>`)}</div>
            <div class="row">${on ? html`<${Btn} kind="secondary" size="sm" disabled=${busy} onClick=${disc}>Disconnect<//>` : html`<${Btn} size="sm" id="test-conn" icon="zap" disabled=${busy} onClick=${test}>${busy ? "Checking…" : "Test connection"}<//>`}</div>
          </div>
        </div>
        <div class="col" style="gap:24px">
          <div class="card col" style="gap:12px"><b class="t-heading">What your AI can do</b><div class="list">${c.tools.map(([t, d]) => html`<div key=${t} class="li"><div class="step-card" style="gap:12px"><div class="n" style="width:28px;height:28px"><${Icon} name="check" size="14" /></div><div><div class="t" style="font-weight:500">${t}</div><div class="sub">${d}</div></div></div></div>`)}</div></div>
          <div class="card col" style="gap:12px"><div class="row between"><b class="t-heading">Recent AI activity</b><${Btn} kind="quiet" size="xs" icon="refresh" onClick=${aq.reload}>Refresh<//></div>
            <${Async} q=${aq} skeleton=${html`<${Skeleton} card=${false} rows=${4} />`} whenEmpty=${html`<p class="muted t-small">Nothing yet. Ask your AI to edit something.</p>`}>${(list) => html`<div class="list">${list.slice(0, 6).map((a) => html`<div key=${a.id} class="li"><${Chip} tone="neutral" size="sm">${a.ai}<//><div class="grow"><div class="t">${a.text}</div><div class="sub">${a.project?.name} · ${fmtAgo(a.at)}</div></div></div>`)}</div>`}<//>
          </div>
        </div>
      </div>`; }}<//>
  </div>`;
}

/* ---------- /usage ---------- */
function UsagePage() {
  const toast = useToast(); const q = useAsync(() => api.getUsage(), []);
  const hq = useAsync(() => api.getUsageHistory(), []);
  return html`<div class="page">
    <div class="page-head"><div><h1 class="t-title">Usage</h1><p class="muted">What you rendered this month, and how much room is left.</p></div><${Btn} kind="secondary" id="manage-plan" onClick=${() => toast("Plan settings open in billing (demo)")}>Manage plan<//></div>
    <${Async} q=${q} skeleton=${html`<div class="three">${[1, 2, 3].map((i) => html`<div key=${i} class="card"><div class="skeleton" style="height:56px;width:60%" /></div>`)}</div>`}>${(u) => html`
      <div class="three">
        <div class="card stat"><span class="big" id="minutes-big">${u.renderMinutes}</span><span class="lbl">Render minutes this month</span></div>
        <div class="card stat"><span class="big">${u.videosEdited}</span><span class="lbl">Videos edited this month</span></div>
        <div class="card stat"><span class="big" style="font-size:32px;line-height:56px">${u.plan}</span><span class="lbl">Current plan · renews ${u.planRenew}</span></div>
      </div>
      <div class="card col" style="gap:12px" id="storage-card"><div class="row between"><div><b class="t-heading">Storage</b><p class="t-small muted">Only light preview copies and your final exports live with us.</p></div><b class="t-label">${u.storageUsedGB} GB of ${u.storageTotalGB} GB used</b></div>
        <div class="bar big split"><i style=${{ width: Math.round((u.previewsGB / u.storageTotalGB) * 100) + "%" }} /><i class="alt" style=${{ width: Math.round((u.finalsGB / u.storageTotalGB) * 100) + "%" }} /></div>
        <div class="row" style="gap:16px"><span class="t-small"><i class="dot" style="background:var(--ink)" /> Previews ${u.previewsGB} GB</span><span class="t-small"><i class="dot" style="background:var(--muted)" /> Finals ${u.finalsGB} GB</span><div class="grow" /><span class="t-small">${(u.storageTotalGB - u.storageUsedGB).toFixed(1)} GB free</span></div>
        <p class="t-small muted" id="usage-note">Raw footage in your Drive and on your computer is not counted.</p></div>`}<//>
    <${Async} q=${hq} skeleton=${html`<div class="card"><div class="skeleton" style="height:140px" /></div>`}>${(days) => html`<${Heatmap} days=${days} />`}<//>
  </div>`;
}

// 12 weeks of activity, one square per day. Darker = more render minutes that day.
function Heatmap({ days }) {
  const max = Math.max(1, ...days.map((d) => d.minutes));
  const level = (c) => (c === 0 ? 0 : Math.min(4, Math.ceil((c / max) * 4)));
  const first = new Date(days[0].date + "T00:00:00"); const pad = (first.getDay() + 6) % 7; // Monday first
  const cells = [...Array(pad).fill(null), ...days];
  const weeks = []; for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  const months = weeks.map((w, i) => { const d = w.find(Boolean); if (!d) return ""; const dt = new Date(d.date + "T00:00:00"); const prev = weeks[i - 1]?.find(Boolean); const pm = prev ? new Date(prev.date + "T00:00:00").getMonth() : -1; return dt.getMonth() !== pm ? dt.toLocaleString("en", { month: "short" }) : ""; });
  const total = +days.reduce((a, d) => a + d.minutes, 0).toFixed(0); const renders = days.reduce((a, d) => a + d.renders, 0); const busiest = days.reduce((a, d) => (d.minutes > a.minutes ? d : a), days[0]);
  const active = days.filter((d) => d.renders > 0).length;
  const fmt = (iso) => new Date(iso + "T00:00:00").toLocaleDateString("en", { weekday: "short", day: "numeric", month: "short" });
  return html`<div class="card col" style="gap:16px" id="heatmap">
    <div class="row between"><div><b class="t-heading">Activity, last 12 weeks</b><p class="t-small muted">${renders} renders · ${total} render minutes · active ${active} of ${days.length} days</p></div><span class="t-small muted">Busiest: ${fmt(busiest.date)} (${busiest.minutes} min)</span></div>
    <div class="hm">
      <div class="hm-days"><span>Mon</span><span /><span>Wed</span><span /><span>Fri</span><span /><span>Sun</span></div>
      <div class="hm-grid"><div class="hm-months">${months.map((m, i) => html`<span key=${i}>${m}</span>`)}</div>
        <div class="hm-weeks">${weeks.map((w, i) => html`<div key=${i} class="hm-week">${Array.from({ length: 7 }).map((_, j) => { const d = w[j]; return d ? html`<i key=${j} class=${"hm-cell l" + level(d.minutes)} data-level=${level(d.minutes)} title=${fmt(d.date) + ": " + d.renders + (d.renders === 1 ? " render, " : " renders, ") + d.minutes + " min"} />` : html`<i key=${j} class="hm-cell empty" />`; })}</div>`)}</div></div>
    </div>
    <div class="row" style="gap:6px;justify-content:flex-end"><span class="t-small muted">Less</span>${[0, 1, 2, 3, 4].map((l) => html`<i key=${l} class=${"hm-cell l" + l} style="width:12px;height:12px" />`)}<span class="t-small muted">More</span></div>
  </div>`;
}

/* ---------- /settings ---------- */
function SettingsPage() {
  const toast = useToast(); const { go } = useNav(); const { user, setUser } = useApp();
  const q = useAsync(() => api.getSettings(), []);
  const [name, setName] = useState(user?.name || ""); const [email, setEmail] = useState(user?.email || ""); const [busy, setBusy] = useState(false);
  const photoRef = useRef(); const logoRef = useRef();
  const readFile = (f, cb) => { const r = new FileReader(); r.onload = () => cb(r.result); r.readAsDataURL(f); };
  const save = async () => { setBusy(true); try { const u = await api.updateProfile({ name, email }); setUser({ ...u }); toast("Saved", { icon: "check", tone: "brand" }); } catch (e) { toast(e.message); } finally { setBusy(false); } };
  const setLogo = async (data) => { try { const u = await api.uploadLogo(data); setUser({ ...u }); toast(data ? "Logo saved" : "Logo removed", { icon: "check", tone: "brand" }); } catch (e) { toast(e.message); } };
  const dq = useAsync(() => api.getDriveStatus(), []); const [confirmFinals, setConfirmFinals] = useState(false); const [dbusy, setDbusy] = useState(false);
  const toggleDrive = async () => { setDbusy(true); try { const d = dq.data?.connected ? await api.disconnectDrive() : await api.connectDrive(); dq.setData(d); toast(d.connected ? "Google Drive connected" : "Google Drive disconnected", { icon: "drive" }); } catch (e) { toast(e.message); } finally { setDbusy(false); } };
  const deleteFinals = async () => { setDbusy(true); try { const r = await api.deleteAllFinals(); setConfirmFinals(false); toast(r.deleted + (r.deleted === 1 ? " final deleted" : " finals deleted"), { icon: "trash" }); } catch (e) { toast(e.message); } finally { setDbusy(false); } };
  return html`<div class="page">
    <div class="page-head"><div><h1 class="t-title">Settings</h1><p class="muted">Your profile, your brand, your storage.</p></div></div>
    <div class="two" style="align-items:start">
      <div class="col" style="gap:24px">
        <div class="card col" style="gap:16px"><b class="t-heading">Profile</b>
          <div class="row" style="gap:16px"><div class="avatar lg">${user?.photo ? html`<img src=${user.photo} alt="" />` : initials(user?.name)}</div><input type="file" accept="image/*" class="hide" ref=${photoRef} onChange=${(e) => { const f = e.target.files[0]; e.target.value = ""; if (f) readFile(f, async (d) => { const u = await api.updateProfile({ photo: d }); setUser({ ...u }); toast("Photo updated", { icon: "check", tone: "brand" }); }); }} /><${Btn} kind="secondary" size="sm" onClick=${() => photoRef.current.click()}>Change photo<//></div>
          <${Field} label="Name" id="st-name"><input id="st-name" class="input" value=${name} onInput=${(e) => setName(e.target.value)} /><//>
          <${Field} label="Email" id="st-email"><input id="st-email" class="input" type="email" value=${email} onInput=${(e) => setEmail(e.target.value)} /><//>
          <div class="row" style="justify-content:flex-end"><${Btn} id="save-profile" disabled=${busy} onClick=${save}>${busy ? "Saving…" : "Save"}<//></div></div>
      </div>
      <div class="col" style="gap:24px">
        <div class="card col" style="gap:16px"><b class="t-heading">Brand</b><p class="muted t-small">Your logo shows at the top of client review pages.</p>
          <div class="row" style="gap:16px"><div class="logo-prev">${user?.logo ? html`<img src=${user.logo} alt="Your logo" />` : html`<span class="t-small muted">No logo</span>`}</div><input type="file" accept="image/*" class="hide" ref=${logoRef} onChange=${(e) => { const f = e.target.files[0]; e.target.value = ""; if (f) readFile(f, setLogo); }} /><${Btn} kind="secondary" size="sm" id="upload-logo" onClick=${() => logoRef.current.click()}>Upload logo<//>${user?.logo && html`<${Btn} kind="ghost" size="sm" onClick=${() => setLogo(null)}>Remove<//>`}</div></div>
        <div class="card col" style="gap:16px" id="st-storage"><b class="t-heading">Storage</b>
          <${Async} q=${dq} skeleton=${html`<${Skeleton} card=${false} rows=${1} />`}>${(d) => html`<div class="row between"><div class="row" style="gap:12px"><div class="ico sm"><${Icon} name="drive" size="18" /></div><div><b class="t-label">Google Drive</b><p class="t-small muted">${d.connected ? "Connected as " + d.email : "Not connected"}</p></div></div><${Btn} kind="secondary" size="sm" id="drive-toggle" disabled=${dbusy} onClick=${toggleDrive}>${d.connected ? "Disconnect" : "Connect"}<//></div>`}<//>
          <div class="hr" />
          <div class="col" style="gap:12px">
            <div class="row" style="gap:12px;align-items:flex-start"><${Icon} name="film" size="16" /><div><b class="t-label">Raw files</b><p class="t-small muted">Never stored. For a final export we fetch the original once and delete it within 24 hours.</p></div></div>
            <div class="row" style="gap:12px;align-items:flex-start"><${Icon} name="clock" size="16" /><div><b class="t-label">Preview copies</b><p class="t-small muted">Light copies kept for 30 days. Rebuild any time from your Drive or computer.</p></div></div>
            <div class="row between" style="gap:12px;align-items:flex-start"><div class="row" style="gap:12px;align-items:flex-start"><${Icon} name="download" size="16" /><div><b class="t-label">Final exports</b><p class="t-small muted">Kept until you delete them.</p></div></div><${Btn} kind="ghost" size="sm" id="delete-finals" onClick=${() => setConfirmFinals(true)}>Delete all finals<//></div>
          </div></div>
        ${confirmFinals && html`<${Modal} title="Delete all finals?" sub="Every exported final is removed from our servers. Your previews and edits stay, so you can render again." onClose=${() => setConfirmFinals(false)} footer=${html`<${Btn} kind="secondary" onClick=${() => setConfirmFinals(false)}>Keep them<//><${Btn} id="confirm-delete-finals" disabled=${dbusy} onClick=${deleteFinals}>${dbusy ? "Deleting…" : "Delete all finals"}<//>`} />`}
        <div class="card row between"><div><b class="t-label">Log out</b><p class="t-small muted">You can log back in any time.</p></div><${Btn} kind="secondary" size="sm" icon="logout" id="st-logout" onClick=${async () => { await api.logout(); setUser(null); go("/login"); }}>Log out<//></div>
      </div>
    </div>
  </div>`;
}

/* ---------- /billing ---------- */
// Payments are not switched on yet (Stripe is stubbed): switching plans works, there is no card and no invoices.
function BillingPage() {
  const toast = useToast(); const { refreshUsage } = useApp(); const q = useAsync(() => api.getBilling(), []); const [busy, setBusy] = useState(false);
  const pick = async (name) => { setBusy(true); try { const b = await api.updatePlan(name); q.setData(b); refreshUsage(); toast("Plan changed to " + name, { icon: "check", tone: "brand" }); } catch (e) { toast(e.message); } finally { setBusy(false); } };
  return html`<div class="page">
    <div class="page-head"><div><h1 class="t-title">Billing</h1><p class="muted">Your plan, your card, your invoices.</p></div></div>
    <${Async} q=${q} skeleton=${html`<${Skeleton} rows=${4} />`}>${(b) => html`
      <div class="three">${b.plans.map((p) => html`<div key=${p.name} class=${"card col" + (b.plan === p.name ? " plan-on" : "")} style="gap:8px" data-plan=${p.name}><div class="row between"><b class="t-heading">${p.name}</b>${b.plan === p.name && html`<span class="tag accent">Current</span>`}</div><span class="t-title" style="font-size:28px">${p.price}<span class="t-small muted" style="font-weight:400"> / month</span></span><p class="t-small muted">${p.note}</p>${b.plan !== p.name && html`<${Btn} kind="secondary" size="sm" disabled=${busy} onClick=${() => pick(p.name)}>Switch to ${p.name}<//>`}</div>`)}</div>
      <div class="two" style="align-items:start">
        <div class="card col" style="gap:12px" id="payment-card"><b class="t-heading">Payment method</b>${b.card ? html`<div class="row between"><div class="row" style="gap:12px"><div class="ico sm"><${Icon} name="key" size="18" /></div><div><b class="t-label">${b.card.brand} ending ${b.card.last4}</b><p class="t-small muted">Expires ${b.card.exp} · renews ${b.renew}</p></div></div></div>` : html`<p class="t-small muted">No card on file. Payments are not switched on yet, so every plan is free for now.</p>`}</div>
        <div class="card col" style="gap:8px" id="invoices"><b class="t-heading">Invoices</b>${b.invoices.length ? b.invoices.map((inv) => html`<div key=${inv.id} class="row between" style="padding:8px 0;border-top:1px solid var(--hair)"><span class="t-label">${inv.id}</span><span class="t-small muted">${inv.date}</span><span class="t-small">${inv.amount}</span><${Chip} tone="neutral" size="sm">${inv.status}<//>${inv.url && html`<${Btn} kind="ghost" size="xs" icon="download" onClick=${() => window.open(inv.url, "_blank", "noopener")}>PDF<//>`}</div>`) : html`<p class="t-small muted">No invoices yet.</p>`}</div>
      </div>`}<//>
  </div>`;
}

export {
  LoginPage, Shell, SourceBadge, DrivePicker, AddFootageModal, LibraryPage, FootagePage, NewProjectModal, ProjectsPage, FolderPage,
  StyleVideo, StyleArt, StylesPage, StylePacks, HomePage, CreatePage, ExploreFeed, PublishModal, CreateLinkModal, ClientReviewPage, ConnectPage, UsagePage, Heatmap,
  BillingPage, SettingsPage,
};
