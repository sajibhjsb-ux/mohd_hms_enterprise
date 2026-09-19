"use client";
// MOHD.HMS ENTERPRISE — authentication flow root.
// Owns the full auth experience (welcome → login → verify, plus the password
// recovery journey: forgot → reset-otp → new-password → reset-success). The
// ACTIVE SCREEN IS DERIVED FROM THE URL (?auth=…), so browser back/forward,
// the on-screen back buttons and direct links are all genuine router
// navigation with a single source of truth.
//
// Route-bypass safety: ?auth=new-password / ?auth=reset-success WITHOUT the
// matching in-memory state (one-time server-issued reset authorization /
// completed flag) falls back — and even a forged visit is blocked by the
// SERVER, which requires a valid single-use authorization on the reset call.
// Sensitive state (which email, OTP, reset authorization, new password)
// lives in memory ONLY — never in the URL, never in any storage.
//
// Everything here talks to the EXISTING backend:
//   POST /api/v1/auth/login                        (screens 1→2→3 or app)
//   POST /api/v1/auth/verify-email                 (screen 3)
//   POST /api/v1/auth/resend-verification          (screen 3)
//   POST /api/v1/auth/forgot-password              (recovery: request OTP)
//   POST /api/v1/auth/forgot-password/verify-otp   (recovery: verify OTP)
//   POST /api/v1/auth/forgot-password/resend       (recovery: resend OTP)
//   POST /api/v1/auth/reset-password               (recovery: set new password)
//   GET  /api/v1/auth/google                       (real OAuth; errors via ?googleError)

import { Suspense, useEffect, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useSession } from "../session";
import { AuthShell } from "./auth-ui";
import { AuthWelcomeScreen } from "./welcome-screen";
import { AuthLoginScreen } from "./login-screen";
import { AuthOtpVerificationScreen } from "./verify-screen";
import { AuthForgotPasswordScreen } from "./forgot-screen";
import { AuthResetOtpScreen } from "./reset-otp-screen";
import { AuthNewPasswordScreen } from "./new-password-screen";
import { AuthResetSuccessScreen } from "./success-screen";

type AuthScreen = "welcome" | "login" | "verify" | "forgot" | "reset-otp" | "new-password" | "reset-success";

/** Server error codes (?googleError=) mapped to friendly, actionable messages. */
const GOOGLE_ERROR_MESSAGES: Record<string, string> = {
  not_configured: "Google sign-in is not configured on this server yet.",
  no_account:
    "We could not set up your customer account with this Google email (it may already exist with a different state). Please contact support for help completing your registration.",
  account_disabled: "This account has been disabled. Contact your administrator.",
  email_unverified:
    "Your Google account email is not verified. Use a verified Google account or sign in with your password.",
  state_mismatch: "This sign-in attempt expired or is no longer valid. Please try again.",
  exchange_failed: "Could not complete Google sign-in (token exchange failed). Please try again.",
  profile_failed: "Could not read your Google profile. Please try again.",
  provider_error: "Google returned an error during sign-in. Please try again.",
  rate_limited: "Too many sign-in attempts. Please wait a few minutes and try again.",
};

function googleErrorMessage(code: string): string {
  if (code === "not_configured") {
    return `${GOOGLE_ERROR_MESSAGES.not_configured} Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to the server environment, then register this callback URL in Google Cloud Console: /api/v1/auth/google/callback`;
  }
  return GOOGLE_ERROR_MESSAGES[code] ?? "Google sign-in failed. Please try again.";
}

