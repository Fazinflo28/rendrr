// End-to-end smoke test. Prints PASS or FAIL per step.
//   API_URL=https://api-production-2428.up.railway.app CLERK_SECRET_KEY=sk_test_... pnpm smoke
// Optional: MCP_URL + INTERNAL_API_SECRET to also exercise the AI tools through the API.
import { execFileSync } from "node:child_process";

const API = (process.env.API_URL || "http://localhost:4000").replace(/\/$/, "");
const CLERK = process.env.CLERK_SECRET_KEY || "";
const EMAIL = process.env.SMOKE_EMAIL || "smoke+clerk_test@rendrr.dev";
const PASSWORD = process.env.SMOKE_PASSWORD || "Rendrr-Smoke-Test-2026!";
const INTERNAL = process.env.INTERNAL_API_SECRET || "";

type Res = { name: string; ok: boolean; ms: number; note: string };
const results: Res[] = [];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function clerk(path: string, init: RequestInit = {}) {
  const r = await fetch("https://api.clerk.com/v1" + path, { ...init, headers: { authorization: `Bearer ${CLERK}`, "content-type": "application/json" } });
  const j = await r.json();
  if (!r.ok) throw new Error(`Clerk ${path}: ${JSON.stringify(j).slice(0, 200)}`);
  return j;
}
let sessionId = "", clerkUserId = "", tok = "", tokAt = 0;
async function token() {
  if (tok && Date.now() - tokAt < 45_000) return tok;
  if (!sessionId) {
    const found = await clerk(`/users?email_address=${encodeURIComponent(EMAIL)}`);
    const u = found[0] || (await clerk("/users", { method: "POST", body: JSON.stringify({ email_address: [EMAIL], password: PASSWORD, first_name: "Smoke", last_name: "Test" }) }));
    clerkUserId = u.id;
    sessionId = (await clerk("/sessions", { method: "POST", body: JSON.stringify({ user_id: u.id }) })).id;
  }
  tok = (await clerk(`/sessions/${sessionId}/tokens`, { method: "POST", body: "{}" })).jwt;
  tokAt = Date.now();
  return tok;
}
async function api(path: string, init: RequestInit & { json?: unknown; public?: boolean } = {}) {
  const headers: Record<string, string> = { ...(init.headers as Record<string, string>) };
  if (!init.public) headers.authorization = `Bearer ${await token()}`;
  if (init.json !== undefined) headers["content-type"] = "application/json";
  const r = await fetch(API + path, { ...init, headers, body: init.json !== undefined ? JSON.stringify(init.json) : init.body });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j?.error?.message || `HTTP ${r.status}`), { status: r.status, body: j });
  return j;
}
async function tool(name: string, input: unknown) {
  const r = await fetch(`${API}/internal/tools/${name}`, { method: "POST", headers: { "x-internal-secret": INTERNAL, "x-rendrr-clerk-id": clerkUserId, "x-rendrr-ai": "claude", "content-type": "application/json" }, body: JSON.stringify(input) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j?.error?.message || `HTTP ${r.status}`);
  return j;
}

async function step<T>(name: string, fn: () => Promise<[T, string] | T>): Promise<T | undefined> {
  const t0 = Date.now();
  try {
    const out = await fn();
    const [val, note] = Array.isArray(out) && out.length === 2 && typeof out[1] === "string" ? (out as [T, string]) : [out as T, ""];
    results.push({ name, ok: true, ms: Date.now() - t0, note });
    console.log(`PASS  ${name}${note ? "  (" + note + ")" : ""}  ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    return val;
  } catch (e) {
    results.push({ name, ok: false, ms: Date.now() - t0, note: (e as Error).message });
    console.log(`FAIL  ${name}  -> ${(e as Error).message}`);
    return undefined;
  }
}

/** Waits for a render over the live progress stream, exactly like the web app does. */
async function waitRender(renderId: string, timeoutMs: number) {
  const r = await fetch(`${API}/renders/${renderId}/events`, { headers: { authorization: `Bearer ${await token()}` } });
  if (!r.ok || !r.body) throw new Error("progress stream did not open");
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = "", steps: string[] = [], last = -1;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
      const ev = /event: (\w+)/.exec(chunk)?.[1];
      const data = /data: (.*)/.exec(chunk)?.[1];
      if (!ev || !data) continue;
      const d = JSON.parse(data);
      if (ev === "progress") { steps = d.steps; if (d.step !== last) { last = d.step; process.stdout.write(`      · ${d.steps[d.step] ?? "…"} ${d.percent}%\n`); } }
      if (ev === "done") { reader.cancel().catch(() => {}); return { ...d, steps }; }
      if (ev === "failed") { reader.cancel().catch(() => {}); throw new Error(`${d.error} (${d.code || "no code"})`); }
    }
  }
  throw new Error("render did not finish in time");
}

function ffprobeUrl(url: string) {
  return JSON.parse(execFileSync("ffprobe", ["-v", "error", "-print_format", "json", "-show_entries", "format=duration:stream=codec_type,width,height", url]).toString());
}

async function main() {
  console.log(`Rendrr smoke test against ${API}\n`);
  if (!CLERK) { console.log("FAIL  setup  -> set CLERK_SECRET_KEY (dev instance) so the test can log in"); process.exit(1); }

  await step("API is healthy", async () => { const h = await fetch(API + "/health").then((r) => r.json()); if (!h.ok) throw new Error(JSON.stringify(h)); return [h, `db ${h.db}, redis ${h.redis}`]; });
  await step("Log in (Clerk session)", async () => { const p = await api("/account/profile"); return [p, p.email]; });

  const video = await step("Add sample footage", async () => { const [v] = await api("/videos/sample", { method: "POST", json: {} }); return [v, v.id]; });
  if (!video) return finish();

  const ready = await step("Analyze footage (preview copy, transcript, silences, scene cuts)", async () => {
    const t0 = Date.now(); let v: any, seen = "";
    while (Date.now() - t0 < 6 * 60_000) {
      v = await api(`/videos/${video.id}`);
      const s = v.status + (v.stepName ? ":" + v.stepName : "");
      if (s !== seen) { console.log(`      · ${s}`); seen = s; }
      if (v.status === "ready") break;
      if (v.status === "failed") throw new Error(v.error);
      await sleep(2000);
    }
    if (v.status !== "ready") throw new Error("still " + v.status);
    const words = v.transcript.flatMap((l: any) => l.words);
    if (!words.length) throw new Error("empty transcript");
    return [v, `${v.transcript.length} lines, ${words.length} words, ${words.filter((w: any) => w.filler).length} fillers, ${v.sceneCuts.length} scene cuts, ${v.keyFrames.length} key frames`];
  });
  if (!ready) return finish();

  await step("Breakdown: the video as text and frames for the AI", async () => {
    const b = ready.breakdown;
    if (!b) throw new Error("no breakdown on the footage");
    if (!b.shots.length || !b.sheets.length) throw new Error(`shots ${b.shots.length}, sheets ${b.sheets.length}`);
    if (!/PACING shots=/.test(b.text)) throw new Error("breakdown text is missing PACING");
    const img = await fetch(b.sheets[0].url);
    const bytes = (await img.arrayBuffer()).byteLength;
    if (!img.ok || !/image\/jpeg/.test(img.headers.get("content-type") || "") || bytes < 5000) throw new Error(`contact sheet did not load (${img.status}, ${bytes} bytes)`);
    return [b, `${b.shots.length} shots, ${b.pacing.cutsPerMin} cuts/min, ${b.pacing.wordsPerMin} words/min, ${b.frames.count} frames on ${b.sheets.length} sheets, beat ${b.beat ? b.beat.bpm + " BPM" : "none"}`];
  });

  const folder = await step("Create a project folder", async () => { const f = await api("/folders", { method: "POST", json: { name: "Smoke test " + new Date().toISOString().slice(0, 16) } }); return [f, f.name]; });
  const project = await step("Create an edit (style rules applied as the first pass)", async () => {
    const p = await api("/projects", { method: "POST", json: { videoId: video.id, styleId: "s1", folderId: folder?.id } });
    const full = await api(`/projects/${p.id}`);
    return [full, `v${full.version}: ${full.versions[full.versions.length - 1].note}`];
  });
  if (!project) return finish();

  if (INTERNAL) {
    await step("AI: read the footage as text + contact sheets (get_footage)", async () => {
      const r = await tool("get_footage", { videoId: video.id });
      if (!/PACING shots=/.test(r.text) || !/SHOTS/.test(r.text) || !/TRANSCRIPT/.test(r.text)) throw new Error("breakdown text missing");
      if (!r.images?.length) throw new Error("no contact sheets attached");
      return [r, `${String(r.text).length} chars, ${r.images.length} sheets attached`];
    });
    await step("AI: look at exact moments (get_frames)", async () => {
      const r = await tool("get_frames", { videoId: video.id, times: [2, 20.5] });
      if ((r.images || []).length !== 2) throw new Error(`${(r.images || []).length} frames came back`);
      return [r, String(r.text).split("\n")[0]];
    });
    await step("AI: apply style (via the MCP tool path)", async () => { const r = await tool("apply_style", { projectId: project.id, styleId: "s4" }); return [r, String(r.text).split("\n")[0]]; });
    await step("AI: cut silences over 0.5s", async () => { const r = await tool("cut_silences", { projectId: project.id, overSeconds: 0.5 }); return [r, String(r.text).split("\n")[0]]; });
  }

  await step("Editor autosave (timeline replace)", async () => {
    const p = await api(`/projects/${project.id}`);
    const tl = p.timeline; tl.captionsOn = true;
    const u = await api(`/projects/${project.id}`, { method: "PATCH", json: { timeline: tl, name: p.name, baseVersion: p.version } });
    return [u, `version ${u.version}`];
  });

  const preview = await step("Render preview (live progress)", async () => {
    const s = await api(`/projects/${project.id}/renders`, { method: "POST", json: { kind: "preview" } });
    const d = await waitRender(s.renderId, 4 * 60_000);
    const pr = ffprobeUrl(d.result.url);
    return [d, `${d.result.quality}, ${d.result.size}, ${Number(pr.format.duration).toFixed(1)}s, steps: ${d.steps.join(" > ")}`];
  });

  await step("Render final (1080p)", async () => {
    const s = await api(`/projects/${project.id}/renders`, { method: "POST", json: { kind: "final" } });
    const d = await waitRender(s.renderId, 15 * 60_000);
    const pr = ffprobeUrl(d.result.url);
    const v = pr.streams.find((x: any) => x.codec_type === "video");
    return [d, `${v.width}x${v.height}, ${d.result.size}, ${Number(pr.format.duration).toFixed(1)}s, note: ${d.result.note}`];
  });

  const review = await step("Create review link (with password)", async () => {
    const r = await api("/reviews", { method: "POST", json: { projectId: project.id, password: "rendrr", allowDownload: true } });
    return [r, `${r.token}, password ${r.password}`];
  });
  if (review) {
    const key = await step("Client opens the review and unlocks it", async () => {
      const locked = await api(`/public/reviews/${review.token}`, { public: true });
      if (!locked.locked) throw new Error("review should start locked");
      const u = await api(`/public/reviews/${review.token}/unlock`, { method: "POST", json: { password: "rendrr" }, public: true });
      const open = await api(`/public/reviews/${review.token}`, { public: true, headers: { "x-review-key": u.key } });
      const m = open.media[project.id];
      if (!m?.latest?.url) throw new Error("no video link on the review page");
      return [u.key, `views ${open.views}, ${m.latest.kind} ${m.latest.quality}`];
    });
    const comment = await step("Client adds a comment at 0:04", async () => {
      const c = await api(`/public/reviews/${review.token}/comments`, { method: "POST", json: { time: 4, text: "Can the logo come in sooner?" }, public: true, headers: { "x-review-key": key || "" } });
      return [c, c.id];
    });
    if (comment) await step("Editor resolves the comment", async () => { const c = await api(`/comments/${comment.id}`, { method: "PATCH", json: { resolved: true } }); if (!c.resolved) throw new Error("not resolved"); return [c, "resolved"]; });
    await step("Client approves", async () => {
      const r = await api(`/public/reviews/${review.token}/approve`, { method: "POST", json: {}, public: true, headers: { "x-review-key": key || "" } });
      const p = await api(`/projects/${project.id}`);
      if (p.status !== "Approved") throw new Error("status is " + p.status);
      return [r, "project status Approved"];
    });
  }
  const ref = await step("Add a reference video (read like footage)", async () => {
    const [v0] = await api("/videos/sample", { method: "POST", json: { kind: "reference" } });
    const t0 = Date.now(); let v: any;
    while (Date.now() - t0 < 6 * 60_000) { v = await api(`/videos/${v0.id}`); if (v.status === "ready" || v.status === "failed") break; await sleep(2000); }
    if (v.status !== "ready") throw new Error("still " + v.status + (v.error ? ": " + v.error : ""));
    if (v.kind !== "reference") throw new Error("kind is " + v.kind);
    if (!v.breakdown?.sheets?.length) throw new Error("reference has no breakdown");
    return [v, `${v.id}, ${v.breakdown.shots.length} shots, ${v.breakdown.sheets.length} sheets`];
  });
  if (ref && INTERNAL) {
    await step("AI: find and read the reference (list_references, get_reference)", async () => {
      const l = await tool("list_references", {});
      if (!String(l.text).includes(ref.id)) throw new Error("reference not listed");
      const r = await tool("get_reference", { referenceId: ref.id });
      if (!/VIDEO REFERENCE/.test(r.text) || !r.images?.length) throw new Error("reference breakdown or sheets missing");
      return [r, `${r.images.length} sheets, ${String(r.text).length} chars`];
    });
  }
  if (ref) await step("Delete the reference (its frames go with it)", async () => { await api(`/videos/${ref.id}`, { method: "DELETE" }); const left = await fetch(ref.breakdown.sheets[0].url); if (left.ok) throw new Error("contact sheet still there"); return [true, `sheet now HTTP ${left.status}`]; });

  await step("Usage page numbers", async () => { const u = await api("/account/usage"); return [u, `${u.renderMinutes} render min, ${u.storageUsedGB} GB used`]; });
  void preview;
  return finish();
}

function finish() {
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} steps passed. ${failed.length ? "FAIL" : "PASS"}`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.log("FAIL  unexpected  -> " + (e as Error).message); finish(); });
