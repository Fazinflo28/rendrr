import type { MetadataRoute } from "next";

// The public pages, so Google visits them (and picks up the Rendrr icon) sooner.
const SITE = (process.env.SITE_URL || "https://app.rendrr.live").replace(/\/$/, "");

export default function sitemap(): MetadataRoute.Sitemap {
  const now = new Date();
  return [
    { url: `${SITE}/`, lastModified: now, changeFrequency: "weekly", priority: 1 },
    { url: `${SITE}/explore`, lastModified: now, changeFrequency: "daily", priority: 0.8 },
    { url: `${SITE}/pricing`, lastModified: now, changeFrequency: "weekly", priority: 0.7 },
    { url: `${SITE}/login`, lastModified: now, changeFrequency: "monthly", priority: 0.5 },
  ];
}
