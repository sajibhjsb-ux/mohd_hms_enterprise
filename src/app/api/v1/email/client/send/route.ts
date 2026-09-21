// MOHD.HMS ENTERPRISE — Direct compose send (§12).
// POST /api/v1/email/client/send
// Compose + send in ONE call (the Compose page without an intermediate
// draft). Honest result: the response reports QUEUED until the worker's real
// SMTP outcome lands in the Outbox (§49).

import { z } from "zod";
import { handler, ok, parseBody, Errors } from "@/lib/hms/api";
import { PERMISSIONS } from "@/lib/hms/constants";
import { rateLimit, clientIp } from "@/lib/hms/rate-limit";
import { sendCompose } from "@/lib/hms/email/client";

const sendSchema = z.object({
  mailboxId: z.string().min(1).max(64),
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
    const body = await parseBody(req, sendSchema);
    return ok(await sendCompose(user, body));
  },
  { permission: PERMISSIONS.email_client },
);
