// MOHD.HMS ENTERPRISE — Retry a failed/dead/canceled email (§37).
// Retrying a SENT email is refused — no duplicate sends.

import { NextRequest } from "next/server";
import { handler, ok, Errors } from "@/lib/hms/api";
import { PERMISSIONS } from "@/lib/hms/constants";
import { audit } from "@/lib/hms/services";
import { retryEmail } from "@/lib/hms/email/service";

export const POST = handler(
  async ({ req, user }) => {
    const id = new URL(req.url).pathname.split("/").filter(Boolean)[4] ?? "";
    const result = await retryEmail(id);
    if (!result.ok) throw Errors.badRequest(result.reason ?? "This email cannot be retried.");
    await audit({ actorId: user.id, actorEmail: user.email, action: "EMAIL_RETRIED", resourceType: "EMAIL", resourceId: id, metadata: { by: user.email } });
    return ok({ id, status: "QUEUED" });
  },
  { permission: PERMISSIONS.email_actions }
);
