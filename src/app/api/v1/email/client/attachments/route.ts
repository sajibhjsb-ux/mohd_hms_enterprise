// MOHD.HMS ENTERPRISE — Compose attachment upload (§19/§20).
// POST /api/v1/email/client/attachments  (multipart/form-data, field "file")
// The file becomes a REAL File in the user's Files space ("Email Attachments"
// folder, quota enforced) stored in MinIO — metadata only in PostgreSQL.

import { handler, ok, Errors } from "@/lib/hms/api";
import { PERMISSIONS } from "@/lib/hms/constants";
import { rateLimit } from "@/lib/hms/rate-limit";
import { uploadComposeAttachment } from "@/lib/hms/email/client";

export const POST = handler(
  async ({ req, user }) => {
    const limit = rateLimit(`mail-attach:${user.id}`, 60, 3_600_000);
    if (!limit.allowed) throw Errors.tooMany(`Too many uploads — try again in ${limit.retryAfterSec}s.`);

    const form = await req.formData().catch(() => null);
    const file = form?.get("file");
    if (!(file instanceof File)) throw Errors.badRequest("Attach a file in the 'file' field.");
    const buffer = Buffer.from(await file.arrayBuffer());
    const result = await uploadComposeAttachment(user, {
      name: file.name || "attachment",
      buffer,
      mimeType: file.type || "application/octet-stream",
    });
    return ok(result, 201);
  },
  { permission: PERMISSIONS.email_client },
);
