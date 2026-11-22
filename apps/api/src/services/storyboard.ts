// Storyboard mode (create_storyboard, the editor's Storyboard): a set of samples with a board. Its panels are frames and
// short clips drawn as the export draws them, each with its words; the worker reads the edit's style sheet as it draws
// them. The user comments on a panel or draws on it (comments on this render at the panel's edit time), and approves
// the board; then the whole video is rendered.
import { AppError, enqueue, publishRender, type RenderJob } from "@rendrr/core";
import { prisma, type Render } from "@rendrr/db";
import { boardPanelsText, boardStyleText, panelOf, sampleClock, SampleError, STORYBOARD_STEPS, storyboardItems, type AppComment, type AppSamples, type Board, type BoardPanel, type SamplePlan, type StoryboardRequest } from "@rendrr/shared";
import { getOwnedProject } from "./projects";
import { samplesView } from "./samples";
import { storedDrawing } from "./commentMedia";
import { stillsFor } from "./frames";

const words = (xs: BoardPanel[]) => JSON.stringify(xs.map(({ kind, at, end }) => [kind, at, end ?? null]));
const planOf = (r: Pick<Render, "plan">) => (r.plan as { samples?: SamplePlan } | null)?.samples;

/**
 * Starts a storyboard of the edit's latest version. The same board of the same version already drawing or drawn (the
 * same panels, or both left to Rendrr) is joined, with the new words, title, rules and palette, instead of drawn again.
 */
