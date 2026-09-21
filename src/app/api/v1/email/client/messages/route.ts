// MOHD.HMS ENTERPRISE — Email client message list + server-side search (§21).
// GET /api/v1/email/client/messages?folder=INBOX&q=...&flag=unread&page=1
// Every query is scoped to the mailboxes the authenticated user can access —
// search is NEVER performed client-side over an unrestricted set (§21/§44).

import { handler, ok } from "@/lib/hms/api";
import { PERMISSIONS } from "@/lib/hms/constants";
import { listMessages } from "@/lib/hms/email/client";

export const GET = handler(
  async ({ req, user }) => {
    const sp = new URL(req.url).searchParams;
    // folder is OPTIONAL: absent + q → global search across every folder (§21).
    return ok(await listMessages(user.id, {
      folder: sp.get("folder") ?? undefined,
      q: sp.get("q") ?? undefined,
      flag: sp.get("flag") ?? undefined,
      from: sp.get("from") ?? undefined,
      dateFrom: sp.get("dateFrom") ?? undefined,
      dateTo: sp.get("dateTo") ?? undefined,
      page: Number(sp.get("page") ?? "1") || 1,
    }));
  },
  { permission: PERMISSIONS.email_client },
);
