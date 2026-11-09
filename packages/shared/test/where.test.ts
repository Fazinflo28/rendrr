import { describe, expect, it } from "vitest";
import { deviceName, nextExportText, whereShort, whereText, type RenderWhere } from "../src/where";

const w = (delivery: Partial<RenderWhere["delivery"]>): RenderWhere => ({ renders: "cloud", region: "US East", delivery: { to: "download", device: null, state: null, folder: null, at: null, ...delivery } });

describe("where a render is made and where it goes", () => {
  it("every render is made on the cloud server, never on the computer", () => {
    for (const d of [w({}), w({ to: "mac", device: "Studio Mac", state: "waiting" }), w({ to: "drive", folder: "Clients/Acme" })]) {
      expect(whereText(d, "final", false)).toMatch(/^Rendering on Rendrr's cloud server \(US East\), not on your computer\./);
      expect(whereText(d, "final", true)).toMatch(/^Rendered on Rendrr's cloud server/);
    }
    expect(whereText(w({}), "preview", true)).toBe("Rendered on Rendrr's cloud server (US East), not on your computer. It plays in Rendrr and in the chat's card.");
  });
  it("a final for the Mac names the Mac and says when it is saved", () => {
    expect(whereText(w({ to: "mac", device: "Studio Mac", state: "waiting" }), "final", false)).toMatch(/Goes to the Rendrr Mac app on "Studio Mac": it saves the file to Downloads the moment it is done\./);
    expect(whereText(w({ to: "mac", device: null, state: "sent" }), "final", true)).toMatch(/Sent to the Rendrr Mac app on your Mac: saved in its Downloads folder\./);
    expect(whereShort(w({ to: "mac", device: "Studio Mac", state: "sent" }), "final")).toBe('Made in the cloud · Saved to "Studio Mac"');
  });
  it("Drive and a download say so", () => {
    expect(whereText(w({ to: "drive", folder: "Clients/Acme" }), "final", true)).toMatch(/Goes to Google Drive › Clients\/Acme\./);
    expect(whereShort(w({}), "final")).toBe("Made in the cloud · Download");
    expect(whereShort(w({}), "preview")).toBe("Made on Rendrr's cloud server");
  });
  it("a Mac's name reads like one", () => {
    expect(deviceName("Ronniis-MacBook-Pro.local")).toBe("Ronniis MacBook Pro");
    expect(deviceName("  ")).toBe(null);
    expect(deviceName(undefined)).toBe(null);
    expect(deviceName("<script>alert(1)</script>")).toBe("scriptalert1script");
    expect(deviceName("x".repeat(80))!.length).toBe(40);
  });
  it("where the next export goes", () => {
    expect(nextExportText({ online: true, device: "Studio Mac", version: "0.2.0", seenAt: 1 })).toMatch(/Mac app is open on "Studio Mac", so finals your AI exports go to that Mac's Downloads/);
    expect(nextExportText({ online: false, device: null, version: null, seenAt: null })).toMatch(/not open, so finals your AI exports go to Google Drive/);
  });
});
