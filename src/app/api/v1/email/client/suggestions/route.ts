// MOHD.HMS ENTERPRISE — Recipient suggestions (§11).
// GET /api/v1/email/client/suggestions?q=...
// Returns only identities the caller is allowed to see: staff users, the
// caller's mailboxes, and customers only when the caller holds customers.read.

import { handler, ok } from "@/lib/hms/api";
import { PERMISSIONS } from "@/lib/hms/constants";
import { recipientSuggestions } from "@/lib/hms/email/client";

export const GET = handler(
  async ({ req, user }) => {
    const q = new URL(req.url).searchParams.get("q") ?? "";
    return ok(await recipientSuggestions(user, q));
  },
  { permission: PERMISSIONS.email_client },
);
