/* ===================== Admin panel (Rendrr's team) ===================== */
// Laid out like Dragly's admin panel: a side panel of sections, the one picked in the address (?s=), so a reload or a
// shared link opens the same one. Overview (users, money in and out, margin, usage, product, storage, queues,
// problems), Users (open one to see everything and change their plan, trial, bonus minutes or limit, each with a
// reason), Client folders, Billing (read only), Render health (by kind, cloud or people's computers), Costs, Storage,
// Connections (AI apps, desktop apps), Gallery, Jobs, Audit log (every change made here), Issues and System health.
import { useState, useEffect, html, Btn, Chip, Seg, Field, Modal, useToast, useAsync, Async, Skeleton, EmptyState, useNav, fmtAgo, Icon } from "./ui";
import { api } from "./api";

const usd = (n, d = 2) => (n == null ? "–" : "$" + Number(n).toFixed(d));
const num = (n, d = 1) => (n == null ? "–" : (Math.round(Number(n) * 10 ** d) / 10 ** d).toLocaleString("en"));
const ago = (iso) => (iso ? fmtAgo(new Date(iso).getTime()) : "never");
const shortDay = (iso) => new Date(iso).toLocaleDateString("en", { month: "short", day: "numeric" });
const secs = (s) => (s == null ? "–" : s < 90 ? `${num(s)} s` : `${num(s / 60)} min`);
const PLAN_TONE = { comp: "neutral", starter: "brand", trial: "neutral" };
/** The sections, in the side panel's order: key, label, icon, the line under the heading. */
export const SECTIONS = [
  ["overview", "Overview", "home", "The whole system at a glance"],
  ["users", "Users", "user", "Every account: plan, usage, what they cost us and what they paid"],
  ["folders", "Client folders", "folder", "Every client folder: its owner, edits, finals and review links"],
  ["billing", "Billing", "usage", "Payments, failed payments, open bills, recurring revenue by plan, and minutes given"],
  ["renders", "Render health", "film", "How renders are going: in the cloud and on people's computers, speed and failures"],
  ["costs", "Costs", "gauge", "What Rendrr pays, measured: by day, by kind of job, per export minute"],
  ["storage", "Storage", "layers", "What is stored, by kind and by user, and how it grew"],
  ["connections", "Connections", "link", "The AI apps people connected and the desktop apps open in the last day"],
  ["gallery", "Gallery", "image", "Every edit published to the gallery that everyone sees"],
  ["jobs", "Jobs", "clock", "The latest work the worker started, finished or failed"],
  ["audit", "Audit log", "key", "Every change made from this panel: who, to whom, what and why"],
  ["issues", "Issues", "alert", "Failed renders and jobs grouped by error, stuck work, AI tool errors, browser errors"],
  ["health", "System health", "heart", "Live checks, keys, this deployment, migrations and queues"],
];
const isSection = (k) => SECTIONS.some(([key]) => key === k);
const fromAddress = () => { if (typeof window === "undefined") return "overview"; const p = new URLSearchParams(window.location.search); const k = p.get("s") || p.get("tab"); return isSection(k) ? k : "overview"; };

export function AdminPage() {
  const me = useAsync(() => api.adminMe(), []);
  const [section, setSection] = useState(fromAddress);
  const [navOpen, setNavOpen] = useState(false);
  const [userId, setUserId] = useState(null);
  const [rev, setRev] = useState(0); // a change in the user window reloads the lists
  const go = (key) => {
    setSection(key); setNavOpen(false);
    // Only the address changes, in the browser: a reload or a shared link opens this section.
    try { window.history.replaceState(window.history.state, "", key === "overview" ? window.location.pathname : `${window.location.pathname}?s=${key}`); } catch { /* the demo */ }
  };
  const cur = SECTIONS.find(([k]) => k === section) || SECTIONS[0];
  return html`<div class="page admin" id="admin">
    <${Async} q=${me} skeleton=${html`<${Skeleton} rows=${4} />`}>${() => html`<div class="adm" data-section=${section}>
      <div class="adm-top"><button class="adm-menu iconbtn" id="adm-menu" aria-label="Sections" aria-expanded=${navOpen} onClick=${() => setNavOpen((o) => !o)}><${Icon} name="lines" size=${18} /></button><b class="t-heading">Admin</b><span class="adm-top-cur t-small muted">${cur[1]}</span></div>
      ${navOpen && html`<div class="adm-scrim" onClick=${() => setNavOpen(false)} />`}
      <nav class="adm-nav" id="adm-nav" data-open=${navOpen ? "true" : undefined} aria-label="Admin sections">
        <b class="t-heading adm-nav-title">Admin</b>
        ${SECTIONS.map(([key, label, icon]) => html`<button key=${key} class=${"adm-navitem" + (key === section ? " on" : "")} data-s=${key} aria-current=${key === section ? "page" : undefined} onClick=${() => go(key)}><${Icon} name=${icon} size=${16} /><span>${label}</span></button>`)}
      </nav>
      <main class="adm-main col" style="gap:16px">
        <div class="adm-head" id="adm-head"><h1 class="t-title row" style="gap:10px"><${Icon} name=${cur[2]} size=${22} />${cur[1]}</h1><p class="t-small muted">${cur[3]}</p></div>
        ${section === "overview" && html`<${Overview} go=${go} />`}
        ${section === "users" && html`<${Users} open=${setUserId} rev=${rev} />`}
        ${section === "folders" && html`<${Folders} open=${setUserId} />`}
        ${section === "billing" && html`<${Billing} open=${setUserId} />`}
        ${section === "renders" && html`<${RenderHealth} open=${setUserId} />`}
        ${section === "costs" && html`<${Costs} open=${setUserId} />`}
        ${section === "storage" && html`<${Storage} open=${setUserId} />`}
        ${section === "connections" && html`<${Connections} open=${setUserId} />`}
        ${section === "gallery" && html`<${Gallery} open=${setUserId} />`}
        ${section === "jobs" && html`<${Jobs} open=${setUserId} />`}
        ${section === "audit" && html`<${Audit} open=${setUserId} rev=${rev} />`}
        ${section === "issues" && html`<${Issues} open=${setUserId} />`}
        ${section === "health" && html`<${Health} />`}
      </main>
      ${userId && html`<${UserDrawer} id=${userId} onClose=${() => setUserId(null)} onChanged=${() => setRev((n) => n + 1)} />`}
    </div>`}<//>
  </div>`;
}

const Stat = ({ v, l, id, tone }) => html`<div class=${"card stat" + (tone ? " " + tone : "")} id=${id}><span class="big">${v}</span><span class="lbl">${l}</span></div>`;

