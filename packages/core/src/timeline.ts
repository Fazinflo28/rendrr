import { prisma, type Prisma } from "@rendrr/db";
import {
  allWords, applyOp, EditError, GRAPHIC_TEMPLATES, outputDuration, StyleRulesSchema, TimelineSchema,
  type Actor, type EditContext, type Op, type Silence, type Snapshot, type StyleLite, type Timeline, type Transcript,
} from "@rendrr/shared";
import { AppError, notFound } from "./errors";
import { publishProject } from "./queue";

// ---------------------------------------------------------------------------------------------
// applyTimelineChange: the ONLY code path that writes a project's timeline.
// Validates, saves a version, logs an ai_action when the actor is an AI, notifies open editors.
// ---------------------------------------------------------------------------------------------

export type ChangeActor = {
  kind: Actor;               // user | claude | chatgpt | rendrr
  userId: string;            // owner of the project (Rendrr user id)
  ai?: string;               // display name for the activity feed: "Claude", "ChatGPT", "Rendrr"
  via?: "chat";              // the change was asked for in the editor's AI chat
  toolName?: string;         // MCP tool or UI action name
  input?: unknown;           // tool input, stored on ai_actions
};
export type ChangeResult = { projectId: string; version: number; summary: string; snapshot: Snapshot; createdVersion: boolean; unchanged?: boolean };

const COALESCE_MS = 10 * 60_000;
const isAi = (k: Actor) => k === "claude" || k === "chatgpt";

export function displayAi(kind: Actor, fallback?: string) {
  return kind === "claude" ? "Claude" : kind === "chatgpt" ? "ChatGPT" : kind === "rendrr" ? "Rendrr" : fallback || "You";
}

/** Everything the pure editing ops need to know about a project's footage. */
export async function editContext(tx: Prisma.TransactionClient, userId: string, videoId: string): Promise<EditContext> {
  const video = await tx.video.findUnique({ where: { id: videoId }, include: { analysis: true } });
  if (!video) throw notFound("The footage for this edit is gone.");
  const styles = await tx.style.findMany({ where: { OR: [{ ownerId: null }, { ownerId: userId }] } });
  const styleMap = new Map<string, StyleLite>(styles.map((s) => [s.id, { id: s.id, name: s.name, captionLook: s.captionLook as StyleLite["captionLook"], rules: StyleRulesSchema.parse(s.rules) }]));
  const videos = await tx.video.findMany({ where: { userId }, select: { id: true, name: true, seconds: true, status: true } });
  const graphics = await tx.graphic.findMany({ where: { OR: [{ ownerId: null }, { ownerId: userId }] }, select: { id: true, name: true, durationSec: true, status: true } });
  return {
    transcript: (video.analysis?.transcript as unknown as Transcript) || [],
    silences: (video.analysis?.silences as unknown as Silence[]) || [],
    sceneCuts: (video.analysis?.sceneCuts as unknown as number[]) || [],
    duration: video.seconds,
    getStyle: (id) => styleMap.get(id),
    getVideo: (id) => { const v = videos.find((x) => x.id === id); return v ? { id: v.id, name: v.name, seconds: v.seconds, ready: v.status === "ready" } : undefined; },
    getGraphic: (id) => {
      const g = graphics.find((x) => x.id === id) || GRAPHIC_TEMPLATES.find((x) => x.id === id);
      if (!g || ("status" in g && g.status === "failed")) return undefined;
      return { id: g.id, name: g.name, durationSec: g.durationSec };
    },
  };
}

export function snapshotOf(p: { timeline: unknown; name: string; aspect: string; styleId: string }): Snapshot {
  return { timeline: TimelineSchema.parse(p.timeline) as Timeline, name: p.name, aspect: p.aspect as Snapshot["aspect"], styleId: p.styleId };
}

/** Key order does not matter (Postgres JSON reorders keys); everything else must match. */
function stable(v: unknown): string {
  if (Array.isArray(v)) return "[" + v.map(stable).join(",") + "]";
  if (v && typeof v === "object") return "{" + Object.keys(v).filter((k) => (v as Record<string, unknown>)[k] !== undefined).sort().map((k) => JSON.stringify(k) + ":" + stable((v as Record<string, unknown>)[k])).join(",") + "}";
  return JSON.stringify(v) ?? "null";
}
const sameSnapshot = (a: Snapshot, b: Snapshot) => stable(a) === stable(b);

