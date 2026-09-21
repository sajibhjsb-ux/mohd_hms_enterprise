// MOHD.HMS ENTERPRISE — Upload chunk storage (§8/§36).
// PUT /api/v1/files/uploads/{id}/parts/{index} — raw bytes body. Chunks are
// staged as private MinIO objects (uploads-tmp/{sessionId}/{index}); nothing
// touches the local filesystem. The received-chunk ledger is the DB session
// row (transactional with the storage write outcome).

import { handler, ok, Errors } from "@/lib/hms/api";
import { PERMISSIONS } from "@/lib/hms/constants";
import { db } from "@/lib/db";
import { storage, StorageError } from "@/lib/hms/storage";
import { assertRolePermission, chunkObjectKey, MAX_CHUNK_BYTES, sha256, withParams } from "@/lib/hms/files/service";

type Ctx = { params: Promise<{ id: string; index: string }> };

export const PUT = withParams<{ id: string; index: string }>(async ({ req, user, params }) => {
    const { id, index: rawIndex } = params;
    assertRolePermission(user, PERMISSIONS.files_create);
    const index = Number.parseInt(rawIndex, 10);
    if (!Number.isInteger(index) || index < 0 || index > 999_999) throw Errors.badRequest("Invalid chunk index.");

    const session = await db.fileUploadSession.findUnique({ where: { id } });
    if (!session || session.userId !== user.id) throw Errors.notFound("Upload session not found.");
    if (session.status !== "PENDING") throw Errors.invalidTransition("Upload session is no longer active.");
    if (index >= session.totalChunks) throw Errors.badRequest("Chunk index beyond the session plan.");

    // Size guard BEFORE buffering (Content-Length is authoritative at the edge).
    const declared = Number(req.headers.get("content-length") ?? "0");
    if (declared > MAX_CHUNK_BYTES) throw Errors.badRequest("Chunk exceeds the chunk size limit.");

    const buf = Buffer.from(await req.arrayBuffer());
    if (buf.length === 0) throw Errors.badRequest("Empty chunk.");
    if (buf.length > MAX_CHUNK_BYTES) throw Errors.badRequest("Chunk exceeds the chunk size limit.");

    const key = chunkObjectKey(session.id, index);
    try {
      await storage.put(key, buf, "application/octet-stream");
    } catch (e) {
      if (e instanceof StorageError && e.code === "STORAGE_UNAVAILABLE") {
        throw Errors.internal("Object storage is unavailable — the chunk was NOT accepted. Retry shortly.");
      }
      throw e;
    }
    // The object exists — verify what we just wrote (§8 check #2/#3 pre-verified per chunk).
    const stat = await storage.stat(key);
    if (!stat || stat.size !== buf.length) {
      await storage.remove(key).catch(() => undefined);
      throw Errors.internal("Chunk verification failed after upload — nothing was accepted.");
    }

    const received = new Set(session.receivedChunks ? session.receivedChunks.split(",").filter(Boolean) : []);
    const wasNew = !received.has(String(index));
    received.add(String(index));
    await db.fileUploadSession.update({
      where: { id: session.id },
      data: {
        receivedChunks: [...received].join(","),
        receivedBytes: wasNew ? { increment: buf.length } : session.receivedBytes,
      },
    });
    return ok({ index, sizeBytes: buf.length, checksum: sha256(buf), received: received.size, totalChunks: session.totalChunks });
  }, { permission: PERMISSIONS.files_create });
