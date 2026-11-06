import type { MetadataRoute } from "next";

// Lets people add Rendrr to a phone home screen or the Mac Dock (Safari: File > Add to Dock) with the Rendrr mark.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Rendrr",
    short_name: "Rendrr",
    description: "Edit videos with Claude.",
    start_url: "/projects",
    display: "standalone",
    background_color: "#0b0c0e",
    theme_color: "#0b0c0e",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
