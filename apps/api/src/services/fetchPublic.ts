import { lookup } from "node:dns/promises";
import { createWriteStream } from "node:fs";
import { isIP } from "node:net";
import { AppError } from "@rendrr/core";

/** An IPv6 address as its 8 groups (null when it is not one). "::ffff:127.0.0.1" and "::ffff:7f00:1" both work. */
function v6Groups(ip: string): number[] | null {
  let x = ip.toLowerCase().split("%")[0];
  const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(x);
  if (tail) {
    if (isIP(tail[1]) !== 4) return null;
    const [a, b, c, d] = tail[1].split(".").map(Number);
    x = x.slice(0, -tail[1].length) + ((a << 8) | b).toString(16) + ":" + ((c << 8) | d).toString(16);
  }
  const halves = x.split("::");
  if (halves.length > 2) return null;
  const part = (h: string) => (h ? h.split(":") : []);
  const head = part(halves[0]), rest = halves.length === 2 ? part(halves[1]) : [];
  const fill = halves.length === 2 ? 8 - head.length - rest.length : 0;
  if (fill < 0 || (halves.length === 1 && head.length !== 8)) return null;
  const all = [...head, ...Array(fill).fill("0"), ...rest];
  if (all.length !== 8 || all.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  return all.map((g) => parseInt(g, 16));
}

function privateV4(v4: string): boolean {
  const [a, b] = v4.split(".").map(Number);
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b < 128) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b < 32) || (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
}

/** Loopback, private, link-local and other non-public addresses (a url the AI sends must not reach Rendrr's own network).
 *  IPv6 forms that carry an IPv4 address inside (mapped, compatible, NAT64, 6to4), in any spelling, are checked by it. */
export function privateAddress(ip: string): boolean {
  if (isIP(ip) === 4) return privateV4(ip);
  const g = v6Groups(ip);
  if (!g) return true; // not an address we can read: refused
  const v4At = (i: number) => `${g[i] >> 8}.${g[i] & 255}.${g[i + 1] >> 8}.${g[i + 1] & 255}`;
  const zeros = (n: number) => g.slice(0, n).every((x) => x === 0);
  if (zeros(8)) return true; // ::
  if (zeros(7) && g[7] === 1) return true; // ::1
  if (zeros(5) && g[5] === 0xffff) return privateV4(v4At(6)); // ::ffff:a.b.c.d
  if (zeros(6)) return privateV4(v4At(6)); // ::a.b.c.d (old IPv4-compatible)
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return privateV4(v4At(6)); // NAT64
  if (g[0] === 0x2002) return privateV4(v4At(1)); // 6to4
  return (g[0] & 0xfe00) === 0xfc00 || (g[0] & 0xffc0) === 0xfe80 || (g[0] & 0xffc0) === 0xfec0 || (g[0] & 0xff00) === 0xff00;
}

/** The answer of a public https url after its redirects: every hop's address checked. */
async function openPublic(url: string, o: { what: string; code: string; headers?: Record<string, string>; timeoutMs?: number }): Promise<{ r: Response; u: URL }> {
  const err = (m: string) => new AppError(m, 400, o.code);
  let u: URL;
  try { u = new URL(url); } catch { throw err(`That ${o.what} url is not a url.`); }
  for (let hop = 0; hop < 6; hop++) {
    if (u.protocol !== "https:") throw err(`${o.what[0].toUpperCase()}${o.what.slice(1)} urls must start with https://.`);
    const host = u.hostname.replace(/^\[|\]$/g, "");
    const addrs = isIP(host) ? [host] : (await lookup(host, { all: true }).catch(() => [])).map((a) => a.address);
    if (!addrs.length) throw err(`Could not find ${host}.`);
    if (addrs.some(privateAddress)) throw err(`That ${o.what} url is not on the public internet.`);
    const r = await fetch(u, { redirect: "manual", headers: hop === 0 ? o.headers : undefined, signal: AbortSignal.timeout(o.timeoutMs ?? 20_000) }).catch((e) => { throw err(`Could not download the ${o.what}: ${(e as Error).message}.`); });
    const to = r.headers.get("location");
    if (r.status >= 300 && r.status < 400 && to) { u = new URL(to, u); continue; }
    if (!r.ok || !r.body) throw err(`The ${o.what} url answered ${r.status}.`);
    return { r, u };
  }
  throw err(`The ${o.what} url redirects too many times.`);
}

/** A file from a public https url: every hop's address checked (redirects too), `max` bytes at most, 20 s.
 *  what: the file's name in messages ("font", "LUT"); code: the error code. */
export async function fetchPublic(url: string, o: { max: number; what: string; code: string; headers?: Record<string, string> }): Promise<{ buf: Buffer; type: string; url: URL }> {
  const err = (m: string) => new AppError(m, 400, o.code);
  const mb = `${o.what[0].toUpperCase()}${o.what.slice(1)} files are ${Math.round(o.max / 1024 / 1024)} MB at most.`;
  const { r, u } = await openPublic(url, o);
  if (Number(r.headers.get("content-length") || 0) > o.max) throw err(mb);
  const parts: Buffer[] = [];
  let n = 0;
  for await (const c of r.body as unknown as AsyncIterable<Uint8Array>) {
    n += c.length;
    if (n > o.max) throw err(mb);
    parts.push(Buffer.from(c));
  }
  return { buf: Buffer.concat(parts), type: r.headers.get("content-type") || "", url: u };
}

/** The same, written to a file as it comes (big files: audio), `max` bytes at most, `timeoutMs` for the whole of it. */
export async function fetchPublicTo(url: string, path: string, o: { max: number; what: string; code: string; timeoutMs: number }): Promise<{ bytes: number; type: string; url: URL; name: string | null }> {
  const err = (m: string) => new AppError(m, 400, o.code);
  const mb = `${o.what[0].toUpperCase()}${o.what.slice(1)} files are ${Math.round(o.max / 1024 / 1024)} MB at most.`;
  const { r, u } = await openPublic(url, o);
  if (Number(r.headers.get("content-length") || 0) > o.max) throw err(mb);
  const out = createWriteStream(path);
  let n = 0;
  try {
    for await (const c of r.body as unknown as AsyncIterable<Uint8Array>) {
      n += c.length;
      if (n > o.max) throw err(mb);
      if (!out.write(c)) await new Promise<void>((ok) => out.once("drain", () => ok()));
    }
  } finally { await new Promise<void>((ok) => out.end(() => ok())); }
  const cd = r.headers.get("content-disposition") || "";
  const name = /filename\*=UTF-8''([^;]+)/i.exec(cd)?.[1] ? decodeURIComponent(/filename\*=UTF-8''([^;]+)/i.exec(cd)![1]) : /filename="?([^";]+)"?/i.exec(cd)?.[1] ?? null;
  return { bytes: n, type: r.headers.get("content-type") || "", url: u, name };
}