function AuthFlow() {
  const { refresh } = useSession();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  // Pending email verification (screen 3). Kept in memory only — the OTP is
  // never stored client-side and no auth state touches localStorage.
  const [pendingEmail, setPendingEmail] = useState<string | null>(null);
  const [resendAfterSec, setResendAfterSec] = useState(30);
  const [remember, setRemember] = useState(false);
  const [focusEmail, setFocusEmail] = useState(false);
  const [oauthError, setOauthError] = useState<string | null>(null);

  // Password recovery context (memory only, one recovery at a time — never
  // in the URL, never in any storage). GATING RULE: a handler must never
  // invalidate the gate of the screen it is LEAVING. An intermediate render
  // with (old URL, failed gate) would trigger the stale-deep-link cleanup
  // and yank the user back to the welcome screen mid-flow. So: the one-time
  // token survives its own completion (it is a DEAD credential the moment
  // the server consumes it — single-use) and the whole context is dropped
  // only where no gate depends on it: when a NEW flow starts (leaving the
  // ungated email screen) and when a session opens (leaving login/verify).
  // A full page reload drops everything → deep links stay blocked; the
  // server-side authorization remains the real guard either way.
  const [resetEmail, setResetEmail] = useState<string | null>(null);
  const [resetResendAfterSec, setResetResendAfterSec] = useState(60);
  const [resetNotice, setResetNotice] = useState<string | null>(null);
  const [resetToken, setResetToken] = useState<string | null>(null);
  const [resetDone, setResetDone] = useState(false);

  const hasPushedRef = useRef(false);

  // Surface the outcome of a redirected Google sign-in attempt (full-page
  // navigation back from the OAuth callback), then clean the URL so a refresh
  // doesn't replay the message. The banner is set asynchronously — after the
  // URL write — so it survives the cleanup.
  useEffect(() => {
    const code = new URLSearchParams(window.location.search).get("googleError");
    if (!code) return;
    try {
      window.history.replaceState(null, "", window.location.pathname);
    } catch {
      /* ignore */
    }
    const message = code === "access_denied" ? null : googleErrorMessage(code);
    queueMicrotask(() => setOauthError(message));
  }, []);

  // ACTIVE SCREEN — derived from the URL (single source of truth).
  // State-gated screens (?auth=verify / reset-otp / new-password /
  // reset-success) without their in-memory context (stale bookmark, refresh,
  // hand-typed deep link) fall back instead of rendering a dead screen.
  const authParam = searchParams.get("auth");
  // Screens that require their in-memory context to be present.
  const stateGates: Partial<Record<string, boolean>> = {
    verify: !!pendingEmail,
    "reset-otp": !!resetEmail,
    "new-password": !!resetToken,
    "reset-success": resetDone,
  };
  const screen: AuthScreen =
    (authParam === "forgot" || authParam === "login") ? authParam
    : authParam && stateGates[authParam] ? (authParam as AuthScreen)
    : "welcome";

  // Clean up stale deep links (URL write only, no state sync).
  useEffect(() => {
    const stale =
      (authParam === "verify" && !pendingEmail) ||
      (authParam === "reset-otp" && !resetEmail) ||
      (authParam === "new-password" && !resetToken) ||
      (authParam === "reset-success" && !resetDone);
    if (stale) router.replace(pathname, { scroll: false });
  }, [authParam, pendingEmail, resetEmail, resetToken, resetDone, router, pathname]);

  /** Navigate by pushing a real history entry. */
  function navigate(to: AuthScreen) {
    if (to !== "welcome") hasPushedRef.current = true;
    router.push(to === "welcome" ? pathname : `${pathname}?auth=${to}`, { scroll: false });
  }

  /** On-screen back buttons: real history navigation with a deep-link fallback. */
  function goBack() {
    if (hasPushedRef.current) {
      hasPushedRef.current = false;
      router.back();
    } else {
      router.replace(pathname, { scroll: false });
    }
  }

  /** Session is open — clean auth params from the URL and refresh the session
   *  context; the existing Gate then routes to the app (customers with an
   *  incomplete profile continue through the existing profile-completion flow). */
  async function onAuthenticated() {
    // Session is open — any recovery context is now irrelevant. Safe to drop:
    // this transition leaves the (ungated) login screen or the verify screen
    // whose gate (pendingEmail) is untouched here.
    setResetEmail(null);
    setResetNotice(null);
    setResetToken(null);
    setResetDone(false);
    try {
      window.history.replaceState(null, "", window.location.pathname);
    } catch {
      /* ignore */
    }
    await refresh();
  }

  function handleOtpRequired(email: string, resendAfter: number) {
    setPendingEmail(email);
    setResendAfterSec(resendAfter);
    navigate("verify");
  }

  // ---- Password recovery handlers (state lives in memory only) ----
  // Every handler below keeps the gate of the screen it leaves intact —
  // see the context comment above.

  function handleResetCodeSent(email: string, resendAfter: number, notice: string) {
    // Leaving the UNGATED email screen — full context reset is safe here.
    setResetEmail(email);
    setResetResendAfterSec(resendAfter);
    setResetNotice(notice);
    setResetToken(null);
    setResetDone(false);
    navigate("reset-otp");
  }

  function handleResetVerified(token: string) {
    // Leaving reset-otp (gated by email — still set).
    setResetToken(token);
    setResetNotice(null);
    navigate("new-password");
  }

  function handleResetCompleted() {
    // Leaving new-password (gated by token — kept: the server consumed the
    // authorization, so this is a dead credential that the next flow start
    // or session open drops).
    setResetDone(true);
    navigate("reset-success");
  }

  function handleBackToLogin() {
    // Leaving reset-success (gated by done — kept until the next flow/login).
    navigate("login");
  }

  return (
    <AuthShell screenKey={screen}>
      {screen === "welcome" ? (
        <AuthWelcomeScreen
          onEmail={(focus) => {
            setFocusEmail(!!focus);
            navigate("login");
          }}
          oauthError={oauthError}
        />
      ) : screen === "login" ? (
        <AuthLoginScreen
          onBack={goBack}
          autoFocusEmail={focusEmail}
          oauthError={oauthError}
          remember={remember}
          onRememberChange={setRemember}
          onAuthenticated={onAuthenticated}
          onOtpRequired={handleOtpRequired}
          onForgotPassword={() => navigate("forgot")}
        />
      ) : screen === "forgot" ? (
        <AuthForgotPasswordScreen onBack={goBack} onCodeSent={handleResetCodeSent} />
      ) : screen === "reset-otp" ? (
        <AuthResetOtpScreen
          email={resetEmail ?? ""}
          initialResendAfterSec={resetResendAfterSec}
          sentNotice={resetNotice}
          onBack={goBack}
          onVerified={handleResetVerified}
        />
      ) : screen === "new-password" ? (
        <AuthNewPasswordScreen
          email={resetEmail ?? ""}
          resetToken={resetToken ?? ""}
          onBack={goBack}
          onReset={handleResetCompleted}
        />
      ) : screen === "reset-success" ? (
        <AuthResetSuccessScreen onBackToLogin={handleBackToLogin} />
      ) : (
        <AuthOtpVerificationScreen
          email={pendingEmail ?? ""}
          initialResendAfterSec={resendAfterSec}
          remember={remember}
          onBack={goBack}
          onAuthenticated={onAuthenticated}
        />
      )}
    </AuthShell>
  );
}

/** Suspense boundary required: useSearchParams inside a client component. */
export function AuthFlowRoot() {
  return (
    <Suspense fallback={null}>
      <AuthFlow />
    </Suspense>
  );
}
