"use client";
// MOHD.HMS ENTERPRISE — authentication flow root.
// Owns the three-screen experience (welcome → login → verify). The ACTIVE
// SCREEN IS DERIVED FROM THE URL (?auth=…), so browser back/forward, the
// on-screen back buttons and direct links are all genuine router navigation
// with a single source of truth. Sensitive verification state (which email is
// being verified) lives in memory only — never in the URL, never in storage.
//
// Everything here talks to the EXISTING backend:
//   POST /api/v1/auth/login            (screens 1→2→3 or straight to the app)
//   POST /api/v1/auth/verify-email     (screen 3)
//   POST /api/v1/auth/resend-verification (screen 3)
//   GET  /api/v1/auth/google           (real OAuth; callback errors via ?googleError)

import { Suspense, useEffect, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useSession } from "../session";
import { AuthShell } from "./auth-ui";
import { AuthWelcomeScreen } from "./welcome-screen";
import { AuthLoginScreen } from "./login-screen";
import { AuthOtpVerificationScreen } from "./verify-screen";

type AuthScreen = "welcome" | "login" | "verify";

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
  // ?auth=verify without a pending verification (stale bookmark/refresh)
  // falls back to the welcome screen.
  const authParam = searchParams.get("auth");
  const screen: AuthScreen =
    authParam === "verify" && pendingEmail ? "verify" : authParam === "login" ? "login" : "welcome";

  // Clean up a stale ?auth=verify deep link (URL write only, no state sync).
  useEffect(() => {
    if (authParam === "verify" && !pendingEmail) {
      router.replace(pathname, { scroll: false });
    }
  }, [authParam, pendingEmail, router, pathname]);

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
        />
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
