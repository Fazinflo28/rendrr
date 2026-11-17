// Rendrr for Mac's and Windows' public download links: each platform's build puts its installers up with its GitHub
// OIDC token (checked against GitHub's keys: signature, audience, repository, that platform's workflow, expiry), and
// anyone gets the newest one from /download/:platform (a page; /download picks by the browser) and
// /download/:platform/:chip (the file). A stand-in GitHub serves the keys.
// Needs Redis and storage (as in .env).
import assert from "node:assert/strict";
import { createSign, generateKeyPairSync, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { after, before, describe, it } from "node:test";

process.env.INTERNAL_API_SECRET ||= "test-internal-secret";
process.env.LOG_LEVEL = process.env.TEST_LOG || "silent";
const ready = !!process.env.REDIS_URL && !!process.env.S3_BUCKET && !!process.env.DATABASE_URL;

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const other = generateKeyPairSync("rsa", { modulusLength: 2048 });
const KID = "test-kid";
const jwks = createServer((_req, res) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ keys: [{ ...publicKey.export({ format: "jwk" }), kid: KID, alg: "RS256", use: "sig" }] })); });
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
function token(claims: Record<string, unknown>, key = privateKey, kid = KID) {
  const now = Math.floor(Date.now() / 1000);
  const body = `${b64({ alg: "RS256", kid, typ: "JWT" })}.${b64({ iss: "https://token.actions.githubusercontent.com", aud: "rendrr-downloads", repository: "Fazinflo28/rendrr", workflow_ref: "Fazinflo28/rendrr/.github/workflows/desktop-mac.yml@refs/heads/main", iat: now, nbf: now, exp: now + 300, run_id: "1", ...claims })}`;
  return `${body}.${createSign("RSA-SHA256").update(body).sign(key).toString("base64url")}`;
}

const OBJECTS = ["downloads/Rendrr-Mac-AppleSilicon.dmg", "downloads/Rendrr-Mac-Intel.dmg", "downloads/mac.json", "downloads/Rendrr-Windows-x64.exe", "downloads/Rendrr-Windows-Arm.exe", "downloads/windows.json"];
const WIN_FLOW = "Fazinflo28/rendrr/.github/workflows/desktop-windows.yml@refs/heads/main";

