// MOHD.HMS ENTERPRISE — public company identity for legal pages.
// GET /api/v1/legal/company (public) — whitelisted identity fields ONLY
// (name/address/phone/email/website/country). The full settings map stays
// admin-only behind settings.read; this endpoint must never leak it.

import { handler, ok } from "@/lib/hms/api";
import { getCompanyIdentity } from "@/lib/hms/legal/legal";

export const GET = handler(
  async () => {
    return ok(await getCompanyIdentity());
  },
  { auth: false }
);
