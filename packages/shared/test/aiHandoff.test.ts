import { describe, expect, it } from "vitest";
import { HANDOFF_LIST_MAX, handoffPrompt, handoffTarget, handoffUrl, sentLabel } from "../src/aiHandoff";

describe("Send to Claude from the Rendrr app", () => {
  it("writes the same message as the Claude card's button", () => {
    const t = handoffPrompt({ name: "Promo", projectId: "p1", version: 4, comments: [{ time: 65.2, text: "Cut  the\ncough" }, { time: 3, text: "", drawing: { w: 1 } }] });
    expect(t).toBe('Please work through the 2 open comments on my Rendrr edit "Promo" (project p1), made on preview v4:\n- 1:05 Cut the cough\n- 0:03 (no words) (drawing)\n\n' +
      "Read them with get_comments (images true shows the drawings and pictures), fix each one and the same kind of mistake everywhere in one apply_edits, check it with check_edit, render one preview, then resolve the comments you fixed.");
  });

  it("stays short enough for a chat link: long comments are cut, many are counted", () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ time: i, text: "x".repeat(500) }));
    const t = handoffPrompt({ name: 'My "best" edit', projectId: "p2", comments: many });
    expect(t).toContain(`the 30 open comments on my Rendrr edit "My 'best' edit"`);
    expect(t.split("\n").filter((l) => l.startsWith("- ")).length).toBe(HANDOFF_LIST_MAX + 1);
    expect(t).toContain(`- and ${30 - HANDOFF_LIST_MAX} more`);
    expect(t).not.toContain("images true");
    expect(handoffUrl("claude", t).length).toBeLessThan(8000);
  });

  it("opens the AI's own chat with the message typed in", () => {
    expect(handoffUrl("claude", "Fix a & b?")).toBe("https://claude.ai/new?q=Fix%20a%20%26%20b%3F");
    expect(handoffUrl("chatgpt", "hi")).toBe("https://chatgpt.com/?q=hi");
  });

  it("sends to the AI picked before if it is still connected, else Claude, else ChatGPT, else none", () => {
    expect(handoffTarget({ claude: true, chatgpt: true }, "chatgpt")).toBe("chatgpt");
    expect(handoffTarget({ claude: true, chatgpt: false }, "chatgpt")).toBe("claude");
    expect(handoffTarget({ claude: false, chatgpt: true })).toBe("chatgpt");
    expect(handoffTarget({})).toBeNull();
    expect(sentLabel("chatgpt")).toBe("Sent to ChatGPT");
  });
});
