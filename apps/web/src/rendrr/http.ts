/* eslint-disable @typescript-eslint/no-explicit-any */
// HTTP helpers shared by the api and the local footage jobs.
// BASE: the API's address, baked in when the web app is built (NEXT_PUBLIC_API_URL on Railway's web service): changing
// it needs a new build, not just a restart. It is api2 at https://api-production-2428.up.railway.app.
export const BASE = (process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000").replace(/\/$/, "");
export const DEV = process.env.NODE_ENV !== "production";
export const NETWORK_MSG = "We could not reach Rendrr. Check your connection and try again.";

// Demo switches (profile menu > Demo states). Development only: simulated in the browser.
export const demo = { mode: "ready", failNextRender: false, failNextUpload: false, failNextDrive: false };


export type FriendlyError = Error & { friendly: true; code?: string; status?: number; [k: string]: any };
export function fail(message: string, code?: string, extra: Record<string, any> = {}): FriendlyError {
  const e = new Error(message) as FriendlyError;
  e.friendly = true;
  if (code) e.code = code;
  Object.assign(e, extra);
  return e;
}
export const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------- Clerk ----------------
export async function clerk(): Promise<any> {
  for (let i = 0; i < 200; i++) {
    const c = (window as any).Clerk;
    if (c && c.loaded) return c;
    await wait(50);
  }
  throw fail("Login did not load. Refresh the page and try again.", "auth-load");
}
// Supabase Auth (once NEXT_PUBLIC_AUTH_PROVIDER=supabase): api.ts sets where the session token comes from.
let tokenSource: null | (() => Promise<string | null>) = null;
export function setTokenSource(fn: () => Promise<string | null>) { tokenSource = fn; }
// Public pages ask for data straight away; wait for Clerk to load first so a logged-in user is sent as logged in.
export async function token(): Promise<string | null> {
  if (tokenSource) { try { return await tokenSource(); } catch { return null; } }
  let c = (window as any).Clerk;
  if (!c?.loaded) { try { c = await clerk(); } catch { return null; } }
  if (!c?.session) return null;
  try { return await c.session.getToken(); } catch { return null; }
}

// ---------------- HTTP ----------------
type Opts = { auth?: boolean; headers?: Record<string, string>; keepalive?: boolean };
export async function req(method: string, path: string, body?: unknown, opts: Opts = {}): Promise<any> {
  if (DEV && demo.mode === "error") { await wait(300); throw fail(NETWORK_MSG, "network"); }
  // A write: pages remembered in memory (ui.js useAsync) are loaded fresh next time.
  if (method !== "GET") (globalThis as any).__rendrrWrites = ((globalThis as any).__rendrrWrites || 0) + 1;
  const h: Record<string, string> = { ...(opts.headers || {}) };
  if (body !== undefined) h["content-type"] = "application/json";
  if (opts.auth !== false) { const t = await token(); if (t) h.authorization = "Bearer " + t; }
  let res: Response;
  try {
    res = await fetch(BASE + path, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined, keepalive: opts.keepalive });
  } catch {
    throw fail(NETWORK_MSG, "network");
  }
  const text = await res.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (!res.ok) {
    const err = (data && data.error) || {};
    const { message, code, ...rest } = err;
    // A plan limit (402 billing_*): the app shows what ran out and where to top up, wherever it was asked.
    if (res.status === 402 && typeof code === "string" && code.startsWith("billing_") && typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent("rendrr:billing", { detail: { message, code } }));
    }
    throw fail(message || (res.status >= 500 ? "Something went wrong on our side. Please try again." : "That did not work. Please try again."), code, { status: res.status, ...rest });
  }
  return data;
}
export const get = (p: string, o?: Opts) => req("GET", p, undefined, o);
export const post = (p: string, b: unknown = {}, o?: Opts) => req("POST", p, b, o);
export const patch = (p: string, b: unknown, o?: Opts) => req("PATCH", p, b, o);
export const del = (p: string, o?: Opts) => req("DELETE", p, undefined, o);
export const emptyIf = <T,>(arr: T): T => (DEV && demo.mode === "empty" && Array.isArray(arr) ? ([] as unknown as T) : arr);
export const enc = encodeURIComponent;

// ---------------- server-sent events over fetch (keeps the Authorization header) ----------------
export async function readEvents(path: string, onEvent: (event: string, data: any) => boolean | void, signal?: AbortSignal, headers: Record<string, string> = {}) {
  const t = await token();
  const res = await fetch(BASE + path, { headers: { accept: "text/event-stream", ...(t ? { authorization: "Bearer " + t } : {}), ...headers }, signal });
  if (!res.ok || !res.body) {
    let data: any = null; try { data = await res.json(); } catch { /* ignore */ }
    throw fail(data?.error?.message || NETWORK_MSG, data?.error?.code);
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
      let ev = "message", data = "";
      for (const line of chunk.split("\n")) {
        if (line.startsWith("event:")) ev = line.slice(6).trim();
        else if (line.startsWith("data:")) data += line.slice(5).trim();
      }
      if (!data) continue;
      let parsed: any = data; try { parsed = JSON.parse(data); } catch { /* text */ }
      if (onEvent(ev, parsed) === true) { try { reader.cancel(); } catch { /* ignore */ } return; }
    }
  }
}

