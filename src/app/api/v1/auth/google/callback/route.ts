// GET /api/v1/auth/google/callback — Google OAuth redirect target.
// Validates state (single-use cookies), exchanges the code (PKCE), resolves
// the verified Google identity, then:
//   • Existing account  → link by googleId / verified email, preserve role +
//     customer relationship (never duplicate, never overwrite role).
//   • New person        → transactionally provision a CUSTOMER account AND its
//     canonical Customer identity (company name optional, mobile/address to be
//     completed during mandatory onboarding), then open the session.
//   • Legacy CUSTOMER user without a Customer record → repaired on sign-in so
//     every customer session has a valid customer identity (idempotent).
// Customers with an incomplete profile (missing mobile/address) land on the
// dedicated profile-completion page; everyone else lands on the dashboard.
// Every failure path redirects to the login screen with ?googleError=<code>
// which the UI maps to a friendly message.

import { NextRequest, NextResponse } from "next/server";
import { randomBytes } from "crypto";
import { db } from "@/lib/db";
import { createSession, SESSION_COOKIE } from "@/lib/hms/auth";
import { clientIp, rateLimit } from "@/lib/hms/rate-limit";
import { audit } from "@/lib/hms/services";
import { customerProfileState, createCustomerRecord, newCustomerCode } from "@/lib/hms/customer-profile";
import { importExternalAvatar, isAvatarRef } from "@/lib/hms/profile-photo";
import {
  exchangeCodeForTokens,
  externalOrigin,
  fetchGoogleProfile,
  googleErrorRedirect,
  googleOAuthConfig,
  googleRedirectUri,
  OAUTH_STATE_COOKIE,
  OAUTH_VERIFIER_COOKIE,
  safeEqual,
} from "@/lib/hms/google-auth";

/** Landing page after sign-in: onboard incomplete customers, rest → dashboard. */
function landingFor(role: string, state: { profileComplete: boolean }): string {
  if (role === "CUSTOMER" && !state.profileComplete) return "/profile/complete";
  return "/dashboard";
}

