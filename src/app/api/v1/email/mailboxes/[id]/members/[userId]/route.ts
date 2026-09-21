// MOHD.HMS ENTERPRISE — Mailbox membership (§28/§36 — assignment IS the gate).
// POST   /api/v1/email/mailboxes/[id]/members/[userId]  → add/update member
// DELETE /api/v1/email/mailboxes/[id]/members/[userId]  → remove member

import { z } from "zod";
import { handler, ok, parseBody } from "@/lib/hms/api";
import { PERMISSIONS } from "@/lib/hms/constants";
import { adminAddMailboxMember, adminRemoveMailboxMember } from "@/lib/hms/email/client";

const addSchema = z.object({ canSend: z.boolean().optional() });

function idsFrom(url: string): { mailboxId: string; userId: string } {
  const parts = new URL(url).pathname.split("/").filter(Boolean);
  return { mailboxId: parts[4] ?? "", userId: parts[6] ?? "" };
}

export const POST = handler(
  async ({ req, user }) => {
    const { mailboxId, userId } = idsFrom(req.url);
    const body = await parseBody(req, addSchema).catch(() => ({ canSend: true }));
    return ok(await adminAddMailboxMember(user, mailboxId, userId, body.canSend ?? true));
  },
  { permission: PERMISSIONS.email_config },
);

export const DELETE = handler(
  async ({ req, user }) => {
    const { mailboxId, userId } = idsFrom(req.url);
    return ok(await adminRemoveMailboxMember(user, mailboxId, userId));
  },
  { permission: PERMISSIONS.email_config },
);
