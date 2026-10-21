// Live updates for open browsers (Server-Sent Events). One Redis subscriber connection per API process,
// shared by every open stream, so a burst of streams cannot use up Redis connections.
import { newRedis } from "@rendrr/core";
import type { FastifyReply, FastifyRequest } from "fastify";

type Listener = (msg: string) => void;
type Redis = ReturnType<typeof newRedis>;
let sub: Redis | null = null;
const listeners = new Map<string, Set<Listener>>();

function subscriber(): Redis {
  if (sub) return sub;
  sub = newRedis();
  sub.on("message", (channel: string, msg: string) => {
    for (const fn of listeners.get(channel) || []) {
      try { fn(msg); } catch { /* one bad stream must not stop the others */ }
    }
  });
  sub.on("error", () => { /* ioredis reconnects on its own */ });
  return sub;
}

/** Calls `fn` for every message on `channel`. Returns the function that stops listening. */
export async function listen(channel: string, fn: Listener): Promise<() => void> {
  let set = listeners.get(channel);
  if (!set) { set = new Set(); listeners.set(channel, set); }
  set.add(fn);
  if (set.size === 1) await subscriber().subscribe(channel);
  let done = false;
  return () => {
    if (done) return;
    done = true;
    const s = listeners.get(channel);
    if (!s) return;
    s.delete(fn);
    if (!s.size) { listeners.delete(channel); subscriber().unsubscribe(channel).catch(() => {}); }
  };
}

export function liveStats() {
  return { channels: listeners.size, listeners: [...listeners.values()].reduce((n, s) => n + s.size, 0) };
}

/** Starts an SSE response. `onClose` runs once when the browser goes away, even if it already has. */
export function openSse(req: FastifyRequest, reply: FastifyReply) {
  const headers = { ...(reply.getHeaders() as Record<string, string>), "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", connection: "keep-alive", "x-accel-buffering": "no" };
  reply.hijack();
  const res = reply.raw;
  const gone = () => res.destroyed || res.writableEnded || req.raw.socket?.destroyed === true;
  if (!gone()) res.writeHead(200, headers);
  const send = (event: string, data: unknown) => { if (!gone()) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };
  const ping = setInterval(() => { if (!gone()) res.write(": ping\n\n"); }, 15_000);
  const hooks: (() => void)[] = [];
  let closed = false;
  const fire = () => {
    if (closed) return;
    closed = true;
    clearInterval(ping);
    for (const fn of hooks.splice(0)) { try { fn(); } catch { /* ignore */ } }
  };
  res.on("close", fire);
  req.raw.on("close", () => { if (req.raw.socket?.destroyed) fire(); });
  if (gone()) fire();
  const close = () => { if (!res.writableEnded) res.end(); fire(); };
  const onClose = (fn: () => void) => { if (closed) fn(); else hooks.push(fn); };
  return { send, close, onClose, isClosed: () => closed };
}
