// The Rendrr mark in AI chats: the server's info carries `icons` (links on the connector's address and a small one
// inline), and every icon path the HTTP server answers has a real image behind it.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

process.env.INTERNAL_API_SECRET ||= "s3cret";

describe("connector icon", () => {
  it("the server info names Rendrr with its icons", async () => {
    const { buildServer } = await import("../src/build");
    const server = buildServer({ clerkId: "user_1", kind: "claude", name: "Claude" }, "https://mcp.example.com/mcp");
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "claude-ai", version: "1.0.0" });
    await Promise.all([server.connect(a), client.connect(b)]);
    try {
      const info = client.getServerVersion()!;
      assert.equal(info.title, "Rendrr");
      const icons = (info as { icons?: { src: string; mimeType?: string; sizes?: string[] }[] }).icons || [];
      assert.ok(icons.some((i) => i.src === "https://mcp.example.com/icon.png" && i.mimeType === "image/png" && i.sizes?.includes("512x512")), JSON.stringify(icons.map((i) => i.src.slice(0, 40))));
      assert.ok(icons.some((i) => i.src === "https://mcp.example.com/icon.svg"));
      const inline = icons.find((i) => i.src.startsWith("data:image/png;base64,"));
      assert.ok(inline && Buffer.from(inline.src.split(",")[1], "base64").subarray(1, 4).toString() === "PNG");
    } finally { await client.close(); }
  });

  it("every served icon path is a real image of its type", async () => {
    const { ICON_FILES, iconBytes } = await import("../src/icons");
    for (const [path, f] of Object.entries(ICON_FILES)) {
      const b = iconBytes(f.file);
      assert.ok(b.length > 100, path);
      if (f.type === "image/png") assert.equal(b.subarray(1, 4).toString(), "PNG", path);
      if (f.type === "image/svg+xml") assert.match(b.toString(), /^<svg/, path);
      if (f.type === "image/x-icon") assert.deepEqual([...b.subarray(0, 4)], [0, 0, 1, 0], path);
    }
    for (const p of ["/favicon.ico", "/icon.png", "/apple-touch-icon.png"]) assert.ok(ICON_FILES[p], p);
  });
});
