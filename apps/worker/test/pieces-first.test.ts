// A very heavy final is made in pieces from the start (its one pass runs out of memory after many minutes);
// previews and ordinary finals keep the one pass.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { piecesFirst } from "../src/jobs/render";

describe("pieces first", () => {
  it("a final with dozens of inputs or many scalers", () => {
    assert.equal(piecesFirst("final", { inputs: 43, scalers: 224 }), true); // the V30 edit that timed out
    assert.equal(piecesFirst("final", { inputs: 10, scalers: 160 }), true);
  });
  it("not an ordinary final, nor a preview however heavy", () => {
    assert.equal(piecesFirst("final", { inputs: 12, scalers: 60 }), false);
    assert.equal(piecesFirst("preview", { inputs: 43, scalers: 224 }), false);
  });
});
