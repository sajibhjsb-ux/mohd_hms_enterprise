import "server-only";

// MOHD.HMS ENTERPRISE — VAPID configuration (shared by the push pipeline).
//
// web-push stores its VAPID key material as MODULE state (setVapidDetails).
// Because Next.js can instantiate more than one copy of a module across
// bundles (instrumentation/scheduler vs API routes), the configuration MUST
// be idempotent and invoked at every delivery site — the scheduler's worker
// bundle otherwise sends requests WITHOUT the Authorization header (→ 401).
//
// VAPID private keys live ONLY in server env (never bundled/shipped).

import webpush from "web-push";

const PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY?.trim() ?? "";
const PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY?.trim() ?? "";
const SUBJECT = process.env.VAPID_SUBJECT?.trim() || "mailto:it@mohdhms.com";

const g = globalThis as unknown as { __hmsVapidConfigured?: boolean };

/** Idempotent: safe to call before every send. True when keys are present. */
export function ensureVapidConfigured(): boolean {
  if (!PUBLIC_KEY || !PRIVATE_KEY) return false;
  if (!g.__hmsVapidConfigured) {
    try {
      webpush.setVapidDetails(SUBJECT, PUBLIC_KEY, PRIVATE_KEY);
      g.__hmsVapidConfigured = true;
    } catch (e) {
      console.error("push-vapid-config-failed", e);
      return false;
    }
  }
  return true;
}

/** Public key is public by design (served to browsers for subscribing). */
export function vapidPublicKey(): string | null {
  return PUBLIC_KEY && PRIVATE_KEY ? PUBLIC_KEY : null;
}
