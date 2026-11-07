/* ===================== Admin panel (Rendrr's team) ===================== */
// Overview (users, money in and out, margin, usage, storage, queues, problems), Users (each one's plan, usage, our
// cost, payments; open one to see everything and change their plan, trial, bonus minutes or limit), Costs (measured,
// by day, by kind of job, per export minute), Storage, Issues (failed jobs and renders grouped by error, stuck work,
// AI tool errors, errors in people's browsers) and Jobs (the latest job log).
import { useState, useEffect, html, Btn, Chip, Seg, Field, Modal, useToast, useAsync, Async, Skeleton, EmptyState, useNav, fmtAgo } from "./ui";
import { api } from "./api";

const usd = (n, d = 2) => (n == null ? "–" : "$" + Number(n).toFixed(d));
const num = (n, d = 1) => (n == null ? "–" : (Math.round(Number(n) * 10 ** d) / 10 ** d).toLocaleString("en"));
const ago = (iso) => (iso ? fmtAgo(new Date(iso).getTime()) : "never");
const shortDay = (iso) => new Date(iso).toLocaleDateString("en", { month: "short", day: "numeric" });
const TABS = [["overview", "Overview"], ["users", "Users"], ["costs", "Costs"], ["storage", "Storage"], ["issues", "Issues"], ["jobs", "Jobs"]];
const PLAN_TONE = { comp: "neutral", starter: "brand", trial: "neutral" };

export function AdminPage() {
  const me = useAsync(() => api.adminMe(), []);
  const [tab, setTab] = useState(() => (typeof window !== "undefined" && new URLSearchParams(window.location.search).get("tab")) || "overview");
  const [userId, setUserId] = useState(null);
  const [rev, setRev] = useState(0); // a change in the user window reloads the lists
  return html`<div class="page admin" id="admin">
    <div class="page-head"><div><h1 class="t-title">Admin</h1></div>
      <${Seg} value=${tab} options=${TABS.map(([value, label]) => ({ value, label }))} onChange=${setTab} /></div>
    <${Async} q=${me} skeleton=${html`<${Skeleton} rows=${4} />`}>${() => html`
      ${tab === "overview" && html`<${Overview} go=${setTab} />`}
      ${tab === "users" && html`<${Users} open=${setUserId} rev=${rev} />`}
      ${tab === "costs" && html`<${Costs} open=${setUserId} />`}
      ${tab === "storage" && html`<${Storage} open=${setUserId} />`}
      ${tab === "issues" && html`<${Issues} open=${setUserId} />`}
      ${tab === "jobs" && html`<${Jobs} open=${setUserId} />`}
      ${userId && html`<${UserDrawer} id=${userId} onClose=${() => setUserId(null)} onChanged=${() => setRev((n) => n + 1)} />`}
    `}<//>
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
  const change = async (c, msg) => { setBusy(true); try { const d = await api.adminChangeUser(id, c); q.setData(d); onChanged?.(); toast(msg, { icon: "check", tone: "brand" }); } catch (e) { toast(e.message); } finally { setBusy(false); } };
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
      ${d.actions.length > 0 && html`<div class="card col" style="gap:6px"><b class="t-heading">Changes by the team</b>${d.actions.map((a, i) => html`<div key=${i} class="t-small">${a.action}: ${JSON.stringify(a.meta)} <span class="muted">${ago(a.at)}</span></div>`)}</div>`}
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
