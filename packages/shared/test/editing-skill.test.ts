// The editing skill and the Rendrr app ship with the connector: every tool they name exists, nothing private leaks
// into them, the instructions stay short enough for hosts to keep, and the guide says to render once.
import { describe, expect, it } from "vitest";
import { APP_RESOURCE_URI, APP_TOOLS, EDIT_OP_NAMES, EDITING_SKILL, HOW_TO_EDIT, MCP_INSTRUCTIONS, MCP_TOOLS } from "../src";

const toolNames = new Set(MCP_TOOLS.map((t) => t.name));
const named = (text: string) => Array.from(new Set(text.match(/\b[a-z]+(?:_[a-z]+)+\b/g) ?? []));

describe("editing skill", () => {
  it("names only tools and edits Rendrr has", () => {
    const known = new Set([...toolNames, ...EDIT_OP_NAMES, "director_note", "false_start", "click_pop", "low_light", "out_of_focus", "face_lost", "off_camera"]);
    for (const text of [EDITING_SKILL, MCP_INSTRUCTIONS]) {
      const unknown = named(text).filter((n) => !known.has(n));
      expect(unknown, `unknown names: ${unknown.join(", ")}`).toEqual([]);
    }
  });

  it("keeps out the private pipeline it came from", () => {
    for (const word of ["Ronnii", "Framecut", "Frame.io", "Composio", "Google Drive", "Lotus", "AdsFlow", "Glow Flow", "propose_skills", "client_rules", "ffmpeg", "Whisper"]) {
      expect(EDITING_SKILL.toLowerCase()).not.toContain(word.toLowerCase());
    }
    expect(EDITING_SKILL).not.toMatch(/—/); // no em dashes
  });

  it("fits in one tool answer and the instructions stay short", () => {
    expect(EDITING_SKILL.length).toBeLessThan(24_000);
    expect(MCP_INSTRUCTIONS.length).toBeLessThan(1_600);
    expect(MCP_INSTRUCTIONS).toContain("get_editing_skill");
    expect(MCP_INSTRUCTIONS).toMatch(/render_preview ONCE/);
  });

  it("the guide and the tools say: one apply_edits, check without rendering, render once", () => {
    expect(HOW_TO_EDIT).toMatch(/Check, then render once/);
    expect(HOW_TO_EDIT).toContain("check_edit");
    const doc = (n: string) => MCP_TOOLS.find((t) => t.name === n)!.description;
    expect(doc("render_preview")).toMatch(/render ONCE per revision/);
    expect(doc("apply_edits")).toMatch(/every change of a revision in one call/);
    expect(doc("check_edit")).toMatch(/without rendering/);
    expect(toolNames.has("get_editing_skill")).toBe(true);
  });
});

describe("the Rendrr app tools", () => {
  it("open_projects opens the app; the app's own tools are separate and hidden from the AI", () => {
    expect(MCP_TOOLS.find((t) => t.name === "open_projects")?.ui).toBe(true);
    expect(APP_RESOURCE_URI).toMatch(/^ui:\/\//);
    for (const t of APP_TOOLS) {
      expect(t.app).toBe(true);
      expect(toolNames.has(t.name)).toBe(false);
      expect(t.name).toMatch(/^app_/);
    }
    expect(new Set(APP_TOOLS.map((t) => t.name)).size).toBe(APP_TOOLS.length);
  });
});
