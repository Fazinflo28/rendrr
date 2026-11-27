/* ===================== Usage & billing (like Railway's usage page) ===================== */
// The plan and its period, what is used of each allowance, pay as you go so far and the bill it makes, the
// spending limit, day by day usage, usage by project, then the plans, the card and the invoices.
import { React, useState, html, Btn, Chip, Seg, Field, Modal, useToast, useAsync, Async, Skeleton, useNav, Icon } from "./ui";
import { api } from "./api";
import { PLANS } from "./pricing";

const money = (c) => "$" + ((c || 0) / 100).toFixed(2);
const day = (iso) => new Date(iso).toLocaleDateString("en", { month: "short", day: "numeric" });
const num = (n) => (Math.round((n || 0) * 10) / 10).toLocaleString("en");
const pct = (used, inc) => (inc ? Math.min(100, Math.round((used / inc) * 100)) : 0);

export function UsageBillingPage({ initialTab = "usage" }) {
  const { go } = useNav(); const toast = useToast();
  const q = useAsync(() => api.getBillingOverview(), []);
  const [tab, setTab] = useState(initialTab);
  const [busy, setBusy] = useState(false);
  const [limitOpen, setLimitOpen] = useState(false);
  const params = typeof window !== "undefined" ? new URLSearchParams(window.location.search) : null;
  const paid = params?.get("paid") === "1";
  const start = async () => { setBusy(true); try { const r = await api.startCheckout(); window.location.assign(r.url); } catch (e) { toast(e.message); setBusy(false); } };
  const manage = async () => { setBusy(true); try { const r = await api.openBillingPortal(); window.location.assign(r.url); } catch (e) { toast(e.message); setBusy(false); } };
  const sk = html`<div class="three">${[0, 1, 2].map((i) => html`<div key=${i} class="card stat"><div class="skeleton" style="height:36px;width:50%" /><div class="skeleton sk-line" style="width:80%;margin-top:10px" /></div>`)}</div><div class="card"><div class="skeleton" style="height:180px" /></div>`;
  return html`<div class="page" id="usage-billing">
    <div class="page-head"><div><h1 class="t-title">Usage & billing</h1></div>
      <${Seg} value=${tab} options=${[{ value: "usage", label: "Usage" }, { value: "billing", label: "Billing" }]} onChange=${setTab} /></div>
    ${paid && html`<div class="note ok" id="paid-note"><${Icon} name="check" size="16" /> Thanks. Editor Pro is on: your allowance renews every month.</div>`}
    <${Async} q=${q} skeleton=${sk}>${(b) => html`
      <${PlanBar} b=${b} busy=${busy} onStart=${start} onManage=${manage} />
      ${tab === "usage" ? html`<${UsageTab} b=${b} onLimit=${() => setLimitOpen(true)} />` : html`<${BillingTab} b=${b} busy=${busy} onStart=${start} onManage=${manage} />`}
      ${limitOpen && html`<${LimitModal} b=${b} onClose=${() => setLimitOpen(false)} onSaved=${(cents) => { q.setData({ ...b, spendLimitCents: cents }); setLimitOpen(false); toast("Spending limit saved", { icon: "check", tone: "brand" }); }} />`}
    `}<//>
  </div>`;
}

