// MOHD.HMS ENTERPRISE — Upload session create (§8/§11/§29/§36).
// POST /api/v1/files/uploads { name, sizeBytes, mimeType?, totalChunks, folderId?, checksum? }
// Server validates size/chunks/quota, derives the owner from the session, and
// returns the session id + already-received chunks (resume §8).

import { handler, ok, parseBody, Errors } from "@/lib/hms/api";
import { PERMISSIONS } from "@/lib/hms/constants";
import { z } from "zod";
import { db } from "@/lib/db";
import { audit } from "@/lib/hms/services";
import { storage } from "@/lib/hms/storage";
import {
  assertRolePermission, sanitizeFileName, sniffMimeType, canAccessFolder, folderChain,
  assertQuota, MAX_SESSION_BYTES, MAX_TOTAL_CHUNKS, MAX_CHUNK_BYTES,
  chunkObjectKey, QUOTA_SETTING_KEY, userQuotaMb, scanUpload,
} from "@/lib/hms/files/service";

const createSchema = z.object({
  name: z.string().min(1).max(512),
  sizeBytes: z.number().int().min(1).max(2_000_000_000),
  mimeType: z.string().max(120).optional(),
  totalChunks: z.number().int().min(1),
  folderId: z.string().max(64).nullable().optional(),
  checksum: z.string().length(64).regex(/^[a-f0-9]{64}$/).nullable().optional(),
});

export const POST = handler(
  async ({ req, user }) => {
    assertRolePermission(user, PERMISSIONS.files_create);
    const body = await parseBody(req, createSchema);
    const name = sanitizeFileName(body.name);
    if (body.sizeBytes > MAX_SESSION_BYTES) {
      throw Errors.badRequest(`File is too large — the limit is ${Math.round(MAX_SESSION_BYTES / (1024 * 1024))} MB per file.`);
    }
    const expectedChunks = Math.ceil(body.sizeBytes / MAX_CHUNK_BYTES);
    if (body.totalChunks !== expectedChunks) {
      throw Errors.badRequest(`Chunk plan mismatch — expected ${expectedChunks} chunk(s) of up to ${Math.round(MAX_CHUNK_BYTES / (1024 * 1024))} MB.`);
    }
    if (body.totalChunks > MAX_TOTAL_CHUNKS) throw Errors.badRequest("Too many chunks.");

    const folderId = body.folderId ?? null;
    if (folderId) {
      const chain = await folderChain(folderId, user.id);
      if (!chain.some((f) => f.id === folderId)) throw Errors.notFound("Destination folder not found.");
    }

    // Quota (§29) — server-authoritative; browser numbers are never trusted.
    await assertQuota(user.id, body.sizeBytes);

    // Zombie sweep: abort stale PENDING sessions of this user (24h+) and clear
    // their staged chunks — tmp storage never accumulates silently.
    const stale = await db.fileUploadSession.findMany({
      where: { userId: user.id, status: "PENDING", createdAt: { lt: new Date(Date.now() - 24 * 3600_000) } },
      select: { id: true },
      take: 20,
    });
    for (const s of stale) {
      await storage.removePrefix(`uploads-tmp/${s.id}/`).catch(() => undefined);
      await db.fileUploadSession.update({ where: { id: s.id }, data: { status: "ABORTED", error: "expired" } }).catch(() => undefined);
    }

    const session = await db.fileUploadSession.create({
      data: {
        userId: user.id, name, mimeType: (body.mimeType ?? "").slice(0, 120),
        sizeBytes: body.sizeBytes, totalChunks: body.totalChunks, folderId, checksum: body.checksum ?? "",
      },
    });

    void audit({
      actorId: user.id, actorEmail: user.email, action: "UPLOAD_STARTED", resourceType: "FILE_UPLOAD", resourceId: session.id,
      metadata: { name, sizeBytes: body.sizeBytes, chunks: body.totalChunks, folderId },
    });
    return ok({
      sessionId: session.id,
      chunkSize: MAX_CHUNK_BYTES,
      receivedChunks: [] as number[],
      receivedBytes: 0,
      scanning: (await scanUpload(Buffer.alloc(0), name)).scanned, // honest scanner status (§37)
      quotaMb: await userQuotaMb(),
      quotaKey: QUOTA_SETTING_KEY,
    }, 201);
  },
  { permission: PERMISSIONS.files_create },
);

// keep sniffMimeType referenced for the shared validation contract (used at complete)
void sniffMimeType;
