// MOHD.HMS ENTERPRISE — Email client message retry (§12/§14).
// POST /api/v1/email/client/messages/[id]/retry
// Requeues a FAILED client email through the EXISTING EmailService retry
// policy. A SENT email is never retried (no duplicate delivery).

import { handler, ok } from "@/lib/hms/api";
import { PERMISSIONS } from "@/lib/hms/constants";
import { retryMessage } from "@/lib/hms/email/client";

export const POST = handler(
  async ({ req, user }) => {
    const id = new URL(req.url).pathname.split("/").filter(Boolean)[5] ?? "";
    return ok(await retryMessage(user, id));
  },
  { permission: PERMISSIONS.email_client },
);
