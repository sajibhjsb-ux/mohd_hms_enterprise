// GET /api/v1/auth/google/callback — Google OAuth redirect target.
// Validates state (single-use cookies), exchanges the code (PKCE), resolves
// the verified Google identity, links it to an EXISTING active account by
// googleId/email, opens a DB session (same primitive as password login) and
// lands the user in the app. Every failure path redirects to the login
// screen with ?googleError=<code> which the UI maps to a friendly message.

import { NextRequest, NextResponse } from "next/server";
import { randomBytes } from "crypto";
import { db } from "@/lib/db";
import { createSession, SESSION_COOKIE } from "@/lib/hms/auth";
import { clientIp, rateLimit } from "@/lib/hms/rate-limit";
import { audit } from "@/lib/hms/services";
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

  // Link existing account by googleId then by verified email; otherwise the
  // FIRST Google sign-in auto-provisions a customer/client account (no prior
  // password — login is Google-only for that account).
  let provisioned = false;
  let user = await db.user.findUnique({ where: { googleId: profile.sub } });
  if (!user) user = await db.user.findUnique({ where: { email: profile.email } });

  if (!user) {
    provisioned = true;
    try {
      user = await db.user.create({
        data: {
          email: profile.email,
          passwordHash: randomBytes(32).toString("hex"),
          name: profile.name?.trim() || profile.email.split("@")[0],
          role: "CUSTOMER",
          status: "ACTIVE",
          emailVerified: new Date(),
          googleId: profile.sub,
          avatarUrl: profile.picture ?? undefined,
          lastLoginAt: new Date(),
        },
      });
    } catch {
      user = await db.user.findUnique({ where: { googleId: profile.sub } });
      if (!user) user = await db.user.findUnique({ where: { email: profile.email } });
    }
  }

  if (!user) return fail("no_account", { email: profile.email });
  if (user.status !== "ACTIVE") return fail("account_disabled", { email: profile.email });

  await db.user.update({
    where: { id: user.id },
    data: {
      googleId: profile.sub,
      ...(profile.picture ? { avatarUrl: profile.picture } : {}),
      emailVerified: user.emailVerified ?? new Date(),
      lastLoginAt: new Date(),
    },
  });

  const { token, expiresAt } = await createSession(user.id, ip, req.headers.get("user-agent") ?? undefined);
  await audit({
    actorId: user.id,
    actorEmail: user.email,
    action: "LOGIN_GOOGLE",
    resourceType: "AUTH",
    ip,
    metadata: provisioned ? { provisioned: true } : undefined,
  });

  const res = NextResponse.redirect(new URL("/dashboard", externalOrigin(req)));
  res.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    expires: expiresAt,
    path: "/",
  });
  return clearOAuth(res);
}