describe("Mac and Windows download links", { skip: !ready && "needs Redis, storage and a database" }, async () => {
  const { buildServer } = await import("../src/server");
  const { deleteObjects, redis } = await import("@rendrr/core");
  let app: Awaited<ReturnType<typeof buildServer>>;
  const dmg = randomBytes(2 * 1024 * 1024);
  const put = (chip: string, auth: string | null, body: Buffer = dmg, q = "?version=0.1.9") => app.inject({ method: "PUT", url: `/download/mac/${chip}${q}`, payload: body, headers: { "content-type": "application/octet-stream", ...(auth ? { authorization: `Bearer ${auth}` } : {}) } });

  before(async () => {
    await new Promise<void>((r) => jwks.listen(0, "127.0.0.1", () => r()));
    process.env.DOWNLOADS_OIDC_JWKS_URL = `http://127.0.0.1:${(jwks.address() as { port: number }).port}/jwks`;
    app = await buildServer();
    await deleteObjects(OBJECTS).catch(() => {});
  });
  after(async () => {
    await deleteObjects(OBJECTS).catch(() => {});
    await app.close(); jwks.close();
    await redis().quit().catch(() => {});
  });

  it("before any build, the page says it is being prepared and the file link says so", async () => {
    const pg = await app.inject({ method: "GET", url: "/download/mac" });
    assert.equal(pg.statusCode, 200);
    assert.match(pg.body, /being prepared/);
    assert.equal((await app.inject({ method: "GET", url: "/download/mac/apple" })).statusCode, 404);
  });

  it("refuses an upload without the Mac build's own sign-in", async () => {
    assert.equal((await put("apple", null)).statusCode, 401, "no token");
    assert.equal((await put("apple", token({}, other.privateKey))).statusCode, 401, "signed by another key");
    assert.equal((await put("apple", token({ aud: "someone-else" }))).statusCode, 401, "another audience");
    assert.equal((await put("apple", token({ exp: Math.floor(Date.now() / 1000) - 120 }))).statusCode, 401, "expired");
    assert.equal((await put("apple", token({ repository: "someone/fork" }))).statusCode, 403, "another repository");
    assert.equal((await put("apple", token({ workflow_ref: "Fazinflo28/rendrr/.github/workflows/other.yml@refs/heads/main" }))).statusCode, 403, "another workflow");
    assert.equal((await put("apple", token({}), Buffer.alloc(10))).statusCode, 400, "not an installer");
    assert.equal((await put("windows", token({}))).statusCode, 404, "unknown chip");
  });

  it("takes the Mac build's installers, and anyone downloads the newest one", async () => {
    const a = await put("apple", token({}));
    assert.equal(a.statusCode, 200, a.body);
    assert.equal(a.json().bytes, dmg.length);
    assert.equal((await put("intel", token({}))).statusCode, 200);
    const pg = await app.inject({ method: "GET", url: "/download/mac" });
    assert.match(pg.body, /Download for Apple chip/);
    assert.match(pg.body, /Download for Intel/);
    assert.match(pg.body, /Version 0\.1\.9/);
    assert.match(pg.body, /Open Anyway/);
    const link = await app.inject({ method: "GET", url: "/download/mac/apple" });
    assert.equal(link.statusCode, 302);
    const url = String(link.headers.location);
    assert.match(url, /Rendrr-Mac-AppleSilicon\.dmg/);
    const got = Buffer.from(await (await fetch(url)).arrayBuffer());
    assert.ok(got.equals(dmg), "the same bytes come back");
  });

  it("takes the Windows build's installers (only from the Windows workflow), and a Windows browser gets the Windows page", async () => {
    const exe = randomBytes(2 * 1024 * 1024);
    const putWin = (chip: string, auth: string) => app.inject({ method: "PUT", url: `/download/windows/${chip}?version=0.1.4`, payload: exe, headers: { "content-type": "application/octet-stream", authorization: `Bearer ${auth}` } });
    assert.match((await app.inject({ method: "GET", url: "/download/windows" })).body, /being prepared/);
    assert.equal((await putWin("x64", token({}))).statusCode, 403, "the Mac workflow cannot put Windows installers");
    assert.equal((await put("apple", token({ workflow_ref: WIN_FLOW }))).statusCode, 403, "nor the Windows workflow Mac ones");
    assert.equal((await putWin("intel", token({ workflow_ref: WIN_FLOW }))).statusCode, 404, "unknown chip");
    const x = await putWin("x64", token({ workflow_ref: WIN_FLOW }));
    assert.equal(x.statusCode, 200, x.body);
    assert.equal((await putWin("arm64", token({ workflow_ref: WIN_FLOW }))).statusCode, 200);
    const pg = await app.inject({ method: "GET", url: "/download/windows" });
    assert.match(pg.body, /Rendrr for Windows/);
    assert.match(pg.body, /Download for Windows \(most PCs\)/);
    assert.match(pg.body, /Windows on Arm/);
    assert.match(pg.body, /Version 0\.1\.4/);
    assert.match(pg.body, /More info/);
    const link = await app.inject({ method: "GET", url: "/download/windows/x64" });
    assert.equal(link.statusCode, 302);
    assert.match(String(link.headers.location), /Rendrr-Windows-Setup\.exe/);
    assert.ok(Buffer.from(await (await fetch(String(link.headers.location))).arrayBuffer()).equals(exe), "the same bytes come back");
    // /download: the page for the browser's computer.
    const win = await app.inject({ method: "GET", url: "/download", headers: { "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130.0" } });
    assert.match(win.body, /<h1>Rendrr for Windows<\/h1>/);
    const mac = await app.inject({ method: "GET", url: "/download", headers: { "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) Safari/605.1" } });
    assert.match(mac.body, /<h1>Rendrr for Mac<\/h1>/);
    assert.equal((await app.inject({ method: "GET", url: "/download/linux" })).statusCode, 404);
    // The newest version of each app, for the web app inside an older app to offer the update (no sign-in needed).
    const latest = await app.inject({ method: "GET", url: "/downloads/latest" });
    assert.equal(latest.statusCode, 200);
    const l = latest.json() as { mac: { version: string; link: string }; windows: { version: string; link: string } };
    assert.equal(l.mac.version, "0.1.9");
    assert.equal(l.windows.version, "0.1.4");
    assert.match(l.mac.link, /\/download\/mac$/);
    assert.match(l.windows.link, /\/download\/windows$/);
  });
});
