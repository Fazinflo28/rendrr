import type { FastifyInstance, FastifyReply } from "fastify";
import { createPublicKey, verify as verifySig, type JsonWebKey } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { AppError, getText, headObject, putObject, signGet, uploadFile } from "@rendrr/core";
import { saveBody } from "../services/uploadBody";
import { RENDRR_ICON_SVG } from "../data/rendrrIcon";

// Rendrr for Mac and Windows, for anyone: a public page per platform (GET /download/mac, /download/windows; GET
// /download picks by the browser, and app.rendrr.live/download opens it) with the installers, and a link per chip that
// always serves the newest build. Each platform's build on GitHub Actions puts its new installers here
// (PUT /download/:platform/:chip), signed in with GitHub's own OIDC token for this repository's workflow for that
// platform: no shared secret is stored anywhere.

const PLATFORMS = {
  mac: {
    title: "Rendrr for Mac", info: "downloads/mac.json", type: "application/x-apple-diskimage", workflow: () => process.env.DOWNLOADS_WORKFLOW || ".github/workflows/desktop-mac.yml",
    chips: {
      apple: { key: "downloads/Rendrr-Mac-AppleSilicon.dmg", name: "Rendrr-Mac-AppleSilicon.dmg", label: "Apple chip (M1, M2, M3, M4)" },
      intel: { key: "downloads/Rendrr-Mac-Intel.dmg", name: "Rendrr-Mac-Intel.dmg", label: "Intel" },
    } as Record<string, { key: string; name: string; label: string }>,
  },
  windows: {
    title: "Rendrr for Windows", info: "downloads/windows.json", type: "application/vnd.microsoft.portable-executable", workflow: () => process.env.DOWNLOADS_WORKFLOW_WINDOWS || ".github/workflows/desktop-windows.yml",
    chips: {
      x64: { key: "downloads/Rendrr-Windows-x64.exe", name: "Rendrr-Windows-Setup.exe", label: "Windows (most PCs)" },
      arm64: { key: "downloads/Rendrr-Windows-Arm.exe", name: "Rendrr-Windows-Arm-Setup.exe", label: "Windows on Arm (Snapdragon)" },
    } as Record<string, { key: string; name: string; label: string }>,
  },
} as const;
type Platform = keyof typeof PLATFORMS;
const platformOf = (p: string): Platform | null => (p === "mac" || p === "windows" ? p : null);
const MAX_BYTES = 600 * 1024 * 1024;
export const DOWNLOAD_AUDIENCE = "rendrr-downloads";

const env = () => ({
  issuer: process.env.DOWNLOADS_OIDC_ISSUER || "https://token.actions.githubusercontent.com",
  jwks: process.env.DOWNLOADS_OIDC_JWKS_URL || "https://token.actions.githubusercontent.com/.well-known/jwks",
  repo: (process.env.DOWNLOADS_REPO || "Fazinflo28/rendrr").toLowerCase(),
});

// GitHub's signing keys, kept for an hour (fetched again at once for a key id not seen yet).
let keys: { at: number; url: string; list: (JsonWebKey & { kid?: string })[] } | null = null;
async function signingKey(kid: string) {
  const { jwks } = env();
  const fresh = keys && keys.url === jwks && Date.now() - keys.at < 3600_000;
  if (!fresh || !keys!.list.some((k) => k.kid === kid)) {
    const r = await fetch(jwks, { signal: AbortSignal.timeout(10_000) });
    if (!r.ok) throw new AppError("Could not check the build's sign-in.", 503, "oidc-keys");
    keys = { at: Date.now(), url: jwks, list: ((await r.json()) as { keys: (JsonWebKey & { kid?: string })[] }).keys || [] };
  }
  const k = keys!.list.find((x) => x.kid === kid);
  if (!k) throw new AppError("The build's sign-in is not from GitHub.", 401, "oidc");
  return createPublicKey({ key: k, format: "jwk" });
}

const b64json = (s: string) => JSON.parse(Buffer.from(s, "base64url").toString("utf8"));

/** Checks a GitHub Actions OIDC token: GitHub's signature, not expired, for this audience, from this repository's
 *  workflow for that platform (the Mac build for Mac installers, the Windows build for Windows ones). Returns its claims. */
