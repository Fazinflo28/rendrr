import { describe, expect, it } from "vitest";
import { agoText, deviceName, lastSeenText, macOriginalOf, nextExportText, platformOf, whereShort, whereText, type RenderWhere } from "../src/where";

const w = (delivery: Partial<RenderWhere["delivery"]>): RenderWhere => ({ renders: "cloud", region: "US East", device: null, delivery: { to: "download", device: null, state: null, folder: null, at: null, ...delivery } });
const mac = (device: string | null): RenderWhere => ({ renders: "mac", region: "US East", device, delivery: { to: "mac", device, state: "sent", folder: null, at: null } });

describe("where a render is made and where it goes", () => {
  it("the cloud getting it ready (the footage, graphics, checks) for the Mac that makes the video next: says so, not \"not on your computer\"", () => {
    const soon: RenderWhere = { renders: "cloud", region: "US East", device: null, delivery: { to: "download", device: null, state: null, folder: null, at: null }, next: { device: "Ronnii's MacBook Air", platform: "mac" } };
    expect(whereText(soon, "final", false)).toBe(`Getting it ready on Rendrr's cloud server (the footage, graphics and checks); your Mac ("Ronnii's MacBook Air") makes the video next and saves it to Downloads.`);
    expect(whereText(soon, "preview", false)).toBe(`Getting it ready on Rendrr's cloud server (the footage, graphics and checks); your Mac ("Ronnii's MacBook Air") makes the video next.`);
    expect(whereShort(soon, "final")).toBe(`Getting ready · then on "Ronnii's MacBook Air"`);
    // Done: where it was made, not what was planned.
    expect(whereText(soon, "final", true)).toMatch(/^Rendered on Rendrr's cloud server/);
  });

  it("made on the user's Mac (the Mac app open): says so, names the Mac, and a final is in its Downloads", () => {
    expect(whereText(mac("Studio Mac"), "preview", false)).toBe(`Rendering on your Mac ("Studio Mac") by the Rendrr Mac app (graphics and checks on Rendrr's cloud server). It plays in Rendrr and in the chat's card.`);
    expect(whereText(mac(null), "final", true)).toMatch(/^Rendered on your Mac by the Rendrr Mac app .* Saved in that Mac's Downloads folder; it downloads from Rendrr too\.$/);
    expect(whereText(mac(null), "final", false)).toMatch(/It is saved in that Mac's Downloads folder the moment it is done/);
    expect(whereShort(mac("Studio Mac"), "preview")).toBe('Made on "Studio Mac"');
    expect(whereShort(mac(null), "final")).toBe("Made on your Mac · Saved to Downloads");
    expect(whereText(mac(null), "final", true)).not.toMatch(/cloud server \(US East\), not on your computer/);
  });
  it("made on the cloud server when the Mac does not render it", () => {
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
    expect(nextExportText({ online: true, device: "Studio Mac", version: "0.2.0", seenAt: 1, renders: true })).toMatch(/^Renders run on the user's Mac: the Rendrr Mac app is open on "Studio Mac", so previews and finals are made there/);
    expect(nextExportText({ online: true, device: null, version: "0.1.9", seenAt: 1, renders: false, why: "rendering on the Mac is turned off in the Mac app" })).toMatch(/^Renders run on Rendrr's cloud server \(rendering on the Mac is turned off in the Mac app\)\. The Rendrr Mac app is open/);
  });
  it("no app open, but one was today: says when Rendrr last heard from it and what the user can check", () => {
    const now = Date.now();
    const t = nextExportText({ online: false, device: null, version: null, seenAt: null, lastSeen: { name: "MacBook Air", platform: "mac", at: now - 13 * 3600_000 } });
    expect(t).toMatch(/not open, so finals your AI exports go to Google Drive \(or a download link\)\. Rendrr last heard from the Rendrr Mac app on "MacBook Air" 13 hours ago; an open app checks in every 20 seconds\./);
    expect(t).toMatch(/stays in the Dock/);
    expect(t).toMatch(/quit Rendrr and open it again/);
    expect(t).toMatch(/logged in to this same account/);
    expect(lastSeenText({ name: null, platform: "windows", at: now - 5 * 60_000 }, now)).toMatch(/^Rendrr last heard from the Rendrr Windows app on the user's PC 5 minutes ago;.*stays in the taskbar/);
    expect(agoText(61_000)).toBe("1 minute ago");
    expect(agoText(90 * 60_000)).toBe("2 hours ago");
  });
  it("several computers: listed, and the next render asks which (or says the one picked)", () => {
    const d = (id: string, name: string, platform: "mac" | "windows") => ({ id, name, platform, version: "0.2.0", seenAt: 1, renders: true, busy: false, why: null });
    const devices = [d("a", "M1", "mac"), d("b", "Gaming PC", "windows")];
    const base = { online: true, device: "M1", version: "0.2.0", seenAt: 1, renders: true, devices };
    expect(nextExportText({ ...base, choice: null })).toMatch(/^2 of the user's computers can render now: "M1" \(Mac\) and "Gaming PC" \(PC\), or Rendrr's cloud server\. The next render asks which one to use/);
    expect(nextExportText({ ...base, choice: "b" })).toMatch(/For now the user picked "Gaming PC" \(PC\)/);
    expect(nextExportText({ ...base, choice: "cloud" })).toMatch(/For now the user picked Rendrr's cloud server/);
  });
  it("a Windows PC is said as a PC, and the Rendrr Windows app by its name", () => {
    expect(platformOf("win32")).toBe("windows");
    expect(platformOf("windows")).toBe("windows");
    expect(platformOf("darwin")).toBe("mac");
    expect(platformOf(undefined)).toBe("mac");
    const pc = { ...w({}), renders: "mac" as const, device: "Gaming PC", platform: "windows" as const };
    expect(whereText(pc, "final", true)).toMatch(/^Rendered on your PC \("Gaming PC"\) by the Rendrr Windows app .* Saved in that PC's Downloads folder/);
    expect(whereShort({ ...pc, device: null }, "preview")).toBe("Made on your PC");
    expect(whereText(w({ to: "mac", device: null, state: "sent", platform: "windows" }), "final", true)).toMatch(/Sent to the Rendrr Windows app on your PC/);
    expect(nextExportText({ online: true, device: "Gaming PC", version: "0.1.1", seenAt: 1, renders: true, platform: "windows" })).toMatch(/^Renders run on the user's PC: the Rendrr Windows app is open on "Gaming PC"/);
    expect(macOriginalOf({ macOriginal: { size: 9, width: 1920, height: 1080, platform: "windows" } })?.platform).toBe("windows");
    expect(macOriginalOf({ macOriginal: { size: 9, width: 1920, height: 1080 } })?.platform).toBe("mac");
  });
});
