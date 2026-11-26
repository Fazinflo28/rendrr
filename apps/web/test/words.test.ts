// The editor's word lookups give the same answers as the plain scans they replace, only faster.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isSortedByTime, lastWordAtOrBefore, lineOfWord, wordIndexById } from "../src/rendrr/words";

const w = (id: string, t: number) => ({ id, t });

describe("transcript word lookups", () => {
  it("the word playing matches filter().pop() for every moment, sorted or not", () => {
    const sorted = [w("a", 0), w("b", 0.5), w("c", 0.5), w("d", 1.2), w("e", 3)];
    const shuffled = [w("a", 0), w("c", 2), w("b", 1), w("d", 1.5)];
    for (const list of [sorted, shuffled, []]) {
      const s = isSortedByTime(list);
      for (const t of [-1, 0, 0.25, 0.5, 0.7, 1, 1.2, 1.9, 2, 3, 10]) {
        const plain = list.filter((x) => x.t <= t).pop() ?? null;
        assert.equal(lastWordAtOrBefore(list, t, s), plain, `t=${t}`);
      }
    }
    assert.equal(isSortedByTime(sorted), true);
    assert.equal(isSortedByTime(shuffled), false);
  });
  it("places and lines by id", () => {
    const idx = wordIndexById([w("a", 0), w("b", 1)]);
    assert.equal(idx.get("b"), 1);
    assert.equal(idx.get("z"), undefined);
    const lines = lineOfWord([{ id: "l1", words: [{ id: "a" }] }, { id: "l2", words: [{ id: "b" }, { id: "c" }] }]);
    assert.equal(lines.get("c"), "l2");
  });
  it("a long transcript is looked up fast", () => {
    const many = Array.from({ length: 50000 }, (_, i) => w(`w${i}`, i * 0.3));
    const t0 = performance.now();
    for (let k = 0; k < 2000; k++) lastWordAtOrBefore(many, (k * 7.3) % 15000, true);
    assert.ok(performance.now() - t0 < 500);
  });
});