export async function checkBuildToken(header: unknown, platform: Platform = "mac"): Promise<Record<string, unknown>> {
  const deny = (m = "Only Rendrr's own app builds can put installers here.") => new AppError(m, 401, "oidc");
  const m = /^Bearer ([\w-]+)\.([\w-]+)\.([\w-]+)$/.exec(String(header || ""));
  if (!m) throw deny();
  let head: { alg?: string; kid?: string }, claims: Record<string, unknown>;
  try { head = b64json(m[1]); claims = b64json(m[2]); } catch { throw deny(); }
  if (head.alg !== "RS256" || !head.kid) throw deny();
  const ok = verifySig("RSA-SHA256", Buffer.from(`${m[1]}.${m[2]}`), await signingKey(head.kid), Buffer.from(m[3], "base64url"));
  if (!ok) throw deny();
  const { issuer, repo } = env();
  const workflow = PLATFORMS[platform].workflow();
  const now = Date.now() / 1000;
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (claims.iss !== issuer || !aud.includes(DOWNLOAD_AUDIENCE)) throw deny();
  if (typeof claims.exp !== "number" || claims.exp < now - 30 || (typeof claims.nbf === "number" && claims.nbf > now + 30)) throw deny("The build's sign-in has run out. Run the build again.");
  if (String(claims.repository || "").toLowerCase() !== repo) throw new AppError("That build is not from Rendrr's repository.", 403, "oidc-repo");
  if (!String(claims.workflow_ref || "").includes(`/${workflow}@`)) throw new AppError(`Only the ${platform === "mac" ? "Mac" : "Windows"} app workflow can put these installers here.`, 403, "oidc-workflow");
  return claims;
}

type Info = { version?: string; at?: number; sizes?: Record<string, number> };
const readInfo = async (p: Platform): Promise<Info> => { try { return JSON.parse(await getText(PLATFORMS[p].info)) as Info; } catch { return {}; } };
const fmtMB = (n?: number) => (n ? `${Math.round(n / 1024 / 1024)} MB` : "");
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

const MARK = RENDRR_ICON_SVG.replace("<svg ", '<svg width="48" height="48" aria-hidden="true" ');

const STYLE = `:root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;min-height:100vh;background:#0b0c0e;color:#f2f2f3;font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;display:flex;justify-content:center;padding:48px 16px}
main{width:100%;max-width:560px}h1{font-size:30px;line-height:1.15;margin:20px 0 6px;letter-spacing:-.02em}p{color:#a1a1aa;margin:0 0 8px}
.btns{display:flex;flex-direction:column;gap:10px;margin:28px 0 8px}.btn{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:15px 18px;border-radius:14px;background:#1b1c20;color:#f2f2f3;text-decoration:none;font-weight:600;border:1px solid #2a2b30}
.btn:hover{background:#232429}.btn.primary{background:#bde816;color:#0b0c0e;border-color:#bde816}.btn.primary:hover{background:#c8ee3a}.btn small{font-weight:500;opacity:.7;white-space:nowrap}
.hint{font-size:13px}ol{margin:28px 0 0;padding:20px 20px 20px 40px;background:#141518;border:1px solid #23242a;border-radius:14px;color:#d4d4d8}li{margin:6px 0}code{background:#23242a;padding:2px 6px;border-radius:6px;font-size:13px}
.foot{margin-top:24px;font-size:13px}.foot a{color:#bde816}`;

const STEPS: Record<Platform, { which: string; steps: string; other: string }> = {
  mac: {
    which: `Not sure? Apple menu › About This Mac: "Chip: Apple M…" is an Apple chip; "Processor: … Intel" is Intel.`,
    steps: `<li>Open the downloaded file and drag <b>Rendrr</b> onto <b>Applications</b>.</li><li>Open Rendrr. The first time, macOS says it cannot check the app: click <b>Done</b>.</li><li>Open <b>System Settings › Privacy &amp; Security</b>, scroll down and click <b>Open Anyway</b> next to Rendrr, then <b>Open</b>. Only once.<br><span class="hint">(Or in Terminal: <code>xattr -cr /Applications/Rendrr.app</code>)</span></li><li>Click <b>Log in with your browser</b> and allow the app.</li>`,
    other: `On a Windows PC? <a href="/download/windows">Get Rendrr for Windows</a>`,
  },
  windows: {
    which: `Not sure? Settings › System › About: "System type: x64-based" is most PCs; "ARM-based" is Windows on Arm.`,
    steps: `<li>Open the downloaded file. Rendrr installs for you (no admin needed) and opens.</li><li>The first time, Windows may say <b>Windows protected your PC</b>: click <b>More info</b>, then <b>Run anyway</b>. Only once.</li><li>Click <b>Log in with your browser</b> and allow the app.</li>`,
    other: `On a Mac? <a href="/download/mac">Get Rendrr for Mac</a>`,
  },
};

