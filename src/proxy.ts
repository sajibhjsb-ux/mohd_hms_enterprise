// MOHD.HMS ENTERPRISE — public verification host canonicalisation (QR spec
// §36 legacy-record migration + §8/§9 public domain architecture).
//
// Old printed QR codes may carry a LEGACY verification origin (e.g.
// https://www.mohdhms.com/verify/…). The controlled-migration strategy:
//
//   OLD QR → old verification URL
//          → this proxy (only /verify/* is touched)
//          → 308 Permanent Redirect to the CANONICAL origin
//          → https://app.mohdhms.com/verify/{token}
//
// The canonical origin comes from PUBLIC_APP_URL (the same single source the
// QRService uses). When it is unset (development/sandbox), the proxy is a
// no-op and every host resolves tokens locally. Non-verification routes are
// NEVER redirected — www.mohdhms.com remains whatever the public site is.
//
// 308 preserves the method and the exact token path; browsers update the
// address bar, search engines consolidate, and printed codes keep working.
// (Next.js 16: the proxy file replaces the deprecated middleware convention.)

import { NextRequest, NextResponse } from "next/server";

export default function proxy(req: NextRequest) {
  const configured = (process.env.PUBLIC_APP_URL || "").replace(/\/+$/, "");
  if (!configured || !/^https:\/\//i.test(configured)) return NextResponse.next();

  let canonicalHost: string;
  try {
    canonicalHost = new URL(configured).host.toLowerCase();
  } catch {
    return NextResponse.next();
  }

  const xfHost = req.headers.get("x-forwarded-host")?.split(",")[0]?.trim();
  const incomingHost = (xfHost || req.headers.get("host") || "").toLowerCase();
  if (!incomingHost || incomingHost === canonicalHost) return NextResponse.next();

  // Already behind the canonical host (or an internal alias) — pass through.
  const url = req.nextUrl.clone();
  url.host = canonicalHost;
  url.protocol = "https:";
  url.port = "";
  return NextResponse.redirect(url, 308);
}

export const config = {
  // ONLY the public verification route — nothing else is ever canonicalised.
  matcher: ["/verify/:path*"],
};
