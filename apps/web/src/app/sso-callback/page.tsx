"use client";
import { AuthenticateWithRedirectCallback } from "@clerk/nextjs";

// Clerk's Google sign-in lands here, then Clerk sends the browser on to /home. With Supabase Auth (no Clerk loaded)
// Google comes back to /auth/callback instead, so this page has nothing to do.
const SUPABASE_AUTH = (process.env.NEXT_PUBLIC_AUTH_PROVIDER || "").toLowerCase() === "supabase" && !!process.env.NEXT_PUBLIC_SUPABASE_URL && !!process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

export default function SsoCallback() {
  if (SUPABASE_AUTH) return null;
  return <AuthenticateWithRedirectCallback signInFallbackRedirectUrl="/home" signUpFallbackRedirectUrl="/home" />;
}
