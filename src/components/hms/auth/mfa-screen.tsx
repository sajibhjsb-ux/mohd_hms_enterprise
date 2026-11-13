"use client";
// SCREEN — TOTP verification for a pending login challenge.

import { useState } from "react";
import { REGEXP_ONLY_DIGITS } from "input-otp";
import { ArrowRight } from "lucide-react";
import { InputOTP, InputOTPGroup, InputOTPSlot } from "@/components/ui/input-otp";
import { ClientApiError, api } from "@/lib/hms/api-client";
import { AuthError, AuthPrimaryButton, BackButton } from "./auth-ui";
import { fmtResendCountdown, useResendCountdown } from "./use-resend-countdown";

export function AuthMfaScreen({
  expiresAt,
  onBack,
  onUseRecovery,
  onAuthenticated,
}: {
  expiresAt: string;
  onBack: () => void;
  onUseRecovery: () => void;
  onAuthenticated: () => Promise<void>;
}) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { secondsLeft } = useResendCountdown(Math.max(0, Math.floor((new Date(expiresAt).getTime() - Date.now()) / 1000)));
  const expired = secondsLeft <= 0;

  async function abandon() {
    try {
      await api.post("/api/v1/auth/mfa/abandon");
    } catch {
      /* best effort */
    }
    onBack();
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy || code.length !== 6 || expired) return;
    setError(null);
    setBusy(true);
    try {
      await api.post("/api/v1/auth/mfa/verify", { code });
      await onAuthenticated();
    } catch (err) {
      setError(err instanceof ClientApiError && err.code === "NETWORK" ? "Unable to connect. Please check your connection and try again." : err instanceof ClientApiError ? err.message : "Something went wrong. Please try again.");
      setCode("");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} noValidate>
      <div className="flex items-center gap-3">
        <BackButton onClick={abandon} label="Back to login" />
      </div>

      <div className="mt-5 space-y-1.5">
        <h1 className="text-[1.65rem] font-bold leading-tight tracking-tight text-foreground">Two-factor authentication</h1>
        <p className="text-sm text-muted-foreground">Enter the 6-digit code from your authenticator app.</p>
      </div>

      <div className="mt-7">
        <InputOTP
          maxLength={6}
          value={code}
          onChange={(v) => {
            setCode(v);
            setError(null);
          }}
          disabled={busy || expired}
          pattern={REGEXP_ONLY_DIGITS}
          inputMode="numeric"
          autoComplete="one-time-code"
          aria-label="6-digit authentication code"
          containerClassName="justify-center gap-1.5 sm:gap-2.5"
        >
          <InputOTPGroup className="flex items-center gap-1.5 sm:gap-2.5">
            {Array.from({ length: 6 }, (_, i) => (
              <InputOTPSlot
                key={i}
                index={i}
                className={`h-12 w-[2.6rem] rounded-xl border bg-background text-lg font-semibold shadow-sm sm:h-14 sm:w-12 ${
                  error ? "border-destructive data-[active=true]:border-destructive" : ""
                }`}
              />
            ))}
          </InputOTPGroup>
        </InputOTP>
      </div>

      <div aria-live="polite" className="mt-4 space-y-2.5">
        <AuthError message={error} />
        {expired ? (
          <p className="rounded-lg border border-amber-300 bg-amber-50 px-3.5 py-2.5 text-sm font-medium text-amber-900">
            This verification window expired. Please sign in again.
          </p>
        ) : (
          <p className="text-center text-xs tabular-nums text-muted-foreground">Expires in {fmtResendCountdown(secondsLeft)}</p>
        )}
      </div>

      <div className="mt-5">
        <AuthPrimaryButton loading={busy} loadingLabel="Verifying…" disabled={code.length !== 6 || expired}>
          {busy ? "Verifying…" : "Verify"}
          {!busy && <ArrowRight className="ml-1 h-4 w-4" aria-hidden />}
        </AuthPrimaryButton>
      </div>

      <p className="mt-6 text-center text-sm text-muted-foreground">
        <button
          type="button"
          onClick={onUseRecovery}
          className="inline-flex min-h-11 items-center font-semibold text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-sm"
        >
          Use a recovery code
        </button>
      </p>
    </form>
  );
}
