// MOHD.HMS ENTERPRISE — Email client bootstrap (§6–§9).
// GET /api/v1/email/client/bootstrap
// Honest client state: the user's mailboxes (§28 mapping), per-folder counts
// and the REAL SMTP status. No mock data is ever produced here.

import { handler, ok } from "@/lib/hms/api";
import { PERMISSIONS } from "@/lib/hms/constants";
import { bootstrap } from "@/lib/hms/email/client";

export const GET = handler(
  async ({ user }) => ok(await bootstrap(user.id)),
  { permission: PERMISSIONS.email_client },
);
