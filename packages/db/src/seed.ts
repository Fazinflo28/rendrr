// Seeds built-in content. Safe to run on every deploy: everything is an upsert.
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
  // Example videos for Explore and Create: up to two per built-in style, posted by Rendrr itself (no made-up people or counts).
  const rendrr = await prisma.user.upsert({ where: { clerkId: "system:rendrr" }, create: { clerkId: "system:rendrr", email: "", name: "Rendrr" }, update: {} });
  let examples = 0;
  for (const s of STYLES) {
    for (const [k, ori] of s.ori.slice(0, 2).entries()) {
      const id = `example-${s.id}-${k + 1}`;
      const data = { userId: rendrr.id, author: "Rendrr", title: `${s.name} example (${ori})`, styleId: s.id, ori, platforms: s.platforms.slice(0, 2), allowRecreate: true, recipe: { styleId: s.id, aspect: ori, example: true } };
      await prisma.galleryItem.upsert({ where: { id }, create: { id, ...data }, update: data });
      examples++;
    }
  }
  return { styles: STYLES.length, graphics: GRAPHIC_TEMPLATES.length, examples };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  seed().then((r) => { console.log("seeded", r); return prisma.$disconnect(); }).catch((e) => { console.error(e); process.exit(1); });
}
