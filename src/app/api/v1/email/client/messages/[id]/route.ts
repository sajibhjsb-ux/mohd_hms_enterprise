// MOHD.HMS ENTERPRISE — Email client message detail (single mailbox row).
//
// GET    — full message (body rendered in the UI inside a SANDBOXED iframe;
//          the body is additionally passed through the shared email HTML
//          sanitizer as defense-in-depth).
// PATCH  — flags (read/starred) + folder moves (backend-validated per
//          direction; TRASH keeps the origin folder for exact restore).
// DELETE — permanent remove; only from TRASH or DRAFT. Attachment objects
//          are removed from MinIO when the requester owns the only copies
//          (best-effort; never blocks the delete).

import { db } from "@/lib/db";
import { handler, ok, Errors } from "@/lib/hms/api";
import { PERMISSIONS } from "@/lib/hms/constants";
import { sanitizeEmailHtml } from "@/lib/hms/email/layout";
import { cancelEmail } from "@/lib/hms/email/service";
import {
  canMoveTo, findOwnedMessage, parseAttachmentRefs, removeAttachmentObjects,
} from "@/lib/hms/email/client";

function idFromPath(url: string): string {
  // /api/v1/email/client/messages/{id}
  return new URL(url).pathname.split("/").filter(Boolean)[5] ?? "";
}

export const GET = handler(
  async ({ req, user }) => {
    const id = idFromPath(req.url);
    const msg = await findOwnedMessage(id, user.id);
    if (!msg) throw Errors.notFound("Message not found.");

    const attachments = parseAttachmentRefs(msg.attachmentRefs);
    const bodyHtml =
      msg.direction === "OUT" && msg.folder === "DRAFT"
        ? msg.bodyHtml // own draft: exact content for editing
        : sanitizeEmailHtml(msg.bodyHtml);

    return ok({
      ...msg,
      bodyHtml,
      attachments,
      attachmentRefs: undefined,
    });
  },
  { permission: PERMISSIONS.email_client }
);

export const PATCH = handler(
  async ({ req, user }) => {
    const id = idFromPath(req.url);
    const msg = await findOwnedMessage(id, user.id);
    if (!msg) throw Errors.notFound("Message not found.");

    const body = (await req.json().catch(() => ({}))) as {
      read?: boolean;
      starred?: boolean;
      folder?: string;
    };

    const data: { readAt?: Date | null; starredAt?: Date | null; folder?: string; originFolder?: string } = {};
    if (typeof body.read === "boolean") data.readAt = body.read ? new Date() : null;
    if (typeof body.starred === "boolean") data.starredAt = body.starred ? new Date() : null;

    if (typeof body.folder === "string") {
      const target = body.folder.toUpperCase();
      const verdict = canMoveTo(msg.direction, msg.folder, target as never, msg.status);
      if (!verdict.ok) throw Errors.badRequest(verdict.reason ?? "That move is not allowed.");
      data.folder = target;
      // TRASH keeps the origin for exact restore; leaving TRASH clears it.
      if (target === "TRASH") data.originFolder = msg.folder === "TRASH" ? msg.originFolder : msg.folder;
      if (msg.folder === "TRASH") data.originFolder = "";
    }

    const updated = await db.mailMessage.update({ where: { id: msg.id }, data });
    return ok({
      id: updated.id,
      folder: updated.folder,
      readAt: updated.readAt,
      starredAt: updated.starredAt,
      originFolder: updated.originFolder,
    });
  },
  { permission: PERMISSIONS.email_client }
);

export const DELETE = handler(
  async ({ req, user }) => {
    const id = idFromPath(req.url);
    const msg = await findOwnedMessage(id, user.id);
    if (!msg) throw Errors.notFound("Message not found.");
    if (msg.folder !== "TRASH" && msg.folder !== "DRAFT") {
      throw Errors.badRequest("Move the message to Trash before deleting it permanently.");
    }

    // An outbox row still holding an active delivery is canceled first so the
    // worker can never send a deleted message.
    if (msg.emailLogId && msg.status !== "SENT") {
      await cancelEmail(msg.emailLogId).catch(() => undefined);
    }

    const attachments = parseAttachmentRefs(msg.attachmentRefs);
    await db.mailMessage.delete({ where: { id: msg.id } });

    // Attachment bytes: remove objects that are no longer referenced by any
    // other mailbox copy (internal copies share the same keys).
    for (const ref of attachments) {
      const stillUsed = await db.mailMessage.count({
        where: { attachmentRefs: { contains: ref.key }, id: { not: msg.id } },
      });
      if (stillUsed === 0) await removeAttachmentObjects([ref]);
    }

    return ok({ id: msg.id, deleted: true });
  },
  { permission: PERMISSIONS.email_client }
);
