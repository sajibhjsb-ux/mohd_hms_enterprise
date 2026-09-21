// MOHD.HMS ENTERPRISE — Email client attachment download.
//
// GET /api/v1/email/client/attachments/{id}?m=<messageId>
//   Serves attachment bytes through the authenticated API — the bucket stays
//   private. Authorization: the requester must own a mailbox row (any folder)
//   whose attachmentRefs contain the requested attachment id. No public URLs,
//   no presigned links, no direct object access.

import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { handler, Errors } from "@/lib/hms/api";
import { PERMISSIONS } from "@/lib/hms/constants";
import { storage, StorageError } from "@/lib/hms/storage";
import { parseAttachmentRefs, sanitizeFilename } from "@/lib/hms/email/client";

export const GET = handler(
  async ({ req, user }) => {
    const url = new URL(req.url);
    // /api/v1/email/client/attachments/{id}
    const attachmentId = url.pathname.split("/").filter(Boolean)[5] ?? "";
    const messageId = url.searchParams.get("m") ?? "";
    if (!attachmentId || !messageId) throw Errors.badRequest("Missing attachment or message reference.");

    const msg = await db.mailMessage.findFirst({
      where: { id: messageId, ownerId: user.id },
      select: { attachmentRefs: true },
    });
    if (!msg) throw Errors.notFound("Message not found.");

    const ref = parseAttachmentRefs(msg.attachmentRefs).find((a) => a.id === attachmentId);
    if (!ref) throw Errors.notFound("Attachment not found on this message.");

    let obj: { buffer: Buffer; contentType: string } | null = null;
    try {
      obj = await storage.get(ref.key);
    } catch (err) {
      if (err instanceof StorageError) throw Errors.internal(err.message);
      throw Errors.internal("The attachment could not be read.");
    }
    if (!obj) throw Errors.notFound("The attachment file is no longer available.");

    const filename = sanitizeFilename(ref.filename);
    return new NextResponse(new Uint8Array(obj.buffer), {
      status: 200,
      headers: {
        "Content-Type": ref.contentType || obj.contentType,
        "Content-Length": String(obj.buffer.length),
        "Content-Disposition": `attachment; filename="${filename.replace(/[^\x20-\x7e]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
        "Cache-Control": "private, no-store",
      },
    });
  },
  { permission: PERMISSIONS.email_client }
);
