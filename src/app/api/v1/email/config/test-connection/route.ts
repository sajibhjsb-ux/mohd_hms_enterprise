// MOHD.HMS ENTERPRISE — Test SMTP connection (§27).
// The backend performs a REAL SMTP conversation (TCP connect + EHLO + optional
// STARTTLS/AUTH verify) against the configured server. Success is never faked
// and credentials are never part of any error message.

import { handler, ok } from "@/lib/hms/api";
import { PERMISSIONS } from "@/lib/hms/constants";
import { audit } from "@/lib/hms/services";
import { testConnection } from "@/lib/hms/email/service";

export const POST = handler(
  async ({ user }) => {
    const result = await testConnection();
    void audit({
      actorId: user.id, actorEmail: user.email, action: "EMAIL_TEST_CONNECTION",
      resourceType: "EMAIL_CONFIG", resourceId: "singleton",
      metadata: { ok: result.ok }, // detail intentionally not audited (may name the host failure mode)
    });
    return ok(result);
  },
  { permission: PERMISSIONS.email_config }
);
