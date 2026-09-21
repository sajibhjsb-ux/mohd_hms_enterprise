// MOHD.HMS ENTERPRISE — Email client delivery actions on OWN outbox mail.
// Reuses the ONE EmailService retry/cancel logic — no second queue, no second
// worker. Ownership is enforced against MailMessage (ownerId + emailLogId).

import { z } from "zod";
import { db } from "@/lib/db";
import { handler, ok, Errors, parseBody } from "@/lib/hms/api";
import { PERMISSIONS } from "@/lib/hms/constants";
import { retryEmail, cancelEmail } from "@/lib/hms/email/service";

const schema = z.object({ action: z.enum(["retry", "cancel"]) });

function idFromPath(url: string): string {
  // /api/v1/email/client/messages/{id}/delivery
  return new URL(url).pathname.split("/").filter(Boolean)[5] ?? "";
}

export const POST = handler(
  async ({ req, user }) => {
    const { action } = await parseBody(req, schema);
    const id = idFromPath(req.url);

    const msg = await db.mailMessage.findFirst({
      where: { id, ownerId: user.id, direction: "OUT" },
      select: { id: true, folder: true, status: true, emailLogId: true },
    });
    if (!msg) throw Errors.notFound("Message not found.");
    if (msg.folder !== "OUTBOX" || !msg.emailLogId) {
      throw Errors.badRequest("Only queued or failed outbox email can be retried or canceled.");
    }

    const result = action === "retry" ? await retryEmail(msg.emailLogId) : await cancelEmail(msg.emailLogId);
    if (!result.ok) throw Errors.conflict(result.reason ?? "The delivery state changed. Refresh and try again.");

    return ok({ id: msg.id, action, done: true });
  },
  { permission: PERMISSIONS.email_client }
);