export async function applyTimelineChange(projectId: string, change: Op, actor: ChangeActor, opts: { baseVersion?: number } = {}): Promise<ChangeResult> {
  const result = await prisma.$transaction(async (tx) => {
    // Lock the project row so two writers (the editor and an AI) never interleave.
    await tx.$executeRaw`SELECT 1 FROM "Project" WHERE id = ${projectId} FOR UPDATE`;
    const p = await tx.project.findUnique({ where: { id: projectId } });
    if (!p || p.deletedAt) throw notFound("We could not find that project.");
    if (p.userId !== actor.userId) throw notFound("We could not find that project.");

    // The editor's autosave sends the whole timeline. If an AI changed it since the editor loaded, refuse:
    // the editor reloads and shows the AI's change instead of silently overwriting it.
    if (change.op === "replace" && opts.baseVersion != null && opts.baseVersion < p.currentVersion) {
      const newer = await tx.projectVersion.findFirst({ where: { projectId, v: { gt: opts.baseVersion }, createdBy: { not: "user" } } });
      if (newer) throw new AppError(`${displayAi(newer.createdBy as Actor)} just changed this edit. Loading the new version.`, 409, "stale", { version: p.currentVersion });
    }

    const ctx = await editContext(tx, p.userId, p.videoId);
    let out: { snap: Snapshot; summary: string };
    try {
      out = applyOp(snapshotOf(p), change, ctx);
    } catch (e) {
      if (e instanceof EditError) throw new AppError(e.message, 400, "invalid-edit");
      throw e;
    }

    // Nothing changed (an AI op with nothing to do, or an autosave of what is already saved): no new version.
    if (sameSnapshot(out.snap, snapshotOf(p))) return { projectId, version: p.currentVersion, summary: out.summary, snapshot: out.snap, createdVersion: false, unchanged: true };

    const latest = await tx.projectVersion.findFirst({ where: { projectId }, orderBy: { v: "desc" } });
    const prevV = p.currentVersion;
    const coalesce = actor.kind === "user" && change.op === "replace" && latest && latest.createdBy === "user" && !latest.sealed && Date.now() - latest.updatedAt.getTime() < COALESCE_MS;
    let v: number;
    if (coalesce && latest) {
      await tx.projectVersion.update({ where: { id: latest.id }, data: { timeline: out.snap as unknown as Prisma.InputJsonValue } });
      v = latest.v;
    } else {
      if (latest && !latest.sealed) await tx.projectVersion.update({ where: { id: latest.id }, data: { sealed: true } });
      v = (latest?.v ?? 0) + 1;
      const note = actor.kind === "user" ? (change.op === "replace" ? "Your edits" : out.summary.charAt(0).toUpperCase() + out.summary.slice(1)) : `${displayAi(actor.kind)}: ${out.summary}`;
      await tx.projectVersion.create({ data: { projectId, v, note: note.slice(0, 300), timeline: out.snap as unknown as Prisma.InputJsonValue, createdBy: actor.kind, sealed: isAi(actor.kind) } });
    }
    await tx.project.update({
      where: { id: projectId },
      data: { timeline: out.snap.timeline as unknown as Prisma.InputJsonValue, name: out.snap.name, aspect: out.snap.aspect, styleId: out.snap.styleId, currentVersion: v,
        outputSeconds: Math.round(outputDuration(out.snap.timeline, allWords(ctx.transcript)) * 100) / 100 },
    });
    if (actor.kind !== "user") {
      await tx.aiAction.create({
        data: { projectId, userId: p.userId, ai: displayAi(actor.kind, actor.ai), text: out.summary.slice(0, 500), toolName: actor.toolName || change.op, input: ((actor.input ?? { op: change.op }) as Prisma.InputJsonValue), via: actor.via ?? null, beforeVersion: prevV, afterVersion: v },
      });
    }
    return { projectId, version: v, summary: out.summary, snapshot: out.snap, createdVersion: !coalesce };
  }, { timeout: 20_000, maxWait: 10_000 });

  if (!result.unchanged && (actor.kind !== "user" || result.createdVersion)) {
    await publishProject(projectId, { version: result.version, by: actor.kind, text: result.summary }).catch(() => {});
  }
  return result;
}

/**
 * Puts a project back to an earlier version, as a new version (nothing is ever lost). `keepName` keeps the edit's
 * current name (a manual "Restore this version" is about the edit, not its title); undoing an AI action restores all.
 */
export async function restoreVersion(projectId: string, v: number, actor: ChangeActor, note?: string, opts: { keepName?: boolean } = {}) {
  const ver = await prisma.projectVersion.findUnique({ where: { projectId_v: { projectId, v } } });
  if (!ver) throw notFound(`Version ${v} does not exist.`);
  let snap = ver.timeline as unknown as Snapshot;
  if (opts.keepName) {
    const p = await prisma.project.findUnique({ where: { id: projectId }, select: { name: true } });
    if (p) snap = { ...snap, name: p.name };
  }
  return applyTimelineChange(projectId, { op: "restore_snapshot", snapshot: snap, note: note || `restored version ${v}` }, actor);
}

/**
 * Seals the newest version so the next autosave starts a new one (after a render or a share).
 * Takes the same row lock as applyTimelineChange, so an autosave can never change a version after it was sealed.
 */
export async function sealLatestVersion(projectId: string) {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT 1 FROM "Project" WHERE id = ${projectId} FOR UPDATE`;
    const latest = await tx.projectVersion.findFirst({ where: { projectId }, orderBy: { v: "desc" } });
    if (latest && !latest.sealed) await tx.projectVersion.update({ where: { id: latest.id }, data: { sealed: true } });
    return latest?.v ?? 1;
  }, { timeout: 10_000, maxWait: 10_000 });
}
