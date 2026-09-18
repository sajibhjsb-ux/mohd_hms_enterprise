"use client";
// SCREEN 1 — Welcome / authentication entry.
// Brand moment + the providers this application actually supports.
// (Google OAuth and email credentials; WhatsApp/Apple sign-in do not exist in
// the backend and are therefore never shown as fake options.)

import { useState } from "react";
import { Mail } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AuthDivider, AuthError, AuthLogo, AuthPrimaryButton, GoogleIcon } from "./auth-ui";

export function AuthWelcomeScreen({
  onEmail,
  oauthError,
}: {
  onEmail: (focusEmail?: boolean) => void;
  oauthError: string | null;
}) {
  const [googleBusy, setGoogleBusy] = useState(false);

  function startGoogle() {
    setGoogleBusy(true);
    // Real OAuth entry point (state + PKCE handled server-side).
    window.location.assign("/api/v1/auth/google");
  }

  return (
    <div className="flex flex-col items-center gap-5 text-center">
      <AuthLogo />

      <div className="space-y-1.5">
        <p className="text-sm text-muted-foreground">Welcome to</p>
        <h1 className="text-[1.7rem] font-bold leading-tight tracking-tight text-foreground">
          <span className="text-primary">MOHD.HMS</span> Enterprise
        </h1>
        <p className="text-sm text-muted-foreground">Your Trusted Maintenance Partner</p>
      </div>

      <div className="mt-3 w-full space-y-3">
        <AuthError message={oauthError} />

        <Button
          type="button"
          variant="outline"
          className="h-12 w-full rounded-xl border-border bg-background text-[0.95rem] font-medium shadow-sm hover:bg-muted/50"
          onClick={startGoogle}
          disabled={googleBusy}
          aria-busy={googleBusy || undefined}
        >
          <GoogleIcon className="mr-2 h-5 w-5" />
          {googleBusy ? "Redirecting to Google…" : "Continue with Google"}
        </Button>

        <Button
          type="button"
          variant="outline"
          className="h-12 w-full rounded-xl border-border bg-background text-[0.95rem] font-medium shadow-sm hover:bg-muted/50"
          onClick={() => onEmail(true)}
        >
          <Mail className="mr-2 h-5 w-5 text-primary" aria-hidden />
          Continue with Email
        </Button>

        <AuthDivider label="OR" />

        <AuthPrimaryButton type="button" onClick={() => onEmail(false)}>
          Log In
        </AuthPrimaryButton>
      </div>

      <p className="mt-4 text-xs leading-relaxed text-muted-foreground">
        By continuing, you agree to our Terms of Service &amp; Privacy Policy.
      </p>
      <p className="text-[0.7rem] text-muted-foreground/80">
        Protected enterprise system — authenticated, role-based and audit-logged.
      </p>
    </div>
  );
}
