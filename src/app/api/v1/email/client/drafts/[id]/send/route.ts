// MOHD.HMS ENTERPRISE — Send draft (§12 — real send through the ONE EmailService).
// POST /api/v1/email/client/drafts/[id]/send
// Validates recipients, materializes attachments into the mail-owned MinIO
// prefix, queues the delivery and answers honestly — the UI never shows
// "sent" unless the backend accepted the operation (§49).

import { z } from "zod";
import { handler, ok, parseBody, Errors } from "@/lib/hms/api";
import { PERMISSIONS } from "@/lib/hms/constants";
import { rateLimit, clientIp } from "@/lib/hms/rate-limit";
import { sendCompose } from "@/lib/hms/email/client";

const sendSchema = z.object({
  to: z.union([z.array(z.string().max(254)).max(100), z.string().max(8000)]),
  cc: z.union([z.array(z.string().max(254)).max(100), z.string().max(8000)]).optional(),
  bcc: z.union([z.array(z.string().max(254)).max(100), z.string().max(8000)]).optional(),
  subject: z.string().max(500).optional(),
  body: z.string().max(200_000).optional(),
  attachmentFileIds: z.array(z.string().max(64)).max(10).optional(),
});

export const POST = handler(
  async ({ req, user }) => {
    // Flood guard — one user cannot flood mailboxes from the client (§39 spirit).
    const limit = rateLimit(`mail-send:${user.id}:${clientIp(req)}`, 30, 3_600_000);
    if (!limit.allowed) {
      throw Errors.tooMany(`Send rate limit reached — try again in ${limit.retryAfterSec}s.`);
    }
    const draftId = new URL(req.url).pathname.split("/").filter(Boolean)[5] ?? "";
    const body = await parseBody(req, sendSchema);
    // The sender mailbox comes from the draft itself (server-authorized) —
    // never from the browser (§45).
    return ok(await sendCompose(user, { ...body, draftId }));
  },
  { permission: PERMISSIONS.email_client },
);
