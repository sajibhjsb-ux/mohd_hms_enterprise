// MOHD.HMS ENTERPRISE — Email health dashboard metrics (§29).
// Every number comes from real EmailLog/config data — no fake or static values.

import { handler, ok } from "@/lib/hms/api";
import { PERMISSIONS } from "@/lib/hms/constants";
import { emailHealth } from "@/lib/hms/email/service";

export const GET = handler(
  async () => ok(await emailHealth()),
  { permission: PERMISSIONS.email_view }
);
