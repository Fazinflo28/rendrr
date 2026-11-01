// Files picked to add from the computer: one file, several, a folder (its videos only). The list sent is never empty
// when something was picked (it once was: the picked list was emptied in place, and every upload failed with
// "Array must contain at least 1 element(s)").
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { filesToAdd } from "../src/rendrr/localPick";

describe("files to add from the computer", () => {
  it("one file picked on its own is sent, whatever its extension's case", () => {
    const picked = [{ name: "Ranking cold outreach platforms.MP4", type: "video/mp4" }];
    const r = filesToAdd(picked);
    assert.equal(r.fromFolder, false);
    assert.deepEqual(r.files.map((f) => f.name), ["Ranking cold outreach platforms.MP4"]);
    assert.equal(picked.length, 1, "the picked list is left as it was");
  });
  it("several files picked: all of them, a file with no type too", () => {
    assert.equal(filesToAdd([{ name: "a.mov", type: "video/quicktime" }, { name: "b.MP4", type: "" }]).files.length, 2);
  });
  it("a folder: its videos only, hidden files and others left out", () => {
    const r = filesToAdd([{ name: "a.mp4", type: "video/mp4", webkitRelativePath: "Course/a.mp4" }, { name: "notes.txt", type: "text/plain", webkitRelativePath: "Course/notes.txt" }, { name: ".DS_Store", type: "", webkitRelativePath: "Course/.DS_Store" }, { name: "b.MOV", type: "", webkitRelativePath: "Course/Module 1/b.MOV" }]);
    assert.equal(r.fromFolder, true);
    assert.deepEqual(r.files.map((f) => f.name), ["a.mp4", "b.MOV"]);
  });
});
