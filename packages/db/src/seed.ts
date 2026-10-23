// Seeds built-in content (styles, graphic templates). Safe to run on every deploy: everything is an upsert.
import { GRAPHIC_TEMPLATES, STYLES } from "@rendrr/shared";
import { prisma } from "./index";

export async function seed() {
  for (const [i, s] of STYLES.entries()) {
    const data = { name: s.name, type: s.type, vibe: s.vibe, ori: s.ori, platforms: s.platforms, captionLook: s.captionLook, cutPace: s.cutPace, captionRule: s.captionRule, zoomRules: s.zoomRules, musicVibe: s.musicVibe, rules: s.rules, art: s.art, sortOrder: i };
    await prisma.style.upsert({ where: { id: s.id }, create: { id: s.id, ownerId: null, ...data }, update: data });
  }
  for (const t of GRAPHIC_TEMPLATES) {
    const data = { name: t.name, kind: "template", paramsSchema: t.paramsSchema as object, durationSec: t.durationSec, transparent: t.transparent, status: "ready" };
    await prisma.graphic.upsert({ where: { id: t.id }, create: { id: t.id, ownerId: null, ...data }, update: data });
  }
  // No example content: Explore shows only videos people publish. Earlier deploys posted example videos as a
  // "Rendrr" user; they are removed here (their likes go with them).
  const removed = await prisma.galleryItem.deleteMany({ where: { id: { startsWith: "example-" } } });
  await prisma.user.deleteMany({ where: { clerkId: "system:rendrr" } });
  return { styles: STYLES.length, graphics: GRAPHIC_TEMPLATES.length, examplesRemoved: removed.count };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  seed().then((r) => { console.log("seeded", r); return prisma.$disconnect(); }).catch((e) => { console.error(e); process.exit(1); });
}