export async function startStoryboard(userId: string, projectId: string, req: StoryboardRequest, target: string | null = null, by: string | null = null): Promise<Render> {
  const p = await getOwnedProject(userId, projectId);
  const video = await prisma.video.findUniqueOrThrow({ where: { id: p.videoId } });
  if (!video.proxyKey || video.status === "expired") throw new AppError("The preview copy of this footage expired. Rebuild it from your Library, then make the storyboard again.", 409, "expired");
  let items: BoardPanel[];
  try { items = req.panels?.length ? storyboardItems(req.panels, p.outputSeconds || 24 * 3600) : []; } catch (e) { if (e instanceof SampleError) throw new AppError(e.message, 400, "storyboard"); throw e; }
  const board: Board = { title: (req.title || p.name).slice(0, 120), rules: req.rules ?? [], palette: (req.palette ?? []).map((c) => ({ hex: c.hex.toUpperCase(), name: c.name || "palette" })), ...(items.length ? {} : { auto: true }), status: "review" };
  const made = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"samples:" + projectId}))`;
    const latest = await tx.projectVersion.findFirst({ where: { projectId }, orderBy: { v: "desc" }, select: { v: true, updatedAt: true } });
    const version = latest?.v ?? p.currentVersion;
    const since = latest?.updatedAt ?? new Date(0);
    const near = await tx.render.findMany({ where: { projectId, kind: "sample", version, status: { in: ["queued", "running", "done"] }, createdAt: { gt: since } }, orderBy: { createdAt: "desc" }, take: 10 });
    for (const r of near) {
      const sp = planOf(r);
      if (!sp?.board || !!sp.board.auto !== !!board.auto) continue;
      if (!board.auto && words(sp.items) !== words(items)) continue;
      if (r.status === "done" && !((r.framesKeys as string[]) || []).length) continue; // its files were cleaned up
      if (r.status !== "done" && r.status !== "running" && r.status !== "queued") continue;
      const keepWords = <T extends BoardPanel>(xs: T[]) => (board.auto ? xs : xs.map((x, k) => { const y = { ...x }; for (const w of ["title", "caption", "shot", "note"] as const) { if (items[k][w] != null) y[w] = items[k][w]; else delete y[w]; } return y; }));
      const next: SamplePlan = { ...sp, items: keepWords(sp.items), ...(sp.done ? { done: keepWords(sp.done) } : {}), board: { ...sp.board, title: board.title, rules: board.rules, palette: board.palette } };
      await tx.render.update({ where: { id: r.id }, data: { plan: { ...(r.plan as object), samples: next } as never } });
      return { joined: await tx.render.findUniqueOrThrow({ where: { id: r.id } }) };
    }
    const steps = [...STORYBOARD_STEPS];
    return { made: await tx.render.create({ data: { projectId, userId, kind: "sample", version, status: "queued", steps, quality: "540p", target, ...(by ? { by } : {}), plan: { samples: { items, board } } as never } }), steps };
  }, { timeout: 15_000, maxWait: 10_000 });
  if ("joined" in made && made.joined) return made.joined;
  const { made: r, steps } = made as { made: Render; steps: string[] };
  await publishRender(r.id, { status: "queued", step: 0, steps, percent: 0 });
  await enqueue<RenderJob>("render", { renderId: r.id }, { jobId: r.id });
  return r;
}

/** A storyboard for the app and the editor (its samples' view with the board). */
export async function storyboardView(userId: string, renderId: string): Promise<AppSamples> {
  const v = await samplesView(userId, renderId);
  if (!v.board) throw new AppError("That is a set of samples, not a storyboard.", 404, "not-found");
  return v;
}

/** The edit's latest storyboards, newest first. */
export async function listStoryboards(userId: string, projectId: string, take = 4): Promise<AppSamples[]> {
  const p = await getOwnedProject(userId, projectId);
  const rs = await prisma.render.findMany({ where: { projectId: p.id, kind: "sample", status: { in: ["queued", "running", "done"] } }, orderBy: { createdAt: "desc" }, take: 24, select: { id: true, plan: true } });
  const boards = rs.filter((r) => planOf(r)?.board).slice(0, take);
  return Promise.all(boards.map((r) => samplesView(userId, r.id)));
}

/** The edit's newest storyboard still there (drawing or drawn), or null. */
export async function latestBoardId(userId: string, projectId: string): Promise<string | null> {
  const rs = await prisma.render.findMany({ where: { projectId, userId, kind: "sample", status: { in: ["queued", "running", "done"] } }, orderBy: { createdAt: "desc" }, take: 12, select: { id: true, plan: true } });
  return rs.find((r) => planOf(r)?.board)?.id ?? null;
}

/** A line for get_project: the edit's newest storyboard, and how to show it to the user again. */
export async function boardLine(userId: string, projectId: string): Promise<string | null> {
  const rs = await prisma.render.findMany({ where: { projectId, userId, kind: "sample", status: { in: ["queued", "running", "done"] } }, orderBy: { createdAt: "desc" }, take: 12, select: { id: true, plan: true, version: true, status: true } });
  const r = rs.find((x) => planOf(x)?.board);
  const b = r ? planOf(r)!.board! : null;
  if (!r || !b) return null;
  const n = (planOf(r)!.done ?? planOf(r)!.items ?? []).length;
  return `Storyboard: ${r.id} "${b.title}" (v${r.version}, ${n} panels, ${r.status === "done" ? (b.status === "approved" ? "approved" : "in review") : "being drawn"}). open_projects renderId shows it to the user again; get_samples reads it with their changes.`;
}

/** The user approves the board (or takes the approval back). Only a finished board can be approved. */
export async function approveStoryboard(userId: string, renderId: string, approved = true): Promise<AppSamples> {
  await prisma.$transaction(async (tx) => {
    const r = await tx.render.findUnique({ where: { id: renderId } });
    if (!r || r.userId !== userId || r.kind !== "sample" || !planOf(r)?.board) throw new AppError("That storyboard is gone.", 404, "not-found");
    if (approved && r.status !== "done") throw new AppError("The storyboard is still being drawn: approve it once it is done.", 409, "storyboard");
    const sp = planOf(r)!;
    await tx.render.update({ where: { id: r.id }, data: { plan: { ...(r.plan as object), samples: { ...sp, board: { ...sp.board!, status: approved ? "approved" : "review", approvedAt: approved ? Date.now() : null } } } as never } });
  });
  return storyboardView(userId, renderId);
}

/** The board as Claude reads it: its state, the style sheet, the rules, the panels and the user's changes on each. */
export function storyboardOut(v: AppSamples): string {
  const b = v.board!;
  const items: BoardPanel[] = v.items.map((x) => ({ kind: x.kind, at: x.at, ...(x.end != null ? { end: x.end } : {}), ...(x.note ? { note: x.note } : {}), ...(x.title ? { title: x.title } : {}), ...(x.caption ? { caption: x.caption } : {}), ...(x.shot ? { shot: x.shot } : {}), ...(x.onScreen ? { onScreen: x.onScreen } : {}) }));
  const head = `Storyboard "${b.title}" of v${v.version}`;
  if (v.status === "failed") return `${head} failed: ${v.error}`;
  if (v.status !== "done") return `${head} is ${v.status === "queued" ? "queued" : `at ${v.percent}% (${v.step ?? "starting"})`} (render id ${v.renderId}). get_samples {renderId: "${v.renderId}", wait_seconds: 60} waits for it.${items.length ? `\nPanels:\n${boardPanelsText(items)}` : " Rendrr is picking its panels."}`;
  const state = b.status === "approved" ? `APPROVED by the user${b.approvedAt ? ` (${new Date(b.approvedAt).toISOString().slice(0, 16).replace("T", " ")} UTC)` : ""}` : "in review";
  const stale = b.latestVersion > v.version ? `; the edit is at v${b.latestVersion} now, so this board shows it before the later changes` : "";
  const open = v.comments.filter((c) => !c.resolved);
  const where = (c: AppComment) => { const k = panelOf(items, c.time); return k >= 0 ? `panel ${k + 1}` : sampleClock(c.time); };
  const ink = (c: AppComment) => (c.drawing ? " | drew on it (images true shows the drawing on the panel)" : "") + (c.images?.length ? ` | ${c.images.length} ${c.images.length === 1 ? "picture" : "pictures"}` : "");
  const changes = open.length
    ? `\nThe user's changes (comment id | panel | text | what it carries):\n${open.map((c) => `${c.id} | ${where(c)} at ${sampleClock(c.time)} | ${c.text.replace(/\s+/g, " ").slice(0, 600) || "(no words)"}${ink(c)}`).join("\n")}\nMake them in one apply_edits, then create_storyboard again (the board of the new version), and resolve_comment each.`
    : "\nNo changes asked on it yet.";
  const next = b.status === "approved" ? "\nThe user approved it: render_preview renders the whole video (render_final when they ask for the export)." : "\nWhen the user approves it (in Rendrr, or by saying so), render_preview renders the whole video.";
  return [
    `${head}, ${v.width}x${v.height}, ${state}${stale}. The user sees it at ${b.url ?? "the editor's Storyboard"} and in the chat.`,
    ...(b.style ? ["Style sheet (read from the edit):", ...boardStyleText(b.style).map((l) => `- ${l}`)] : []),
    ...(b.rules.length ? ["Visual rules:", ...b.rules.map((r) => `- ${r}`)] : []),
    `Panels (edit seconds):\n${boardPanelsText(items)}`,
  ].join("\n") + changes + next;
}

