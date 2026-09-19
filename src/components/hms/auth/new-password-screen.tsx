"use client";
// FORGOT PASSWORD — steps 3: New Password + Confirm New Password.
// Talks ONLY to the real backend: POST /api/v1/auth/reset-password consumes
// the one-time reset authorization (issued after OTP verification) and
// atomically updates the password hash, revokes all sessions and audits the
// change. Client validation mirrors the EXISTING password policy purely for
// UX — the server re-validates strength AND match authoritatively. Both
// values live in memory only (never in URLs or storage) and are wiped as
// soon as the screen unmounts.

import { useMemo, useState } from "react";
import { Eye, EyeOff, Lock } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ClientApiError, api } from "@/lib/hms/api-client";
import { AuthError, AuthPrimaryButton, BackButton } from "./auth-ui";

/** Client mirror of the server's existing policy (min 8 chars, letter+number). */
function policyError(pw: string): string | null {
  if (!pw || pw.length < 8) return "Password must be at least 8 characters long.";
  if (!/[a-zA-Z]/.test(pw) || !/[0-9]/.test(pw)) return "Password must contain letters and numbers.";
  return null;
}

/** 0–3 strength score — purely a client-side hint, never authoritative. */
function strengthScore(pw: string): number {
  if (!pw) return 0;
  let score = 0;
  if (pw.length >= 8) score++;
  if (/[a-zA-Z]/.test(pw) && /[0-9]/.test(pw)) score++;
  if (pw.length >= 12 || /[^a-zA-Z0-9]/.test(pw)) score++;
  return score;
}

const STRENGTH_LABELS = ["Too weak", "Weak", "Good", "Strong"] as const;

export function AuthNewPasswordScreen({
  email,
  resetToken,
  onBack,
  onReset,
}: {
  email: string;
  /** One-time authorization from the server — required to reach this step. */
  resetToken: string;
  onBack: () => void;
  /** Server committed the reset transaction successfully. */
  onReset: () => void;
}) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [confirmError, setConfirmError] = useState<string | null>(null);

  const score = useMemo(() => strengthScore(password), [password]);

  const showPasswordToggle = (show: boolean, toggle: () => void, what: string) => (
    <button
      type="button"
      onClick={toggle}
      aria-label={show ? `Hide ${what}` : `Show ${what}`}
      aria-pressed={show}
      className="absolute right-1.5 top-1/2 grid h-9 w-9 -translate-y-1/2 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {show ? <EyeOff className="h-[1.05rem] w-[1.05rem]" aria-hidden /> : <Eye className="h-[1.05rem] w-[1.05rem]" aria-hidden />}
    </button>
  );

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;

    // Client-side UX validation — the server is authoritative.
    const pwErr = policyError(password);
    const matchErr = confirm !== password ? "Passwords do not match." : null;
    setPasswordError(pwErr);
    setConfirmError(matchErr);
    setError(null);
    if (pwErr || matchErr) return;

    setBusy(true);
    try {
      await api.post("/api/v1/auth/reset-password", {
        resetToken,
        password,
        confirmPassword: confirm,
      });
      // Transaction committed server-side (hash updated, sessions revoked,
      // authorization consumed) — only now does the success screen show.
      onReset();
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
        <BackButton onClick={onBack} label="Back to verification" />
      </div>

      <div className="mt-5 space-y-1.5">
        <h1 className="text-[1.65rem] font-bold leading-tight tracking-tight text-foreground">
          Create New Password
        </h1>
        <p className="text-sm text-muted-foreground">
          Set a new password for <span className="font-semibold text-foreground">{email}</span>
        </p>
      </div>

      <div className="mt-7 space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="new-password" className="text-sm font-medium">
            New Password
          </Label>
          <div className="relative">
            <Lock className="pointer-events-none absolute left-3.5 top-1/2 h-[1.05rem] w-[1.05rem] -translate-y-1/2 text-muted-foreground" aria-hidden />
            <Input
              id="new-password"
              type={showPassword ? "text" : "password"}
              autoComplete="new-password"
              enterKeyHint="next"
              required
              value={password}
              onChange={(e) => {
                setPassword(e.target.value);
                setPasswordError(null);
                setError(null);
              }}
              aria-invalid={!!passwordError || undefined}
              aria-describedby={passwordError ? "new-password-error" : score > 0 ? "new-password-strength" : undefined}
              placeholder="At least 8 characters"
              className="h-12 rounded-xl bg-background pl-10 pr-11 text-base"
            />
            {showPasswordToggle(showPassword, () => setShowPassword((v) => !v), "password")}
          </div>

          {/* Strength hint — client-side UX only; the server enforces the policy. */}
          <div id="new-password-strength" aria-live="polite" className="pt-0.5">
            <div className="flex gap-1.5" aria-hidden>
              {[1, 2, 3].map((i) => (
                <span
                  key={i}
                  className={`h-1.5 flex-1 rounded-full transition-colors ${
                    score >= i
                      ? score <= 1
                        ? "bg-destructive"
                        : score === 2
                          ? "bg-primary/60"
                          : "bg-primary"
                      : "bg-border"
                  }`}
                />
              ))}
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              {password ? STRENGTH_LABELS[score] : "Use 8+ characters with letters and numbers."}
            </p>
          </div>
          <div aria-live="polite">
            {passwordError ? (
              <p className="text-sm font-medium text-destructive" id="new-password-error">
                {passwordError}
              </p>
            ) : null}
          </div>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="confirm-password" className="text-sm font-medium">
            Confirm New Password
          </Label>
          <div className="relative">
            <Lock className="pointer-events-none absolute left-3.5 top-1/2 h-[1.05rem] w-[1.05rem] -translate-y-1/2 text-muted-foreground" aria-hidden />
            <Input
              id="confirm-password"
              type={showConfirm ? "text" : "password"}
              autoComplete="new-password"
              enterKeyHint="done"
              required
              value={confirm}
              onChange={(e) => {
                setConfirm(e.target.value);
                setConfirmError(null);
                setError(null);
              }}
              aria-invalid={!!confirmError || undefined}
              aria-describedby={confirmError ? "confirm-password-error" : undefined}
              placeholder="Repeat the new password"
              className="h-12 rounded-xl bg-background pl-10 pr-11 text-base"
            />
            {showPasswordToggle(showConfirm, () => setShowConfirm((v) => !v), "confirmation password")}
          </div>
          <div aria-live="polite">
            {confirmError ? (
              <p className="text-sm font-medium text-destructive" id="confirm-password-error">
                {confirmError}
              </p>
            ) : null}
          </div>
        </div>

        <AuthError message={error} />

        <AuthPrimaryButton loading={busy} loadingLabel="Resetting…">
          {busy ? "Resetting…" : "Reset Password"}
        </AuthPrimaryButton>
      </div>
    </form>
  );
}
