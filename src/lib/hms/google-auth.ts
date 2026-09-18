// MOHD.HMS ENTERPRISE — Google OAuth 2.0 (Authorization Code flow + PKCE).
// Server-side helpers for the /api/v1/auth/google routes.
//
// Configuration (all optional — the feature is inert until credentials exist):
//   GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET — OAuth 2.0 Web client from
//     https://console.cloud.google.com/apis/credentials
//   GOOGLE_REDIRECT_URI — optional explicit override of the callback URL
//     (defaults to <request origin>/api/v1/auth/google/callback, honoring
//     x-forwarded-host/proto behind the gateway).
//   GOOGLE_AUTH_ENDPOINT / GOOGLE_TOKEN_ENDPOINT / GOOGLE_USERINFO_ENDPOINT —
//     optional endpoint overrides (defaults are Google's official endpoints;
//     useful for private deployments and local testing doubles).
//
// Sign-in policy: Google sign-in links to an EXISTING account by googleId or
// verified email; a first-time Google person is auto-provisioned as a CUSTOMER
// together with a canonical Customer identity (see the callback route) whose
// mobile number + address are completed during mandatory profile onboarding.
// There is deliberately NO open email/password self-registration — staff
// accounts are provisioned by administrators.

import "server-only";
import { createHash, randomBytes, timingSafeEqual } from "crypto";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

export const OAUTH_STATE_COOKIE = "hms_oauth_state";
export const OAUTH_VERIFIER_COOKIE = "hms_oauth_verifier";
export const OAUTH_COOKIE_MAX_AGE = 600; // 10 minutes, single-use

const AUTH_ENDPOINT = process.env.GOOGLE_AUTH_ENDPOINT?.trim() || "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = process.env.GOOGLE_TOKEN_ENDPOINT?.trim() || "https://oauth2.googleapis.com/token";
const USERINFO_ENDPOINT = process.env.GOOGLE_USERINFO_ENDPOINT?.trim() || "https://openidconnect.googleapis.com/v1/userinfo";

export type GoogleOAuthConfig = { clientId: string; clientSecret: string };

/** Configured only when both credentials are present (empty/absent = disabled). */
export function googleOAuthConfig(): GoogleOAuthConfig | null {
  const clientId = process.env.GOOGLE_CLIENT_ID?.trim() ?? "";
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim() ?? "";
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

/** Public origin of this deployment (honors reverse-proxy forwarded headers). */
export function externalOrigin(req: NextRequest): string {
  const host = req.headers.get("x-forwarded-host")?.split(",")[0]?.trim();
  if (host) {
    const proto = req.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() || "https";
    return `${proto}://${host}`;
  }
  return new URL(req.url).origin;
}

/** The callback URL registered in Google Cloud Console (exact-match required). */
export function googleRedirectUri(req: NextRequest): string {
  const override = process.env.GOOGLE_REDIRECT_URI?.trim();
  return override || `${externalOrigin(req)}/api/v1/auth/google/callback`;
}

/** PKCE S256 pair for the authorization request. */
export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

/** Constant-time string comparison (OAuth state check). */
export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ba.length === 0 || ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/** Build Google's consent-screen URL. */
export function googleAuthUrl(opts: {
  clientId: string;
  redirectUri: string;
  state: string;
  challenge: string;
  loginHint?: string;
}): string {
  const u = new URL(AUTH_ENDPOINT);
  u.searchParams.set("client_id", opts.clientId);
  u.searchParams.set("redirect_uri", opts.redirectUri);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", "openid email profile");
  u.searchParams.set("state", opts.state);
  u.searchParams.set("code_challenge", opts.challenge);
  u.searchParams.set("code_challenge_method", "S256");
  u.searchParams.set("prompt", "select_account");
  if (opts.loginHint) u.searchParams.set("login_hint", opts.loginHint);
  return u.toString();
}

export type GoogleProfile = {
  sub: string;
  email: string;
  emailVerified: boolean;
  name: string | null;
  picture: string | null;
};

/** Exchange the authorization code for tokens. Returns the access token or null. */
export async function exchangeCodeForTokens(
  code: string,
  cfg: GoogleOAuthConfig,
  opts: { redirectUri: string; verifier: string }
): Promise<string | null> {
  try {
    const res = await fetch(TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: cfg.clientId,
        client_secret: cfg.clientSecret,
        redirect_uri: opts.redirectUri,
        grant_type: "authorization_code",
        code_verifier: opts.verifier,
      }),
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { access_token?: unknown };
    return typeof json.access_token === "string" && json.access_token ? json.access_token : null;
  } catch {
    return null;
  }
}

/** Fetch the verified identity from the provider's userinfo endpoint. */
export async function fetchGoogleProfile(accessToken: string): Promise<GoogleProfile | null> {
  try {
    const res = await fetch(USERINFO_ENDPOINT, {
      headers: { authorization: `Bearer ${accessToken}` },
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const p = (await res.json()) as {
      sub?: unknown;
      email?: unknown;
      email_verified?: unknown;
      name?: unknown;
      picture?: unknown;
    };
    if (typeof p.sub !== "string" || !p.sub || typeof p.email !== "string" || !p.email) return null;
    return {
      sub: p.sub,
      email: p.email.trim().toLowerCase(),
      emailVerified: p.email_verified !== false,
      name: typeof p.name === "string" && p.name.trim() ? p.name.trim() : null,
      picture: typeof p.picture === "string" && p.picture ? p.picture : null,
    };
  } catch {
    return null;
  }
}

/** Redirect back to the login screen carrying a stable, client-mapped error code. */
export function googleErrorRedirect(req: NextRequest, code: string): NextResponse {
  const url = new URL("/", externalOrigin(req));
  url.searchParams.set("googleError", code);
  return NextResponse.redirect(url);
}
