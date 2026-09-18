"use client";
// SCREEN 2 — Login (credentials).
// Visual redesign ONLY — the authentication flow is the existing one:
// browser → POST /api/v1/auth/login (rate-limited) → DB session cookie →
// RBAC session → existing dashboard routing / customer profile onboarding.
// Forgot Password uses the existing /api/v1/auth/forgot-password flow.

import { useEffect, useRef, useState } from "react";
import { ArrowRight, Eye, EyeOff, Lock, Mail } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ClientApiError, api } from "@/lib/hms/api-client";
import {
  AuthDivider,
  AuthError,
  AuthPrimaryButton,
  BackButton,
  GoogleIcon,
} from "./auth-ui";

/** Login API response: either a full session payload or an OTP challenge. */
export type LoginResponse =
  | { otpRequired: true; email: string; resendAfterSec: number; expiresInSec: number }
  | { otpRequired?: false };

export function AuthLoginScreen({
  onBack,
  autoFocusEmail,
  oauthError,
  remember,
  onRememberChange,
  onAuthenticated,
  onOtpRequired,
}: {
  onBack: () => void;
  autoFocusEmail: boolean;
  oauthError: string | null;
  /** Lifted so the OTP verification request can reuse the same choice. */
  remember: boolean;
  onRememberChange: (v: boolean) => void;
  /** Credentials accepted — session cookie set; continue to the app. */
  onAuthenticated: () => Promise<void>;
  /** Server requires email verification first (6-digit code sent). */
  onOtpRequired: (email: string, resendAfterSec: number) => void;
}) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [googleBusy, setGoogleBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Forgot password — existing backend flow, unchanged.
  const [forgotOpen, setForgotOpen] = useState(false);
  const [forgotEmail, setForgotEmail] = useState("");
  const [forgotMsg, setForgotMsg] = useState<string | null>(null);
  const [forgotBusy, setForgotBusy] = useState(false);

  const emailRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (autoFocusEmail) emailRef.current?.focus();
  }, [autoFocusEmail]);

  function startGoogle() {
    setGoogleBusy(true);
    window.location.assign("/api/v1/auth/google");
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setError(null);
    setBusy(true);
    try {
      const res = await api.post<LoginResponse>("/api/v1/auth/login", {
        email: email.trim().toLowerCase(),
        password,
        remember,
      });
      if (res.data.otpRequired) {
        // Server has queued a 6-digit code — go verify it (resend countdown
        // value comes from the backend so it matches the enforced cooldown).
        onOtpRequired(res.data.email, res.data.resendAfterSec);
        return;
      }
      await onAuthenticated();
    } catch (err) {
      if (err instanceof ClientApiError && err.code === "NETWORK") {
        setError("Unable to connect. Please check your connection and try again.");
      } else {
        setError(err instanceof ClientApiError ? err.message : "Something went wrong. Please try again.");
      }
    } finally {
      setBusy(false);
    }
  }

  async function sendReset() {
    setForgotBusy(true);
    setForgotMsg(null);
    try {
      const res = await api.post<{ message: string }>("/api/v1/auth/forgot-password", {
        email: forgotEmail.trim().toLowerCase(),
      });
      setForgotMsg(res.data.message);
    } catch (err) {
      setForgotMsg(err instanceof ClientApiError ? err.message : "Something went wrong. Please try again.");
    } finally {
      setForgotBusy(false);
    }
  }

  return (
    <>
      {/* Screen chrome — back is real history navigation (router.back fallback). */}
      <div className="flex items-center gap-3">
        <BackButton onClick={onBack} label="Back to welcome" />
      </div>

      <div className="mt-5 space-y-1.5">
        <h1 className="text-[1.65rem] font-bold leading-tight tracking-tight text-foreground">Welcome back</h1>
        <p className="text-sm text-muted-foreground">Sign in to continue to MOHD.HMS Enterprise</p>
      </div>

      <form onSubmit={submit} className="mt-7 space-y-4" noValidate>
        <div className="space-y-1.5">
          <Label htmlFor="auth-email" className="text-sm font-medium">
            Email Address
          </Label>
          <div className="relative">
            <Mail className="pointer-events-none absolute left-3.5 top-1/2 h-[1.05rem] w-[1.05rem] -translate-y-1/2 text-muted-foreground" aria-hidden />
            <Input
              id="auth-email"
              ref={emailRef}
              type="email"
              inputMode="email"
              autoComplete="username"
              enterKeyHint="next"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              className="h-12 rounded-xl bg-background pl-10 text-base"
            />
          </div>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="auth-password" className="text-sm font-medium">
            Password
          </Label>
          <div className="relative">
            <Lock className="pointer-events-none absolute left-3.5 top-1/2 h-[1.05rem] w-[1.05rem] -translate-y-1/2 text-muted-foreground" aria-hidden />
            <Input
              id="auth-password"
              type={showPassword ? "text" : "password"}
              autoComplete="current-password"
              enterKeyHint="go"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              className="h-12 rounded-xl bg-background pl-10 pr-11 text-base"
            />
            <button
              type="button"
              onClick={() => setShowPassword((v) => !v)}
              aria-label={showPassword ? "Hide password" : "Show password"}
              aria-pressed={showPassword}
              className="absolute right-1.5 top-1/2 grid h-9 w-9 -translate-y-1/2 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {showPassword ? <EyeOff className="h-[1.05rem] w-[1.05rem]" aria-hidden /> : <Eye className="h-[1.05rem] w-[1.05rem]" aria-hidden />}
            </button>
          </div>
        </div>

        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Checkbox
              id="auth-remember"
              checked={remember}
              onCheckedChange={(v) => onRememberChange(v === true)}
              className="h-[1.1rem] w-[1.1rem]"
            />
            <Label htmlFor="auth-remember" className="text-sm font-normal text-foreground/90">
              Remember me
            </Label>
          </div>
          <button
            type="button"
            className="text-sm font-semibold text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-sm"
            onClick={() => setForgotOpen(true)}
          >
            Forgot Password?
          </button>
        </div>

        <AuthError message={error ?? oauthError} />

        <AuthPrimaryButton loading={busy} loadingLabel="Signing in…" disabled={googleBusy}>
          {busy ? "Signing in…" : "Log In"}
          {!busy && <ArrowRight className="ml-1 h-4 w-4" aria-hidden />}
        </AuthPrimaryButton>

        <AuthDivider label="or continue with" />

        <Button
          type="button"
          variant="outline"
          className="h-12 w-full rounded-xl border-border bg-background text-[0.95rem] font-medium shadow-sm hover:bg-muted/50"
          onClick={startGoogle}
          disabled={busy || googleBusy}
          aria-busy={googleBusy || undefined}
        >
          <GoogleIcon className="mr-2 h-5 w-5" />
          {googleBusy ? "Redirecting to Google…" : "Google"}
        </Button>
      </form>

      {/* Google sign-in auto-provisions a customer account for new people —
          this is the application's real self-service registration path. */}
      <p className="mt-7 text-center text-sm text-muted-foreground">
        Don&apos;t have an account?{" "}
        <button
          type="button"
          onClick={startGoogle}
          disabled={busy || googleBusy}
          className="font-semibold text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-sm disabled:opacity-60"
        >
          Sign up with Google
        </button>
      </p>

      <Dialog open={forgotOpen} onOpenChange={setForgotOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Reset your password</DialogTitle>
            <DialogDescription>
              Enter your account email. If it exists, a reset link will be sent.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-2">
              <Label htmlFor="forgot-email">Email</Label>
              <Input
                id="forgot-email"
                type="email"
                inputMode="email"
                autoComplete="username"
                value={forgotEmail}
                onChange={(e) => setForgotEmail(e.target.value)}
                placeholder="you@example.com"
              />
            </div>
            {forgotMsg ? (
              <p className="rounded-md bg-muted px-3 py-2 text-sm text-muted-foreground">{forgotMsg}</p>
            ) : null}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setForgotOpen(false)}>
              Close
            </Button>
            <Button onClick={sendReset} disabled={forgotBusy || !forgotEmail.includes("@")}>
              {forgotBusy ? "Sending…" : "Send reset link"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
