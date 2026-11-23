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

describe("a final the Mac ran out of memory on is made there again in pieces", async () => {
  const { macRanOutOfRoom } = await import("../src/lib/macPieces");
  it("the system stopped FFmpeg (this app), it failed with no exit code (older apps), or it froze", () => {
    assert.equal(macRanOutOfRoom("the Mac could not render it: FFmpeg was stopped by the system (SIGKILL) at 12.4 s, most likely out of memory"), true);
    assert.equal(macRanOutOfRoom("the Mac could not render it: FFmpeg failed (null):"), true);
    assert.equal(macRanOutOfRoom("the Mac could not render it: FFmpeg froze at 0.0 s"), true);
  });
  it("not when it never took it, lacked a feature, lost a file or FFmpeg refused the edit", () => {
    for (const why of [null, "your Mac did not pick it up", "your Mac stopped answering", "the Mac's FFmpeg lacks zscale", "the Mac could not render it: download failed (404)", "the Mac could not render it: FFmpeg failed (1): No such filter"]) assert.equal(macRanOutOfRoom(why), false, String(why));
  });
});