/** The pictures Claude gets with a board: each open comment's drawing on its panel, then the panels (at most 12 in all). */
export async function storyboardImages(userId: string, v: AppSamples): Promise<{ urls: string[]; said: string[] }> {
  const r = await prisma.render.findUnique({ where: { id: v.renderId }, select: { plan: true } });
  const sp = r ? planOf(r) : undefined;
  const done = sp?.done ?? [];
  const items: BoardPanel[] = v.items.map((x) => ({ kind: x.kind, at: x.at, ...(x.end != null ? { end: x.end } : {}) }));
  const urls: string[] = [], said: string[] = [];
  const notes = await prisma.projectComment.findMany({ where: { renderId: v.renderId, userId, resolved: false }, orderBy: { createdAt: "asc" }, take: 50 });
  const drawn = notes.flatMap((n) => { const d = storedDrawing(n), k = panelOf(items, n.time); return d?.key && k >= 0 && done[k]?.still ? [{ n, k, key: done[k].still, overlay: d.key }] : []; }).slice(0, 4);
  if (drawn.length) {
    const got = await stillsFor(v.renderId, drawn.map((x) => ({ key: x.key, overlay: x.overlay }))).catch(() => [] as string[]);
    got.forEach((u, i) => { urls.push(u); said.push(`${urls.length}. comment ${drawn[i].n.id}: panel ${drawn[i].k + 1} with the user's drawing`); });
  }
  for (const [k, x] of v.items.entries()) {
    if (urls.length >= 12) break;
    if (x.still) { urls.push(x.still); said.push(`${urls.length}. panel ${k + 1}${x.kind === "clip" ? " (the clip's first frame)" : ""}`); }
  }
  return { urls, said };
}
