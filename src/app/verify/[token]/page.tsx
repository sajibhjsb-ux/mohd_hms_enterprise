// MOHD.HMS ENTERPRISE — PUBLIC verification page (ch.35 spec §6/§41/§42/§48).
// Reached ONLY by scanning a MOHD.HMS QR code: /verify/{token}. It is a real
// route segment of the existing application (not a second app, not a menu
// item — §4/§67) and works without signing in whenever the record is
// intentionally publicly verifiable (§5).
//
// The page itself NEVER decides validity: every claim on screen comes from
// the authoritative backend via GET /api/v1/public/verify/{token} (§62) and
// online connectivity is required (§48 — offline scanners see an honest
// "unable to connect" state, never a fake verified badge).

import type { Metadata } from "next";
import { VerifyClient } from "./verify-client";

export const metadata: Metadata = {
  title: "Verify — MOHD.HMS ENTERPRISE",
  description: "Online verification of MOHD.HMS ENTERPRISE documents, equipment and records.",
  robots: { index: false, follow: false },
};

export default async function VerifyPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <VerifyClient token={token} />;
}
