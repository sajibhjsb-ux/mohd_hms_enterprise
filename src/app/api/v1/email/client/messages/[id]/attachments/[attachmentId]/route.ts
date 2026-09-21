// MOHD.HMS ENTERPRISE — Email client attachments (§19/§20).
// GET    /api/v1/email/client/messages/[id]/attachments                     → attach a File
// POST     body { fileId } — the file must be the user's own or shared with
//          them (object-level authorization through the Files core).
// DELETE /api/v1/email/client/messages/[id]/attachments/[attachmentId]      → detach (drafts only)
// GET    /api/v1/email/client/messages/[id]/attachments/[attachmentId]      → download stream
// Downloads are always authenticated + authorized and served with an
// attachment disposition — MinIO objects stay fully private (§19/§44).

import { NextResponse } from "next/server";
import { z } from "zod";
import { handler, ok, parseBody } from "@/lib/hms/api";
import { PERMISSIONS } from "@/lib/hms/constants";
import { attachFileToMessage, detachAttachment, readAttachment } from "@/lib/hms/email/client";

const bodySchema = z.object({ fileId: z.string().min(1).max(64) });

function idsFrom(url: string): { messageId: string; attachmentId: string } {
  const parts = new URL(url).pathname.split("/").filter(Boolean);
  return { messageId: parts[5] ?? "", attachmentId: parts[7] ?? "" };
}

export const POST = handler(
  async ({ req, user }) => {
    const messageId = new URL(req.url).pathname.split("/").filter(Boolean)[5] ?? "";
    const body = await parseBody(req, bodySchema);
    const att = await attachFileToMessage(user, messageId, body.fileId);
    return ok({ id: att.id, filename: att.filename, sizeBytes: att.sizeBytes, contentType: att.contentType }, 201);
  },
  { permission: PERMISSIONS.email_client },
);

export const GET = handler(
  async ({ req, user }) => {
    const { messageId, attachmentId } = idsFrom(req.url);
    const file = await readAttachment(user.id, messageId, attachmentId);
    return new NextResponse(new Uint8Array(file.buffer), {
      status: 200,
      headers: {
        "Content-Type": file.contentType,
        "Content-Length": String(file.buffer.length),
        "Content-Disposition": `attachment; filename="attachment"; filename*=UTF-8''${encodeURIComponent(file.filename)}`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  },
  { permission: PERMISSIONS.email_client },
);

export const DELETE = handler(
  async ({ req, user }) => {
    const { messageId, attachmentId } = idsFrom(req.url);
    await detachAttachment(user, messageId, attachmentId);
    return ok({ ok: true });
  },
  { permission: PERMISSIONS.email_client },
);
