// MOHD.HMS ENTERPRISE — canonical Terms & Conditions (public).
// GET /api/v1/legal/terms (public) — the currently PUBLISHED document.
// This is the single authoritative source consumed by the /terms page, the
// customer portal, the consent gate and any future surfaces. No HTML ever
// leaves the API — sections are plain text rendered client-side.

import { handler, ok } from "@/lib/hms/api";
import { ensureLegalDocuments, getPublishedLegal } from "@/lib/hms/legal/legal";

export const GET = handler(
  async () => {
    await ensureLegalDocuments();
    return ok(await getPublishedLegal("TERMS"));
  },
  { auth: false }
);