export async function GET(req: NextRequest) {
  const ip = clientIp(req);
  const cfg = googleOAuthConfig();
  const q = req.nextUrl.searchParams;

  // OAuth cookies are single-use: every response discards them.
  const clearOAuth = (res: NextResponse): NextResponse => {
    const base = { httpOnly: true, sameSite: "lax" as const, path: "/", maxAge: 0 };
    res.cookies.set(OAUTH_STATE_COOKIE, "", base);
    res.cookies.set(OAUTH_VERIFIER_COOKIE, "", base);
    return res;
  };

  const fail = async (code: string, meta?: Record<string, unknown>): Promise<NextResponse> => {
    if (meta) {
      await audit({
        action: "LOGIN_GOOGLE_FAILED",
        resourceType: "AUTH",
        metadata: { reason: code, ...meta },
        ip,
      });
    }
    return clearOAuth(googleErrorRedirect(req, code));
  };

  // Provider returned an error (e.g. the user cancelled consent).
  const providerError = q.get("error");
  if (providerError === "access_denied") {
    return clearOAuth(googleErrorRedirect(req, "access_denied"));
  }
  if (providerError) return fail("provider_error", { providerError });

  if (!cfg) return fail("not_configured");

  const rl = rateLimit(`oauth-cb:${ip}`, 30, 5 * 60 * 1000);
  if (!rl.allowed) return fail("rate_limited");

  const code = q.get("code");
  const state = q.get("state");
  const stateCookie = req.cookies.get(OAUTH_STATE_COOKIE)?.value ?? "";
  const verifier = req.cookies.get(OAUTH_VERIFIER_COOKIE)?.value ?? "";

  // Single-use: query state must match the cookie exactly; then cookies die.
  if (!code || !state || !stateCookie || !verifier || !safeEqual(state, stateCookie)) {
    return fail("state_mismatch");
  }

  const accessToken = await exchangeCodeForTokens(code, cfg, {
    redirectUri: googleRedirectUri(req),
    verifier,
  });
  if (!accessToken) return fail("exchange_failed");

  const profile = await fetchGoogleProfile(accessToken);
  if (!profile) return fail("profile_failed");
  if (!profile.emailVerified) return fail("email_unverified", { email: profile.email });

  // Identity chain: verified Google identity → googleId → verified email.
  // Never rely on display names; never create duplicates for a known email.
  let provisioned = false;
  let customerCreated = false;
  let user = await db.user.findUnique({ where: { googleId: profile.sub } });
  if (!user) user = await db.user.findUnique({ where: { email: profile.email } });

  if (!user) {
    // First sign-in auto-provisions a CUSTOMER account (no prior password —
    // login is Google-only for that account) together with its canonical
    // Customer identity, atomically. On a unique-email race the loser
    // re-resolves and continues down the existing-user path.
    provisioned = true;
    const customerCode = await newCustomerCode();
    const name = profile.name?.trim() || profile.email.split("@")[0];
    try {
      user = await db.$transaction(async (tx) => {
        const customer = await createCustomerRecord(tx, customerCode, { name, email: profile.email });
        return tx.user.create({
          data: {
            email: profile.email,
            passwordHash: randomBytes(32).toString("hex"),
            name,
            role: "CUSTOMER",
            status: "ACTIVE",
            emailVerified: new Date(),
            googleId: profile.sub,
            lastLoginAt: new Date(),
            customerId: customer.id,
          },
        });
      });
      customerCreated = true;
    } catch {
      user = await db.user.findUnique({ where: { googleId: profile.sub } });
      if (!user) user = await db.user.findUnique({ where: { email: profile.email } });
    }
  }

  if (!user) return fail("no_account", { email: profile.email });
  if (user.status !== "ACTIVE") return fail("account_disabled", { email: profile.email });

  // Existing CUSTOMER user without a canonical Customer record (e.g. created
  // before identity provisioning existed) — repair idempotently so the
  // session always carries a valid customer identity. Never touches staff
  // roles, never re-links a user that already has a customer.
  if (user.role === "CUSTOMER" && !user.customerId) {
    const current = user; // captured non-null reference for the tx closure
    const customerCode = await newCustomerCode();
    try {
      user = await db.$transaction(async (tx) => {
        const customer = await createCustomerRecord(tx, customerCode, { name: current.name, email: current.email });
        return tx.user.update({
          where: { id: current.id },
          data: { customerId: customer.id },
        });
      });
      customerCreated = true;
    } catch {
      // Another concurrent sign-in repaired it first — re-read and continue.
      user = await db.user.findUnique({ where: { id: current.id } });
    }
  }

  if (!user) return fail("no_account", { email: profile.email });
  if (user.status !== "ACTIVE") return fail("account_disabled", { email: profile.email });

  // avatarUrl is a STORAGE KEY. Import the Google picture only when the account
  // has no valid stored photo (fresh account or a legacy external URL left by an
  // older callback); undefined means "leave the stored value untouched".
  const importedAvatar = !isAvatarRef(user.avatarUrl)
    ? await importExternalAvatar(profile.picture, user.id)
    : undefined;

  await db.user.update({
    where: { id: user.id },
    data: {
      googleId: profile.sub,
      emailVerified: user.emailVerified ?? new Date(),
      lastLoginAt: new Date(),
      // avatarUrl is a STORAGE KEY (avatars/...), never an external URL. A
      // valid stored photo is preserved across sign-ins; a legacy external URL
      // (once written by this callback) is repaired by importing the Google
      // picture into private storage so the photo actually loads after re-login.
      ...(importedAvatar !== undefined ? { avatarUrl: importedAvatar } : {}),
    },
  });

  const { token, expiresAt } = await createSession(user.id, ip, req.headers.get("user-agent") ?? undefined);

  // Landing decision from the DERIVED profile state (authoritative, not guessed).
  const profileState = await customerProfileState(user);

  await audit({
    actorId: user.id,
    actorEmail: user.email,
    action: "LOGIN_GOOGLE",
    resourceType: "AUTH",
    ip,
    metadata: {
      ...(provisioned ? { provisioned: true } : {}),
      ...(customerCreated ? { customerCreated: true } : {}),
      profileComplete: profileState.profileComplete,
    },
  });

  const res = NextResponse.redirect(new URL(landingFor(user.role, profileState), externalOrigin(req)));
  res.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    expires: expiresAt,
    path: "/",
  });
  // Post-login welcome popup bridge (spec §6): a Google sign-in lands the
  // browser on a full-page redirect the SPA cannot observe in-memory, so the
  // success response carries a short-lived, NON-sensitive UI flag cookie. The
  // welcome system captures + clears it once on the landing page load — it
  // never replays on refresh and never reaches any auth logic.
  res.cookies.set("hms_welcome", "1", {
    httpOnly: false,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 120,
    path: "/",
  });
  return clearOAuth(res);
}
