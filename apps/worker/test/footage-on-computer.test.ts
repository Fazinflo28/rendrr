// Footage work on the user's computer (lib/onComputer.ts): the preview copy's run, as the worker hands it to the app,
// passes the app's own task check (desktop/render.js) and names nothing outside the task's folder; the words the app
// sends back are checked before they become a transcript; where each step ran is kept and noted for the usage page.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { describe, it } from "node:test";
import { frameArgs } from "../src/lib/ffmpeg";
import { madeOnMeta, withMadeOn, wordsOf } from "../src/lib/onComputer";
import { proxyArgs } from "../src/jobs/proxy";

const require = createRequire(import.meta.url);
const { checkTask } = require("../../../desktop/render.js") as { checkTask: (t: unknown, o?: { allowHttp?: boolean }) => void };

const taskWith = (commands: { args: string[]; seconds?: number }[], outputs: string[]) => ({
  v: 1, id: "11111111-2222-3333-4444-555555555555", token: "t", api: "https://api.rendrr.live", renderId: "prep-v1", kind: "footage_preview", label: "x",
  inputs: [{ name: "src", url: "https://www.googleapis.com/drive/v3/files/abc?alt=media", headers: { authorization: "Bearer x" }, size: 10, keep: "drive:abc#10#1" }],
  commands, outputs: outputs.map((name) => ({ name, url: `https://storage.example/${name}`, type: "application/octet-stream" })),
});

describe("the preview copy made on the user's computer", () => {
  it("is a task the app accepts: SDR and HDR, with and without sound", () => {
    for (const info of [
      { width: 1920, height: 1080, seconds: 12.5, hasAudio: true, hdr: null },
      { width: 1080, height: 1920, seconds: 3, hasAudio: false, hdr: "pq" },
    ]) {
      const run = proxyArgs("src", info, "proxy.mp4", "audio.m4a");
      assert.ok(!run.includes("-headers"), "no sign-in in the run (the app fetches the file itself)");
      assert.ok(run.includes("-progress") && run.includes("pipe:1"), "it reports progress");
      const frames = [0.1, 0.9].map((f, i) => ({ args: frameArgs("proxy.mp4", info.seconds * f, `kf${i}.jpg`, 640) }));
      assert.doesNotThrow(() => checkTask(taskWith([{ args: run, seconds: info.seconds }, ...frames], ["proxy.mp4", "audio.m4a", "kf0.jpg", "kf1.jpg"])));
    }
  });
  it("is the same run the cloud makes, but for where it reads and writes", () => {
    const info = { width: 3840, height: 2160, seconds: 60, hasAudio: true, hdr: null };
    const here = proxyArgs("https://drive/x", info, "/tmp/j/proxy.mp4", "/tmp/j/audio.m4a", "Authorization: Bearer y\r\n");
    const there = proxyArgs("src", info, "proxy.mp4", "audio.m4a");
    assert.deepEqual(here.filter((a) => !/^(https:|\/tmp\/|Authorization|-headers$)/.test(a)), there.filter((a) => !["src", "proxy.mp4", "audio.m4a"].includes(a)));
    assert.ok(there.includes("scale=-2:720,fps=30,format=yuv420p"));
  });
});

describe("the words the app sends back", () => {
  it("are kept when they are words with times inside the footage, in order", () => {
    assert.deepEqual(wordsOf({ words: [{ text: " Hello ", start: 0.1, end: 0.5 }, { text: "there.", start: 0.4, end: 0.9 }] }, 10), [{ text: "Hello", start: 0.1, end: 0.5 }, { text: "there.", start: 0.4, end: 0.9 }]);
    assert.deepEqual(wordsOf({ words: [] }, 10), [], "no speech is a transcript too");
  });
  it("drop what is not a word, and refuse what is not a list", () => {
    assert.deepEqual(wordsOf({ words: [{ text: "", start: 0, end: 1 }, { text: "x", start: "a", end: 1 }, { text: "late", start: 50, end: 51 }, { text: "ok", start: 2, end: 1 }] }, 10), [{ text: "ok", start: 2, end: 2.01 }]);
    assert.equal(wordsOf({ nope: 1 }, 10), null);
    assert.equal(wordsOf(null, 10), null);
    // A word that starts before the one before it is moved to start with it (the transcript's words stay in order).
    assert.deepEqual(wordsOf({ words: [{ text: "a", start: 1, end: 1.2 }, { text: "b", start: 0.5, end: 1.4 }] }, 10).map((w) => w.start), [1, 1]);
  });
});

describe("where each step ran", () => {
  it("is kept on the video, one step at a time, and noted with the footage minutes", () => {
    const pv = { on: "computer" as const, device: "Ronnii's MacBook", platform: "mac" as const, by: "app", at: 1 };
    const m1 = withMadeOn(null, { preview: pv });
    const m2 = withMadeOn(m1, { transcript: { on: "cloud", by: "assemblyai", why: "the Mac is busy with another render", at: 2 } });
    assert.deepEqual(m2.preview, pv);
    assert.equal(m2.transcript?.on, "cloud");
    assert.deepEqual(madeOnMeta(m2), { preview: "computer", transcript: "cloud", device: "Ronnii's MacBook", platform: "mac" });
    assert.deepEqual(madeOnMeta(withMadeOn([1, 2], {})), {});
  });
});
