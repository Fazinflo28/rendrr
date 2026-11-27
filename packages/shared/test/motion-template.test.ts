import { describe, expect, it } from "vitest";
import fs from "node:fs";
import {
  MOTION_TEMPLATES, builtinMotionTemplate, checkMotionTemplate, deriveMotionTemplate, motionSlotRefs, motionSlotValues,
  motionTemplateHtml, motionTemplateText, MOTION_HTML_MAX, type MotionTemplate,
} from "../src/motionTemplate";
import { MOTION_RUNTIME } from "../src/motionTemplate/runtimeCode";

const launch = builtinMotionTemplate("mt_launch_story")!.spec;

describe("motion templates", () => {
  it("the generated player matches runtime.js", () => {
    const js = fs.readFileSync(new URL("../src/motionTemplate/runtime.js", import.meta.url), "utf8");
    expect(MOTION_RUNTIME).toBe(js);
  });

  it("Rendrr's templates are valid and every {{slot}} is declared", () => {
    for (const t of MOTION_TEMPLATES) {
      const r = checkMotionTemplate(t.spec);
      expect(r.ok, r.ok ? "" : r.error).toBe(true);
    }
    expect(launch.duration).toBeCloseTo(41.3);
    expect(motionSlotRefs(launch).has("brand")).toBe(true);
  });

  it("refuses an undeclared slot, a duplicate slot and a layer after the end", () => {
    const base = { v: 1, name: "T", w: 1920, h: 1080, duration: 5, slots: [{ id: "a", type: "text", label: "A" }], layers: [{ kind: "text", t0: 0, text: "{{a}} {{b}}" }] };
    expect(checkMotionTemplate(base)).toMatchObject({ ok: false, error: expect.stringContaining("{{b}}") });
    expect(checkMotionTemplate({ ...base, slots: [...base.slots, { id: "a", type: "text", label: "A2" }] })).toMatchObject({ ok: false, error: expect.stringContaining("twice") });
    expect(checkMotionTemplate({ ...base, layers: [{ kind: "text", t0: 9, text: "{{a}}" }] })).toMatchObject({ ok: false, error: expect.stringContaining("after the template ends") });
    expect(checkMotionTemplate({ ...base, layers: [{ kind: "sparkles", t0: 0 }] }).ok).toBe(false);
  });

  it("checks slot values: unknown slot, length, colour, picture", () => {
    expect(motionSlotValues(launch, { nope: "x" })).toMatchObject({ error: expect.stringContaining("no slot") });
    expect(motionSlotValues(launch, { brand: "x".repeat(40) })).toMatchObject({ error: expect.stringContaining("characters at most") });
    expect(motionSlotValues(launch, { accent1: "pink" })).toMatchObject({ error: expect.stringContaining("colour") });
    expect(motionSlotValues(launch, { hero_image: "https://example.com/a.jpg" })).toMatchObject({ error: expect.stringContaining("picture") });
    expect(motionSlotValues(launch, { hero_image: "video:abc" })).toHaveProperty("values");
    expect(motionSlotValues(launch, { tile1: "video:abc" })).toMatchObject({ error: expect.stringContaining("picture") });
    const ok = motionSlotValues(launch, { brand: "Nimbus", accent1: "#22AAFF" });
    expect(ok).toMatchObject({ values: { brand: "Nimbus", accent1: "#22AAFF", version: "2.0" } });
  });

  it("builds the graphic HTML with the slot values as defaults, script-safe and under the code limit", () => {
    const html = motionTemplateHtml(launch, { brand: "</script><b>x" });
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).not.toContain("</script><b>");
    expect(html).toContain("window.renderFrame");
    expect(html.length).toBeLessThan(MOTION_HTML_MAX);
  });

  it("new video mode keeps the base design and motion", () => {
    const d = deriveMotionTemplate(launch, { name: "New", duration: 6, slots: [], layers: [{ kind: "text", t0: 0, text: "Hello" }], camera: [] }) as MotionTemplate;
    const r = checkMotionTemplate(d);
    expect(r.ok).toBe(true);
    expect(d.design).toEqual(launch.design);
    expect(d.motion?.word).toEqual(launch.motion?.word);
    expect(d.name).toBe("New");
  });

  it("describes design, motion, camera, scenes and slots in words", () => {
    const t = motionTemplateText(launch);
    expect(t).toContain("DESIGN:");
    expect(t).toContain("CAMERA:");
    expect(t).toMatch(/zoom 1x to 3\.9x/);
    expect(t).toContain("SCENE 0-2.45s opener");
    expect(t).toContain("SLOTS: brand (text");
  });
});

describe("talking-head ad template (broken down from a reference)", () => {
  const t = MOTION_TEMPLATES.find((x) => x.id === "mt_talking_head_ad")!;
  it("is a valid template with code from a reference", () => {
    expect(t).toBeTruthy();
    const r = checkMotionTemplate(t.spec);
    expect(r.ok).toBe(true);
    expect(t.spec.source).toBe("reference");
    expect(t.spec.w).toBe(1080);
    expect(t.spec.h).toBe(1920);
  });
  it("maps every element: shots, captions, title, disc, logo, flashes, end card", () => {
    const kinds = new Set(t.spec.layers.map((l) => l.kind));
    for (const k of ["backdrop", "flash", "captions", "titlebox", "disc", "bug", "endcard", "cursor"]) expect(kinds.has(k as never)).toBe(true);
    expect(t.spec.edit?.shots.length).toBe(17);
    expect(t.spec.elements!.length).toBeGreaterThan(12);
    const cap = t.spec.layers.find((l) => l.kind === "captions") as unknown as { groups: unknown[] };
    const script = t.spec.slots.find((s) => s.id === "script")!.default!;
    expect(script.split("|").length).toBe(cap.groups.length);
  });
  it("says its shots in the breakdown", () => {
    const text = motionTemplateText(t.spec);
    expect(text).toMatch(/SHOTS: 0-0.96s speaker/);
    expect(text).toMatch(/whip left in/);
    expect(text).toMatch(/SILHOUETTE FLASHES: 0s speaker 1f/);
  });
  it("cuts hard: shots end to end, whips only 2 frames, no white ramps", () => {
    const shots = t.spec.edit!.shots;
    for (let i = 1; i < shots.length; i++) expect(shots[i].t0).toBeCloseTo(shots[i - 1].t1, 3);
    const whips = shots.filter((s) => s.in?.type === "whip");
    expect(whips.length).toBe(5);
    for (const w of whips) expect(w.in!.dur!).toBeLessThan(0.1);
    const flash = t.spec.layers.find((l) => l.kind === "flash") as unknown as { hits: { t: number; hard?: boolean; ms: number }[] };
    expect(flash.hits.map((h) => h.t)).toEqual([15.583, 18.583]);
    for (const h of flash.hits) { expect(h.hard).toBe(true); expect(h.ms).toBe(83); }
    expect(t.spec.edit!.silhouettes!.length).toBe(8);
  });
  it("refuses a silhouette on a slot that takes no video", () => {
    const bad = { ...t.spec, edit: { shots: t.spec.edit!.shots, silhouettes: [{ t: 1, dur: 0.05, slot: "brand" }] } };
    expect(checkMotionTemplate(bad).ok).toBe(false);
  });
  it("refuses a shot on a slot that takes no video", () => {
    const bad = { ...t.spec, edit: { shots: [{ id: "x", slot: "brand", t0: 0, t1: 1 }] } };
    const r = checkMotionTemplate(bad);
    expect(r.ok).toBe(false);
  });
});