function page(p: Platform, info: Info, base: string) {
  const P = PLATFORMS[p], ready = !!info.version, chips = Object.keys(P.chips);
  const btn = (chip: string, primary: boolean) => `<a class="btn${primary ? " primary" : ""}" href="${base}/download/${p}/${chip}" download>Download for ${P.chips[chip].label}${info.sizes?.[chip] ? `<small>${fmtMB(info.sizes[chip])}</small>` : ""}</a>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${P.title}</title>
<link rel="icon" href="https://app.rendrr.live/favicon.ico"><meta name="theme-color" content="#0b0c0e">
<meta property="og:title" content="${P.title}"><meta property="og:description" content="Edit video with your AI. Download ${P.title}.">
<style>${STYLE}</style></head><body><main>${MARK}<h1>${P.title}</h1><p>Edit video with your AI. The app opens Rendrr in its own window, stays up to date by itself, and makes your renders on this computer.</p>
${ready ? `<div class="btns">${chips.map((c, i) => btn(c, i === 0)).join("")}</div>
<p class="hint">${STEPS[p].which}${info.version ? ` Version ${esc(info.version)}.` : ""}</p>
<ol>${STEPS[p].steps}</ol>`
    : `<p style="margin-top:28px">The download is being prepared. Check back in a few minutes.</p>`}
<p class="foot">${STEPS[p].other} · Or use Rendrr in your browser: <a href="https://app.rendrr.live">app.rendrr.live</a></p></main></body></html>`;
}

export default async function downloads(app: FastifyInstance) {
  app.removeAllContentTypeParsers();
  app.addContentTypeParser("*", (_req, payload, done) => done(null, payload));
  const base = () => (process.env.PUBLIC_API_URL || "https://api.rendrr.live").replace(/\/$/, "");

  // The page to share: /download picks the Windows page for a Windows browser, the Mac page otherwise.
  const sendPage = async (p: Platform, reply: FastifyReply) => {
    reply.header("cache-control", "public, max-age=60").type("text/html; charset=utf-8");
    return page(p, await readInfo(p), base());
  };
  app.get("/download", { config: { rateLimit: { max: 120, timeWindow: "1 minute" } } }, async (req, reply) => {
    reply.header("vary", "user-agent");
    return sendPage(/Windows/i.test(String(req.headers["user-agent"] || "")) ? "windows" : "mac", reply);
  });
  app.get("/download/:platform", { config: { rateLimit: { max: 120, timeWindow: "1 minute" } } }, async (req, reply) => {
    const p = platformOf((req.params as { platform: string }).platform);
    if (!p) throw new AppError("There is a download for a Mac (/download/mac) or a Windows PC (/download/windows).", 404, "not-found");
    return sendPage(p, reply);
  });
  // The newest installer for a chip: a short-lived link to the file, made fresh on each click.
  app.get("/download/:platform/:chip", { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } }, async (req, reply) => {
    const { platform, chip } = req.params as { platform: string; chip: string };
    const p = platformOf(platform);
    const c = p ? PLATFORMS[p].chips[chip] : undefined;
    if (!p || !c) throw new AppError(p === "windows" ? "There is a download for most PCs (x64) or Windows on Arm (arm64)." : "There is a download for an Apple chip (apple) or an Intel Mac (intel).", 404, "not-found");
    if (!(await headObject(c.key))) throw new AppError("The download is being prepared. Try again in a few minutes.", 404, "not-ready");
    reply.header("cache-control", "no-store");
    return reply.redirect(await signGet(c.key, 3600, { download: c.name, contentType: PLATFORMS[p].type }), 302);
  });
  // A new installer from that platform's build (GitHub Actions, with its OIDC token).
  app.put("/download/:platform/:chip", { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, async (req) => {
    const { platform, chip } = req.params as { platform: string; chip: string };
    const p = platformOf(platform);
    const c = p ? PLATFORMS[p].chips[chip] : undefined;
    if (!p || !c) throw new AppError("Unknown chip.", 404, "not-found");
    const claims = await checkBuildToken(req.headers.authorization, p);
    const body = req.body as Readable | undefined;
    if (!body || typeof body.pipe !== "function") throw new AppError("Send the installer as the body.", 400, "bad-file");
    const dir = await mkdtemp(join(tmpdir(), "installer-up-"));
    try {
      const path = join(dir, "installer.bin");
      const n = await saveBody(body, path, MAX_BYTES, { length: req.headers["content-length"], tooBig: "That installer is too big.", code: "too-big" });
      if (n < 1024 * 1024) throw new AppError("That is not an installer (too small).", 400, "bad-file");
      await uploadFile(c.key, path, PLATFORMS[p].type);
      const q = (req.query as { version?: unknown }).version;
      const prev = await readInfo(p);
      const info: Info = { version: typeof q === "string" ? q.slice(0, 40) : prev.version, at: Date.now(), sizes: { ...(prev.sizes || {}), [chip]: n } };
      await putObject(PLATFORMS[p].info, JSON.stringify(info), "application/json");
      req.log.info({ platform: p, chip, bytes: n, version: info.version, run: claims.run_id, sha: claims.sha }, "installer updated");
      return { ok: true, platform: p, chip, bytes: n, version: info.version, link: `${base()}/download/${p}/${chip}` };
    } finally { await rm(dir, { recursive: true, force: true }).catch(() => {}); }
  });
}