/** A stacked bar chart of daily values (cost parts, or minutes). */
function Bars({ rows, parts, money, id, height = 140 }) {
  const total = (r) => parts.reduce((s, [k]) => s + (r[k] || 0), 0);
  const max = Math.max(1e-9, ...rows.map(total));
  return html`<div class="col" style="gap:8px" id=${id}>
    <div class="row legend" style="gap:12px;flex-wrap:wrap">${parts.map(([k, l]) => html`<span key=${k} class="t-small row" style="gap:6px"><i class=${"dot sw-" + k} />${l}</span>`)}</div>
    <div class="chart" style=${{ height: height + "px" }}>${rows.map((r) => { let y = 0; return html`<div key=${r.date || r.day} class="col-bar" style=${{ width: 100 / rows.length + "%" }} title=${`${shortDay(r.date || r.day)}: ${money ? usd(total(r), 3) : num(total(r))}`}>
      ${parts.map(([k]) => { const h = ((r[k] || 0) / max) * 100; const el = h > 0 ? html`<i key=${k} class=${"seg-" + k} style=${{ height: h + "%", bottom: y + "%" }} />` : null; y += h; return el; })}</div>`; })}</div>
    <div class="row between t-small muted"><span>${rows[0] ? shortDay(rows[0].date || rows[0].day) : ""}</span><span>${money ? "Highest day " + usd(max, 3) : ""}</span><span>${rows.length ? shortDay(rows[rows.length - 1].date || rows[rows.length - 1].day) : ""}</span></div>
  </div>`;
}

function Overview({ go }) {
  const q = useAsync(() => api.adminOverview(), []);
  return html`<${Async} q=${q} skeleton=${html`<${Skeleton} rows=${6} />`}>${(o) => html`
    <div class="four" id="adm-money">
      <${Stat} v=${usd(o.money.mrr)} l="Monthly recurring (Starter)" id="adm-mrr" />
      <${Stat} v=${usd(o.money.revenue30)} l="Paid, last 30 days" id="adm-revenue" />
      <${Stat} v=${usd(o.money.cost30)} l="Our cost, last 30 days" id="adm-cost" />
      <${Stat} v=${o.money.margin30 == null ? "–" : num(o.money.margin30) + "%"} l="Margin, last 30 days" id="adm-margin" tone=${o.money.margin30 != null && o.money.margin30 < 80 ? "warn" : ""} />
    </div>
    <div class="four" id="adm-users">
      <${Stat} v=${o.users.total} l=${`Users · ${o.users.new7d} new this week`} />
      <${Stat} v=${o.users.active7d} l="Active this week" />
      <${Stat} v=${o.users.trialing} l=${`On the trial · ${o.users.trialEnded} ended`} />
      <${Stat} v=${o.users.starter} l=${`On Starter · ${o.users.pastDue} payment failed · ${o.users.comp} comp`} />
    </div>
    <div class="two" style="align-items:start">
      <div class="card col" style="gap:12px"><b class="t-heading">Our cost by day</b><${Bars} rows=${o.series} parts=${[["compute", "CPU"], ["memory", "Memory"], ["transcription", "Transcription"], ["egress", "Data out"], ["storage", "Storage"], ["fixed", "Fixed"]]} money=${true} id="adm-cost-chart" /></div>
      <div class="card col" style="gap:10px" id="adm-cost-parts"><b class="t-heading">Where the money goes (30 days)</b>
        ${Object.entries(o.money.costParts30).map(([k, v]) => html`<div key=${k} class="row between"><span class="t-label">${({ compute: "CPU (renders, graphics, analysis)", memory: "Memory", transcription: "Transcription (AssemblyAI)", egress: "Data sent out (uploads, Drive)", storage: "Storage", fixed: "Fixed (API, web, database)" })[k]}</span><span class="t-small">${usd(v)}</span></div>`)}
        <div class="hr" /><div class="row between"><span class="t-label">Cost of one export minute (measured)</span><b>${usd(o.money.costPerExportMinute, 4)}</b></div>
        <div class="row between"><span class="t-label">Cost today so far</span><span class="t-small">${usd(o.money.costToday, 4)}</span></div></div>
    </div>
    <div class="two" style="align-items:start">
      <div class="card col" style="gap:10px" id="adm-usage"><b class="t-heading">Usage, last 30 days</b>
        ${["export", "footage", "preview"].map((m) => html`<div key=${m} class="row between"><span class="t-label">${({ export: "Export minutes", footage: "Footage minutes", preview: "Preview minutes" })[m]}</span><span class="t-small">${num(o.usage30[m].minutes)} min · ${o.usage30[m].count} times</span></div>`)}
        <div class="row between"><span class="t-label">Renders</span><span class="t-small">${Object.entries(o.renders30).map(([k, v]) => `${v} ${k}`).join(" · ") || "none"}</span></div>
        <div class="row between"><span class="t-label">Storage now</span><span class="t-small">${num(o.storage.totalGB)} GB</span></div></div>
      <div class="card col" style="gap:10px" id="adm-issues-sum"><div class="row between"><b class="t-heading">Problems, last 24 hours</b><${Btn} kind="ghost" size="sm" onClick=${() => go("issues")}>Open issues<//></div>
        ${[["failedRenders24h", "Failed renders"], ["failedJobs24h", "Failed jobs (with retries)"], ["aiToolErrors24h", "AI tool errors"], ["clientErrors24h", "Errors in browsers"], ["stuckRenders", "Renders stuck over an hour"]].map(([k, l]) => html`<div key=${k} class="row between"><span class="t-label">${l}</span><${Chip} tone=${o.issues[k] ? "ink" : "neutral"} size="sm">${o.issues[k]}<//></div>`)}</div>
    </div>
    ${o.product && html`<div class="card col" style="gap:10px" id="adm-product"><b class="t-heading">Product usage</b>
      <div class="four adm-mini">
        ${[["Edits", o.product.edits, `${num(o.product.edits30, 0)} worked on in 30 days`], ["Videos", o.product.videos, "In libraries"], ["Client folders", o.product.folders, null], ["Finals, 30 days", o.product.finals30, `${num(o.product.onComputers30, 0)} renders made on people's computers`],
          ["Review links", o.product.reviews, `${num(o.product.reviewComments, 0)} client comments`], ["AI connections", o.product.aiConnections, `${num(o.product.aiUsed30, 0)} used in 30 days`], ["Gallery", o.product.gallery, "Published edits"], ["Styles", o.product.styles, null]]
          .map(([l, v, sub]) => html`<div key=${l} class="col adm-mini-cell"><span class="big">${num(v, 0)}</span><span class="t-label">${l}</span>${sub ? html`<span class="t-small muted">${sub}</span>` : null}</div>`)}
      </div></div>`}
    <div class="card col" style="gap:8px" id="adm-queues"><b class="t-heading">Queues now</b>
      <table class="tbl"><thead><tr><th>Queue</th><th class="num">Waiting</th><th class="num">Running</th><th class="num">Delayed</th><th class="num">Failed (kept)</th></tr></thead><tbody>
        ${Object.entries(o.queues).map(([k, c]) => html`<tr key=${k}><td>${k}</td><td class="num">${c.waiting ?? "–"}</td><td class="num">${c.active ?? "–"}</td><td class="num">${c.delayed ?? "–"}</td><td class="num">${c.failed ?? "–"}</td></tr>`)}</tbody></table></div>
  `}<//>`;
}

