// MOHD.HMS ENTERPRISE — record acceptance of the current Terms & Conditions.
// POST /api/v1/legal/terms/accept (authenticated)
//
// Backend-authoritative consent: the server decides WHICH version is being
// accepted (the currently published one — the client never supplies it) and
// stores one append-only acceptance record per user per document version
// (unique userId+documentId makes repeat calls idempotent). Records keep the
// user, version, timestamp, context and IP/UA metadata under the existing
// privacy architecture; nothing sensitive (no credentials, no codes) is stored.

import { handler, ok } from "@/lib/hms/api";
import { recordTermsAcceptance } from "@/lib/hms/legal/legal";

function clientIp(req: import("next/server").NextRequest): string {
  return (
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    req.headers.get("x-real-ip") ??
    ""
  );
}

export const POST = handler(
  async ({ req, user }) => {
    const status = await recordTermsAcceptance(user, {
      ip: clientIp(req),
      userAgent: req.headers.get("user-agent") ?? undefined,
      context: "WEB_APP",
    });
    return ok(status);
  },
  { auth: true }
);
