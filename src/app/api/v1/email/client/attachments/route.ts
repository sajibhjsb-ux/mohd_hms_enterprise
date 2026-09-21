// MOHD.HMS ENTERPRISE — Email client attachment upload.
//
// POST /api/v1/email/client/attachments   (auth: email.client, multipart "file")
//   Stores the bytes in MinIO under a SERVER-GENERATED key inside the
//   uploader's own `mail/{userId}/` prefix — client filenames never become
//   object keys and ownership of the ref is bound to the uploader. Returns a
//   reference the compose UI attaches to a message; the send endpoint
//   re-verifies the prefix, so foreign keys can never be attached.
//   10 MB per file, max 10 attachments enforced again at send time.

import { randomUUID } from "crypto";
import { handler, ok, Errors, ApiError } from "@/lib/hms/api";
import { PERMISSIONS } from "@/lib/hms/constants";
import { storage, StorageError } from "@/lib/hms/storage";
import { buildAttachmentKey, sanitizeFilename } from "@/lib/hms/email/client";

const MAX_BYTES = 10 * 1024 * 1024; // 10 MB — professional mail attachments

export const POST = handler(
  async ({ req, user }) => {
    let form: FormData;
    try {
      form = await req.formData();
    } catch {
      throw Errors.badRequest("Expected a multipart form upload.");
    }
    const file = form.get("file");
    if (!(file instanceof File)) throw Errors.badRequest("No file was uploaded (field name: file).");
    if (file.size === 0) throw Errors.badRequest("The file is empty.");
    if (file.size > MAX_BYTES) {
      throw new ApiError(422, "FILE_TOO_LARGE", "Attachments are limited to 10 MB per file.");
    }

    const filename = sanitizeFilename(file.name || "attachment");
    const contentType = (file.type || "application/octet-stream").slice(0, 150);
    // Server-generated key under the uploader's own prefix (§14 policy).
    const key = buildAttachmentKey(user.id, filename);

    try {
      const buf = Buffer.from(await file.arrayBuffer());
      await storage.put(key, buf, contentType);
    } catch (err) {
      if (err instanceof StorageError) throw new ApiError(503, err.code, err.message);
      throw Errors.internal("The attachment could not be stored. Please try again.");
    }

    return ok({
      id: randomUUID(),
      key,
      filename,
      size: file.size,
      contentType,
    });
  },
  { permission: PERMISSIONS.email_client }
);
