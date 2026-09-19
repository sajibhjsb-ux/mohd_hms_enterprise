"use client";
// FORGOT PASSWORD — final step: success. Rendered only after the server
// confirmed the reset transaction committed (hash updated, sessions revoked,
// authorization consumed). "Back to Login" is the REAL login screen — no
// auto-login, no dashboard redirect.

import { CheckCircle2 } from "lucide-react";
import { AuthPrimaryButton } from "./auth-ui";

export function AuthResetSuccessScreen({ onBackToLogin }: { onBackToLogin: () => void }) {
  return (
    <div className="flex flex-col items-center text-center">
      <div className="grid h-16 w-16 place-items-center rounded-full bg-primary/10" aria-hidden>
        <CheckCircle2 className="h-8 w-8 text-primary" />
      </div>

      <h1 className="mt-5 text-[1.65rem] font-bold leading-tight tracking-tight text-foreground">
        Password Reset Successful
      </h1>
      <p className="mt-1.5 text-sm text-muted-foreground">
        Your password has been changed successfully. Sign in with your new password to continue.
      </p>

      <div className="mt-7 w-full">
        <AuthPrimaryButton type="button" onClick={onBackToLogin}>
          Back to Login
        </AuthPrimaryButton>
      </div>

      <p className="mt-5 text-xs leading-relaxed text-muted-foreground">
        For your security, all previous sessions were signed out.
      </p>
    </div>
  );
}
