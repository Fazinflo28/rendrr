// The Assets page in the UI preview: favourites and the Trash on the fake library's videos, plus elements (logos and
// overlays) and audio kept in this tab. Tests can read globalThis.__demoAssets.
import { TRASH_DAYS, trashDaysLeft } from "../../../packages/shared/src/assets.ts";
import { assetFile } from "../src/rendrr/svgPng.ts";

const svg = (body) => "data:image/svg+xml," + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="400" height="200">${body}</svg>`);
// A second of silence as a WAV, so the play button has something to play.
const silence = (() => { const n = 8000, b = new Uint8Array(44 + n); const v = new DataView(b.buffer); const w = (o, s) => [...s].forEach((c, i) => b[o + i] = c.charCodeAt(0));
  w(0, "RIFF"); v.setUint32(4, 36 + n, true); w(8, "WAVEfmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, 8000, true); v.setUint32(28, 8000, true); v.setUint16(32, 1, true); v.setUint16(34, 8, true); w(36, "data"); v.setUint32(40, n, true); b.fill(128, 44);
  let s = ""; b.forEach((x) => s += String.fromCharCode(x)); return "data:audio/wav;base64," + btoa(s); })();

export function demoAssetsApi(api) {
  const listVideos0 = api.listVideos, getVideo0 = api.getVideo;
  const now = Date.now();
  const st = globalThis.__demoAssets = {
    fav: new Set(), trashed: new Map(), // video id -> deleted at
    elements: [
      { id: "el_logo", type: "element", name: "Brand logo", status: "ready", width: 800, height: 400, thumb: svg(`<circle cx="100" cy="100" r="70" fill="#bde816"/><text x="190" y="118" font-family="Arial" font-weight="700" font-size="56" fill="#fff">rendrr</text>`), favorite: true, at: now - 86_400_000, sizeBytes: 42_000, deletedAt: null },
      { id: "el_sub", type: "element", name: "Subscribe sticker", status: "ready", width: 600, height: 200, thumb: svg(`<rect x="20" y="40" width="360" height="120" rx="60" fill="#ff3b30"/><text x="200" y="115" text-anchor="middle" font-family="Arial" font-weight="700" font-size="44" fill="#fff">SUBSCRIBE</text>`), favorite: false, at: now - 3 * 86_400_000, sizeBytes: 18_000, deletedAt: null },
    ],
    sounds: [
      { id: "snd_theme", type: "audio", name: "Podcast theme", status: "ready", seconds: 92.4, url: silence, favorite: false, at: now - 2 * 86_400_000, sizeBytes: 2_900_000, deletedAt: null },
      { id: "snd_vo", type: "audio", name: "Voice-over take 3", status: "ready", seconds: 41, url: silence, favorite: true, at: now - 5 * 86_400_000, sizeBytes: 1_100_000, deletedAt: null },
    ],
  };
  const withFlags = (v) => (v ? { ...v, favorite: st.fav.has(v.id), deletedAt: st.trashed.get(v.id) ?? null } : v);
  const allVideos = async () => { const vs = await listVideos0(); return (Array.isArray(vs) ? vs : []).map(withFlags); };
  const days = (x) => (x.deletedAt ? { ...x, daysLeft: trashDaysLeft(x.deletedAt) } : x);
  const live = (xs) => xs.filter((x) => !x.deletedAt);
  const find = (type, id) => (type === "element" ? st.elements : type === "audio" ? st.sounds : null)?.find((x) => x.id === id);
  const later = (ms = 120) => new Promise((r) => setTimeout(r, ms));
  Object.assign(api, {
    listVideos: async () => (await allVideos()).filter((v) => !v.deletedAt),
    getVideo: async (id) => withFlags(await getVideo0(id)),
    listElements: async () => { await later(); return live(st.elements).map((x) => ({ ...x })); },
    listSounds: async () => { await later(); return live(st.sounds).map((x) => ({ ...x })); },
    listTrash: async () => {
      await later();
      const vs = (await allVideos()).filter((v) => v.deletedAt).map((v) => days({ ...v, type: v.still ? "image" : "video" }));
      return [...vs, ...st.elements.filter((x) => x.deletedAt).map(days), ...st.sounds.filter((x) => x.deletedAt).map(days)].sort((a, b) => b.deletedAt - a.deletedAt);
    },
    assetsSummary: async () => {
      const vs = await allVideos(), lv = vs.filter((v) => !v.deletedAt);
      const videos = lv.filter((v) => !v.still).length, images = lv.filter((v) => v.still).length, elements = live(st.elements).length, audio = live(st.sounds).length;
      return { all: videos + images + elements + audio, videos, images, elements, audio,
        favorites: lv.filter((v) => v.favorite).length + live(st.elements).filter((x) => x.favorite).length + live(st.sounds).filter((x) => x.favorite).length,
        trash: vs.filter((v) => v.deletedAt).length + st.elements.filter((x) => x.deletedAt).length + st.sounds.filter((x) => x.deletedAt).length };
    },
    favoriteAsset: async (type, id, favorite) => { await later(60); const x = find(type, id); if (x) x.favorite = favorite; else if (favorite) st.fav.add(id); else st.fav.delete(id); return { id, type, favorite }; },
    renameAsset: async (type, id, name) => { const x = find(type, id); if (x) x.name = name.trim(); return { id, type, name }; },
    trashAsset: async (type, id) => { await later(60); const at = Date.now(); const x = find(type, id); if (x) x.deletedAt = at; else st.trashed.set(id, at); return { id, type, deletedAt: at, daysLeft: TRASH_DAYS }; },
    restoreTrashed: async (type, id) => { const x = find(type, id); if (x) x.deletedAt = null; else st.trashed.delete(id); return { id, type, restored: true }; },
    deleteAssetForever: async (type, id) => { st.elements = st.elements.filter((x) => x.id !== id); st.sounds = st.sounds.filter((x) => x.id !== id); return { ok: true }; },
    emptyTrash: async () => {
      const n = st.elements.filter((x) => x.deletedAt).length + st.sounds.filter((x) => x.deletedAt).length;
      st.elements = st.elements.filter((x) => !x.deletedAt); st.sounds = st.sounds.filter((x) => !x.deletedAt);
      let vids = 0; for (const id of [...st.trashed.keys()]) { try { await api.removeVideo(id, true); } catch { /* the fake keeps it */ } st.trashed.delete(id); vids++; }
      return { deleted: n + vids, kept: [] };
    },
    uploadAsset: async (file0, as) => {
      const f = await assetFile(file0, as); // as the real app sends it (an SVG element drawn to a PNG)
      await later(200);
      const url = await new Promise((ok) => { const r = new FileReader(); r.onload = () => ok(r.result); r.readAsDataURL(f.body); });
      const base = { id: (as === "audio" ? "snd_" : "el_") + Math.random().toString(36).slice(2, 8), name: f.name.replace(/\.[a-z0-9]+$/i, ""), status: "ready", favorite: false, at: Date.now(), sizeBytes: f.body.size, deletedAt: null };
      (globalThis.__demoUploads ||= []).push({ name: f.name, as, type: f.type });
      if (as === "audio") { st.sounds.unshift({ ...base, type: "audio", seconds: 12, url }); return { soundId: base.id }; }
      if (as === "element") { st.elements.unshift({ ...base, type: "element", width: 512, height: 512, thumb: url }); return { graphicId: base.id }; }
      (globalThis.__demoImages ||= []).push(base.id); return { videoId: base.id };
    },
  });
}
