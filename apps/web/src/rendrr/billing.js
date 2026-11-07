/* ===================== Usage & billing (like Railway's usage page) ===================== */
// The plan and its period, what is used of each allowance, pay as you go so far and the bill it makes, the
// spending limit, day by day usage, usage by project, then the plans, the card and the invoices.
import { useState, html, Btn, Chip, Seg, Field, Modal, useToast, useAsync, Async, Skeleton, useNav, Icon } from "./ui";
import { api } from "./api";

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
    ${paid && html`<div class="note ok" id="paid-note"><${Icon} name="check" size="16" /> Thanks. Starter is on: your allowance renews every month.</div>`}
    <${Async} q=${q} skeleton=${sk}>${(b) => html`
      <${PlanBar} b=${b} busy=${busy} onStart=${start} onManage=${manage} />
      ${tab === "usage" ? html`<${UsageTab} b=${b} onLimit=${() => setLimitOpen(true)} />` : html`<${BillingTab} b=${b} busy=${busy} onStart=${start} onManage=${manage} />`}
      ${limitOpen && html`<${LimitModal} b=${b} onClose=${() => setLimitOpen(false)} onSaved=${(cents) => { q.setData({ ...b, spendLimitCents: cents }); setLimitOpen(false); toast("Spending limit saved", { icon: "check", tone: "brand" }); }} />`}
    `}<//>
  </div>`;
}

/** The plan, its period, and the one thing to do next (start Starter, or manage it). */
function PlanBar({ b, busy, onStart, onManage }) {
  const trial = b.trial;
  const tone = b.status === "active" || b.status === "trialing" ? "brand" : "ink";
  const status = trial ? (trial.ended ? "Trial ended" : `${trial.daysLeft} ${trial.daysLeft === 1 ? "day" : "days"} left`) : ({ active: "Active", past_due: "Payment failed", canceled: "Cancelled", expired: "Ended" }[b.status] || b.status);
  const cta = b.plan === "comp" ? null
    : b.plan === "trial" || b.status === "canceled" ? html`<${Btn} id="start-starter" disabled=${busy || !b.payments.enabled} onClick=${onStart}>${b.payments.enabled ? "Start Starter · $5/mo" : "Payments coming soon"}<//>`
    : html`<${Btn} kind="secondary" id="manage-billing" disabled=${busy} onClick=${onManage}>${b.status === "past_due" ? "Update card" : "Manage billing"}<//>`;
  return html`<div class=${"card plan-bar" + (trial?.ended || b.status === "past_due" ? " warn" : "")} id="plan-bar">
    <div class="row" style="gap:14px;flex-wrap:wrap">
      <div class="col" style="gap:4px"><div class="row" style="gap:8px"><b class="t-heading" id="plan-name">${b.planName}</b><${Chip} tone=${tone} size="sm" id="plan-status">${status}<//></div>
        <span class="t-small muted" id="plan-period">${trial ? `Trial ends ${day(trial.endsAt)}` : `This period: ${day(b.period.start)} – ${day(b.period.end)} · ${b.period.daysLeft} days left`}</span></div>
      <div class="grow" />
      ${cta}
    </div>
    ${trial && !trial.ended && html`<p class="t-small muted" style="margin:10px 0 0">${b.blurb} No card needed. When it ends, start Starter to keep exporting; your edits stay.</p>`}
    ${trial?.ended && html`<p class="t-small" style="margin:10px 0 0" id="trial-ended">Your free trial has ended. Your edits and videos are kept; start Starter to export again.</p>`}
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
  const label = m.metric === "preview" && plan === "starter" ? "Preview minutes (free on Starter)" : m.label;
  const over = m.over > 0;
  return html`<div class="meter" data-metric=${m.metric}>
    <div class="row between"><span class="t-label">${label}</span><span class="t-small ${over ? "" : "muted"}">${num(m.used)} ${m.unit}${free ? "" : ` of ${num(m.included)} ${m.unit}`}${over ? ` · ${num(m.over)} over` : ""}</span></div>
    ${!free && html`<div class=${"bar" + (over ? " over" : pct(m.used, m.included) >= 80 ? " near" : "")}><i style=${{ width: pct(m.used, m.included) + "%" }} /></div>`}
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

function BillingTab({ b, busy, onStart, onManage }) {
  return html`
    <div class="two" style="align-items:stretch" id="plans">${b.plans.map((p) => html`<div key=${p.id} class=${"card col plan" + (b.plan === p.id ? " plan-on" : "")} style="gap:10px" data-plan=${p.id}>
      <div class="row between"><b class="t-heading">${p.name}</b>${b.plan === p.id && html`<span class="tag accent">Current</span>`}</div>
      <span class="t-title" style="font-size:28px">${p.priceCents ? money(p.priceCents) : "Free"}<span class="t-small muted per-month">${p.priceCents ? " / month" : " for 7 days"}</span></span>
      <ul class="incl">
        <li>${p.allowance.exportMinutes} export minutes${p.id === "trial" ? " (about 10 short videos)" : ""}</li>
        <li>${p.allowance.footageMinutes} minutes of footage uploaded and processed</li>
        <li>${p.allowance.previewMinutes == null ? "Previews free" : p.allowance.previewMinutes + " preview minutes"}</li>
        <li>${p.allowance.storageGB} GB storage</li>
        <li>${p.fourK ? "4K exports (count double)" : "Up to 1080p"}</li>
        <li>Captions, motion graphics, color, sound, Mac and Drive export</li>
        ${p.payAsYouGo && html`<li>Then pay as you go: ${money(b.rates.exportMinuteCents)} an export minute, $1 an hour of footage, $0.10 a GB</li>`}
      </ul>
      <div class="grow" />
      ${p.id === "starter" && b.plan !== "starter" && b.plan !== "comp" && html`<${Btn} id="plan-start" disabled=${busy || !b.payments.enabled} onClick=${onStart}>${b.payments.enabled ? "Start Starter" : "Payments coming soon"}<//>`}
    </div>`)}</div>
    <div class="two" style="align-items:start">
      <div class="card col" style="gap:12px" id="payment-card"><b class="t-heading">Payment method</b>
        ${b.payments.customer ? html`<p class="t-small muted">Your card, receipts and cancelling are on Stripe's secure page.</p><div class="row"><${Btn} kind="secondary" size="sm" id="open-portal" disabled=${busy} onClick=${onManage}>Manage card and billing<//></div>`
          : html`<p class="t-small muted">${b.payments.enabled ? "No card on file. You add one when you start Starter." : "Payments are being set up. Your free trial keeps working until then."}</p>`}</div>
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
