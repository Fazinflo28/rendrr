// The time left while the user's computer fetches a render's files (a big original from Drive the first time): the
// download's own pace, then the encode. It said "about 5 s left" for the whole of a long download.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fetchEtaSec } from "../src/lib/macTask";

describe("time left while the Mac fetches the files", () => {
  it("goes by the download's pace, then the encode", () => {
    // A tenth fetched in 60 s: nine tenths more is 540 s, plus 90 s of encode.
    assert.equal(fetchEtaSec({ start: 0, frac: 0.1 }, 60_000, 90), 630);
    // Halfway after 10 minutes: another 10 minutes, plus the encode.
    assert.equal(fetchEtaSec({ start: 0, frac: 0.5 }, 600_000, 30), 630);
  });
  it("says nothing until there is a pace to go by, and never less than 5 s", () => {
    assert.equal(fetchEtaSec({ start: 0, frac: 0 }, 60_000, 30), null);
    assert.equal(fetchEtaSec({ start: 0, frac: 0.01 }, 60_000, 30), null);
    assert.equal(fetchEtaSec({ start: 0, frac: 0.5 }, 1000, 30), null);
    assert.equal(fetchEtaSec({ start: 0, frac: 1 }, 60_000, 0), 5);
  });
});
