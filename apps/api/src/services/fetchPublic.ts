import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { AppError } from "@rendrr/core";

/** Loopback, private, link-local and other non-public addresses (a url the AI sends must not reach Rendrr's own network). */
export function privateAddress(ip: string): boolean {
  const v4 = ip.startsWith("::ffff:") ? ip.slice(7) : ip;
  if (isIP(v4) === 4) {
    const [a, b] = v4.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b < 128) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b < 32) || (a === 192 && b === 168) || a >= 224;
  }
  const x = ip.toLowerCase();
  return x === "::" || x === "::1" || /^f[cd]/.test(x) || /^fe[89ab]/.test(x) || x.startsWith("ff");
}

/** A file from a public https url: every hop's address checked (redirects too), `max` bytes at most, 20 s.
 *  what: the file's name in messages ("font", "LUT"); code: the error code. */
export async function fetchPublic(url: string, o: { max: number; what: string; code: string; headers?: Record<string, string> }): Promise<{ buf: Buffer; type: string; url: URL }> {
  const err = (m: string) => new AppError(m, 400, o.code);
  const mb = `${o.what[0].toUpperCase()}${o.what.slice(1)} files are ${Math.round(o.max / 1024 / 1024)} MB at most.`;
  let u: URL;
  try { u = new URL(url); } catch { throw err(`That ${o.what} url is not a url.`); }
  for (let hop = 0; hop < 6; hop++) {
    if (u.protocol !== "https:") throw err(`${o.what[0].toUpperCase()}${o.what.slice(1)} urls must start with https://.`);
    const host = u.hostname.replace(/^\[|\]$/g, "");
    const addrs = isIP(host) ? [host] : (await lookup(host, { all: true }).catch(() => [])).map((a) => a.address);
    if (!addrs.length) throw err(`Could not find ${host}.`);
    if (addrs.some(privateAddress)) throw err(`That ${o.what} url is not on the public internet.`);
    const r = await fetch(u, { redirect: "manual", headers: hop === 0 ? o.headers : undefined, signal: AbortSignal.timeout(20_000) }).catch((e) => { throw err(`Could not download the ${o.what}: ${(e as Error).message}.`); });
    const to = r.headers.get("location");
    if (r.status >= 300 && r.status < 400 && to) { u = new URL(to, u); continue; }
    if (!r.ok || !r.body) throw err(`The ${o.what} url answered ${r.status}.`);
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
  throw err(`The ${o.what} url redirects too many times.`);
}
