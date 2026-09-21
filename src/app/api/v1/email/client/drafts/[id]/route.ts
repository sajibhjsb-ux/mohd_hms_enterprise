// MOHD.HMS ENTERPRISE — Draft update / discard (§10).
// PATCH  /api/v1/email/client/drafts/[id]  → update draft (autosave / resume)
// DELETE /api/v1/email/client/drafts/[id]  → discard draft

import { z } from "zod";
import { handler, ok, parseBody } from "@/lib/hms/api";
import { PERMISSIONS } from "@/lib/hms/constants";
import { updateDraft, deleteDraft } from "@/lib/hms/email/client";

const draftSchema = z.object({
  mailboxId: z.string().min(1).max(64),
  to: z.union([z.array(z.string().max(254)).max(100), z.string().max(8000)]).optional(),
  cc: z.union([z.array(z.string().max(254)).max(100), z.string().max(8000)]).optional(),
  bcc: z.union([z.array(z.string().max(254)).max(100), z.string().max(8000)]).optional(),
  subject: z.string().max(500).optional(),
  body: z.string().max(200_000).optional(),
  attachmentFileIds: z.array(z.string().max(64)).max(10).optional(),
});

function idFrom(url: string): string {
  return new URL(url).pathname.split("/").filter(Boolean)[5] ?? "";
}

export const PATCH = handler(
  async ({ req, user }) => {
    const body = await parseBody(req, draftSchema);
    return ok(await updateDraft(user, idFrom(req.url), body));
  },
  { permission: PERMISSIONS.email_client },
);

export const DELETE = handler(
  async ({ req, user }) => {
    await deleteDraft(user, idFrom(req.url));
    return ok({ ok: true });
  },
  { permission: PERMISSIONS.email_client },
);
