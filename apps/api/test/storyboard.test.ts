// Storyboard mode (create_storyboard, the editor's Storyboard): what Claude reads about a board (drawing, done, the
// style sheet, the rules, the panels and the user's changes placed on their panels, approved or not), and with a
// database: a board is a sample render holding its panels and board; the same board of the same version joins it
// (new words kept); a bad panel draws nothing; the editor's routes list, read and approve it; a comment with a drawing
// on a panel reaches Claude; boards are not listed as samples. The pure part always runs; the rest needs a database,
// Redis and storage (as in .env).
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { AppOpen, AppSamples, BoardStyle } from "@rendrr/shared";
import { storyboardOut } from "../src/services/storyboard";

const style: BoardStyle = {
  aspect: "9:16", seconds: 18, width: 540, height: 960,
  captions: { font: "Inter", weight: 700, size: 7.4, color: "#FFFFFF", highlight: "#34C759", stroke: "#000000", box: null, case: "upper", wordsAtOnce: 3, lines: 1, position: "bottom", animation: "3 words at a time, the spoken word lit in #34C759" },
  fonts: [{ font: "Inter", weight: 700, use: "captions" }, { font: "Poppins", weight: 600, use: "titles and text" }], texts: { count: 2, animations: ["pop"] },
  colors: [{ hex: "#34C759", name: "brand green, spoken word" }], look: "as shot", background: null, transitions: ["whip"], music: "1 track (m_lofi), 12 dB down under speech", sound: "cleanup studio", pacing: "4 cuts in 0:18 (13.3 a minute)",
};
const base: AppSamples = {
  renderId: "sb1", project: { id: "p1", name: "Launch", aspect: "9:16", version: 3, editorUrl: null }, version: 3, status: "done", percent: 100, step: null, etaSec: null, error: null,
  width: 540, height: 960, comments: [],
  items: [
    { kind: "frame", at: 0.5, end: null, note: null, still: "u0", clip: null, title: "Hook", caption: "Still downloading icons?", shot: "Close-up", onScreen: "STILL DOWNLOADING" },
    { kind: "clip", at: 6, end: 9, note: "Check the pace", still: "u1", clip: "c1", title: "Reveal", caption: null, shot: "UI zoom", onScreen: null },
  ],
  board: { title: "Fontora launch", rules: ["Captions 3 words at a time", "Green only for highlights"], palette: [{ hex: "#34C759", name: "brand green" }], style, status: "review", approvedAt: null, latestVersion: 3, url: "https://app.rendrr.live/editor/p1?storyboard=sb1" },
};
const comment = (id: string, time: number, text: string, extra: Record<string, unknown> = {}) => ({ id, time, text, author: "Ana", mine: true, resolved: false, at: 0, edited: false, renderId: "sb1", drawing: null, images: [], ...extra });

