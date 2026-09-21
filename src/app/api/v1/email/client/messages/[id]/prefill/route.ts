// MOHD.HMS ENTERPRISE — Compose prefill for Reply / Reply-All / Forward (§16–§18).
// GET /api/v1/email/client/messages/[id]/prefill?mode=reply|replyAll|forward
// The server resolves the recipients/subject/quote — BCC is never carried over.

import { handler, ok, Errors } from "@/lib/hms/api";
import { PERMISSIONS } from "@/lib/hms/constants";
import { composePrefill } from "@/lib/hms/email/client";

export const GET = handler(
  async ({ req, user }) => {
    const url = new URL(req.url);
    const id = url.pathname.split("/").filter(Boolean)[5] ?? "";
    const mode = url.searchParams.get("mode") ?? "reply";
    if (!(mode === "reply" || mode === "replyAll" || mode === "forward")) {
      throw Errors.badRequest("mode must be reply, replyAll or forward.");
    }
    return ok(await composePrefill(user.id, mode, id));
  },
  { permission: PERMISSIONS.email_client },
);
