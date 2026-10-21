"use client";
import { AuthenticateWithRedirectCallback } from "@clerk/nextjs";

// Google sign-in lands here, then Clerk sends the browser on to /home.
export default function SsoCallback() {
  return <AuthenticateWithRedirectCallback signInFallbackRedirectUrl="/home" signUpFallbackRedirectUrl="/home" />;
}
