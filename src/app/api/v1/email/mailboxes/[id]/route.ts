// MOHD.HMS ENTERPRISE — Mailbox administration (§28).
// PATCH  /api/v1/email/mailboxes/[id] → update mailbox (owner, name, active…)
// DELETE /api/v1/email/mailboxes/[id] → delete (only when it holds no messages)

import { z } from "zod";
import { handler, ok, parseBody } from "@/lib/hms/api";
import { PERMISSIONS } from "@/lib/hms/constants";
import { adminUpdateMailbox, adminDeleteMailbox } from "@/lib/hms/email/client";

const updateSchema = z.object({
  email: z.string().min(3).max(254).optional(),
  displayName: z.string().max(120).optional(),
  description: z.string().max(300).optional(),
  kind: z.enum(["PERSONAL", "SHARED"]).optional(),
  ownerUserId: z.string().max(64).nullable().optional(),
  isActive: z.boolean().optional(),
});

function idFrom(url: string): string {
  return new URL(url).pathname.split("/").filter(Boolean)[4] ?? "";
}

export const PATCH = handler(
  async ({ req, user }) => {
    const body = await parseBody(req, updateSchema);
    return ok(await adminUpdateMailbox(user, idFrom(req.url), body));
  },
  { permission: PERMISSIONS.email_config },
);

export const DELETE = handler(
  async ({ req, user }) => {
    await adminDeleteMailbox(user, idFrom(req.url));
    return ok({ ok: true });
  },
  { permission: PERMISSIONS.email_config },
);
