// MOHD.HMS ENTERPRISE — Upload session status/abort (§8: resume + cancel).
// GET    — session state + received chunks (client resumes by skipping them).
// DELETE — cancel: session ABORTED + staged chunk objects removed from MinIO.

import { handler, ok, Errors } from "@/lib/hms/api";
import { PERMISSIONS } from "@/lib/hms/constants";
import { db } from "@/lib/db";
import { audit } from "@/lib/hms/services";
import { storage } from "@/lib/hms/storage";
import { assertRolePermission, withParams } from "@/lib/hms/files/service";

type Ctx = { params: Promise<{ id: string }> };

async function getOwnedSession(userId: string, id: string) {
  const session = await db.fileUploadSession.findUnique({ where: { id } });
  // Sessions are private to their owner — a foreign id is a 404 (no existence leak, §36).
  if (!session || session.userId !== userId) throw Errors.notFound("Upload session not found.");
  return session;
}

export const GET = withParams<{ id: string }>(async ({ user, params }) => {
    const { id } = params;
    assertRolePermission(user, PERMISSIONS.files_create);
    const session = await getOwnedSession(user.id, id);
    const receivedChunks = session.receivedChunks ? session.receivedChunks.split(",").map(Number).filter((n) => Number.isInteger(n)) : [];
    return ok({
      sessionId: session.id, name: session.name, sizeBytes: session.sizeBytes,
      totalChunks: session.totalChunks, receivedChunks, receivedBytes: session.receivedBytes,
      status: session.status, error: session.error || null,
    });
  }, { permission: PERMISSIONS.files_create });

export const DELETE = withParams<{ id: string }>(async ({ user, params }) => {
    const { id } = params;
    assertRolePermission(user, PERMISSIONS.files_create);
    const session = await getOwnedSession(user.id, id);
    if (session.status === "PENDING") {
      await storage.removePrefix(`uploads-tmp/${session.id}/`).catch(() => undefined);
      await db.fileUploadSession.update({ where: { id: session.id }, data: { status: "ABORTED", error: "cancelled by user" } });
      void audit({
        actorId: user.id, actorEmail: user.email, action: "UPLOAD_FAILED", resourceType: "FILE_UPLOAD", resourceId: session.id,
        metadata: { name: session.name, reason: "cancelled" },
      });
    }
    return ok({ cancelled: true });
  }, { permission: PERMISSIONS.files_create });
