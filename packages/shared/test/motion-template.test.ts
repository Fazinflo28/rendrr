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
