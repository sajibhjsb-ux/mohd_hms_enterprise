// MOHD.HMS ENTERPRISE — canonical Privacy Policy (public).
// GET /api/v1/legal/privacy (public) — the currently PUBLISHED document.

import { handler, ok } from "@/lib/hms/api";
import { ensureLegalDocuments, getPublishedLegal } from "@/lib/hms/legal/legal";

export const GET = handler(
  async () => {
    await ensureLegalDocuments();
    return ok(await getPublishedLegal("PRIVACY"));
  },
  { auth: false }
);
