import { ClerkProvider } from "@clerk/nextjs";
import type { Metadata, Viewport } from "next";
import ClientRoot from "./client-root";
import "../rendrr/styles.css";

// The tab icon, Apple icon and manifest come from icon.svg, favicon.ico, apple-icon.png and manifest.ts in this folder.
export const metadata: Metadata = { title: "Rendrr", applicationName: "Rendrr", appleWebApp: { title: "Rendrr", statusBarStyle: "black-translucent" } };
export const viewport: Viewport = { width: "device-width", initialScale: 1, viewportFit: "cover", themeColor: "#0b0c0e" };

// Every screen is the client app from ui/rendrr-ui.html. Each route file exists so the URL is real;
// the client root picks the screen from the path, exactly like the original ROUTES table.
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* A square PNG at a multiple of 48 px, the size Google's favicon rules ask for (it shows next to Rendrr in
            Google and in Claude's connector list, which takes Google's saved favicon). */}
        <link rel="icon" href="/icons/icon-192.png" type="image/png" sizes="192x192" />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Space+Grotesk:wght@700&display=swap" />
      </head>
      <body>
        <ClerkProvider publishableKey={process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY} signInUrl="/login" signUpUrl="/login" afterSignOutUrl="/explore">
          <ClientRoot />
          {children}
        </ClerkProvider>
      </body>
    </html>
  );
}
