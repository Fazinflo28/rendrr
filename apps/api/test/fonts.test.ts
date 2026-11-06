// Fonts added once: add_font takes a font file (base64 or a public https url), checks it is a font, keeps it by
// family, weight and style (the same three again replace it), and list_graphics names them. A url that points into
// Rendrr's own network, or is not https, is refused before anything is downloaded.
// Needs a database and storage (as in .env), and an installed font file to upload (fc-match).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { after, before, describe, it } from "node:test";

const ready = !!process.env.DATABASE_URL && !!process.env.REDIS_URL && !!process.env.S3_BUCKET;
const fontPath = (() => { try { const [file, fam] = execFileSync("fc-match", ["-f", "%{file}|%{family[0]}", "Pacifico"], { encoding: "utf8" }).split("|"); return fam === "Pacifico" ? file : null; } catch { return null; } })();
const run = Math.random().toString(36).slice(2, 8);

describe("fonts", async () => {
  const { fontFormat, privateAddress, fetchFont } = await import("../src/services/fonts");

  it("knows a font file by its first bytes", () => {
    const head = (s: string | number[]) => Buffer.concat([Buffer.from(s as never), Buffer.alloc(16)]);
    assert.equal(fontFormat(head([0, 1, 0, 0])), "ttf");
    assert.equal(fontFormat(head("OTTO")), "otf");
    assert.equal(fontFormat(head("wOFF")), "woff");
    assert.equal(fontFormat(head("wOF2")), "woff2");
    assert.equal(fontFormat(head("<htm")), null);
    assert.equal(fontFormat(Buffer.from("OTTO")), null);
  });

  it("refuses urls into Rendrr's own network, and plain http", async () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.20.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fd12::1", "fe80::1", "::ffff:10.0.0.1"]) assert.ok(privateAddress(ip), ip);
    for (const ip of ["8.8.8.8", "151.101.1.1", "2606:4700::1111"]) assert.ok(!privateAddress(ip), ip);
    // IPv6 spellings that carry a private IPv4 address inside (the hex form is what URL parsing gives).
    for (const ip of ["::ffff:7f00:1", "0:0:0:0:0:ffff:7f00:1", "::ffff:a9fe:a9fe", "::7f00:1", "::127.0.0.1", "64:ff9b::a00:1", "2002:7f00:1::", "0000:0000::0001", "fec0::1", "ff02::1", "not-an-ip"]) assert.ok(privateAddress(ip), ip);
    for (const ip of ["::ffff:808:808", "::ffff:8.8.8.8", "2002:808:808::1", "64:ff9b::808:808"]) assert.ok(!privateAddress(ip), ip);
    await assert.rejects(fetchFont("https://[::ffff:127.0.0.1]/f.ttf"), /not on the public internet/);
    await assert.rejects(fetchFont("https://[::ffff:7f00:1]/f.ttf"), /not on the public internet/);
    await assert.rejects(fetchFont("http://example.com/f.ttf"), /must start with https/);
    await assert.rejects(fetchFont("https://127.0.0.1/f.ttf"), /not on the public internet/);
    await assert.rejects(fetchFont("https://localhost/f.ttf"), /not on the public internet/);
    await assert.rejects(fetchFont("https://[::1]/f.ttf"), /not on the public internet/);
    await assert.rejects(fetchFont("not a url"), /not a url/);
  });

  describe("add_font", { skip: (!ready || !fontPath) && "needs a database, storage and an installed font" }, async () => {
    const { prisma } = await import("@rendrr/db");
    const { deletePrefix, headObject, redis } = await import("@rendrr/core");
    const { PREFIX } = await import("@rendrr/shared");
    const { TOOL_HANDLERS } = await import("../src/tools");
    const { listFonts, deleteFont } = await import("../src/services/fonts");
    let userId = "";
    const c = () => ({ userId, ai: "claude" as const, clerkId: `font_${run}` });
    before(async () => { userId = (await prisma.user.create({ data: { clerkId: `font_${run}`, email: `font-${run}@test.rendrr.dev`, name: "Fonts" } })).id; });
    after(async () => {
      await deletePrefix(`${PREFIX.fonts}${userId}/`).catch(() => {});
      await prisma.user.deleteMany({ where: { id: userId } });
      await redis().quit().catch(() => {});
    });

    it("keeps a font by family, weight and style, replaces it with the same three, and lists it", async () => {
      const data = readFileSync(fontPath!).toString("base64");
      const r = await TOOL_HANDLERS.add_font(c(), { family: "Brand Script", data });
      assert.match(r.text, /^Added font "Brand Script" 400 \(ttf, \d+ KB\)\. Use it in create_graphic code by name: font-family: "Brand Script"/);
      const bold = await TOOL_HANDLERS.add_font(c(), { family: "Brand Script", weight: 700, style: "italic", data: `data:font/ttf;base64,${data}` });
      assert.match(bold.text, /^Added font "Brand Script" 700 italic/);
      const first = (await listFonts(userId)).find((f) => f.weight === 400)!;
      const again = await TOOL_HANDLERS.add_font(c(), { family: "Brand Script", data });
      assert.match(again.text, /^Replaced font "Brand Script" 400/);
      const fonts = await listFonts(userId);
      assert.deepEqual(fonts.map((f) => [f.family, f.weight, f.style, f.format]), [["Brand Script", 400, "normal", "ttf"], ["Brand Script", 700, "italic", "ttf"]]);
      assert.equal(fonts[0].id, first.id);
      const row = await prisma.font.findUniqueOrThrow({ where: { id: first.id } });
      assert.ok(await headObject(row.key), "the file is kept");
      assert.match((await TOOL_HANDLERS.list_graphics(c(), {})).text, /Your fonts \(add_font; use by name\): Brand Script 400, 700 italic/);
      // An installed family can be replaced by the user's own file, and the tool says so.
      assert.match((await TOOL_HANDLERS.add_font(c(), { family: "Montserrat", data })).text, /Montserrat is also installed: graphics that name it now draw with this file/);
      await deleteFont(userId, fonts[1].id);
      assert.equal((await listFonts(userId)).filter((f) => f.family === "Brand Script").length, 1);
    });

    it("refuses what is not a font, a bad name, and a request with both or neither of url and data", async () => {
      await assert.rejects(TOOL_HANDLERS.add_font(c(), { family: "Fake", data: Buffer.from("<html>not a font at all</html>").toString("base64") }), /not a TTF, OTF, WOFF or WOFF2 font file/);
      await assert.rejects(TOOL_HANDLERS.add_font(c(), { family: "Bad;name", data: "AAAA" }), /letters, digits, spaces/);
      await assert.rejects(TOOL_HANDLERS.add_font(c(), { family: "X" }), /url \(https\) or as data/);
      await assert.rejects(TOOL_HANDLERS.add_font(c(), { family: "X", url: "http://example.com/x.ttf" }), /https/);
      assert.equal(await prisma.font.count({ where: { userId, family: { in: ["Fake", "X"] } } }), 0);
    });
  });
});
