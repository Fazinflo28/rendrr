// Engine Part 4.1: every graphic of the hidden library draws in the graphics browser (the recorder's own page, clock
// and fonts) with its default params, in a wide and a tall frame: no page errors, something on screen once it has come
// in, every frame drawn from the time alone (renderFramePure), and a font that is not installed is reported. Needs
// Chromium. Run: pnpm --filter @rendrr/worker test
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PNG } from "pngjs";
import { LIBRARY_ITEMS, libraryParams, templateHtml } from "@rendrr/shared";
import { snapshotHtml } from "../src/lib/graphics";

const SVG = `<svg viewBox="0 0 24 24"><path d="M4 13a8 8 0 0 1 7 7a6 6 0 0 0 3 -5a9 9 0 0 0 6 -8a3 3 0 0 0 -3 -3a9 9 0 0 0 -8 6a6 6 0 0 0 -5 3"/><circle cx="12" cy="12" r="3"/></svg>`;
/** Share of the frame with something drawn (alpha over 0.1). */
function shown(png: Buffer): number {
  const p = PNG.sync.read(png);
  let n = 0;
  for (let i = 3; i < p.data.length; i += 4) if (p.data[i] > 25) n++;
  return n / (p.width * p.height);
}

describe("the library's graphics draw", () => {
  const graphics = LIBRARY_ITEMS.filter((x) => x.place === "graphic");
  it("has the minimum set", () => {
    const ids = new Set(LIBRARY_ITEMS.map((x) => x.id));
    for (const id of ["lib_text_blur_in", "lib_text_slide_in", "lib_text_pop", "lib_text_typewriter", "lib_text_word_by_word", "lib_text_mask_reveal", "lib_text_highlight_wipe", "lib_text_underline", "lib_text_strike",
      "lib_stat_counter", "lib_stat_ring", "lib_stat_bars", "lib_stat_compare", "lib_list_steps", "lib_list_checklist", "lib_list_flow", "lib_callout_arrow", "lib_callout_circle", "lib_callout_zoombox", "lib_callout_spotlight",
      "lib_whiteboard", "lib_pip_circle", "lib_pip_box", "lib_tr_flash", "lib_tr_dip", "lib_tr_whip", "lib_tr_zoom_punch", "lib_tr_slide", "lib_tr_glitch", "lib_tr_light_leak",
      "lib_social_comment", "lib_social_notification", "lib_social_followers", "lib_social_chat", "lib_social_post", "lib_bg_solid", "lib_bg_gradient", "lib_bg_grid", "lib_bg_dots", "lib_bg_paper", "lib_bg_blur", "lib_icon"]) assert.ok(ids.has(id), id);
    assert.equal(LIBRARY_ITEMS.filter((x) => x.kind === "lower_third").length, 6);
  });
  for (const [w, h] of [[640, 360], [360, 640]]) {
    it(`each one at ${w}x${h}: no page errors, on screen once in, pure`, { timeout: 10 * 60_000 }, async () => {
      for (const it of graphics) {
        const p = libraryParams(it, it.id === "lib_icon" ? { label: "Launch" } : {});
        assert.ok("params" in p, `${it.id}: ${"error" in p ? p.error : ""}`);
        const params = { ...p.params, ...(it.id === "lib_icon" ? { svg: SVG } : {}) };
        const dur = Math.max(1, it.durationSec);
        const html = templateHtml(it.id, params, w, h, dur);
        assert.match(html, /window\.renderFramePure=true/, it.id);
        // Halfway in (after any entrance, before the exit): drawn, no errors.
        const r = await snapshotHtml(html, { width: w, height: h, at: dur * 0.5, transparent: true });
        assert.deepEqual(r.errors, [], `${it.id}: ${r.errors.join("; ")}`);
        const s = shown(r.png);
        assert.ok(s > 0.002, `${it.id}: ${(s * 100).toFixed(2)}% of the frame drawn at ${dur * 0.5}s`);
        if (!it.transparent) assert.ok(s > 0.99, `${it.id} is opaque: ${(s * 100).toFixed(1)}%`);
      }
    });
  }
  it("a library graphic placed in an edit is recorded by the render's own path (and kept for the next render)", { skip: !process.env.S3_BUCKET && "needs storage", timeout: 120_000 }, async () => {
    const { renderGraphicClip } = await import("../src/lib/graphics");
    const { mkdtemp, rm } = await import("node:fs/promises"); const { tmpdir } = await import("node:os"); const { join } = await import("node:path");
    const { deletePrefix } = await import("@rendrr/core");
    const dir = await mkdtemp(join(tmpdir(), "lib-clip-")), userId = `libtest-${Math.random().toString(36).slice(2, 8)}`;
    try {
      const clip = { id: "g1", start: 0, end: 2, kind: "graphic", graphicId: "lib_stat_ring", params: { percent: 84, label: "booked" } } as never;
      const r = await renderGraphicClip(clip, { width: 540, height: 960, dir, userId, durationSec: 2 });
      assert.ok(r && r.seconds === 2, JSON.stringify(r));
      const again = await renderGraphicClip(clip, { width: 540, height: 960, dir: await mkdtemp(join(tmpdir(), "lib-clip2-")), userId, durationSec: 2 });
      assert.ok(again && again.path.endsWith("graphic-g1.webm"), "the kept recording");
    } finally { await rm(dir, { recursive: true, force: true }); await deletePrefix(`graphics/${userId}/`).catch(() => {}); }
  });
  it("a font that is not installed is reported by the recorder's font watch", async () => {
    const it0 = LIBRARY_ITEMS.find((x) => x.id === "lib_text_pop")!;
    const p = libraryParams(it0, { font: "Nope Sans" });
    assert.ok("params" in p);
    const html = templateHtml(it0.id, p.params, 640, 360, 3);
    // The recorder asks the page; a snapshot shares the same page setup.
    const { recordHtml } = await import("../src/lib/graphics");
    const { mkdtemp, rm } = await import("node:fs/promises"); const { tmpdir } = await import("node:os"); const { join } = await import("node:path");
    const dir = await mkdtemp(join(tmpdir(), "lib-font-"));
    try {
      const r = await recordHtml(html, { width: 640, height: 360, durationSec: 1, transparent: true, dir });
      assert.deepEqual(r.missingFonts, ["Nope Sans"]);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
