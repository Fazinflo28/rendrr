import type { MetadataRoute } from "next";

// Google may read the public pages (Explore, login, the Mac download) and the icons: Claude shows the connector's icon
// from Google's saved favicon for rendrr.live, which Google takes from these pages. Private pages need a login anyway.
const SITE = (process.env.SITE_URL || "https://app.rendrr.live").replace(/\/$/, "");

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [{ userAgent: "*", allow: "/", disallow: ["/editor/", "/review/", "/desktop-login", "/drive-done", "/sso-callback", "/settings", "/usage", "/billing"] }],
    sitemap: `${SITE}/sitemap.xml`,
  };
}
