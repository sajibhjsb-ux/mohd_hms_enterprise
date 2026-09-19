"use client";
// FORGOT PASSWORD — step 1 of password recovery (Email → OTP → New Password).
// Talks ONLY to the real backend:
//   POST /api/v1/auth/forgot-password → server-side eligibility + issue of a
//   6-digit PASSWORD_RESET OTP through the shared email-OTP system. The
//   response is anti-enumeration (identical for every email), so the next
//   screen follows unconditionally — the SERVER decides whether a code was
//   actually sent. The email lives in memory only (never URL / storage).

import { useState } from "react";
import { Mail } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ClientApiError, api } from "@/lib/hms/api-client";
import { AuthError, AuthPrimaryButton, BackButton } from "./auth-ui";

/** Client-side UX check only — the server re-validates everything. */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function AuthForgotPasswordScreen({
  onBack,
  onCodeSent,
}: {
  onBack: () => void;
  /** Server accepted the request per its security policy → continue to OTP. */
  onCodeSent: (email: string, resendAfterSec: number, notice: string) => void;
}) {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function validate(value: string): string | null {
    const v = value.trim();
    if (!v) return "Please enter your email address.";
    if (!EMAIL_PATTERN.test(v)) return "Please enter a valid email address.";
    return null;
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    const clientError = validate(email);
    if (clientError) {
      setError(clientError);
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const res = await api.post<{ message: string; resendAfterSec: number }>(
        "/api/v1/auth/forgot-password",
        { email: email.trim().toLowerCase() }
      );
      // Backend has processed the request according to its security policy —
      // only now does the flow continue (no fake success, no enumeration).
      onCodeSent(email.trim().toLowerCase(), res.data.resendAfterSec, res.data.message);
    } catch (err) {
      if (err instanceof ClientApiError && err.code === "NETWORK") {
        setError("An internet connection is required to reset your password.");
      } else {
        setError(err instanceof ClientApiError ? err.message : "Something went wrong. Please try again.");
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} noValidate>
      <div className="flex items-center gap-3">
        <BackButton onClick={onBack} label="Back to login" />
      </div>

      <div className="mt-5 space-y-1.5">
        <h1 className="text-[1.65rem] font-bold leading-tight tracking-tight text-foreground">
          Forgot Password?
        </h1>
        <p className="text-sm text-muted-foreground">
          Enter the email address associated with your MOHD.HMS account.
        </p>
      </div>

      <div className="mt-7 space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="forgot-email" className="text-sm font-medium">
            Email Address
          </Label>
          <div className="relative">
            <Mail className="pointer-events-none absolute left-3.5 top-1/2 h-[1.05rem] w-[1.05rem] -translate-y-1/2 text-muted-foreground" aria-hidden />
            <Input
              id="forgot-email"
              type="email"
              inputMode="email"
              autoComplete="username"
              enterKeyHint="send"
              required
              value={email}
              onChange={(e) => {
                setEmail(e.target.value);
                setError(null);
              }}
              aria-invalid={!!error || undefined}
              aria-describedby={error ? "forgot-email-error" : undefined}
              placeholder="you@example.com"
              className="h-12 rounded-xl bg-background pl-10 text-base"
            />
          </div>
        </div>

        <div aria-live="polite" id="forgot-email-error">
          <AuthError message={error} />
        </div>

        <AuthPrimaryButton loading={busy} loadingLabel="Sending…">
          {busy ? "Sending…" : "Send Verification Code"}
        </AuthPrimaryButton>
      </div>

      <p className="mt-6 text-center text-sm text-muted-foreground">
        Remembered it?{" "}
        <button
          type="button"
          onClick={onBack}
          className="font-semibold text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-sm"
        >
          Back to Login
        </button>
      </p>
    </form>
  );
}
