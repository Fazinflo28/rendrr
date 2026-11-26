// Client presets (audit #24): a folder remembers what its edits last used; bad values are left out, and remembering
// never moves the folder in the list.
import { describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => ({ folder: { preset: null as unknown, updatedAt: new Date(1000) }, updates: [] as Record<string, unknown>[] }));
vi.mock("@rendrr/db", () => ({ prisma: { folder: {
  findUnique: async () => store.folder,
  update: async ({ data }: { data: Record<string, unknown> }) => { store.updates.push(data); store.folder = { ...store.folder, ...data } as typeof store.folder; return store.folder; },
} } }));
import { presetDriveRef, presetOf, presetText, rememberPreset } from "../src/presets";

describe("client presets", () => {
  it("keeps only the known shape", () => {
    expect(presetOf(null)).toEqual({});
    expect(presetOf({ styleId: "s2", aspect: "9:16", drive: { folderId: "1AbC_d-9", path: "Clients/Acme" }, junk: 1 })).toEqual({ styleId: "s2", aspect: "9:16", drive: { folderId: "1AbC_d-9", path: "Clients/Acme" } });
    expect(presetOf({ aspect: "tall", drive: { folderId: "../../x" } })).toEqual({});
  });
  it("says what new edits start with, and where the Drive folder is", () => {
    expect(presetText({ aspect: "9:16", styleId: "s2", drive: { folderId: "x", path: "Clients/Acme" } })).toBe("9:16, style s2, Drive Clients/Acme");
    expect(presetText({})).toBe("");
    expect(presetDriveRef({ drive: { folderId: "1AbC", path: null } })).toBe("https://drive.google.com/drive/folders/1AbC");
  });
  it("remembers the latest, writes only a change, and keeps the folder's place", async () => {
    await rememberPreset("f1", { aspect: "9:16" });
    expect(store.folder.preset).toEqual({ aspect: "9:16" });
    expect((store.updates[0].updatedAt as Date).getTime()).toBe(1000);
    await rememberPreset("f1", { styleId: "s2" });
    expect(store.folder.preset).toEqual({ styleId: "s2", aspect: "9:16" });
    const n = store.updates.length;
    await rememberPreset("f1", { aspect: "9:16" });
    expect(store.updates.length).toBe(n);
    await rememberPreset("f1", { drive: { folderId: "D1", path: "Acme/Finals" } });
    expect(store.folder.preset).toEqual({ styleId: "s2", aspect: "9:16", drive: { folderId: "D1", path: "Acme/Finals" } });
  });
});
