// Engine Part 4: the hidden library for the AI (never shown in the user interface). list_library, get_library_item
// (its settings and a preview frame drawn by the graphics browser), add_library_item (placed as a graphic, or turned
// into the explicit edits it stands for), search_icons (the bundled icon set, with a sheet to look at). Rendrr places
// what the AI asks for; "auto" positions are worked out from the face box measured in the footage, nothing else.
import { AppError, enqueue, headObject, newRedis, notFound, signGet, type SnapshotJob, type SnapshotResult } from "@rendrr/core";
import { prisma } from "@rendrr/db";
import {
  CAPTION_FONTS, faceOnScreenAt, GRAPHIC_FONT_ALIASES, GRAPHIC_FONTS, LIBRARY_ITEMS, LIBRARY_KINDS, libraryItem, libraryLine, libraryParams, libraryParamsText, PREFIX, QUEUES, templateHtml,
  type EditOp, type LibraryItem, type SeqClip, type VisionSummary,
} from "@rendrr/shared";
import { outputSize } from "@rendrr/shared/renderPlan";
import { QueueEvents } from "bullmq";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { visionDetailsOf } from "./deep";
import { markScope } from "./marks";
import { getOwnedProject } from "./projects";
import { TEST_WAIT_MS } from "./testGraphic";

// ---------------------------------------------------------------------------------------------
// Icons: Tabler Icons (MIT), brand logos left out (scripts/build-icons.mjs)
// ---------------------------------------------------------------------------------------------
type Icon = [name: string, category: string, tags: string, inner: string, filled: 0 | 1];
let ICONS: { source: string; icons: Icon[]; byName: Map<string, Icon> } | null = null;
function iconSet() {
  if (!ICONS) {
    // Next to the source (src/services -> src/data), or next to a bundle (vercel-build.mjs copies data/ beside it).
    const file = [new URL("../data/icons.json.gz", import.meta.url), new URL("./data/icons.json.gz", import.meta.url)].find((u) => existsSync(u));
    if (!file) throw new AppError("The icon set is not installed on this server.", 500, "no-icons");
    const d = JSON.parse(gunzipSync(readFileSync(file)).toString()) as { source: string; icons: Icon[] };
    ICONS = { ...d, byName: new Map(d.icons.map((x) => [x[0], x])) };
  }
  return ICONS;
}
const svgOf = (ic: Icon) => (ic[4]
  ? `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" stroke="none">${ic[3]}</svg>`
  : `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ic[3]}</svg>`);
/** An icon's SVG by its id ("tabler:rocket", or just "rocket"); null when there is no such icon. */
export function iconSvg(id: string): string | null {
  const ic = iconSet().byName.get(String(id).trim().toLowerCase().replace(/^tabler:/, ""));
  return ic ? svgOf(ic) : null;
}
export const iconCount = () => iconSet().icons.length;

/** Icons for a query, best first: whole-word name matches, then tags, then the category. Outline before filled. */
export function findIcons(query: string, limit = 24): { id: string; category: string; svg: string }[] {
  const q = query.toLowerCase().trim(), toks = q.split(/[^a-z0-9]+/).filter(Boolean);
  if (!toks.length) return [];
  const scored: [number, Icon][] = [];
  for (const ic of iconSet().icons) {
    const [name, cat, tags, , filled] = ic;
    const parts = name.split("-"), tg = tags.split(" ");
    let s = name === toks.join("-") ? 100 : 0, hit = 0;
    for (const t of toks) {
      const n = parts.includes(t) ? 20 : name.includes(t) ? 8 : 0, g = tg.includes(t) ? 10 : tags.includes(t) ? 3 : 0, c = cat.toLowerCase() === t ? 4 : 0;
      if (n || g || c) hit++;
      s += n + g + c;
    }
    if (!hit) continue;
    s += hit === toks.length ? 15 * hit : 0;
    s -= parts.length * 0.5 + (filled ? 1 : 0);
    scored.push([s, ic]);
  }
  return scored.sort((a, b) => b[0] - a[0]).slice(0, limit).map(([, ic]) => ({ id: `tabler:${ic[0]}`, category: ic[1], svg: svgOf(ic) }));
}

