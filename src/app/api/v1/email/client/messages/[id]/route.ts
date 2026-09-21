// MOHD.HMS ENTERPRISE — Email client message detail + actions (§15/§23–§27).
// GET    /api/v1/email/client/messages/[id]  → full message + attachments + thread
// PATCH  /api/v1/email/client/messages/[id]  → { action, folder? } read/unread/
//                                              star/unstar/important/normal/
//                                              archive/spam/trash/restore/move
// DELETE /api/v1/email/client/messages/[id]  → trash, or permanent inside Trash

import { z } from "zod";
import { handler, ok, parseBody, Errors } from "@/lib/hms/api";
import { PERMISSIONS } from "@/lib/hms/constants";
import { getMessage, actOnMessage, deleteMessage, type MessageAction } from "@/lib/hms/email/client";
import { sanitizeEmailHtml } from "@/lib/hms/email/layout";

const ACTIONS = new Set(["read", "unread", "star", "unstar", "important", "normal", "archive", "spam", "trash", "restore", "move"]);
const actionSchema = z.object({
  action: z.string().refine((v) => ACTIONS.has(v), "Unknown action."),
  folder: z.string().max(20).optional(),
});

function idFrom(url: string): string {
  return new URL(url).pathname.split("/").filter(Boolean)[5] ?? "";
}

export const GET = handler(
  async ({ req, user }) => {
    const message = await getMessage(user.id, idFrom(req.url));
    // Defense-in-depth: the stored HTML is application-generated, but it is
    // re-sanitized on read (§44 — HTML/email content attacks).
    return ok({ ...message, bodyHtml: sanitizeEmailHtml(message.bodyHtml) });
  },
  { permission: PERMISSIONS.email_client },
);

export const PATCH = handler(
  async ({ req, user }) => {
    const body = await parseBody(req, actionSchema);
    return ok(await actOnMessage(user, idFrom(req.url), body.action as MessageAction, body.folder));
  },
  { permission: PERMISSIONS.email_client },
);

export const DELETE = handler(
  async ({ req, user }) => {
    const permanent = new URL(req.url).searchParams.get("permanent") === "1";
    return ok(await deleteMessage(user, idFrom(req.url), permanent));
  },
  { permission: PERMISSIONS.email_client },
);

void Errors;