/** The plan, its period, and the one thing to do next (start Editor Pro, or manage it). */
function PlanBar({ b, busy, onStart, onManage }) {
  const trial = b.trial;
  const tone = b.status === "active" || b.status === "trialing" ? "brand" : "ink";
  const status = trial ? (trial.ended ? "Trial ended" : `${trial.daysLeft} ${trial.daysLeft === 1 ? "day" : "days"} left`) : ({ active: "Active", past_due: "Payment failed", canceled: "Cancelled", expired: "Ended" }[b.status] || b.status);
  const cta = b.plan === "comp" ? null
    : b.plan === "trial" || b.status === "canceled" ? html`<${Btn} id="start-starter" disabled=${busy || !b.payments.enabled} onClick=${onStart}>${b.payments.enabled ? "Start Editor Pro · $5/mo" : "Payments coming soon"}<//>`
    : html`<${Btn} kind="secondary" id="manage-billing" disabled=${busy} onClick=${onManage}>${b.status === "past_due" ? "Update card" : "Manage billing"}<//>`;
  return html`<div class=${"card plan-bar" + (trial?.ended || b.status === "past_due" ? " warn" : "")} id="plan-bar">
    <div class="row" style="gap:14px;flex-wrap:wrap">
      <div class="col" style="gap:4px"><div class="row" style="gap:8px"><b class="t-heading" id="plan-name">${b.planName}</b><${Chip} tone=${tone} size="sm" id="plan-status">${status}<//></div>
        <span class="t-small muted" id="plan-period">${trial ? `Trial ends ${day(trial.endsAt)}` : `This period: ${day(b.period.start)} – ${day(b.period.end)} · ${b.period.daysLeft} days left`}</span></div>
      <div class="grow" />
      ${cta}
    </div>
    ${trial && !trial.ended && html`<p class="t-small muted" style="margin:10px 0 0">${b.blurb} No card needed. When it ends, start Editor Pro to keep exporting; your edits stay.</p>`}
    ${trial?.ended && html`<p class="t-small" style="margin:10px 0 0" id="trial-ended">Your free trial has ended. Your edits and videos are kept; start Editor Pro to export again.</p>`}
    ${b.status === "past_due" && html`<p class="t-small" style="margin:10px 0 0">Your last payment did not go through, so exports are paused. Update your card to go on.</p>`}
  </div>`;
}

function UsageTab({ b, onLimit }) {
  const starter = b.plan === "starter";
  return html`
    <div class="three" id="money-cards">
      <div class="card stat"><span class="big" id="current-usage">${money(b.usageCents)}</span><span class="lbl">Pay as you go so far</span></div>
      <div class="card stat"><span class="big" id="estimated-bill">${money(starter ? b.projectedCents : b.totalCents)}</span><span class="lbl">${starter ? "Estimated bill this period" : "Bill this period"}</span></div>
      <div class="card stat"><span class="big" id="spend-limit">${starter ? money(b.spendLimitCents) : "–"}</span><span class="lbl row" style="gap:8px">Spending limit${starter && html`<button class="link" id="edit-limit" onClick=${onLimit}>Edit</button>`}</span></div>
    </div>
    <div class="card col" style="gap:14px" id="meters"><div class="row between"><b class="t-heading">Included in your plan</b><span class="t-small muted">${b.plan === "comp" ? "No limits" : "Resets " + day(b.period.end)}</span></div>
      ${b.meters.map((m) => html`<${MeterRow} key=${m.metric} m=${m} plan=${b.plan} />`)}
      ${(b.bonus.exportMinutes > 0 || b.bonus.footageMinutes > 0) && html`<p class="t-small muted" id="bonus-note">Includes bonus minutes from Rendrr: ${num(b.bonus.exportMinutes)} export, ${num(b.bonus.footageMinutes)} footage.</p>`}
    </div>
    ${b.renders && html`<${WhereRendersRan} r=${b.renders} />`}
    ${b.footage && html`<${FootageFrom} f=${b.footage} />`}
    <${DailyChart} days=${b.days} />
    ${b.lines.length > 0 && html`<div class="card col" style="gap:8px" id="payg-lines"><b class="t-heading">Pay as you go this period</b>
      <table class="tbl"><thead><tr><th>Item</th><th class="num">Quantity</th><th class="num">Price</th><th class="num">Amount</th></tr></thead><tbody>
        ${b.lines.map((l) => html`<tr key=${l.metric}><td>${l.label}</td><td class="num">${num(l.quantity)} ${l.unit}</td><td class="num">${l.metric === "export" ? money(l.unitCents) + " / min" : l.metric === "footage" ? "$1.00 / hour" : "$0.10 / GB-month"}</td><td class="num">${money(l.amountCents)}</td></tr>`)}
        <tr class="total"><td colspan="3">Plan</td><td class="num">${money(b.baseCents)}</td></tr>
        <tr class="total"><td colspan="3"><b>Total so far</b></td><td class="num"><b>${money(b.totalCents)}</b></td></tr>
      </tbody></table></div>`}
    <div class="card col" style="gap:8px" id="by-project"><b class="t-heading">By project</b>
      ${b.byProject.length ? html`<table class="tbl"><thead><tr><th>Project</th><th class="num">Edits</th><th class="num">Export min</th><th class="num">Preview min</th></tr></thead><tbody>
        ${b.byProject.map((p) => html`<tr key=${p.id}><td>${p.name}</td><td class="num">${p.edits}</td><td class="num">${num(p.exportMinutes)}</td><td class="num">${num(p.previewMinutes)}</td></tr>`)}</tbody></table>`
        : html`<p class="t-small muted">Nothing exported this period yet.</p>`}
    </div>
    <div class="card col" style="gap:10px" id="storage-card"><div class="row between"><b class="t-heading">Storage</b><b class="t-label">${num(b.storage.totalGB)} GB</b></div>
      <div class="row" style="gap:16px;flex-wrap:wrap">${Object.entries(b.storage.byKind).filter(([, v]) => v > 0).map(([k, v]) => html`<span key=${k} class="t-small muted">${({ footage: "Footage previews", previews: "Edit previews", finals: "Finals", originals: "Originals", audio: "Audio", other: "Fonts and LUTs" })[k] || k} ${num(v)} GB</span>`)}</div></div>`;
}