// ---------------------------------------------------------------------------------------------
// Pictures drawn by the worker's graphics browser (the test queue answers in a few seconds)
// ---------------------------------------------------------------------------------------------
const SNAP_VERSION = "s1";
let events: QueueEvents | null = null;
/** A picture of a page at time `at`: a signed link, or null when the worker did not answer in time. Kept a day. */
async function snapshot(userId: string, html: string, width: number, height: number, at: number): Promise<{ url: string; errors: string[] } | null> {
  const key = "snap-" + createHash("sha256").update(JSON.stringify([SNAP_VERSION, html, width, height, at])).digest("hex").slice(0, 24);
  const image = `${PREFIX.tests}${userId}/${key}.png`;
  if (await headObject(image)) return { url: await signGet(image, 900), errors: [] };
  events ||= new QueueEvents(QUEUES.test.name, { connection: newRedis() });
  const j = await enqueue<SnapshotJob>("test", { kind: "snapshot", userId, key, html, width, height, at }, { jobId: `test-${key}`, removeOnComplete: true, removeOnFail: true });
  try {
    const r = (await j.waitUntilFinished(events, TEST_WAIT_MS)) as SnapshotResult;
    return { url: await signGet(r.image, 900), errors: r.errors };
  } catch (e) {
    if (/timed out/i.test((e as Error).message || "")) return null;
    throw new AppError(`The picture could not be drawn: ${((e as Error).message || "").slice(0, 300)}`, 400, "snapshot-failed");
  }
}
const GREY = `<style>html,body{background:#3a3a40 !important}</style>`;
const onGrey = (html: string) => html.replace(/<head[^>]*>/i, (m) => m + GREY);

// ---------------------------------------------------------------------------------------------
// list_library, get_library_item
// ---------------------------------------------------------------------------------------------
export function listLibrary(kind?: string): string {
  if (kind && !(LIBRARY_KINDS as readonly string[]).includes(kind)) throw new AppError(`No library kind "${kind}". Kinds: ${LIBRARY_KINDS.join(", ")}.`, 400, "invalid-input");
  const items = LIBRARY_ITEMS.filter((x) => !kind || x.kind === kind);
  return [`LIBRARY: ${items.length} ready items${kind ? ` (${kind})` : ""}. id | kind | name | length | what it does. Settings and a preview: get_library_item. Place: add_library_item.`,
    ...items.map(libraryLine)].join("\n");
}

/** When a preview frame shows the item fully in (after its entrance, before its exit). */
function previewAt(it: LibraryItem) {
  const d = Math.max(1, it.durationSec);
  if (it.kind === "whiteboard") return d - 0.6;
  if (it.kind === "list" || it.id === "lib_social_chat") return d * 0.72;
  return d * 0.5;
}
const exampleParams = (it: LibraryItem) => (it.id === "lib_icon" ? { svg: iconSvg("tabler:sparkles") ?? "" } : {});

export async function getLibraryItem(userId: string, id: string): Promise<{ text: string; images: string[] }> {
  const it = libraryItem(id);
  if (!it) throw notFound(`No library item "${id}". list_library shows them.`);
  const how = it.place === "graphic"
    ? `A graphic on V3, ${it.durationSec}s long by default (it stretches to the placement: the entrance at the start, the exit at the end)${it.transparent ? "" : ", opaque (covers the picture)"}.`
    : `Makes edits: ${it.description}`;
  const lines = [`${it.name} (${it.id}, ${it.kind}): ${it.description}`, how, "Params (* = required; default; limits):", libraryParamsText(it),
    `Place it: add_library_item {projectId, itemId: "${it.id}"${it.place === "graphic" || it.kind === "pip" ? ", start, end" : it.kind === "transition" ? ", start (the cut nearest it)" : ""}, params: {...}}${it.place === "graphic" ? `; test it first with test_graphic {graphicId: "${it.id}", params, over: {videoId, time}}` : ""}.`];
  if (it.place !== "graphic") return { text: lines.join("\n"), images: [] };
  const p = libraryParams(it, {}) as { params: Record<string, unknown> };
  const snap = await snapshot(userId, onGrey(templateHtml(it.id, { ...p.params, ...exampleParams(it) }, 640, 360, Math.max(1, it.durationSec))), 640, 360, previewAt(it));
  lines.push(snap ? `Preview frame attached (default params, 16:9, at ${previewAt(it).toFixed(1)}s, over grey).${snap.errors.length ? ` The page reported: ${snap.errors.join("; ")}` : ""}` : "The preview frame is still being drawn (the worker is busy): ask again in a few seconds.");
  return { text: lines.join("\n"), images: snap ? [snap.url] : [] };
}

