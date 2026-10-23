import { deleteObjects, deletePrefix } from "@rendrr/core";
import { prisma } from "@rendrr/db";
import { PREFIX } from "@rendrr/shared";
import { purgeProjectFiles } from "./projects";

/**
 * Removes demo footage left from before Google Drive was set up: videos added from the fake Drive (they point at
 * Rendrr's built-in sample files) and the built-in sample footage, with their files, plus the fake Drive
 * connections. A video an edit still uses is kept, so no edit breaks. Runs at start; finds nothing once done.
 */
export async function removeDemoFootage() {
  const demo = await prisma.video.findMany({ where: { OR: [{ sample: true }, { source: "drive", sourceKey: { not: null } }] }, include: { analysis: true } });
  let removed = 0, kept = 0;
  for (const v of demo) {
    if (await prisma.project.count({ where: { videoId: v.id, deletedAt: null } })) { kept++; continue; }
    await deleteObjects([v.proxyKey, v.audioKey, v.thumbKey, ...(((v.analysis?.keyFrames as { key: string }[]) || []).map((k) => k.key))]);
    await deletePrefix(`${PREFIX.frames}${v.userId}/${v.id}/`);
    await purgeProjectFiles({ videoId: v.id });
    await prisma.project.deleteMany({ where: { videoId: v.id } });
    await prisma.video.delete({ where: { id: v.id } });
    removed++;
  }
  const drives = await prisma.driveConnection.deleteMany({ where: { stub: true } });
  return { removed, kept, fakeDriveConnections: drives.count };
}
