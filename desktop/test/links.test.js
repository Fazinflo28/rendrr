// Link rules of the Mac app (links.js): what stays in the window, what is saved, what opens in the browser.
//   npm test   (from desktop/)
const test = require("node:test");
const assert = require("node:assert/strict");
const { linkKind, isDownload, cleanUserAgent, uniquePath, fitBounds } = require("../links");

test("Rendrr pages stay in the app", () => {
  for (const u of ["https://app.rendrr.live/projects", "https://app.rendrr.live/editor/p1?x=1", "https://api.rendrr.live/drive/callback?code=1", "https://api-production-2428.up.railway.app/drive/callback", "https://clerk.rendrr.live/v1/oauth_callback", "http://localhost:3000/login"])
    assert.equal(linkKind(u), "app", u);
});

test("sign-in pages stay in the app so the login comes back to it", () => {
  for (const u of ["https://accounts.google.com/o/oauth2/v2/auth?client_id=x", "https://accounts.google.com/v3/signin/identifier", "https://quiet-owl-12.clerk.accounts.dev/v1/client"])
    assert.equal(linkKind(u), "auth", u);
});

test("finals, invoices and other files are saved, not opened", () => {
  const final = "https://t3.storageapi.dev/bucket/renders/r1/final.mp4?X-Amz-Algorithm=AWS4&response-content-disposition=attachment%3B%20filename%3D%22Reel%20v3.mp4%22";
  assert.equal(linkKind(final), "file");
  assert.equal(isDownload("https://files.stripe.com/invoice/in_1/pdf/receipt.pdf"), true);
  assert.equal(isDownload("https://bucket.s3.amazonaws.com/x/captions.srt?sig=1"), true);
  assert.equal(isDownload("https://bucket.s3.amazonaws.com/x/My%20Edit.mov"), true);
  // A picture in a comment opens in the browser to look at; it is not a download.
  assert.equal(linkKind("https://bucket.s3.amazonaws.com/comments/c1.png?X-Amz-Signature=abc"), "web");
  assert.equal(isDownload("https://app.rendrr.live/editor/p1"), false);
});

test("other sites open in the default browser", () => {
  for (const u of ["https://drive.google.com/file/d/abc/view", "https://www.youtube.com/watch?v=1", "https://billing.stripe.com/p/session/x", "mailto:hi@rendrr.live", "https://rendrr.live.evil.com/x", "https://notrendrr.live/"])
    assert.equal(linkKind(u), "web", u);
});

test("odd links do nothing", () => {
  for (const u of ["javascript:alert(1)", "file:///etc/passwd", "not a url", "", "chrome://settings"]) assert.equal(linkKind(u), "none", u);
});

test("a different start address counts as Rendrr too", () => {
  assert.equal(linkKind("https://staging.example.com/projects", "https://staging.example.com"), "app");
  assert.equal(linkKind("https://other.example.com/", "https://staging.example.com"), "web");
});

test("the user agent hides Electron so Google allows sign-in", () => {
  const ua = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Rendrr/0.1.3 Chrome/142.0.7444.59 Electron/44.9.3 Safari/537.36";
  const out = cleanUserAgent(ua);
  assert.equal(out, "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.7444.59 Safari/537.36");
  assert.doesNotMatch(out, /Electron|Rendrr/);
});

test("a download never overwrites a file already in Downloads", () => {
  const have = new Set(["/d/Reel v3.mp4", "/d/Reel v3 2.mp4"]);
  assert.equal(uniquePath("/d", "Reel v3.mp4", (p) => have.has(p)), "/d/Reel v3 3.mp4");
  assert.equal(uniquePath("/d", "new.mp4", (p) => have.has(p)), "/d/new.mp4");
  assert.equal(uniquePath("/d", "../../etc/x.mp4", () => false), "/d/_.._etc_x.mp4");
  assert.equal(uniquePath("/d", "", () => false), "/d/download");
});

test("the window opens where it was, unless that screen is gone", () => {
  const screens = [{ x: 0, y: 25, width: 1512, height: 920 }];
  assert.deepEqual(fitBounds({ x: 40, y: 60, width: 1200, height: 800 }, screens), { x: 40, y: 60, width: 1200, height: 800 });
  assert.deepEqual(fitBounds({ x: 2600, y: 60, width: 1200, height: 800 }, screens), { width: 1200, height: 800 });
  assert.equal(fitBounds(null, screens), null);
  assert.equal(fitBounds({ width: 0, height: 10 }, screens), null);
});