// ---------------------------------------------------------------------------------------------
// search_icons
// ---------------------------------------------------------------------------------------------
export async function searchIcons(userId: string, query: string, limit = 24): Promise<{ text: string; images: string[] }> {
  const n = Math.max(1, Math.min(48, Math.round(limit)));
  const found = findIcons(query, n);
  if (!found.length) return { text: `No icon matches "${query}" (${iconCount()} icons, Tabler Icons, MIT; no brand logos). Try a plainer word: arrow, chart, user, star, check, money, phone.`, images: [] };
  const cols = 6, cw = 150, ch = 128, rows = Math.ceil(found.length / cols);
  const cells = found.map((f, i) => `<div class="c" style="left:${(i % cols) * cw}px;top:${Math.floor(i / cols) * ch}px"><div class="i">${f.svg}</div><div class="n">${i + 1}. ${f.id.replace(/^tabler:/, "")}</div></div>`).join("");
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;background:#1d1d22;font-family:Inter,sans-serif}.c{position:absolute;width:${cw}px;height:${ch}px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;color:#fff}.i svg{width:52px;height:52px;display:block}.n{font-size:12px;color:#cfd2da;max-width:${cw - 10}px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}</style></head><body>${cells}</body></html>`;
  const snap = await snapshot(userId, html, cols * cw, rows * ch, 0);
  return {
    text: [`ICONS for "${query}": ${found.length} of ${iconCount()} (Tabler Icons, MIT; no brand logos). Use the id in the Icon item: add_library_item {itemId: "lib_icon", params: {icon: "<id>", entrance, label}}.`,
      ...found.map((f, i) => `${i + 1}. ${f.id} (${f.category})`), snap ? "A sheet of them is attached, numbered in this order." : "The sheet is still being drawn (the worker is busy): ask again in a few seconds."].join("\n"),
    images: snap ? [snap.url] : [],
  };
}

/** apply_edits add_graphic of the Icon item: its SVG from the icon id (the page has no network, so the SVG goes in). */
export function withIcons(edits: EditOp[]): EditOp[] {
  return edits.map((e) => {
    if (e.op !== "add_graphic" || e.graphicId !== "lib_icon") return e;
    const icon = String((e.params as { icon?: unknown })?.icon ?? "tabler:sparkles");
    const svg = iconSvg(icon);
    if (!svg) throw new AppError(`No icon "${icon}": search_icons finds the ids.`, 400, "invalid-edit");
    return { ...e, params: { ...e.params, svg } };
  });
}

// ---------------------------------------------------------------------------------------------
// add_library_item
// ---------------------------------------------------------------------------------------------
const installedFonts = () => new Set([...Object.values(GRAPHIC_FONTS).flat(), ...CAPTION_FONTS, ...Object.keys(GRAPHIC_FONT_ALIASES)].map((f) => f.toLowerCase()));
/** A font the graphics browser has or the user added; else the placement is refused (never drawn with a fallback). */
async function checkFont(userId: string, font: unknown) {
  if (typeof font !== "string" || !font.trim()) return;
  if (installedFonts().has(font.toLowerCase())) return;
  const mine = await prisma.font.findFirst({ where: { userId, family: { equals: font, mode: "insensitive" } }, select: { id: true } }).catch(() => null);
  if (mine) return;
  throw new AppError(`Font "${font}" is not installed and you have not added it. Use an installed one (Inter, Montserrat, Poppins, Open Sans, Roboto, Oswald, Bebas Neue, Anton, Space Grotesk, Playfair Display, DM Serif Display, Archivo Black, Kalam, Permanent Marker, Lilita One, Bangers, ...) or add the file with add_font first. Nothing was changed.`, 400, "font-missing");
}

