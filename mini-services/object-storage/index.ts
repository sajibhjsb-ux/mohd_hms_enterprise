// MOHD.HMS ENTERPRISE — Local S3-compatible object storage service.
//
// The application's authoritative file/object storage is a LOCAL
// S3-COMPATIBLE object store (the MinIO/S3 API). All photos, videos, PDFs,
// documents and attachments are stored here through the S3 API — never on the
// app server's local filesystem and never as database BLOBs.
//
// This service exposes the S3 API on a fixed internal port. The Next.js
// backend talks to it exclusively server-side with the official `minio` S3
// client (src/lib/hms/storage). Browsers NEVER talk to this service directly:
// every object download is proxied through authenticated, RBAC-checked API
// routes, so no bucket is ever publicly exposed.
//
// In production the same app code can point at a real MinIO server by
// changing the S3_* environment variables — the S3 API contract is identical.

import S3rver from "s3rver";

const PORT = Number(process.env.S3RVER_PORT ?? 3090);
// Bind all interfaces (s3rver's option is `address`): both 127.0.0.1 (app
// server) and other loopbacks work. Do NOT leave the default 'localhost' —
// under bun it resolves to IPv6-only ::1 and breaks IPv4 clients.
const HOST = process.env.S3RVER_HOST ?? "0.0.0.0";
// Object data lives outside git; created on demand.
const DATA_DIR = process.env.S3RVER_DATA_DIR ?? "../../.storage/s3";
const BUCKETS = (process.env.S3RVER_BUCKETS ?? "hms-files").split(",").map((b) => b.trim()).filter(Boolean);

const server = new S3rver({
  address: HOST,
  port: PORT,
  directory: DATA_DIR,
  silent: false,
  configureBuckets: BUCKETS.map((name) => ({ name })),
});
// NOTE: s3rver signs/verifies with its built-in S3RVER/S3RVER credentials —
// the app's local .env therefore sets S3_ACCESS_KEY=S3RVER / S3_SECRET_KEY=S3RVER.
// When pointing the app at a real MinIO server, set the matching S3_* env vars.

server.run((err: unknown) => {
  if (err) {
    console.error("[object-storage] failed to start:", err);
    process.exit(1);
  }
  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      service: "object-storage",
      msg: "s3.storage.ready",
      endpoint: `http://${HOST}:${PORT}`,
      buckets: BUCKETS,
    }),
  );
});

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    server.close(() => process.exit(0));
  });
}
