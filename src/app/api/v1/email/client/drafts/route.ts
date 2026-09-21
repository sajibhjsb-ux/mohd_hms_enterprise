// MOHD.HMS ENTERPRISE — Drafts (§10 — persisted in PostgreSQL, never localStorage).
// POST /api/v1/email/client/drafts → create a draft (returns the full draft).
// A `forwardFrom` field clones the original message's attachments (§18).

import { z } from "zod";
import { handler, ok, parseBody } from "@/lib/hms/api";
import { PERMISSIONS } from "@/lib/hms/constants";
import { createDraft } from "@/lib/hms/email/client";

export const draftSchema = z.object({
  mailboxId: z.string().min(1).max(64),
  to: z.union([z.array(z.string().max(254)).max(100), z.string().max(8000)]).optional(),
  cc: z.union([z.array(z.string().max(254)).max(100), z.string().max(8000)]).optional(),
  bcc: z.union([z.array(z.string().max(254)).max(100), z.string().max(8000)]).optional(),
  subject: z.string().max(500).optional(),
  body: z.string().max(200_000).optional(),
  attachmentFileIds: z.array(z.string().max(64)).max(10).optional(),
  forwardFrom: z.string().max(64).optional(),
});

export const POST = handler(
  async ({ req, user }) => {
    const body = await parseBody(req, draftSchema);
    return ok(await createDraft(user, body), 201);
  },
  { permission: PERMISSIONS.email_client },
);