type Box = [number, number, number, number];
/** The main face on screen over edit times a..b (the median box of up to 9 moments), as the render draws it, or null. */
async function faceIn(userId: string, projectId: string, a: number, b: number) {
  const scope = await markScope(userId, { projectId });
  const p = await getOwnedProject(userId, projectId);
  const { width: W, height: H } = outputSize(p.aspect as "16:9" | "9:16" | "1:1", "preview");
  const view = scope.view!, tl = scope.timeline!;
  const clips = new Map((tl.tracks.v1 as SeqClip[]).map((c) => [c.id, c]));
  const ids = Array.from(new Set(view.pieces.map((x) => x.videoId)));
  const rows = await prisma.footageAnalysis.findMany({ where: { videoId: { in: ids }, video: { userId } }, select: { videoId: true, vision: true } });
  const vis = new Map<string, { details: Awaited<ReturnType<typeof visionDetailsOf>> & object; turned: number }>();
  for (const r of rows) {
    const v = r.vision as unknown as VisionSummary | null;
    const d = v ? await visionDetailsOf(v).catch(() => null) : null;
    if (d) vis.set(r.videoId, { details: d, turned: v!.turned ?? 0 });
  }
  const boxes: Box[] = [];
  for (let k = 0; k < 9; k++) {
    const t = a + ((b - a) * (k + 0.5)) / 9;
    const box = vis.size ? faceOnScreenAt(t, { view, clips, W, H, vision: (id) => vis.get(id) ?? null }) : null;
    if (box) boxes.push(box as Box);
  }
  const med = (i: number) => { const v = boxes.map((x) => x[i]).sort((x, y) => x - y); return v[Math.floor(v.length / 2)]; };
  return { W, H, aspect: p.aspect, view, scope, face: boxes.length ? ([med(0), med(1), med(2), med(3)] as Box) : null, measured: vis.size > 0 };
}

/** "auto": where a library graphic goes, clear of the face (and of a tall frame's buttons, which place() keeps out of). */
function autoPosition(it: LibraryItem, face: Box | null): { position: string; why: string } {
  if (it.kind === "lower_third") {
    if (!face) return { position: "bottom-left", why: "no face measured there" };
    const left = Math.max(0, Math.min(face[2], 0.5) - face[0]) * Math.max(0, face[3] - 0.6), right = Math.max(0, face[2] - Math.max(face[0], 0.5)) * Math.max(0, face[3] - 0.6);
    return left > right ? { position: "bottom-right", why: "the face reaches the lower left" } : { position: "bottom-left", why: "clear of the face" };
  }
  if (!face) return { position: "center", why: "no face measured there" };
  const cy = (face[1] + face[3]) / 2;
  return cy < 0.5 || face[3] - face[1] > 0.6 ? { position: "bottom", why: `the face is in the ${cy < 0.5 ? "upper" : "middle"} part of the frame` } : { position: "top", why: "the face is in the lower half of the frame" };
}

type AddInput = { projectId: string; itemId: string; start?: number; end?: number; params?: Record<string, unknown>; edit?: boolean; note?: string };
type Apply = (edits: EditOp[], note: string | undefined) => Promise<{ text: string; data?: unknown }>;

/**
 * Places a library item. A graphic goes on V3 with its params (an "auto" position worked out now, from the face, so the
 * render and the editor draw the same place). An edits item becomes the explicit edits it names, said in the result.
 */
