import { ClerkProvider } from "@clerk/nextjs";
import type { Metadata, Viewport } from "next";
import ClientRoot from "./client-root";
import "../rendrr/styles.css";

export const metadata: Metadata = { title: "Rendrr" };
export const viewport: Viewport = { width: "device-width", initialScale: 1, viewportFit: "cover" };

// Every screen is the client app from ui/rendrr-ui.html. Each route file exists so the URL is real;
// the client root picks the screen from the path, exactly like the original ROUTES table.
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap" />
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
