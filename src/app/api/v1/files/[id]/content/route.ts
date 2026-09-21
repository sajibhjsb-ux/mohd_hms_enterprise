// MOHD.HMS ENTERPRISE — Secure file content (§10/§12/§21/§39/§43).
// GET /api/v1/files/{id}/content?as=inline|attachment
//   as=inline     → preview (VIEW permission + mime on the preview allowlist).
//   as=attachment → download (DOWNLOAD permission). HTML/SVG/etc. always
//                   download as attachments — never rendered inline (XSS §36).
// Bytes stream from the private bucket through this authenticated route —
// no presigned URLs, no public objects (§10). Every access is audited.

import { NextResponse } from "next/server";
import { handler, Errors } from "@/lib/hms/api";
import { PERMISSIONS } from "@/lib/hms/constants";
import { db } from "@/lib/db";
import { audit } from "@/lib/hms/services";
import { storage } from "@/lib/hms/storage";
import { assertRolePermission, canAccessFile, dispositionFor, withParams
} from "@/lib/hms/files/service";

type Ctx = { params: Promise<{ id: string }> };

export const GET = withParams<{ id: string }>(async ({ req, user, params }) => {
    const { id } = params;
    assertRolePermission(user, PERMISSIONS.files_read);
    const as = new URL(req.url).searchParams.get("as") === "inline" ? "inline" : "attachment";

    const file = await db.fileEntry.findUnique({
      where: { id },
      select: { id: true, name: true, mimeType: true, sizeBytes: true, objectKey: true, trashedAt: true },
    });
    if (!file || file.trashedAt) throw Errors.notFound("File not found.");

    // Object-level authorization (§12/§39) — owner or active grant only.
    if (as === "inline") {
      const access = await canAccessFile(user, id, "VIEW");
      if (dispositionFor(file.mimeType) !== "inline") {
        // Not previewable → downgrade to a download (needs DOWNLOAD permission).
        await canAccessFile(user, id, "DOWNLOAD");
      }
      void access;
    } else {
      await canAccessFile(user, id, "DOWNLOAD");
    }

    const obj = await storage.get(file.objectKey);
    if (!obj) throw Errors.notFound("File content is missing from storage.");

    void audit({
      actorId: user.id, actorEmail: user.email,
      action: as === "inline" ? "FILE_VIEWED" : "FILE_DOWNLOADED",
      resourceType: "FILE", resourceId: id,
      metadata: { name: file.name, sizeBytes: file.sizeBytes, as },
    });

    const safeName = file.name.replace(/["\\\r\n]/g, "_");
    return new NextResponse(new Uint8Array(obj.buffer), {
      status: 200,
      headers: {
        "Content-Type": file.mimeType || "application/octet-stream",
        "Content-Length": String(obj.buffer.length),
        "Content-Disposition": `${as === "inline" && dispositionFor(file.mimeType) === "inline" ? "inline" : "attachment"}; filename="${safeName}"`,
        "Cache-Control": "private, max-age=300",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; sandbox",
      },
    });
  }, { permission: PERMISSIONS.files_read });
