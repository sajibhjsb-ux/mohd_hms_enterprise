// GET /api/v1/auth/google — start the Google OAuth authorization-code flow.
// Issues single-use state + PKCE verifier cookies and redirects the browser
// to Google's consent screen. When the server has no Google credentials the
// user is bounced back to the login screen with ?googleError=not_configured.

import { NextRequest, NextResponse } from "next/server";
import { randomBytes } from "crypto";
import { clientIp, rateLimit } from "@/lib/hms/rate-limit";
import {
  googleAuthUrl,
  googleErrorRedirect,
  googleOAuthConfig,
  googleRedirectUri,
  OAUTH_COOKIE_MAX_AGE,
  OAUTH_STATE_COOKIE,
  OAUTH_VERIFIER_COOKIE,
  pkcePair,
} from "@/lib/hms/google-auth";

export async function GET(req: NextRequest) {
  const cfg = googleOAuthConfig();
  if (!cfg) return googleErrorRedirect(req, "not_configured");

  const ip = clientIp(req);
  const rl = rateLimit(`oauth-start:${ip}`, 30, 5 * 60 * 1000);
  if (!rl.allowed) return googleErrorRedirect(req, "rate_limited");

  const state = randomBytes(16).toString("base64url");
  const { verifier, challenge } = pkcePair();

  const url = googleAuthUrl({
    clientId: cfg.clientId,
    redirectUri: googleRedirectUri(req),
    state,
    challenge,
    // Optional convenience: pre-fills the email on Google's consent screen.
    loginHint: req.nextUrl.searchParams.get("login_hint")?.trim().toLowerCase() || undefined,
  });

  const res = NextResponse.redirect(url);
  const cookieBase = {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/api/v1/auth/google",
    maxAge: OAUTH_COOKIE_MAX_AGE,
  };
  res.cookies.set(OAUTH_STATE_COOKIE, state, cookieBase);
  res.cookies.set(OAUTH_VERIFIER_COOKIE, verifier, cookieBase);
  return res;
}
