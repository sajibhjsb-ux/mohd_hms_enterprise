"use client";
// FORGOT PASSWORD — step 2: verify the 6-digit PASSWORD_RESET OTP.
// Talks ONLY to the real backend:
//   • POST /api/v1/auth/forgot-password/verify-otp → server-side validation;
//     on success the server issues a short-lived single-use reset
//     authorization (held in memory ONLY — never in URLs or storage).
//   • POST /api/v1/auth/forgot-password/resend → server-enforced cooldown;
//     the countdown is driven by the returned resendAfterSec (never hardcoded).
// Inputs are numeric, paste-capable, auto-advancing, backspace-aware and
// disabled while verifying. Every failure shape shows the server's generic
// message — nothing about account or code state leaks.

import { useState } from "react";
import { REGEXP_ONLY_DIGITS } from "input-otp";
import { ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { InputOTP, InputOTPGroup, InputOTPSlot } from "@/components/ui/input-otp";
import { ClientApiError, api } from "@/lib/hms/api-client";
import { useResendCountdown, fmtResendCountdown } from "./use-resend-countdown";
import { AuthError, AuthPrimaryButton, BackButton } from "./auth-ui";

export function AuthResetOtpScreen({
  email,
  initialResendAfterSec,
  sentNotice,
  onBack,
  onVerified,
}: {
  email: string;
  initialResendAfterSec: number;
  /** Generic anti-enumeration notice returned by the request step. */
  sentNotice: string | null;
  onBack: () => void;
  /** Server verified the OTP and issued the one-time reset authorization. */
  onVerified: (resetToken: string) => void;
}) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [resendBusy, setResendBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(sentNotice);
  // Server-authoritative countdown (ticks only while > 0).
  const { secondsLeft, restart } = useResendCountdown(initialResendAfterSec);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy || code.length !== 6) return;
    setError(null);
    setBusy(true);
    try {
      const res = await api.post<{ resetToken: string }>(
        "/api/v1/auth/forgot-password/verify-otp",
        { email, code }
      );
      // Only the server can open the New Password step (route bypass is
      // impossible without this one-time authorization).
      onVerified(res.data.resetToken);
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

  async function resend() {
    if (resendBusy || secondsLeft > 0) return;
    setResendBusy(true);
    setError(null);
    setInfo(null);
    try {
      const res = await api.post<{ resendAfterSec: number }>(
        "/api/v1/auth/forgot-password/resend",
        { email }
      );
      restart(res.data.resendAfterSec);
      setCode("");
      setInfo("A new verification code was sent.");
    } catch (err) {
      if (err instanceof ClientApiError && err.status === 429) {
        // Server cooldown still active — mirror its remaining time exactly.
        const match = err.message.match(/in (\d+)s/);
        restart(match ? Number(match[1]) : 60);
        setError(err.message);
      } else if (err instanceof ClientApiError && err.code === "NETWORK") {
        setError("An internet connection is required to reset your password.");
      } else {
        setError(err instanceof ClientApiError ? err.message : "Something went wrong. Please try again.");
      }
    } finally {
      setResendBusy(false);
    }
  }

  return (
    <form onSubmit={submit} noValidate>
      <div className="flex items-center gap-3">
        <BackButton onClick={onBack} label="Back to email entry" />
      </div>

      <div className="mt-5 space-y-1.5">
        <h1 className="text-[1.65rem] font-bold leading-tight tracking-tight text-foreground">
          Verify Your Email
        </h1>
        <p className="text-sm text-muted-foreground">
          Enter the 6-digit verification code we sent to{" "}
          <span className="font-semibold text-foreground">{email}</span>
        </p>
      </div>

      <div className="mt-7">
        <InputOTP
          maxLength={6}
          value={code}
          onChange={(v) => {
            setCode(v);
            setError(null);
          }}
          disabled={busy}
          pattern={REGEXP_ONLY_DIGITS}
          inputMode="numeric"
          autoComplete="one-time-code"
          aria-label="6-digit password reset verification code"
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
        {info ? (
          <p className="rounded-lg bg-primary/10 px-3.5 py-2.5 text-sm font-medium text-primary">{info}</p>
        ) : null}
      </div>

      <div className="mt-5">
        <AuthPrimaryButton
          loading={busy}
          loadingLabel="Verifying…"
          disabled={code.length !== 6}
        >
          {busy ? "Verifying…" : "Verify Code"}
          {!busy && <ArrowRight className="ml-1 h-4 w-4" aria-hidden />}
        </AuthPrimaryButton>
      </div>

      <p className="mt-6 text-center text-sm text-muted-foreground">
        Didn&apos;t receive the code?{" "}
        {secondsLeft > 0 ? (
          <span className="font-medium tabular-nums text-foreground/80">
            Resend in {fmtResendCountdown(secondsLeft)}
          </span>
        ) : (
          <Button
            type="button"
            variant="link"
            className="h-auto p-0 text-sm font-semibold text-primary underline-offset-4 hover:underline"
            onClick={resend}
            disabled={resendBusy}
            aria-busy={resendBusy || undefined}
          >
            {resendBusy ? "Sending…" : "Resend Code"}
          </Button>
        )}
      </p>
    </form>
  );
}
