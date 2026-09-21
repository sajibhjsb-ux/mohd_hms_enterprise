// MOHD.HMS ENTERPRISE — Mailbox administration (§28 — user↔mailbox mapping).
// GET  /api/v1/email/mailboxes → all mailboxes + members (email.config RBAC)
// POST /api/v1/email/mailboxes → create a PERSONAL or SHARED mailbox
// Managed ONLY from the Email Configuration module — never from the client,
// never from Settings (§3/§37).

import { z } from "zod";
import { handler, ok, parseBody } from "@/lib/hms/api";
import { PERMISSIONS } from "@/lib/hms/constants";
import { adminListMailboxes, adminCreateMailbox } from "@/lib/hms/email/client";

const createSchema = z.object({
  email: z.string().min(3).max(254),
  displayName: z.string().max(120).optional(),
  description: z.string().max(300).optional(),
  kind: z.enum(["PERSONAL", "SHARED"]).optional(),
  ownerUserId: z.string().max(64).nullable().optional(),
  isActive: z.boolean().optional(),
});

export const GET = handler(
  async () => ok(await adminListMailboxes()),
  { permission: PERMISSIONS.email_config },
);

export const POST = handler(
  async ({ req, user }) => {
    const body = await parseBody(req, createSchema);
    return ok(await adminCreateMailbox(user, body), 201);
  },
  { permission: PERMISSIONS.email_config },
);