function MeterRow({ m, plan }) {
  const free = m.included == null;
  const label = m.metric === "preview" && plan === "starter" ? "Preview minutes (free on Editor Pro)" : m.label;
  const over = m.over > 0;
  return html`<div class="meter" data-metric=${m.metric}>
    <div class="row between"><span class="t-label">${label}</span><span class="t-small ${over ? "" : "muted"}">${num(m.used)} ${m.unit}${free ? "" : ` of ${num(m.included)} ${m.unit}`}${over ? ` · ${num(m.over)} over` : ""}</span></div>
    ${!free && html`<div class=${"bar" + (over ? " over" : pct(m.used, m.included) >= 80 ? " near" : "")}><i style=${{ width: pct(m.used, m.included) + "%" }} /></div>`}
  </div>`;
}

/* ---------- Where your renders ran: your own computer or Rendrr's cloud ---------- */
// Straight from the rows the bill is made from: minutes on the user's computer and on the cloud, previews and exports,
// then each video with every render (when, length, where, quality, minutes counted), so nothing is a guess.
const mins = (m) => { m = m || 0; if (m > 0 && m < 1) return Math.max(1, Math.round(m * 60)) + " s"; return num(m) + " min"; };
const machine = (p) => (p === "windows" ? "PC" : "Mac");
const dur = (sec) => { if (sec == null) return "–"; sec = Math.round(sec); if (sec < 60) return sec + " s"; const m = Math.floor(sec / 60), r = sec % 60; return m < 60 ? `${m} m${r ? ` ${r} s` : ""}` : `${Math.floor(m / 60)} h ${m % 60} m`; };
const gb = (g) => (g == null ? "–" : g < 1 ? Math.round(g * 1024) + " MB" : num(g) + " GB");
const when = (iso) => new Date(iso).toLocaleString("en", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

function WhereRendersRan({ r }) {
  const [all, setAll] = useState(false);
  const [open, setOpen] = useState(null);
  const total = r.minutes.computer + r.minutes.cloud;
  const share = total ? Math.round((r.minutes.computer / total) * 100) : 0;
  const videos = all ? r.videos : r.videos.slice(0, 8);
  return html`<${React.Fragment}><div class="card col" style="gap:16px" id="where-renders">
      <div class="row between" style="flex-wrap:wrap"><b class="t-heading">Where your renders ran</b><span class="t-small muted">This period</span></div>
      ${r.total.renders === 0 ? html`<p class="t-small muted" id="where-empty">No renders yet this period. Each preview and export you make shows up here.</p>` : html`<${React.Fragment}>
      <div class="two" style="gap:12px" id="where-split">
        <div class="col" style="gap:4px" data-where="computer"><span class="t-title" style="font-size:32px;line-height:40px" id="where-computer">${mins(r.minutes.computer)}</span>
          <span class="t-small muted">On your computer · ${r.count.computer} ${r.count.computer === 1 ? "render" : "renders"}</span></div>
        <div class="col" style="gap:4px" data-where="cloud"><span class="t-title" style="font-size:32px;line-height:40px" id="where-cloud">${mins(r.minutes.cloud)}</span>
          <span class="t-small muted">On Rendrr's cloud · ${r.count.cloud} ${r.count.cloud === 1 ? "render" : "renders"}</span></div>
      </div>
      <div class="meter" title=${share + "% on your computer"}><div class="bar"><i style=${{ width: share + "%" }} /></div></div>
      <table class="tbl" id="where-kinds"><thead><tr><th></th><th class="num">Your computer</th><th class="num">Cloud</th></tr></thead><tbody>
        <tr><td>Previews</td><td class="num">${mins(r.preview.computer)}</td><td class="num">${mins(r.preview.cloud)}</td></tr>
        <tr><td>Exports</td><td class="num">${mins(r.export.computer)}</td><td class="num">${mins(r.export.cloud)}</td></tr>
        <tr class="total"><td><b>Counted toward your plan</b></td><td class="num" id="counted-computer">${mins(r.counted.computer)}</td><td class="num" id="counted-cloud">${mins(r.counted.cloud)}</td></tr>
      </tbody></table>
      <p class="t-small muted" style="margin:0">Rendrr renders on your own computer while the Rendrr app is open, and on Rendrr's cloud when it is not. A render's minutes are the length of the video it made.</p><//>`}
    </div>
    ${r.total.renders > 0 && r.compute && html`<div class="card col" style="gap:14px" id="real-meters">
      <div class="row between" style="flex-wrap:wrap"><b class="t-heading">Real meters</b><span class="t-small muted">What your renders actually used this period</span></div>
      <div class="three" style="gap:12px">
        <div class="col" style="gap:4px"><span class="t-title" style="font-size:28px;line-height:36px" id="meter-run-computer">${dur(r.compute.runMinutes.computer * 60)}</span><span class="t-small muted">Rendering on your computer</span></div>
        <div class="col" style="gap:4px"><span class="t-title" style="font-size:28px;line-height:36px" id="meter-run-cloud">${dur(r.compute.runMinutes.cloud * 60)}</span><span class="t-small muted">Rendering on Rendrr's cloud</span></div>
        <div class="col" style="gap:4px"><span class="t-title" style="font-size:28px;line-height:36px" id="meter-cpu">${num(r.compute.serverCpuMinutes)} min</span><span class="t-small muted">Server CPU time</span></div>
      </div>
      <table class="tbl" id="meter-table"><tbody>
        <tr><td>Server CPU time</td><td class="num">${num(r.compute.serverCpuMinutes)} vCPU min</td></tr>
        <tr><td>Server memory, on average while rendering</td><td class="num">${gb(r.compute.avgMemoryGB)}</td></tr>
        <tr><td>Server memory over time</td><td class="num">${num(r.compute.serverMemoryGbMinutes)} GB min</td></tr>
        <tr><td>GPU</td><td class="num">None: Rendrr's cloud renders on CPUs</td></tr>
      </tbody></table>
      <p class="t-small muted" style="margin:0">Measured by Rendrr's servers for every render, from the machine's own CPU and memory counters, shared fairly when several jobs run at once. A render made on your computer still uses a little server time to plan it and hand it over; the video itself is made by your computer's own chip, which Rendrr does not meter.</p>
    </div>`}
    ${r.videos.length > 0 && html`<div class="card col" style="gap:8px" id="render-videos"><div class="row between"><b class="t-heading">Each video</b><span class="t-small muted">Tap a video to see every render</span></div>
      <div class="tbl-wrap"><table class="tbl click"><thead><tr><th>Video</th><th class="num">Your computer</th><th class="num">Cloud</th><th class="num">Counted</th></tr></thead><tbody>
        ${videos.map((v) => html`<${React.Fragment} key=${v.id}>
          <tr data-video=${v.id} onClick=${() => setOpen(open === v.id ? null : v.id)}>
            <td><b class="t-label">${v.name}</b>${v.folder && html`<span class="t-small muted"> · ${v.folder}</span>`}<div class="t-small muted">${v.renders.length} ${v.renders.length === 1 ? "render" : "renders"} · last ${day(v.last)}</div></td>
            <td class="num">${mins(v.computer)}</td><td class="num">${mins(v.cloud)}</td><td class="num">${mins(v.counted)}</td></tr>
          ${open === v.id && html`<tr class="renders-of"><td colSpan="4" style="padding:0 0 8px"><div class="tbl-wrap"><table class="tbl" data-renders-of=${v.id}>
            <thead><tr><th>When</th><th>Render</th><th class="num">Length</th><th>Where</th><th>Quality</th><th class="num">Took</th><th class="num">Server CPU</th><th class="num">Memory</th><th class="num">Counted</th></tr></thead><tbody>
            ${v.renders.map((x) => html`<tr key=${x.id} data-render=${x.id}>
              <td style="white-space:nowrap">${when(x.at)}</td>
              <td>${x.kind === "export" ? "Export" : x.samples ? "Samples" : "Preview"}${x.version ? " v" + x.version : ""}</td>
              <td class="num">${mins(x.minutes)}</td>
              <td>${x.where === "computer" ? html`<div>${"Your " + machine(x.platform)}${x.device && html`<div class="t-small muted">${x.device}</div>`}</div>` : html`<div title=${x.why || ""}>Rendrr cloud${x.why && html`<div class="t-small muted">${x.why}</div>`}</div>`}</td>
              <td>${x.quality || "–"}${x.fourK || x.heavy ? html`<span class="tag" style="margin-left:4px" title=${"Counts more: " + (x.fourK ? "4K" : "heavy effects")}>${x.fourK ? "4K" : "Heavy"}</span>` : ""}</td>
              <td class="num">${dur(x.runSeconds)}</td>
              <td class="num" title="CPU time on Rendrr's servers">${x.server ? dur(x.server.cpuSeconds) : "–"}</td>
              <td class="num" title="Server memory on average while it ran">${x.server ? gb(x.server.avgMemoryGB) : "–"}</td>
              <td class="num">${x.counted === 0 && x.minutes > 0 ? "0 (free)" : mins(x.counted)}</td></tr>`)}
            </tbody></table></div></td></tr>`}<//>`)}
      </tbody></table></div>
      ${r.videos.length > 8 && html`<button class="link" id="all-videos" onClick=${() => setAll(!all)}>${all ? "Show fewer" : `Show all ${r.videos.length} videos`}</button>`}
      ${r.more > 0 && html`<p class="t-small muted" style="margin:0">The ${r.more} oldest renders this period are in the totals above but not listed.</p>`}
    </div>`}<//>`;
}

/** Footage added this period: from the user's computer or from cloud storage (Google Drive and the like). */
function FootageFrom({ f }) {
  const [all, setAll] = useState(false);
  if (!f.videos.length) return null;
  const SRC = { upload: "Uploaded from your computer", local: "From the Rendrr app", drive: "Google Drive", dropbox: "Dropbox", google_photos: "Google Photos", canvas: "Made in Rendrr", placeholder: "Made in Rendrr" };
  const list = all ? f.videos : f.videos.slice(0, 6);
  return html`<div class="card col" style="gap:14px" id="footage-from">
    <div class="row between" style="flex-wrap:wrap"><b class="t-heading">Footage added</b><span class="t-small muted">This period</span></div>
    <div class="two" style="gap:12px">
      <div class="col" style="gap:4px"><span class="t-title" style="font-size:28px;line-height:36px" id="footage-computer">${mins(f.minutes.computer)}</span><span class="t-small muted">From your computer · counted ${mins(f.counted.computer)}</span></div>
      <div class="col" style="gap:4px"><span class="t-title" style="font-size:28px;line-height:36px" id="footage-cloud">${mins(f.minutes.cloud)}</span><span class="t-small muted">From cloud storage · counted ${mins(f.counted.cloud)}</span></div>
    </div>
    <div class="tbl-wrap"><table class="tbl"><thead><tr><th>Footage</th><th>From</th><th class="num">Length</th><th class="num">Counted</th></tr></thead><tbody>
      ${list.map((v) => html`<tr key=${v.id} data-footage=${v.id}><td>${v.name}<div class="t-small muted">${day(v.at)}</div></td><td>${SRC[v.source] || (v.from === "computer" ? "Your computer" : "Cloud storage")}</td><td class="num">${mins(v.minutes)}</td><td class="num">${v.counted === 0 && v.minutes > 0 ? "0 (free)" : mins(v.counted)}</td></tr>`)}
    </tbody></table></div>
    ${f.videos.length > 6 && html`<button class="link" id="all-footage" onClick=${() => setAll(!all)}>${all ? "Show fewer" : `Show all ${f.videos.length}`}</button>`}
  </div>`;
}

/** Export, footage and preview minutes per day this period, stacked. */
function DailyChart({ days }) {
  const max = Math.max(1, ...days.map((d) => d.export + d.footage + d.preview));
  const W = 100 / Math.max(1, days.length);
  const parts = [["export", "Export"], ["footage", "Footage"], ["preview", "Preview"]];
  return html`<div class="card col" style="gap:12px" id="daily-chart"><div class="row between"><b class="t-heading">Day by day</b>
      <div class="row legend" style="gap:12px">${parts.map(([k, l]) => html`<span key=${k} class="t-small row" style="gap:6px"><i class=${"dot sw-" + k} />${l}</span>`)}</div></div>
    <div class="chart">${days.map((d) => { let y = 0; const tip = `${day(d.date)}: ${num(d.export)} export, ${num(d.footage)} footage, ${num(d.preview)} preview minutes`; return html`<div key=${d.date} class="col-bar" style=${{ width: W + "%" }} title=${tip} data-date=${d.date}>
      ${parts.map(([k]) => { const h = (d[k] / max) * 100; const el = h > 0 ? html`<i key=${k} class=${"seg-" + k} style=${{ height: h + "%", bottom: y + "%" }} />` : null; y += h; return el; })}</div>`; })}</div>
    <div class="row between t-small muted"><span>${days[0] ? day(days[0].date) : ""}</span><span>${days.length ? day(days[days.length - 1].date) : ""}</span></div>
  </div>`;
}

// The plans, the same as on /pricing (pricing.js PLANS): Free, Editor Pro ($5) and Agency Pro ($24). The account's plan in the
// billing code maps onto them (trial: Free, starter: Editor Pro). Editor Pro's button opens the checkout that already exists;
// Agency Pro has none yet, so it says Coming soon.
const ON_PLAN = { trial: "free", starter: "editor" };
function BillingTab({ b, busy, onStart, onManage }) {
  const { go } = useNav();
  const current = ON_PLAN[b.plan];
  return html`
    <div class="three" style="align-items:stretch" id="plans">${PLANS.map((p) => html`<div key=${p.id} class=${"card col plan" + (current === p.id ? " plan-on" : "")} style="gap:10px" data-plan=${p.id}>
      <div class="row between"><b class="t-heading">${p.name}</b>${current === p.id && html`<span class="tag accent">Current</span>`}</div>
      <span class="t-title" style="font-size:28px">${"$" + p.price}<span class="t-small muted per-month">${p.price ? " / month" : ""}</span></span>
      <ul class="incl">
        <li>${p.minutes} cloud render minutes a month (about ${Math.floor(p.minutes / 5)} short videos)</li>
        <li>${p.storageGB} GB storage</li>
        <li>${p.watermark ? "Rendrr watermark on exports" : "No watermark"}</li>
        ${p.priority && html`<li>Faster cloud renders, front of the line</li>`}
        <li>${p.extra != null ? "Extra minutes $" + p.extra.toFixed(2) + " each" : "No extra minutes"}</li>
        <li>Renders on your own Mac or PC, and footage from your computer: free</li>
      </ul>
      <div class="grow" />
      ${p.checkout && b.plan !== "starter" && b.plan !== "comp" && html`<${Btn} id="plan-start" disabled=${busy || !b.payments.enabled} onClick=${onStart}>${b.payments.enabled ? "Start Editor Pro" : "Payments coming soon"}<//>`}
      ${p.id === "agency" && html`<${Btn} kind="secondary" id="plan-agency" disabled=${true}>Coming soon<//>`}
    </div>`)}</div>
    <div class="row" style="justify-content:center"><button class="link" id="plans-compare" onClick=${() => go("/pricing")}>Compare plans and what uses minutes</button></div>
    <div class="two" style="align-items:start">
      <div class="card col" style="gap:12px" id="payment-card"><b class="t-heading">Payment method</b>
        ${b.payments.customer ? html`<p class="t-small muted">Your card, receipts and cancelling are on Stripe's secure page.</p><div class="row"><${Btn} kind="secondary" size="sm" id="open-portal" disabled=${busy} onClick=${onManage}>Manage card and billing<//></div>`
          : html`<p class="t-small muted">${b.payments.enabled ? "No card on file. You add one when you start Editor Pro." : "Payments are being set up. Your free trial keeps working until then."}</p>`}</div>
      <div class="card col" style="gap:8px" id="invoices"><b class="t-heading">Invoices</b>
        ${b.invoices.length ? html`<table class="tbl"><thead><tr><th>Invoice</th><th>Period</th><th class="num">Amount</th><th>Status</th></tr></thead><tbody>
          ${b.invoices.map((i) => html`<tr key=${i.id}><td>${i.url ? html`<a href=${i.url} target="_blank" rel="noreferrer">${i.number || "Invoice"}</a>` : i.number || "Invoice"}</td><td>${day(i.periodStart)} – ${day(i.periodEnd)}</td><td class="num">${money(i.totalCents)}</td><td><${Chip} tone=${i.status === "paid" ? "brand" : "neutral"} size="sm">${i.status}<//></td></tr>`)}</tbody></table>`
          : html`<p class="t-small muted">No invoices yet.</p>`}</div>
    </div>`;
}

function LimitModal({ b, onClose, onSaved }) {
  const toast = useToast();
  const [v, setV] = useState(String(Math.round(b.spendLimitCents / 100)));
  const [busy, setBusy] = useState(false);
  const save = async () => { setBusy(true); try { const r = await api.setSpendLimit(Math.round(Number(v) * 100)); onSaved(r.spendLimitCents); } catch (e) { toast(e.message); setBusy(false); } };
  return html`<${Modal} title="Spending limit" sub="The most pay-as-you-go usage a month can add on top of the $5. When it is reached, exports pause until the next month or until you raise it. 0 means nothing past the plan." onClose=${onClose}
    footer=${html`<${Btn} kind="secondary" onClick=${onClose}>Cancel<//><${Btn} id="save-limit" disabled=${busy || !(Number(v) >= 0)} onClick=${save}>${busy ? "Saving…" : "Save"}<//>`}>
    <${Field} label="Limit in US dollars" id="limit-input"><input id="limit-input" class="input" type="number" min="0" step="1" value=${v} onInput=${(e) => setV(e.target.value)} /><//>
  <//>`;
}

/** Shown when the server says a plan limit was reached (any render or upload, anywhere in the app). */
export function LimitDialog({ message, onClose }) {
  const { go } = useNav();
  return html`<${Modal} title="Your plan needs a top-up" sub=${message} onClose=${onClose}
    footer=${html`<${Btn} kind="secondary" onClick=${onClose}>Not now<//><${Btn} id="limit-see-plans" onClick=${() => { onClose(); go("/usage"); }}>See usage & billing<//>`} />`;
}

export { Skeleton };