function Users({ open, rev }) {
  const [qText, setQText] = useState(""); const [sort, setSort] = useState("recent"); const [plan, setPlan] = useState("");
  const [search, setSearch] = useState("");
  useEffect(() => { const t = setTimeout(() => setSearch(qText), 300); return () => clearTimeout(t); }, [qText]);
  const q = useAsync(() => api.adminUsers({ q: search, sort, plan }), [search, sort, plan, rev]);
  return html`<div class="card col" style="gap:12px" id="adm-users-list">
    <div class="row" style="gap:10px;flex-wrap:wrap">
      <input class="input" id="adm-search" placeholder="Search name, email or id" value=${qText} onInput=${(e) => setQText(e.target.value)} style="max-width:280px" />
      <select class="input" id="adm-plan" value=${plan} onChange=${(e) => setPlan(e.target.value)} style="max-width:160px"><option value="">All plans</option><option value="trial">Trial</option><option value="starter">Starter</option><option value="comp">Comp</option></select>
      <select class="input" id="adm-sort" value=${sort} onChange=${(e) => setSort(e.target.value)} style="max-width:200px"><option value="recent">Last active</option><option value="cost">Our cost</option><option value="usage">Usage</option><option value="revenue">Paid</option><option value="storage">Storage</option><option value="name">Name</option></select>
    </div>
    <${Async} q=${q} skeleton=${html`<${Skeleton} rows=${6} card=${false} />`}>${(r) => r.users.length ? html`<div class="tbl-wrap"><table class="tbl click"><thead><tr><th>User</th><th>Plan</th><th>Last active</th><th class="num">Export min</th><th class="num">Footage min</th><th class="num">Our cost 30d</th><th class="num">Paid</th><th class="num">Margin</th><th class="num">Storage</th><th class="num">Videos · edits</th></tr></thead><tbody>
      ${r.users.map((u) => html`<tr key=${u.id} data-user=${u.id} onClick=${() => open(u.id)}>
        <td><b class="t-label">${u.name || "—"}</b><div class="t-small muted">${u.email}</div></td>
        <td><${Chip} tone=${PLAN_TONE[u.plan] || "neutral"} size="sm">${u.plan}${u.status !== "active" && u.status !== "trialing" ? " · " + u.status : ""}<//>${u.role === "admin" ? html` <${Chip} tone="neutral" size="sm">admin<//>` : null}</td>
        <td class="t-small">${ago(u.lastActiveAt)}</td><td class="num">${num(u.usage30.exportMinutes)}</td><td class="num">${num(u.usage30.footageMinutes)}</td>
        <td class="num">${usd(u.cost30, 3)}</td><td class="num">${usd(u.revenueAll)}</td><td class="num">${u.marginAll == null ? "–" : num(u.marginAll) + "%"}</td><td class="num">${num(u.storageGB)} GB</td><td class="num">${u.videos} · ${u.edits}</td></tr>`)}</tbody></table></div>
      <p class="t-small muted">${r.total} ${r.total === 1 ? "user" : "users"}${r.total > r.users.length ? `, first ${r.users.length} shown` : ""}.</p>` : html`<${EmptyState} icon="search" title="No users match" />`}<//>
  </div>`;
}

function UserDrawer({ id, onClose, onChanged }) {
  const toast = useToast();
  const q = useAsync(() => api.adminUser(id), [id]);
  const [bonus, setBonus] = useState("10"); const [limit, setLimit] = useState(""); const [busy, setBusy] = useState(false);
  const [reason, setReason] = useState("");
  // Every change says why, for the audit log (as in Dragly's panel).
  const change = async (c, msg) => { if (!reason.trim()) { toast("Say why first. It goes in the audit log."); return; } setBusy(true); try { const d = await api.adminChangeUser(id, { ...c, reason: reason.trim() }); setReason(""); q.setData(d); onChanged?.(); toast(msg, { icon: "check", tone: "brand" }); } catch (e) { toast(e.message); } finally { setBusy(false); } };
  return html`<${Modal} title="User" wide onClose=${onClose}>
    <${Async} q=${q} skeleton=${html`<${Skeleton} rows=${6} card=${false} />`}>${(d) => html`<div class="col adm-user" style="gap:16px" id="adm-user">
      <div class="row between" style="flex-wrap:wrap;gap:10px"><div><b class="t-heading">${d.user.name || d.user.email}</b><div class="t-small muted">${d.user.email} · joined ${shortDay(d.user.createdAt)} · last active ${ago(d.user.lastActiveAt)} · <span class="mono">${d.user.id}</span></div></div>
        <div class="row" style="gap:6px"><${Chip} tone=${PLAN_TONE[d.billing.plan]} size="sm" id="adm-user-plan">${d.billing.plan}<//><${Chip} tone="neutral" size="sm">${d.billing.status}<//></div></div>
      <div class="four">
        <${Stat} v=${`${num(d.billing.usage.exportMinutes)}`} l="Export min this period" />
        <${Stat} v=${`${num(d.billing.usage.footageMinutes)}`} l="Footage min this period" />
        <${Stat} v=${usd(d.billing.statement.totalCents / 100)} l="Bill this period" />
        <${Stat} v=${`${num(d.storage.totalGB)} GB`} l=${`Storage · ${d.storage.videos} videos`} />
      </div>
      <div class="card col" style="gap:10px" id="adm-actions"><b class="t-heading">Change</b>
        <input class="input" id="adm-reason" placeholder="Why? (kept in the audit log)" maxlength="300" value=${reason} onInput=${(e) => setReason(e.target.value)} />
        <div class="row" style="gap:8px;flex-wrap:wrap">
          <${Btn} size="sm" kind="secondary" id="adm-extend" disabled=${busy} onClick=${() => change({ trialDays: 7 }, "Trial extended by 7 days")}>Trial +7 days<//>
          ${d.billing.plan !== "comp" ? html`<${Btn} size="sm" kind="secondary" id="adm-comp" disabled=${busy} onClick=${() => change({ plan: "comp" }, "Now complimentary: no limits")}>Make complimentary<//>` : html`<${Btn} size="sm" kind="secondary" id="adm-trial" disabled=${busy} onClick=${() => change({ plan: "trial", trialDays: 7 }, "Back on a 7-day trial")}>Back to trial<//>`}
          <span class="row" style="gap:6px"><input class="input sm" id="adm-bonus" type="number" value=${bonus} onInput=${(e) => setBonus(e.target.value)} style="width:80px" /><${Btn} size="sm" kind="secondary" id="adm-add-bonus" disabled=${busy || !Number(bonus)} onClick=${() => change({ bonusExportMinutes: Number(bonus) }, `${bonus} bonus export minutes added`)}>Add export minutes<//></span>
          <span class="row" style="gap:6px"><input class="input sm" id="adm-limit" type="number" placeholder=${String(d.billing.spendLimitCents / 100)} value=${limit} onInput=${(e) => setLimit(e.target.value)} style="width:80px" /><${Btn} size="sm" kind="secondary" id="adm-set-limit" disabled=${busy || limit === ""} onClick=${() => change({ spendLimitCents: Math.round(Number(limit) * 100) }, "Spending limit set")}>Set limit ($)<//></span>
        </div>
        <p class="t-small muted">Trial ends ${shortDay(d.billing.trialEndsAt)} · period ${shortDay(d.billing.period.start)} – ${shortDay(d.billing.period.end)} · limit ${usd(d.billing.spendLimitCents / 100)} · bonus ${num(d.billing.bonus.exportMinutes)} export, ${num(d.billing.bonus.footageMinutes)} footage min${d.user.stripeCustomerId ? ` · Stripe ${d.user.stripeCustomerId}` : ""}</p></div>
      <div class="two" style="align-items:start">
        <div class="card col" style="gap:8px"><b class="t-heading">What they cost us (30 days)</b>
          ${d.costsByKind.length ? html`<table class="tbl"><thead><tr><th>Kind</th><th class="num">Jobs</th><th class="num">Cost</th><th class="num">CPU s</th></tr></thead><tbody>${d.costsByKind.map((c) => html`<tr key=${c.kind}><td>${c.kind}</td><td class="num">${c.jobs}</td><td class="num">${usd(c.cost, 4)}</td><td class="num">${num(c.cpuSeconds)}</td></tr>`)}</tbody></table>` : html`<p class="t-small muted">Nothing measured yet.</p>`}</div>
        <div class="card col" style="gap:8px"><b class="t-heading">Invoices</b>
          ${d.invoices.length ? html`<table class="tbl"><tbody>${d.invoices.map((i) => html`<tr key=${i.id}><td>${i.url ? html`<a href=${i.url} target="_blank" rel="noreferrer">${i.number || "Invoice"}</a>` : i.number || "Invoice"}</td><td class="num">${usd(i.totalCents / 100)}</td><td>${i.status}</td></tr>`)}</tbody></table>` : html`<p class="t-small muted">None.</p>`}</div>
      </div>
      <div class="card col" style="gap:8px"><b class="t-heading">Latest renders</b>
        ${d.renders.length ? html`<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Edit</th><th>Kind</th><th>Status</th><th class="num">Length</th><th class="num">Took</th><th class="num">Cost</th><th>When</th></tr></thead><tbody>${d.renders.map((r) => html`<tr key=${r.id} title=${r.error || ""}><td>${r.project}</td><td>${r.kind}${r.quality ? " · " + r.quality : ""}</td><td>${r.status}${r.errorCode ? " (" + r.errorCode + ")" : ""}</td><td class="num">${num(r.seconds)} s</td><td class="num">${r.tookSeconds == null ? "–" : r.tookSeconds + " s"}</td><td class="num">${usd(r.cost, 4)}</td><td class="t-small">${ago(r.createdAt)}</td></tr>`)}</tbody></table></div>` : html`<p class="t-small muted">No renders.</p>`}</div>
      ${(d.failures.length > 0 || d.toolErrors.length > 0) && html`<div class="card col" style="gap:8px"><b class="t-heading">Problems (30 days)</b>
        ${d.failures.map((f, i) => html`<div key=${"f" + i} class="t-small"><b>${f.queue}</b> ${f.error} <span class="muted">${ago(f.at)}</span></div>`)}
        ${d.toolErrors.map((t, i) => html`<div key=${"t" + i} class="t-small"><b>${t.tool}</b> ${t.error} <span class="muted">${ago(t.at)}</span></div>`)}</div>`}
      ${d.actions.length > 0 && html`<div class="card col" style="gap:6px"><b class="t-heading">Changes by the team</b>${d.actions.map((a, i) => { const { reason: why, ...m } = a.meta || {}; return html`<div key=${i} class="t-small">${a.action}: ${JSON.stringify(m)}${why ? html` · <i>${why}</i>` : null} <span class="muted">${ago(a.at)}</span></div>`; })}</div>`}
    </div>`}<//>
  <//>`;
}

function Costs({ open }) {
  const [days, setDays] = useState(30);
  const q = useAsync(() => api.adminCosts(days), [days]);
  return html`<div class="col" style="gap:16px">
    <div class="row" style="gap:10px"><${Seg} value=${String(days)} options=${[{ value: "7", label: "7 days" }, { value: "30", label: "30 days" }, { value: "90", label: "90 days" }]} onChange=${(v) => setDays(Number(v))} /></div>
    <${Async} q=${q} skeleton=${html`<${Skeleton} rows=${5} />`}>${(c) => html`
      <div class="four" id="adm-cost-totals"><${Stat} v=${usd(c.total)} l=${`Total, ${c.days} days`} /><${Stat} v=${usd(c.jobs)} l="Jobs (measured)" /><${Stat} v=${usd(c.storage, 3)} l="Storage" /><${Stat} v=${usd(c.perExportMinute, 4)} l="Per export minute" id="adm-per-minute" /></div>
      <div class="card col" style="gap:12px"><b class="t-heading">By day</b><${Bars} rows=${c.series} parts=${[["compute", "CPU"], ["memory", "Memory"], ["transcription", "Transcription"], ["egress", "Data out"], ["storage", "Storage"], ["fixed", "Fixed"]]} money=${true} /></div>
      <div class="card col" style="gap:8px" id="adm-cost-kinds"><b class="t-heading">By kind of job</b><div class="tbl-wrap"><table class="tbl"><thead><tr><th>Kind</th><th class="num">Jobs</th><th class="num">Cost</th><th class="num">Per job</th><th class="num">CPU s / job</th><th class="num">Avg time</th><th class="num">Transcription</th><th class="num">Data out</th></tr></thead><tbody>
        ${c.byKind.map((k) => html`<tr key=${k.kind}><td>${k.kind}</td><td class="num">${k.jobs}</td><td class="num">${usd(k.cost, 4)}</td><td class="num">${usd(k.perJob, 5)}</td><td class="num">${num(k.cpuSecondsPerJob)}</td><td class="num">${num(k.avgSeconds)} s</td><td class="num">${usd(k.parts.transcription, 4)}</td><td class="num">${num(k.egressGB, 3)} GB</td></tr>`)}</tbody></table></div></div>
      <div class="card col" style="gap:8px"><b class="t-heading">Users who cost the most</b><table class="tbl click"><tbody>${c.topUsers.map((u) => html`<tr key=${u.id} onClick=${() => open(u.id)}><td>${u.name || u.email}<div class="t-small muted">${u.email}</div></td><td>${u.plan}</td><td class="num">${usd(u.cost, 4)}</td></tr>`)}</tbody></table></div>
    `}<//>
  </div>`;
}

function Storage({ open }) {
  const q = useAsync(() => api.adminStorage(), []);
  return html`<${Async} q=${q} skeleton=${html`<${Skeleton} rows=${4} />`}>${(s) => html`
    <div class="three"><${Stat} v=${`${num(s.totalGB)} GB`} l="Stored now" id="adm-storage-total" /><${Stat} v=${usd(s.monthlyCost)} l="Storage cost a month" /><${Stat} v=${s.top.length} l="Users with files" /></div>
    <div class="two" style="align-items:start">
      <div class="card col" style="gap:8px"><b class="t-heading">By kind</b>${Object.entries(s.byKindGB).map(([k, v]) => html`<div key=${k} class="row between"><span class="t-label">${k}</span><span class="t-small">${num(v, 2)} GB</span></div>`)}</div>
      <div class="card col" style="gap:8px"><b class="t-heading">Most storage</b><table class="tbl click"><tbody>${s.top.map((u) => html`<tr key=${u.id} onClick=${() => open(u.id)}><td>${u.name || u.email}</td><td>${u.plan}</td><td class="num">${num(u.gb, 2)} GB</td></tr>`)}</tbody></table></div>
    </div>
    ${s.series.length > 1 && html`<div class="card col" style="gap:12px"><b class="t-heading">Growth</b><${Bars} rows=${s.series} parts=${[["gb", "GB stored"]]} /></div>`}
  `}<//>`;
}

function Issues({ open }) {
  const toast = useToast();
  const [days, setDays] = useState(7);
  const q = useAsync(() => api.adminIssues(days), [days]);
  const resolve = async (id) => { try { await api.adminResolveClientError(id); q.setData({ ...q.data, clientErrors: q.data.clientErrors.filter((c) => c.id !== id) }); toast("Marked fixed", { icon: "check", tone: "brand" }); } catch (e) { toast(e.message); } };
  const Group = ({ title, rows, id }) => html`<div class="card col" style="gap:8px" id=${id}><b class="t-heading">${title}</b>
    ${rows.length ? html`<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Where</th><th>Error</th><th class="num">Times</th><th class="num">Users</th><th>Last</th></tr></thead><tbody>${rows.map((g) => html`<tr key=${g.key}><td>${g.where}</td><td class="err">${g.error}</td><td class="num">${g.count}${g.final != null ? html`<div class="t-small muted">${g.final} final</div>` : null}</td><td class="num">${g.users}</td><td class="t-small">${ago(g.last)}</td></tr>`)}</tbody></table></div>` : html`<p class="t-small muted">None. Good.</p>`}</div>`;
  return html`<div class="col" style="gap:16px">
    <div class="row"><${Seg} value=${String(days)} options=${[{ value: "1", label: "24 hours" }, { value: "7", label: "7 days" }, { value: "30", label: "30 days" }]} onChange=${(v) => setDays(Number(v))} /></div>
    <${Async} q=${q} skeleton=${html`<${Skeleton} rows=${6} />`}>${(i) => html`
      <${Group} title="Failed renders" rows=${i.failedRenders} id="adm-failed-renders" />
      <${Group} title="Failed jobs (retries included)" rows=${i.failedJobs} id="adm-failed-jobs" />
      <${Group} title="AI tool errors" rows=${i.aiToolErrors} id="adm-tool-errors" />
      <div class="card col" style="gap:8px" id="adm-stuck"><b class="t-heading">Stuck now</b>${i.stuck.length ? i.stuck.map((s) => html`<div key=${s.id} class="row between t-small"><span>${s.what}</span><span class="muted">since ${ago(s.since)}${s.userId ? html` · <button class="link" onClick=${() => open(s.userId)}>user</button>` : null}</span></div>`) : html`<p class="t-small muted">Nothing stuck.</p>`}</div>
      <div class="card col" style="gap:8px" id="adm-client-errors"><b class="t-heading">Errors in people's browsers</b>
        ${i.clientErrors.length ? i.clientErrors.map((c) => html`<div key=${c.id} class="col client-err" style="gap:4px"><div class="row between"><b class="t-label err">${c.message}</b><${Btn} size="sm" kind="ghost" onClick=${() => resolve(c.id)}>Mark fixed<//></div>
          <span class="t-small muted">${c.count} times · last ${ago(c.lastSeen)} · ${c.url || ""}</span>${c.stack ? html`<pre class="stack">${c.stack}</pre>` : null}</div>`) : html`<p class="t-small muted">None.</p>`}</div>
      <div class="card col" style="gap:8px"><b class="t-heading">How long jobs take</b><table class="tbl"><thead><tr><th>Queue</th><th class="num">Jobs</th><th class="num">Average</th><th class="num">Longest</th></tr></thead><tbody>${i.queueTimes.map((t) => html`<tr key=${t.queue}><td>${t.queue}</td><td class="num">${t.jobs}</td><td class="num">${num(t.avgSeconds)} s</td><td class="num">${num(t.maxSeconds)} s</td></tr>`)}</tbody></table></div>
    `}<//>
  </div>`;
}

function Jobs({ open }) {
  const [queue, setQueue] = useState(""); const [event, setEvent] = useState("");
  const q = useAsync(() => api.adminJobs({ queue, event }), [queue, event]);
  return html`<div class="card col" style="gap:12px" id="adm-jobs">
    <div class="row" style="gap:10px"><input class="input" placeholder="Queue (render, proxy, analyze…)" value=${queue} onInput=${(e) => setQueue(e.target.value.trim())} style="max-width:240px" />
      <select class="input" value=${event} onChange=${(e) => setEvent(e.target.value)} style="max-width:160px"><option value="">All events</option><option value="start">Started</option><option value="finish">Finished</option><option value="fail">Failed</option></select></div>
    <${Async} q=${q} skeleton=${html`<${Skeleton} rows=${8} card=${false} />`}>${(rows) => html`<div class="tbl-wrap"><table class="tbl"><thead><tr><th>When</th><th>Queue</th><th>Event</th><th class="num">Took</th><th>Error</th><th>User</th></tr></thead><tbody>
      ${rows.map((j) => html`<tr key=${j.id}><td class="t-small">${ago(j.at)}</td><td>${j.queue}</td><td>${j.event}</td><td class="num">${j.durationMs == null ? "–" : num(j.durationMs / 1000) + " s"}</td><td class="err">${j.error || ""}</td><td>${j.userId ? html`<button class="link" onClick=${() => open(j.userId)}>open</button>` : ""}</td></tr>`)}</tbody></table></div>`}<//>
  </div>`;
}

/* ---------- The sections modelled on Dragly's admin panel ---------- */

const PAGE = 50;
/** Back and next for a list read a page at a time. */
const Pager = ({ total, offset, onPage }) => total > PAGE ? html`<div class="row between t-small muted adm-pager"><span>${offset + 1}–${Math.min(total, offset + PAGE)} of ${total}</span>
  <span class="row" style="gap:6px"><${Btn} size="sm" kind="ghost" disabled=${offset === 0} onClick=${() => onPage(Math.max(0, offset - PAGE))}>Back<//><${Btn} size="sm" kind="ghost" disabled=${offset + PAGE >= total} onClick=${() => onPage(offset + PAGE)}>Next<//></span></div>` : null;
/** A search box that waits for typing to stop. */
function useSearch() {
  const [text, setText] = useState(""); const [q, setQ] = useState("");
  useEffect(() => { const t = setTimeout(() => setQ(text.trim()), 300); return () => clearTimeout(t); }, [text]);
  return [text, setText, q];
}
const Person = ({ u, open }) => u ? html`<button class="link" onClick=${(e) => { e.stopPropagation(); open(u.id); }}>${u.name || u.email || u.id}</button>` : html`<span class="muted">—</span>`;
const RefreshBtn = ({ q }) => html`<${Btn} size="sm" kind="ghost" onClick=${() => q.reload?.()}>Refresh<//>`;

function Folders({ open }) {
  const [text, setText, search] = useSearch(); const [offset, setOffset] = useState(0);
  useEffect(() => setOffset(0), [search]);
  const q = useAsync(() => api.adminFolders({ q: search, offset }), [search, offset]);
  return html`<div class="card col" style="gap:12px" id="adm-folders">
    <input class="input" id="adm-folder-search" placeholder="Search folder, workspace or owner's email" value=${text} onInput=${(e) => setText(e.target.value)} style="max-width:320px" />
    <${Async} q=${q} skeleton=${html`<${Skeleton} rows=${6} card=${false} />`}>${(r) => r.folders.length ? html`<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Folder</th><th>Owner</th><th class="num">Edits</th><th class="num">Worked on, 30d</th><th class="num">Finals, 30d</th><th class="num">Review links</th><th class="num">Review views</th><th>Footage folder</th><th>Last active</th></tr></thead><tbody>
      ${r.folders.map((f) => html`<tr key=${f.id} data-folder=${f.id}><td><b class="t-label">${f.name}</b><div class="t-small muted">${f.workspace}</div></td><td><${Person} u=${f.owner} open=${open} /><div class="t-small muted">${f.owner.plan}</div></td>
        <td class="num">${f.edits}</td><td class="num">${f.edits30}</td><td class="num">${f.finals30}</td><td class="num">${f.reviews}</td><td class="num">${f.reviewViews}</td><td>${f.hasFootage ? "Set" : html`<span class="muted">None</span>`}</td><td class="t-small">${ago(f.lastActive)}</td></tr>`)}</tbody></table></div>
      <${Pager} total=${r.total} offset=${r.offset} onPage=${setOffset} />
      <p class="t-small muted">${r.total} of ${r.all} ${r.all === 1 ? "folder" : "folders"}.</p>` : html`<${EmptyState} icon="folder" title="No client folders match" />`}<//>
  </div>`;
}

const INVOICE_TONE = { paid: "brand", failed: "ink", uncollectible: "ink", open: "neutral" };
function Billing({ open }) {
  const [status, setStatus] = useState(""); const [offset, setOffset] = useState(0);
  useEffect(() => setOffset(0), [status]);
  const q = useAsync(() => api.adminBilling({ status, offset }), [status, offset]);
  return html`<${Async} q=${q} skeleton=${html`<${Skeleton} rows=${6} />`}>${(b) => html`
    ${!b.payments && html`<div class="note" id="adm-payments-off"><b>Payments are off.</b> No one is charged yet; this fills in once billing is switched on.</div>`}
    <div class="four" id="adm-billing-totals">
      <${Stat} v=${usd(b.mrr)} l="Monthly recurring" />
      <${Stat} v=${usd(b.revenue30)} l=${`Paid, 30 days · ${b.payments30} ${b.payments30 === 1 ? "payment" : "payments"}`} />
      <${Stat} v=${b.failed30} l="Failed payments, 30 days" tone=${b.failed30 ? "warn" : ""} />
      <${Stat} v=${usd(b.openAmount)} l=${`Open bills · ${b.openCount}`} />
    </div>
    <div class="two" style="align-items:start">
      <div class="card col" style="gap:8px" id="adm-plans"><b class="t-heading">By plan</b><table class="tbl"><thead><tr><th>Plan</th><th class="num">People</th><th>Also</th><th class="num">Recurring</th></tr></thead><tbody>
        ${b.plans.map((p) => html`<tr key=${p.plan}><td>${p.label}</td><td class="num">${p.users}</td><td class="t-small muted">${p.plan === "starter" ? `${p.pastDue} payment failed · ${p.canceled} cancelled` : p.plan === "trial" ? `${p.ended} ended` : ""}</td><td class="num">${usd(p.mrr)}</td></tr>`)}</tbody></table></div>
      <div class="card col" style="gap:10px"><b class="t-heading">Money and minutes</b>
        <div class="row between"><span class="t-label">Paid in all</span><span class="t-small">${usd(b.revenueAll)} · ${b.paidInvoices} bills</span></div>
        <div class="row between"><span class="t-label">Last 30 days: plan / pay as you go</span><span class="t-small">${usd(b.base30)} / ${usd(b.usage30)}</span></div>
        <div class="row between"><span class="t-label">Bonus minutes given, 30 days</span><span class="t-small">${num(b.given30.exportMinutes)} export · ${num(b.given30.footageMinutes)} footage</span></div></div>
    </div>
    <div class="card col" style="gap:10px" id="adm-invoices">
      <div class="row between" style="flex-wrap:wrap;gap:8px"><b class="t-heading">Bills</b>
        <${Seg} value=${status} options=${[{ value: "", label: "All" }, { value: "paid", label: "Paid" }, { value: "open", label: "Open" }, { value: "failed", label: "Failed" }]} onChange=${setStatus} /></div>
      ${b.invoices.length ? html`<div class="tbl-wrap"><table class="tbl"><thead><tr><th>When</th><th>Who</th><th>Bill</th><th>Status</th><th class="num">Plan</th><th class="num">Usage</th><th class="num">Total</th><th>Period</th></tr></thead><tbody>
        ${b.invoices.map((i) => html`<tr key=${i.id}><td class="t-small">${ago(i.paidAt || i.createdAt)}</td><td><${Person} u=${i.user} open=${open} /></td><td>${i.url ? html`<a href=${i.url} target="_blank" rel="noreferrer">${i.number || "Bill"}</a>` : i.number || "Bill"}</td>
          <td><${Chip} tone=${INVOICE_TONE[i.status] || "neutral"} size="sm">${i.status}<//></td><td class="num">${usd(i.base)}</td><td class="num">${usd(i.usage)}</td><td class="num">${usd(i.total)}</td><td class="t-small">${shortDay(i.periodStart)} – ${shortDay(i.periodEnd)}</td></tr>`)}</tbody></table></div>
        <${Pager} total=${b.total} offset=${b.offset} onPage=${setOffset} />` : html`<p class="t-small muted">No bills${status ? " like that" : " yet"}.</p>`}
    </div>
  `}<//>`;
}

function RenderHealth({ open }) {
  const [days, setDays] = useState(7);
  const q = useAsync(() => api.adminRenders(days), [days]);
  return html`<div class="col" style="gap:16px">
    <div class="row" style="gap:10px"><${Seg} value=${String(days)} options=${[{ value: "1", label: "24 hours" }, { value: "7", label: "7 days" }, { value: "30", label: "30 days" }]} onChange=${(v) => setDays(Number(v))} /><${RefreshBtn} q=${q} /></div>
    <${Async} q=${q} skeleton=${html`<${Skeleton} rows=${6} />`}>${(h) => html`
      <div class="four" id="adm-render-totals">
        <${Stat} v=${h.total} l=${`Renders · ${h.done} done`} />
        <${Stat} v=${h.successRate == null ? "–" : num(h.successRate) + "%"} l="Finished without failing" tone=${h.successRate != null && h.successRate < 95 ? "warn" : ""} />
        <${Stat} v=${secs(h.medianSeconds)} l="Median time to render" />
        <${Stat} v=${h.onComputers} l="Made on people's computers" />
      </div>
      <div class="card col" style="gap:8px" id="adm-render-groups"><b class="t-heading">By kind and where it was made</b>
        ${h.groups.length ? html`<div class="tbl-wrap"><table class="tbl"><thead><tr><th>What</th><th class="num">Renders</th><th class="num">Done</th><th class="num">Failed</th><th class="num">Running</th><th class="num">Success</th><th class="num">Median</th><th class="num">Minutes</th><th>Last success</th><th>Top reasons it failed</th></tr></thead><tbody>
          ${h.groups.map((g) => html`<tr key=${g.key}><td>${g.label}</td><td class="num">${g.total}</td><td class="num">${g.done}</td><td class="num">${g.failed}</td><td class="num">${g.running}</td><td class="num">${g.successRate == null ? "–" : num(g.successRate) + "%"}</td><td class="num">${secs(g.medianSeconds)}</td><td class="num">${num(g.minutes)}</td><td class="t-small">${ago(g.lastOk)}</td>
            <td class="err">${g.reasons.map((r) => `${r.reason} (${r.n})`).join(" · ") || ""}</td></tr>`)}</tbody></table></div>` : html`<p class="t-small muted">No renders in this time.</p>`}</div>
      <div class="card col" style="gap:12px"><b class="t-heading">Day by day</b><${Bars} rows=${h.perDay.map((d) => ({ ...d, ok: d.renders - d.failed }))} parts=${[["ok", "Rendered"], ["failed", "Failed"]]} /></div>
      <div class="card col" style="gap:8px" id="adm-render-fails"><b class="t-heading">Latest failures</b>
        ${h.recentFailures.length ? html`<div class="tbl-wrap"><table class="tbl"><thead><tr><th>When</th><th>Edit</th><th>Kind</th><th>Where</th><th>Asked by</th><th>Error</th><th>Who</th></tr></thead><tbody>
          ${h.recentFailures.map((f) => html`<tr key=${f.id}><td class="t-small">${ago(f.at)}</td><td>${f.project}</td><td>${f.kind}</td><td>${f.place === "computer" ? "Computer" : "Cloud"}</td><td>${f.by}</td><td class="err">${f.errorCode ? `(${f.errorCode}) ` : ""}${f.error || ""}</td><td><${Person} u=${f.user} open=${open} /></td></tr>`)}</tbody></table></div>` : html`<p class="t-small muted">None. Good.</p>`}</div>
    `}<//>
  </div>`;
}

function Connections({ open }) {
  const q = useAsync(() => api.adminConnections(), []);
  return html`<${Async} q=${q} skeleton=${html`<${Skeleton} rows=${5} />`}>${(c) => html`
    <div class="four" id="adm-conn-totals">
      <${Stat} v=${c.aiSummary.claude} l="Claude connected" /><${Stat} v=${c.aiSummary.chatgpt} l="ChatGPT connected" />
      <${Stat} v=${c.aiSummary.used7d} l="AI apps used this week" /><${Stat} v=${c.computers.filter((x) => x.online).length} l=${`Desktop apps open now · ${c.computers.length} today`} />
    </div>
    <div class="two" style="align-items:start">
      <div class="card col" style="gap:8px" id="adm-ai"><b class="t-heading">AI apps</b>
        ${c.ai.length ? html`<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Who</th><th>App</th><th>Connected</th><th>Last used</th></tr></thead><tbody>
          ${c.ai.map((a) => html`<tr key=${a.id}><td><${Person} u=${a.user} open=${open} /></td><td>${a.clientName || a.client}${a.revoked ? html` <${Chip} tone="neutral" size="sm">removed<//>` : null}</td><td class="t-small">${shortDay(a.createdAt)}</td><td class="t-small">${ago(a.lastSeenAt)}</td></tr>`)}</tbody></table></div>` : html`<p class="t-small muted">No AI apps connected yet.</p>`}</div>
      <div class="card col" style="gap:8px" id="adm-computers"><b class="t-heading">Desktop apps, last 24 hours</b>
        ${c.versions.length ? html`<div class="row" style="gap:6px;flex-wrap:wrap">${c.versions.map((v) => html`<${Chip} key=${v.version} tone="neutral" size="sm">${v.version} · ${v.n}<//>`)}</div>` : null}
        ${c.computers.length ? html`<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Who</th><th>Computer</th><th>Version</th><th>Renders</th><th>Seen</th></tr></thead><tbody>
          ${c.computers.map((m) => html`<tr key=${m.userId + m.id}><td><${Person} u=${m.user} open=${open} /></td><td>${m.name || (m.platform === "windows" ? "Windows PC" : "Mac")}</td><td>${m.platform} ${m.version || "?"}</td><td>${m.canRender ? "Ready" : html`<span class="muted">No</span>`}</td><td class="t-small">${m.online ? html`<b>open now</b>` : ago(m.at)}</td></tr>`)}</tbody></table></div>` : html`<p class="t-small muted">No desktop app open in the last day.</p>`}</div>
    </div>
  `}<//>`;
}

function Gallery({ open }) {
  const q = useAsync(() => api.adminGallery(), []);
  return html`<${Async} q=${q} skeleton=${html`<${Skeleton} rows=${5} />`}>${(g) => html`
    <div class="four" id="adm-gallery-totals"><${Stat} v=${g.total} l="Published edits" /><${Stat} v=${num(g.views, 0)} l="Views" /><${Stat} v=${num(g.likes, 0)} l="Likes" /><${Stat} v=${num(g.recreates, 0)} l="Recreated" /></div>
    <div class="card col" style="gap:8px" id="adm-gallery">
      ${g.items.length ? html`<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Edit</th><th>By</th><th>Style</th><th>Shape</th><th class="num">Length</th><th class="num">Views</th><th class="num">Likes</th><th class="num">Recreated</th><th>Video</th><th>Published</th></tr></thead><tbody>
        ${g.items.map((i) => html`<tr key=${i.id}><td><b class="t-label">${i.title}</b><div class="t-small muted">${i.platforms.join(", ")}</div></td><td><${Person} u=${{ ...i.user, name: i.author || i.user.name }} open=${open} /></td><td>${i.style}</td><td>${i.shape}</td><td class="num">${secs(i.seconds)}</td><td class="num">${i.views}</td><td class="num">${i.likes}</td><td class="num">${i.recreates}${i.allowRecreate ? "" : html`<div class="t-small muted">off</div>`}</td><td>${i.hasVideo ? "Yes" : html`<span class="muted">No</span>`}</td><td class="t-small">${shortDay(i.createdAt)}</td></tr>`)}</tbody></table></div>` : html`<p class="t-small muted">Nothing published yet.</p>`}
    </div>
  `}<//>`;
}

const CHANGE_LABEL = { plan: "Plan", trialDays: "Trial days", bonusExportMinutes: "Bonus export min", bonusFootageMinutes: "Bonus footage min", spendLimitCents: "Spending limit", role: "Role" };
const changeText = (c) => Object.entries(c || {}).map(([k, v]) => `${CHANGE_LABEL[k] || k}: ${k === "spendLimitCents" ? usd(Number(v) / 100) : typeof v === "number" && v > 0 && k !== "spendLimitCents" ? "+" + v : v}`).join(" · ");
function Audit({ open, rev }) {
  const [text, setText, search] = useSearch(); const [days, setDays] = useState(""); const [offset, setOffset] = useState(0);
  useEffect(() => setOffset(0), [search, days]);
  const q = useAsync(() => api.adminAudit({ q: search, days: days ? Number(days) : undefined, offset }), [search, days, offset, rev]);
  return html`<div class="card col" style="gap:12px" id="adm-audit">
    <div class="row" style="gap:10px;flex-wrap:wrap"><input class="input" id="adm-audit-search" placeholder="Search account, admin, change or reason" value=${text} onInput=${(e) => setText(e.target.value)} style="max-width:320px" />
      <${Seg} value=${days} options=${[{ value: "", label: "All time" }, { value: "1", label: "24 hours" }, { value: "7", label: "7 days" }, { value: "30", label: "30 days" }]} onChange=${setDays} /></div>
    <${Async} q=${q} skeleton=${html`<${Skeleton} rows=${6} card=${false} />`}>${(r) => r.rows.length ? html`<div class="tbl-wrap"><table class="tbl"><thead><tr><th>When</th><th>Admin</th><th>Account</th><th>Change</th><th>Why</th></tr></thead><tbody>
      ${r.rows.map((a) => html`<tr key=${a.id} data-audit=${a.id}><td class="t-small" title=${a.at}>${ago(a.at)}</td><td><${Person} u=${a.admin} open=${open} /></td><td><${Person} u=${a.target} open=${open} /></td><td>${changeText(a.change) || a.action}</td><td>${a.reason ? a.reason : html`<span class="muted">Not given</span>`}</td></tr>`)}</tbody></table></div>
      <${Pager} total=${r.total} offset=${r.offset} onPage=${setOffset} />` : html`<${EmptyState} icon="key" title="No changes yet" />`}<//>
  </div>`;
}

const Check = ({ ok, warn, label, value, sub }) => html`<div class=${"card col adm-check" + (ok ? (warn ? " warn" : " good") : " bad")}><span class="row" style="gap:8px"><i class="adm-dot" /><b class="t-label">${label}</b></span><span class="t-heading">${value}</span>${sub ? html`<span class="t-small muted">${sub}</span>` : null}</div>`;
function Health() {
  const q = useAsync(() => api.adminHealth(), []);
  return html`<div class="col" style="gap:16px"><div class="row"><${RefreshBtn} q=${q} /></div>
    <${Async} q=${q} skeleton=${html`<${Skeleton} rows=${5} />`}>${(h) => {
      const workerAgo = h.live.worker.lastSeen ? Date.now() - new Date(h.live.worker.lastSeen).getTime() : null;
      const keys = [["storage", "File storage"], ["signIn", "Sign-in (Clerk)"], ["transcription", "Transcription (AssemblyAI)"], ["google", "Google (Drive, Photos)"], ["encryption", "Encryption key"], ["payments", "Payments (Stripe)"], ["webhook", "Stripe webhook"]];
      return html`
      <div class="three adm-checks" id="adm-health-live">
        <${Check} ok=${h.live.db.ok} warn=${h.live.db.ms > 400} label="Database" value=${h.live.db.ok ? `${h.live.db.ms} ms` : "Down"} sub="Time to answer a check" />
        <${Check} ok=${h.live.redis.ok} warn=${h.live.redis.ms > 200} label="Redis (queues)" value=${h.live.redis.ok ? `${h.live.redis.ms} ms` : "Down"} />
        <${Check} ok=${workerAgo != null && workerAgo < 2 * 3600_000} warn=${workerAgo != null && workerAgo > 3600_000} label="Worker" value=${h.live.worker.lastSeen ? `Seen ${ago(h.live.worker.lastSeen)}` : "Never seen"} sub=${h.live.worker.lastJob ? `Last job: ${h.live.worker.lastJob.queue} ${h.live.worker.lastJob.event}` : "No jobs logged"} />
        <${Check} ok=${h.jobs.failed1h === 0} warn=${h.jobs.failed24h > 0} label="Failed jobs" value=${`${h.jobs.failed1h} in the last hour`} sub=${`${h.jobs.failed24h} in 24 h · ${h.jobs.finished1h} finished in the last hour`} />
        <${Check} ok=${h.jobs.browserErrors24h === 0} warn=${h.jobs.browserErrors24h > 0} label="Errors in browsers" value=${`${h.jobs.browserErrors24h} in 24 h`} sub="Not marked fixed" />
        <${Check} ok=${!h.migrations || h.migrations.every((m) => m.ok)} label="Database set up" value=${h.migrations ? (h.migrations.every((m) => m.ok) ? "Up to date" : "A migration failed") : "Unknown"} sub=${h.migrations?.[0] ? `Latest: ${h.migrations[0].name}` : null} />
      </div>
      <div class="two" style="align-items:start">
        <div class="card col" style="gap:8px" id="adm-keys"><b class="t-heading">Set up</b>${keys.map(([k, l]) => html`<div key=${k} class="row between"><span class="t-label">${l}</span><${Chip} tone=${h.keys[k] ? "brand" : "neutral"} size="sm">${h.keys[k] ? "Set" : "Not set"}<//></div>`)}</div>
        <div class="card col" style="gap:8px" id="adm-deploy"><b class="t-heading">This deployment</b>
          <div class="row between"><span class="t-label">Version</span><span class="t-small mono">${h.deploy.commit || "–"}</span></div>
          <div class="row between"><span class="t-label">Environment</span><span class="t-small">${h.deploy.environment}</span></div>
          <div class="row between"><span class="t-label">Running for</span><span class="t-small">${secs(h.deploy.upSeconds)}</span></div>
          <div class="row between"><span class="t-label">Maintenance mode</span><span class="t-small">${h.switches.maintenance ? "On" : "Off"}</span></div>
          <div class="row between"><span class="t-label">Billing limits</span><span class="t-small">${h.switches.billingEnforce}</span></div>
          <div class="row between"><span class="t-label">Renders on computers free</span><span class="t-small">${h.switches.localRendersFree ? "Yes" : "No"}</span></div>
          <p class="t-small muted">Checked ${ago(h.checkedAt)}.</p></div>
      </div>
      <div class="card col" style="gap:8px"><b class="t-heading">Queues now</b>
        <table class="tbl"><thead><tr><th>Queue</th><th class="num">Waiting</th><th class="num">Running</th><th class="num">Delayed</th><th class="num">Failed (kept)</th></tr></thead><tbody>
          ${Object.entries(h.queues).map(([k, c]) => html`<tr key=${k}><td>${k}</td><td class="num">${c.waiting ?? "–"}</td><td class="num">${c.active ?? "–"}</td><td class="num">${c.delayed ?? "–"}</td><td class="num">${c.failed ?? "–"}</td></tr>`)}</tbody></table></div>
      ${h.migrations && html`<div class="card col" style="gap:6px"><b class="t-heading">Latest migrations</b>${h.migrations.map((m) => html`<div key=${m.name} class="row between t-small"><span class="mono">${m.name}</span><span class=${m.ok ? "muted" : "err"}>${m.ok ? ago(m.at) : "failed"}</span></div>`)}</div>`}
    `; }}<//>
  </div>`;
}
