// The Library's thumbnails keep their first link while it is good, so a list refreshed every few seconds does not
// make the browser fetch every picture again; a link about to run out is replaced, another picture keeps its own.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { keepThumb, linkUntil } from "../src/rendrr/thumbs";

const link = (path: string, date: string, expires: number, sig: string) => `https://files.example.com/${path}?X-Amz-Date=${date}&X-Amz-Expires=${expires}&X-Amz-Signature=${sig}`;

describe("thumbnail links", () => {
  it("the first link is kept while good; replaced near its end; each picture its own", () => {
    const t0 = Date.UTC(2026, 10, 4, 14, 0, 0);
    const a = link("thumbs/v1.jpg", "20261104T140000Z", 4500, "aaa");
    assert.equal(linkUntil(a), t0 + 4500 * 1000);
    assert.equal(keepThumb({ thumb: a }, t0).thumb, a);
    const b = link("thumbs/v1.jpg", "20261104T141500Z", 4500, "bbb");
    assert.equal(keepThumb({ thumb: b }, t0 + 20 * 60_000).thumb, a, "a refresh 20 minutes later keeps the first link (the browser has the picture)");
    assert.equal(keepThumb({ thumb: link("thumbs/v2.jpg", "20261104T141500Z", 4500, "ccc") }, t0).thumb.includes("v2.jpg"), true, "another picture keeps its own link");
    const late = link("thumbs/v1.jpg", "20261104T151500Z", 4500, "ddd");
    assert.equal(keepThumb({ thumb: late }, t0 + 4400 * 1000).thumb, late, "with under 5 minutes left, the new link is used");
    assert.deepEqual(keepThumb({ thumb: null }), { thumb: null });
  });
});
