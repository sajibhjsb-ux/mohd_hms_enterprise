"use client";

// MOHD.HMS ENTERPRISE — post-login welcome popup (config + logic).
//
// ONE reusable configuration for the professional welcome notification shown
// after a REAL login. Everything visual lives in
// components/hms/welcome/welcome-dialog.tsx; everything decidable lives here
// (greeting wording, role-aware messages, Asia/Brunei time-of-day bucketing
// and the real-login signal plumbing) so no welcome text or login-detection
// logic is ever scattered across components.
//
// REAL-LOGIN DETECTION (spec §6/§7/§8): the popup must appear only after a
// genuine login — never on refresh, session restoration, route navigation,
// heartbeat/session checks, WebSocket reconnects or PWA resume. The signal is
// an IN-MEMORY flag that cannot survive a page reload, set exclusively at the
// existing authentication boundaries:
//   • auth-flow.tsx onAuthenticated() — password login AND OTP-verified login
//   • session.tsx signIn()            — context API (future-proofing)
//   • Google OAuth callback           — a full-page redirect the SPA cannot
//     observe in-memory, so the backend lands the browser with a short-lived
//     `hms_welcome` cookie that is captured + cleared ONCE on the landing page
//     load (module scope below) and never replays afterwards.
// Marking is decoupled from display: the flag is set the moment the session
// opens and consumed by the dialog only once the shell + route are ready.

import { LOCALIZATION } from "./constants";

/** Minimal shape of the already-loaded authenticated session user (structural —
 *  keeps this lib independent of the session component; no extra API call). */
type WelcomeUser = { name: string; role: string };

// ── Time-of-day buckets (Asia/Brunei, app-authoritative — spec §2) ──

export type WelcomePeriod = "morning" | "afternoon" | "evening" | "night";

/** Greeting line per period (always paired with the user's actual name). */
export const WELCOME_GREETINGS: Record<WelcomePeriod, string> = {
  morning: "Good Morning",
  afternoon: "Good Afternoon",
  evening: "Good Evening",
  night: "Good Night",
};

/** Default welcome message per period (professional + positive, spec §2). */
export const WELCOME_MESSAGES_DEFAULT: Record<WelcomePeriod, string> = {
  morning: "Welcome back. Wishing you a productive and successful day ahead.",
  afternoon: "Welcome back. We hope your day is going smoothly.",
  evening: "Welcome back. Thank you for your continued work and support.",
  night: "Welcome back. Wishing you a peaceful evening.",
};

/** Role-aware variations (spec §9). Roles without an entry fall back to the
 *  period defaults above — same layout for every role, only wording differs. */
export const WELCOME_MESSAGES_BY_ROLE: Partial<Record<string, string>> = {
  CUSTOMER: "Welcome back. We're here to help you manage your service requests and facility needs.",
  TECHNICIAN: "Welcome back. Wishing you a safe and productive day.",
  SUPERVISOR: "Welcome back. Wishing you a productive day managing your operations.",
  ADMIN: "Welcome back. Wishing you a productive and successful day ahead.",
  SUPER_ADMIN: "Welcome back. Your management dashboard is ready.",
  FINANCE: "Welcome back. Wishing you a smooth and productive day with your financial work.",
  HR: "Welcome back. Wishing you a productive day supporting our people.",
};

/** Resolve the Asia/Brunei time-of-day bucket for a moment (spec §2).
 *  05–11 morning · 12–16 afternoon · 17–20 evening · 21–04 night. */
export function welcomePeriod(date: Date = new Date()): WelcomePeriod {
  let hour = 12;
  try {
    const parts = new Intl.DateTimeFormat("en-GB", {
      hour: "numeric",
      hourCycle: "h23",
      timeZone: LOCALIZATION.timezone, // existing application timezone config (Asia/Brunei)
    }).formatToParts(date);
    hour = Number(parts.find((p) => p.type === "hour")?.value ?? "12") || 0;
  } catch {
    // Timezone data unavailable — fall back to the device clock rather than
    // blocking the welcome popup over a formatting detail.
    hour = date.getHours();
  }
  if (hour >= 5 && hour < 12) return "morning";
  if (hour >= 12 && hour < 17) return "afternoon";
  if (hour >= 17 && hour < 21) return "evening";
  return "night";
}

/** Full welcome content for a session user (greeting + role-aware message).
 *  Uses the authenticated user's ACTUAL name — never hard-coded (spec §1). */
export function buildWelcomeContent(
  user: WelcomeUser,
  date: Date = new Date()
): { period: WelcomePeriod; greeting: string; message: string } {
  const period = welcomePeriod(date);
  const name = user.name?.trim() || "there";
  return {
    period,
    greeting: `${WELCOME_GREETINGS[period]}, ${name}!`,
    message: WELCOME_MESSAGES_BY_ROLE[user.role] ?? WELCOME_MESSAGES_DEFAULT[period],
  };
}

// ── Real-login signal (spec §6/§7/§8) ──

/** Short-lived cookie the Google OAuth callback sets on SUCCESS so the landing
 *  page load can recognize a real sign-in. Non-sensitive UI flag only. */
const WELCOME_COOKIE = "hms_welcome";

/** Captured once at module load (one page load = one evaluation): if this very
 *  page load IS the Google OAuth landing, take the cookie and clear it so no
 *  later refresh/tab can ever replay the popup. */
let bootFromOAuth = false;
if (typeof window !== "undefined") {
  try {
    if (/(?:^|;\s*)hms_welcome=1(?:;|$)/.test(document.cookie)) {
      bootFromOAuth = true;
      document.cookie = `${WELCOME_COOKIE}=; path=/; max-age=0; samesite=lax`;
    }
  } catch {
    /* storage unavailable — worst case the OAuth landing shows no popup */
  }
}

/** In-memory pending flag. A reload wipes it — exactly the semantics spec §8
 *  demands (real login ⇒ popup; refresh/session restore ⇒ nothing). */
let pendingFromLogin = false;

/** Mark that THIS context just completed a real login. Called only from the
 *  existing authentication boundaries (see file header). */
export function markWelcomePending(): void {
  pendingFromLogin = true;
}

/** Atomically consume the pending signal (once per login event). Returns true
 *  exactly once after a real login, then never again until the next one. */
export function takeWelcomePending(): boolean {
  if (pendingFromLogin) {
    pendingFromLogin = false;
    return true;
  }
  if (bootFromOAuth) {
    bootFromOAuth = false;
    return true;
  }
  return false;
}