export async function addLibraryItem(userId: string, i: AddInput, apply: Apply): Promise<{ text: string; data?: unknown }> {
  const it = libraryItem(i.itemId);
  if (!it) throw notFound(`No library item "${i.itemId}". list_library shows them.`);
  const v = libraryParams(it, i.params ?? {});
  if ("error" in v) throw new AppError(`${v.error} Nothing was changed.`, 400, "invalid-input");
  const sent = { ...(i.params ?? {}) };
  await checkFont(userId, sent.font);
  const edit = i.edit ? { edit: true as const } : {};

  if (it.place === "graphic") {
    if (i.start == null) throw new AppError(`${it.name} needs start (and end; default start + ${it.durationSec}s).`, 400, "invalid-input");
    const end = i.end ?? i.start + it.durationSec;
    let where = "";
    if ("position" in it.paramsSchema.properties && (sent.position ?? it.paramsSchema.properties.position.default) === "auto") {
      const s = await faceIn(userId, i.projectId, ...editRange(i.start, end, i.edit, await viewOf(userId, i.projectId)));
      const a = autoPosition(it, s.face);
      sent.position = a.position;
      where = ` Position auto: ${a.position} (${a.why}${s.face ? `, face box ${s.face.map((x) => x.toFixed(2)).join(",")}` : ""}).`;
    }
    const op = { op: "add_graphic", graphicId: it.id, start: i.start, end, params: sent, label: it.name, ...edit } as EditOp;
    const r = await apply(withIcons([op]), i.note);
    return { text: `${r.text}${where}`, data: r.data };
  }

  const p = v.params;
  if (it.kind === "background") {
    const bg = it.id === "lib_bg_solid" ? { color: p.color } : it.id === "lib_bg_gradient" ? { gradient: { from: p.from, to: p.to, angle: p.angle } } : it.id === "lib_bg_blur" ? { blur: p.amount }
      : { pattern: { kind: it.id.replace("lib_bg_", ""), color: p.color, ink: p.ink, ...(p.size != null ? { size: p.size } : {}) } };
    const r = await apply([{ op: "set_background", ...bg } as EditOp], i.note);
    return { text: `${r.text} (${it.name}: set_background ${JSON.stringify(bg)}; it shows where V1 is framed smaller, cropped or rounded.)`, data: r.data };
  }

  if (it.kind === "transition") {
    if (i.start == null) throw new AppError(`${it.name} needs start: it goes on the cut nearest that time.`, 400, "invalid-input");
    const view = await viewOf(userId, i.projectId);
    const t = editRange(i.start, i.start, i.edit, view)[0];
    const cuts = view.clips.slice(1).filter((c) => c.pieces.length);
    if (!cuts.length) throw new AppError("This edit has one clip on V1: there is no cut for a transition. Split it first (split_clip) or add clips.", 400, "invalid-input");
    const near = cuts.reduce((b, c) => (Math.abs(c.start - t) < Math.abs(b.start - t) ? c : b));
    const type = ({ lib_tr_flash: "dip-white", lib_tr_dip: "dip-black", lib_tr_whip: "whip", lib_tr_zoom_punch: "zoom", lib_tr_slide: "slide" } as Record<string, string>)[it.id];
    const op = { op: "set_transition", clipId: near.id, type, duration: p.duration, ...(p.dir ? { dir: p.dir } : {}) } as EditOp;
    const r = await apply([op], i.note);
    return { text: `${r.text} (${it.name}: set_transition ${type} on the cut at edit ${near.start.toFixed(2)}s, before clip ${near.id}${Math.abs(near.start - t) > 0.05 ? `, the cut nearest ${t.toFixed(2)}s` : ""}.)`, data: r.data };
  }

  // Picture in picture: the V1 clips in the range drawn as a card around the face, made smaller and put in a corner.
  if (i.start == null || i.end == null) throw new AppError(`${it.name} needs start and end.`, 400, "invalid-input");
  let view = await viewOf(userId, i.projectId);
  const [a, b] = editRange(i.start, i.end, i.edit, view);
  if (!(b - a >= 0.2)) throw new AppError("That range is not in the edit (its footage is cut), or shorter than 0.2 s.", 400, "invalid-input");
  // Split V1 at the range's ends when they fall inside a clip (one version), then card and frame the clips in it.
  const splits: EditOp[] = [];
  for (const at of [a, b]) {
    const c = view.clips.find((x) => at > x.start + 0.05 && at < x.end - 0.05);
    if (c) splits.push({ op: "split_clip", track: "v1", clipId: c.id, at, edit: true } as EditOp);
  }
  let versions = 0;
  if (splits.length) {
    // Split at the end first: the clip id holding the start stays the same.
    await apply(splits.reverse(), undefined);
    versions++;
    view = await viewOf(userId, i.projectId);
  }
  const inside = view.clips.filter((c) => c.start >= a - 0.06 && c.end <= b + 0.06 && c.pieces.length).map((c) => c.id);
  if (!inside.length) throw new AppError("No V1 clip lies in that range after splitting.", 400, "invalid-input");
  const s = await faceIn(userId, i.projectId, a, b);
  const { W, H } = s;
  const f = s.face ?? [0.35, 0.2, 0.65, 0.55];
  const fh = (f[3] - f[1]) * H, cx = ((f[0] + f[2]) / 2) * W, cy = ((f[1] + f[3]) / 2) * H;
  const side = Math.min(W, H, fh * 2.6); // head and shoulders, square
  const L = Math.max(0, Math.min(W - side, cx - side / 2)), T = Math.max(0, Math.min(H - side, cy - side * 0.45));
  const crop = { left: r4(L / W), top: r4(T / H), right: r4(1 - (L + side) / W), bottom: r4(1 - (T + side) / H) };
  const target = Number(p.size) * H, scale = Math.max(0.25, Math.min(4, target / side));
  const margin = 0.04 * Math.min(W, H), tall = H > W * 1.2, corner = String(p.corner);
  // framed: X' = 0.5 + (X - 0.5) * scale + x (shares); the card's edges go `margin` in from the corner (a tall frame
  // keeps clear of the app's buttons at the bottom and top).
  const cardL = L / W, cardR = (L + side) / W, cardT = T / H, cardB = (T + side) / H;
  const right = corner.endsWith("right"), bottom = corner.startsWith("bottom");
  const wantX = right ? 1 - margin / W : margin / W, wantY = bottom ? 1 - (margin + (tall ? 0.16 * H : 0)) / H : (margin + (tall ? 0.1 * H : 0)) / H;
  const x = r4(wantX - 0.5 - ((right ? cardR : cardL) - 0.5) * scale), y = r4(wantY - 0.5 - ((bottom ? cardB : cardT) - 0.5) * scale);
  const card = {
    op: "set_card", clipIds: inside, crop, radius: it.id === "lib_pip_circle" ? 0.5 : Number(p.radius),
    border: Number(p.borderWidth) > 0 ? { color: String(p.border).toUpperCase(), width: Number(p.borderWidth) } : null,
    shadow: p.shadow ? {} : null,
  } as EditOp;
  const frame = { op: "set_framing", clipIds: inside, scale: r4(scale), x: Math.max(-1, Math.min(1, x)), y: Math.max(-1, Math.min(1, y)) } as EditOp;
  const ops: EditOp[] = [card, frame];
  const bgIn = p.background as Record<string, unknown> | null;
  if (bgIn && typeof bgIn === "object") ops.push({ op: "set_background", ...bgIn } as EditOp);
  const r = await apply(ops, i.note);
  versions++;
  return {
    text: `${r.text} (${it.name} over edit ${a.toFixed(2)}-${b.toFixed(2)}s: ${splits.length ? `split V1 at ${splits.length === 2 ? "both ends" : "one end"}, then ` : ""}set_card ${JSON.stringify({ crop, radius: (card as { radius: number }).radius })} and set_framing scale ${r4(scale)} x ${x} y ${y} on ${inside.join(", ")}; ${s.face ? "centred on the measured face" : "no face measured there: centred on the upper middle"}.${versions > 1 ? ` Made in ${versions} versions: undo with steps ${versions} to take it all back.` : ""})`,
    data: r.data,
  };
}

const r4 = (x: number) => Math.round(x * 10000) / 10000;
async function viewOf(userId: string, projectId: string) {
  return (await markScope(userId, { projectId })).view!;
}
/** Edit seconds of a range given in main-footage seconds (or already in edit seconds). */
function editRange(a: number, b: number, edit: boolean | undefined, view: Awaited<ReturnType<typeof viewOf>>): [number, number] {
  if (edit) return [a, b];
  const ea = view.videoToEdit(view.mainVideoId, a) ?? a, eb = view.videoToEdit(view.mainVideoId, b) ?? b;
  return [ea, Math.max(ea, eb)];
}
