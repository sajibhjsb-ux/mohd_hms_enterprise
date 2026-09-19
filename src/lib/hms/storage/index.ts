// MOHD.HMS ENTERPRISE — Centralized S3 object-storage service (MinIO API).
//
// CONTRACT (spec §49/§51):
//   The S3-compatible object store is the AUTHORITATIVE file/object storage
//   for every upload (photos, videos, PDFs, documents, attachments).
//   PostgreSQL (SQLite in dev, PostgreSQL in production) stores business data
//   and file metadata/references — never binary blobs.
//   Redis stays cache/queue only. The local filesystem is never permanent
//   storage.
//
// This is the SINGLE storage abstraction for the whole app. Route handlers
// never open S3 connections themselves and never see credentials.
//
// Browsers never talk to the object store directly: every object download is
// served through authenticated, RBAC-checked API routes (e.g.
// /api/v1/irms/photos/[id]/file), so the bucket stays fully private — no
// public bucket policy, no presigned-URL leakage, no CORS exposure.
//
// Client: the official `minio` S3 client, pointed at any S3-compatible
// endpoint via env (local object-storage mini-service on :3090 by default,
// a real MinIO server in production). Credentials live server-side only.

import "server-only";
import { Client } from "minio";

// ─── Configuration (server-side env only — never shipped to the client) ─────

const S3_ENDPOINT = process.env.S3_ENDPOINT ?? "127.0.0.1";
const S3_PORT = Number(process.env.S3_PORT ?? 3090);
const S3_USE_SSL = (process.env.S3_USE_SSL ?? "false") === "true";
const S3_ACCESS_KEY = process.env.S3_ACCESS_KEY ?? "S3RVER";
const S3_SECRET_KEY = process.env.S3_SECRET_KEY ?? "S3RVER";
export const S3_BUCKET = process.env.S3_BUCKET ?? "hms-files";

export type StorageErrorCode =
  | "STORAGE_UNAVAILABLE"
  | "STORAGE_UPLOAD_FAILED"
  | "OBJECT_NOT_FOUND";

/** Error carrying a stable code so callers can map it to an honest user message. */
export class StorageError extends Error {
  code: StorageErrorCode;
  constructor(code: StorageErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

// ─── Safe object keys (§14/§29 — no path traversal, no raw client names) ────

const KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._\-\/]{0,511}$/;

/**
 * Keys are generated server-side ({module}/{entityId}/{id}-{variant}.{ext});
 * client filenames never become object keys. This guard is defense-in-depth
 * for keys reconstructed from the database.
 */
export function assertSafeKey(key: string): string {
  if (!key || !KEY_PATTERN.test(key) || key.includes("..") || key.includes("//")) {
    throw new StorageError("OBJECT_NOT_FOUND", "Invalid storage key.");
  }
  return key;
}

// ─── Client singleton ────────────────────────────────────────────────────────

const client = new Client({
  endPoint: S3_ENDPOINT,
  port: S3_PORT,
  useSSL: S3_USE_SSL,
  accessKey: S3_ACCESS_KEY,
  secretKey: S3_SECRET_KEY,
});

let bucketReady: Promise<void> | null = null;

/** Idempotently make sure the bucket exists (once per process). */
function ensureBucket(): Promise<void> {
  bucketReady ??= (async () => {
    const exists = await client.bucketExists(S3_BUCKET).catch(() => false);
    if (!exists) await client.makeBucket(S3_BUCKET, "us-east-1");
  })();
  return bucketReady;
}

// ─── StorageService ──────────────────────────────────────────────────────────

export const storage = {
  bucket: S3_BUCKET,

  /** Store an object; keys are unique by design so nothing is overwritten. */
  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    assertSafeKey(key);
    try {
      await ensureBucket();
      await client.putObject(S3_BUCKET, key, body, body.length, { "Content-Type": contentType });
    } catch (err) {
      console.error(JSON.stringify({ ts: new Date().toISOString(), level: "error", msg: "storage.put.failed", key, error: String(err) }));
      throw new StorageError("STORAGE_UPLOAD_FAILED", "Could not store the file in object storage.");
    }
  },

  /** Read an object; null when missing (caller decides 404 semantics). */
  async get(key: string): Promise<{ buffer: Buffer; contentType: string } | null> {
    assertSafeKey(key);
    try {
      await ensureBucket();
      const stat = await client.statObject(S3_BUCKET, key);
      const stream = await client.getObject(S3_BUCKET, key);
      const chunks: Buffer[] = [];
      for await (const chunk of stream) chunks.push(chunk as Buffer);
      const contentType =
        stat.metaData?.["content-type"] ??
        stat.metaData?.["Content-Type"] ??
        "application/octet-stream";
      return { buffer: Buffer.concat(chunks), contentType };
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === "NotFound" || code === "NoSuchKey") return null;
      console.error(JSON.stringify({ ts: new Date().toISOString(), level: "error", msg: "storage.get.failed", key, error: String(err) }));
      return null;
    }
  },

  /** Object existence + metadata; null when missing. */
  async stat(key: string): Promise<{ size: number; contentType: string; etag: string } | null> {
    assertSafeKey(key);
    try {
      await ensureBucket();
      const stat = await client.statObject(S3_BUCKET, key);
      return {
        size: stat.size,
        contentType: stat.metaData?.["content-type"] ?? stat.metaData?.["Content-Type"] ?? "application/octet-stream",
        etag: String(stat.etag ?? ""),
      };
    } catch {
      return null;
    }
  },

  /** Delete one object. Idempotent — deleting a missing object succeeds. */
  async remove(key: string): Promise<void> {
    assertSafeKey(key);
    try {
      await ensureBucket();
      await client.removeObject(S3_BUCKET, key);
    } catch (err) {
      // Best-effort: never block business flows on delete failures.
      console.error(JSON.stringify({ ts: new Date().toISOString(), level: "error", msg: "storage.remove.failed", key, error: String(err) }));
    }
  },

  /** Delete every object under a prefix (report folder cleanup). */
  async removePrefix(prefix: string): Promise<void> {
    if (!prefix || prefix.includes("..")) throw new StorageError("OBJECT_NOT_FOUND", "Invalid storage prefix.");
    try {
      await ensureBucket();
      const keys: string[] = [];
      const stream = client.listObjects(S3_BUCKET, prefix, true);
      for await (const obj of stream) {
        if (obj.name) keys.push(obj.name);
      }
      if (keys.length > 0) {
        await client.removeObjects(S3_BUCKET, keys);
      }
    } catch (err) {
      console.error(JSON.stringify({ ts: new Date().toISOString(), level: "error", msg: "storage.removePrefix.failed", prefix, error: String(err) }));
    }
  },

  /** Liveness for /api/health/ready — verifies credentials, bucket and I/O. */
  async healthCheck(): Promise<{ ok: boolean; error?: string }> {
    try {
      await ensureBucket();
      const probeKey = "_health/probe.txt";
      const probe = Buffer.from("ok");
      await client.putObject(S3_BUCKET, probeKey, probe, probe.length, { "Content-Type": "text/plain" });
      await client.removeObject(S3_BUCKET, probeKey);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  },
};