describe("what Claude reads about a storyboard", () => {
  it("done: the state, the link, the style sheet, the rules and the panels with their words", () => {
    const t = storyboardOut(base);
    assert.match(t, /^Storyboard "Fontora launch" of v3, 540x960, in review\. The user sees it at https:\/\/app\.rendrr\.live\/editor\/p1\?storyboard=sb1/);
    assert.match(t, /- Captions: Inter 700, 7\.4% of the short side, #FFFFFF outlined #000000, upper case, 1 line at the bottom; 3 words at a time, the spoken word lit in #34C759/);
    assert.match(t, /- Fonts: Inter 700 \(captions\); Poppins 600 \(titles and text\)/);
    assert.match(t, /Visual rules:\n- Captions 3 words at a time\n- Green only for highlights/);
    assert.match(t, /1\. frame 0:00\.5 "Hook" - says: Still downloading icons\? - on screen: STILL DOWNLOADING - shows: Close-up/);
    assert.match(t, /2\. clip 0:06\.0-0:09\.0 "Reveal" - shows: UI zoom - note: Check the pace/);
    assert.match(t, /No changes asked on it yet/);
    assert.match(t, /When the user approves it .* render_preview renders the whole video/);
  });
  it("the user's changes on their panels, a drawing said; approved; an older version; drawing; failed", () => {
    const t = storyboardOut({ ...base, comments: [comment("k1", 0.5, "Bigger hook", { drawing: { w: 540, h: 960, strokes: [{ c: "#ff3b30", w: 0.004, p: [0.1, 0.1, 0.5, 0.5] }] } }), comment("k2", 7.2, "Slower zoom"), comment("k3", 30, "Somewhere else")] });
    assert.match(t, /k1 \| panel 1 at 0:00\.5 \| Bigger hook \| drew on it/);
    assert.match(t, /k2 \| panel 2 at 0:07\.2 \| Slower zoom/);
    assert.match(t, /k3 \| 0:30\.0 at 0:30\.0 \| Somewhere else/);
    assert.match(t, /create_storyboard again/);
    const ok = storyboardOut({ ...base, board: { ...base.board!, status: "approved", approvedAt: Date.UTC(2026, 10, 22, 9, 30) } });
    assert.match(ok, /APPROVED by the user \(2026-11-22 09:30 UTC\)/);
    assert.match(ok, /The user approved it: render_preview renders the whole video/);
    assert.match(storyboardOut({ ...base, board: { ...base.board!, latestVersion: 5 } }), /the edit is at v5 now/);
    assert.match(storyboardOut({ ...base, status: "running", percent: 30, step: "Drawing the storyboard" }), /at 30% \(Drawing the storyboard\).*get_samples \{renderId: "sb1"/);
    assert.match(storyboardOut({ ...base, status: "queued", items: [] }), /Rendrr is picking its panels/);
    assert.match(storyboardOut({ ...base, status: "failed", error: "Sample 2 could not be rendered." }), /failed: Sample 2 could not be rendered/);
  });
});

const ready = !!process.env.DATABASE_URL && !!process.env.REDIS_URL && !!process.env.S3_BUCKET;
const run = Math.random().toString(36).slice(2, 8);

describe("storyboards in Rendrr", { skip: !ready && "needs DATABASE_URL, REDIS_URL and storage" }, async () => {
  const { prisma } = await import("@rendrr/db");
  const { stubTranscript, MCP_TOOLS, APP_TOOLS } = await import("@rendrr/shared");
  const { createProject } = await import("../src/services/projects");
  const { TOOL_HANDLERS } = await import("../src/tools");
  const { APP_HANDLERS } = await import("../src/services/claudeApp");
  const { approveStoryboard, latestBoardId, listStoryboards, startStoryboard, storyboardView } = await import("../src/services/storyboard");
  const { queue, redis } = await import("@rendrr/core");
  let userId = "", projectId = "";
  const c = () => ({ userId, ai: "claude" as const });
  const tool = (name: string, input: Record<string, unknown>) => TOOL_HANDLERS[name](c(), MCP_TOOLS.find((t) => t.name === name)!.input.parse(input));
  const app = (name: string, input: Record<string, unknown>) => APP_HANDLERS[name](c(), APP_TOOLS.find((t) => t.name === name)!.input.parse(input));
  before(async () => {
    userId = (await prisma.user.create({ data: { clerkId: `sbd_${run}`, email: `sbd-${run}@test.rendrr.dev`, name: "Ana" } })).id;
    await prisma.folder.create({ data: { userId, name: "Client", workspace: "Ana's Workspace" } });
    const analysis = { create: { transcriber: "stub", transcript: stubTranscript(20) as never, silences: [] as never, sceneCuts: [], keyFrames: [] } };
    const videoId = (await prisma.video.create({ data: { userId, name: `Talk ${run}`, seconds: 20, width: 1920, height: 1080, source: "drive", status: "ready", proxyKey: `proxies/${run}.mp4`, analysis } })).id;
    projectId = (await createProject(userId, { videoId, styleId: null })).id;
  });
  after(async () => {
    await prisma.render.deleteMany({ where: { userId } }).catch(() => {});
    await prisma.user.deleteMany({ where: { id: userId } }).catch(() => {});
    await queue("render").obliterate({ force: true }).catch(() => {});
    await redis().quit().catch(() => {});
  });

  it("create_storyboard holds its panels and board; the same board joins it with new words; a bad panel draws nothing", async () => {
    const out = await tool("create_storyboard", { projectId, title: "Launch board", panels: [{ at: 2, title: "Hook", caption: "Still downloading icons?" }, { at: 5, clip: true, title: "Reveal" }], rules: ["Captions centred"], palette: [{ hex: "#34c759", name: "brand green" }], images: false });
    const r = await prisma.render.findFirstOrThrow({ where: { projectId, kind: "sample" } });
    const sp = (r.plan as { samples: { items: unknown[]; board: Record<string, unknown> } }).samples;
    assert.deepEqual(sp.items, [{ kind: "frame", at: 2, title: "Hook", caption: "Still downloading icons?" }, { kind: "clip", at: 5, end: 9, title: "Reveal" }]);
    assert.deepEqual(sp.board, { title: "Launch board", rules: ["Captions centred"], palette: [{ hex: "#34C759", name: "brand green" }], status: "review" });
    assert.deepEqual(r.steps, ["Reading timeline", "Measuring loudness", "Drawing the storyboard", "Packing the board"]);
    assert.equal(r.by, "claude");
    assert.equal((out.data as { samples: { renderId: string; board: { title: string } } }).samples.board.title, "Launch board");
    await tool("create_storyboard", { projectId, title: "Launch board v2", panels: [{ at: 2, title: "Hook", caption: "Tired of icon packs?" }, { at: 5, clip: true, title: "Reveal" }], images: false });
    assert.equal(await prisma.render.count({ where: { projectId, kind: "sample" } }), 1, "the same panels join it");
    const j = ((await prisma.render.findUniqueOrThrow({ where: { id: r.id } })).plan as { samples: { items: { caption?: string }[]; board: { title: string; rules: string[] } } }).samples;
    assert.equal(j.items[0].caption, "Tired of icon packs?");
    assert.deepEqual([j.board.title, j.board.rules], ["Launch board v2", []]);
    const bad = await tool("create_storyboard", { projectId, panels: [{ at: 1, end: 9 }], images: false });
    assert.match(bad.text, /at most 6 s\. Nothing was drawn/);
    // Left to Rendrr: a board of its own (auto), not joined to the one with panels.
    const auto = await startStoryboard(userId, projectId, {}, null, "user");
    assert.notEqual(auto.id, r.id);
    assert.deepEqual((auto.plan as { samples: { items: unknown[]; board: { auto: boolean } } }).samples, { items: [], board: { title: (await prisma.project.findUniqueOrThrow({ where: { id: projectId } })).name, rules: [], palette: [], auto: true, status: "review" } });
    // Boards are not listed as samples; they are listed as boards, newest first.
    const boards = await listStoryboards(userId, projectId);
    assert.deepEqual(boards.map((b) => b.renderId), [auto.id, r.id]);
  });

  it("a drawn change on a panel reaches Claude with the panel; approving needs a finished board and shows in what Claude reads", async () => {
    const r = await prisma.render.findFirstOrThrow({ where: { projectId, kind: "sample" }, orderBy: { createdAt: "asc" } });
    await assert.rejects(approveStoryboard(userId, r.id), /still being drawn/);
    const sp = (r.plan as { samples: { items: Record<string, unknown>[]; board: Record<string, unknown> } }).samples;
    await prisma.render.update({ where: { id: r.id }, data: { status: "done", framesKeys: [`previews/${run}-s0.jpg`], plan: { samples: { ...sp, done: [{ ...sp.items[0], still: `previews/${run}-s0.jpg` }, { ...sp.items[1], still: `previews/${run}-s1.jpg`, clip: `previews/${run}-c1.mp4` }], width: 540, height: 960, board: { ...sp.board, style: { aspect: "16:9", seconds: 20, width: 960, height: 540, captions: null, fonts: [], texts: { count: 0, animations: [] }, colors: [], look: "as shot", background: null, transitions: [], music: "none", sound: "cleanup none", pacing: "0 cuts" } } } } as never } });
    await app("app_add_comment", { projectId, time: 2, text: "Make the hook pop", renderId: r.id });
    const v = await storyboardView(userId, r.id);
    assert.equal(v.board?.status, "review");
    assert.equal(v.items[0].title, "Hook");
    assert.equal(v.comments[0].text, "Make the hook pop");
    const g = await tool("get_samples", { renderId: r.id, images: false });
    assert.match(g.text, /Storyboard "Launch board v2" of v\d+, 540x960, in review/);
    assert.match(g.text, /\| panel 1 at 0:02\.0 \| Make the hook pop/);
    assert.match(g.text, /- Captions: off/);
    const ok = await app("app_approve_storyboard", { renderId: r.id });
    assert.equal((ok.data as AppSamples).board?.status, "approved");
    assert.match((await tool("get_samples", { renderId: r.id, images: false })).text, /APPROVED by the user.*\n[\s\S]*The user approved it: render_preview/);
    const back = await approveStoryboard(userId, r.id, false);
    assert.equal(back.board?.status, "review");
    await assert.rejects(storyboardView(userId, (await prisma.render.create({ data: { projectId, userId, kind: "sample", version: 1, status: "done", steps: [], plan: { samples: { items: [] } } as never } })).id), /not a storyboard/);
  });

  it("Claude shows a storyboard again in the chat: open_projects renderId, or storyboard with the edit; get_project names the newest", async () => {
    const first = await prisma.render.findFirstOrThrow({ where: { projectId, kind: "sample" }, orderBy: { createdAt: "asc" } });
    const shown = await tool("open_projects", { renderId: first.id });
    assert.match(shown.text, /^Showing the storyboard "Launch board v2" of "[^"]+" \([^)]+\) in the Rendrr app: 2 panels, in review, 1 change asked\. The user can look at each one, ask a change on it, approve it and render the video there\./);
    assert.equal((shown.data as AppOpen).samples?.renderId, first.id, "the app opens the board");
    const newest = await latestBoardId(userId, projectId);
    assert.ok(newest && newest !== first.id, "the board left to Rendrr is the newest");
    assert.equal(((await tool("open_projects", { projectId, storyboard: true })).data as AppOpen).samples?.renderId, newest);
    // A storyboard's id given as the edit's opens it too.
    assert.equal(((await tool("open_projects", { projectId: first.id })).data as AppOpen).samples?.renderId, first.id);
    assert.match((await tool("get_project", { projectId })).text, new RegExp(`\\nStoryboard: ${newest} "[^"]+" \\(v\\d+, 0 panels, being drawn\\)\\. open_projects renderId shows it to the user again`));
    const none = await tool("open_projects", { renderId: "nope" });
    assert.match(none.text, /No storyboard or samples have the id "nope"/);
    assert.equal((none.data as AppOpen).samples ?? null, null, "the list instead");
  });
});
