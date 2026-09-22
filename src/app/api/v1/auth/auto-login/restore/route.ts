// MOHD.HMS ENTERPRISE — USER-CONTROLLED AUTO LOGIN (§auto-login).
// POST /api/v1/auth/auto-login/restore
//
// Attempts secure persistent-session restoration on a genuinely fresh app
// open (browser/PWA relaunch). The heavy lifting — validation chain, token
// rotation, cookie issuance — lives in restorePersistentSession() (auth.ts):
// the cookie must hold a remember-grant that still exists (explicit logout,
// password change/reset, admin reset/disable all DELETE it), is within its
// absolute expiry, is genuinely idle-revoked (a live session never needs
// restoration), and belongs to an ACTIVE user; role/permissions are
// re-resolved from the User row — never stale.
//
// Transport semantics: 200 with { restored: false } for the NORMAL no-cookie
// case (most devices) — no error spam, no audit noise. A cookie that FAILS
// validation is a security-relevant rejection: audited
// PERSISTENT_SESSION_REJECTED and the dead credential cookie is cleared.
// MFA note: this app currently has no MFA step; restoration only re-uses the
// existing session identity (the customer email-OTP gate was passed at the
// original login) — it introduces no bypass of any existing verification.

import { NextResponse } from "next/server";
import { handler, ok } from "@/lib/hms/api";
import {
  restorePersistentSession, SESSION_IDLE_TIMEOUT_SECONDS,
} from "@/lib/hms/auth";
import { db } from "@/lib/db";
import { customerProfileState } from "@/lib/hms/customer-profile";
import { termsStatusFor } from "@/lib/hms/legal/legal";
import { audit } from "@/lib/hms/services";

export const POST = handler(
  async ({ user }) => {
    const result = await restorePersistentSession();
    if (!result.restored) {
      if (result.rejected) {
        const { clearSessionCookie } = await import("@/lib/hms/auth");
        await clearSessionCookie();
        await audit({
          actorId: user?.id,
          actorEmail: user?.email,
          action: "PERSISTENT_SESSION_REJECTED",
          resourceType: "SESSION",
          metadata: { reason: result.reason },
        });
      }
      return ok({ restored: false, reason: result.reason });
    }

    const { user: su, expiresAt } = result;
    const [profileState, terms, avatar] = await Promise.all([
      customerProfileState(su),
      termsStatusFor(su),
      db.user.findUnique({ where: { id: su.id }, select: { avatarUrl: true } }),
    ]);
    await audit({
      actorId: su.id, actorEmail: su.email,
      action: "PERSISTENT_SESSION_RESTORED", resourceType: "SESSION",
      metadata: { sessionExpiresAt: expiresAt.toISOString() },
    });
    return NextResponse.json({
      ok: true,
      data: {
        restored: true,
        authenticated: true,
        user: {
          id: su.id,
          email: su.email,
          name: su.name,
          role: su.role,
          customerId: su.customerId,
          permissions: su.permissions,
          profileComplete: profileState.profileComplete,
          missingFields: profileState.missingFields,
          terms,
          avatarUrl: avatar?.avatarUrl ?? null,
        },
        sessionExpiresAt: expiresAt,
        idleTimeoutSeconds: SESSION_IDLE_TIMEOUT_SECONDS,
      },
    });
  },
  { auth: false }
);
