// MOHD.HMS ENTERPRISE — one-off migration: local uploads/irms → S3 object store.
//
// Copies every already-stored IRMS photo variant + signature into the S3
// bucket under the `irms/` key namespace and rewrites the DB references
// (storagePath/displayPath/thumbPath) from legacy relative filesystem paths to
// object keys. Idempotent: rows already carrying the `irms/` prefix are
// skipped, so the script can be re-run safely.

import { PrismaClient } from "@prisma/client";
import { promises as fs } from "fs";
import path from "path";
import { Client } from "minio";

const LEGACY_ROOT = path.join(process.cwd(), "uploads", "irms");
const BUCKET = process.env.S3_BUCKET ?? "hms-files";

const mc = new Client({
  endPoint: process.env.S3_ENDPOINT ?? "127.0.0.1",
  port: Number(process.env.S3_PORT ?? 3090),
  useSSL: (process.env.S3_USE_SSL ?? "false") === "true",
  accessKey: process.env.S3_ACCESS_KEY ?? "S3RVER",
  secretKey: process.env.S3_SECRET_KEY ?? "S3RVER",
});

const db = new PrismaClient();

const prefixed = (p: string) => `irms/${p.split("\\").join("/")}`;

async function ensureBucket() {
  const exists = await mc.bucketExists(BUCKET).catch(() => false);
  if (!exists) await mc.makeBucket(BUCKET, "us-east-1");
}

async function migrateFile(relPath: string): Promise<void> {
  const abs = path.join(LEGACY_ROOT, relPath);
  const buf = await fs.readFile(abs);
  const key = prefixed(relPath);
  await mc.putObject(BUCKET, key, buf, buf.length, {
    "Content-Type": relPath.endsWith(".png") ? "image/png" : "image/jpeg",
  });
}

async function main() {
  await ensureBucket();
  const summary = { photosMigrated: 0, photosSkipped: 0, photosMissingFiles: 0, signaturesMigrated: 0, signaturesSkipped: 0, signaturesMissingFiles: 0 };

  const photos = await db.inspectionPhoto.findMany({
    where: { storagePath: { not: "" } },
    select: { id: true, storagePath: true, displayPath: true, thumbPath: true },
  });
  for (const p of photos) {
    if (p.storagePath.startsWith("irms/")) { summary.photosSkipped += 1; continue; }
    const paths = [p.storagePath, p.displayPath, p.thumbPath].filter(Boolean) as string[];
    let missing = false;
    for (const rel of paths) {
      try { await migrateFile(rel); } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") { missing = true; break; }
        throw err;
      }
    }
    if (missing) { summary.photosMissingFiles += 1; console.warn(`photo ${p.id}: file missing on disk, skipped`); continue; }
    await db.inspectionPhoto.update({
      where: { id: p.id },
      data: {
        storagePath: prefixed(p.storagePath),
        displayPath: p.displayPath ? prefixed(p.displayPath) : "",
        thumbPath: p.thumbPath ? prefixed(p.thumbPath) : "",
      },
    });
    summary.photosMigrated += 1;
  }

  const sigs = await db.inspectionSignature.findMany({
    where: { storagePath: { not: "" } },
    select: { id: true, storagePath: true },
  });
  for (const s of sigs) {
    if (s.storagePath.startsWith("irms/")) { summary.signaturesSkipped += 1; continue; }
    try {
      await migrateFile(s.storagePath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") { summary.signaturesMissingFiles += 1; console.warn(`signature ${s.id}: file missing on disk, skipped`); continue; }
      throw err;
    }
    await db.inspectionSignature.update({ where: { id: s.id }, data: { storagePath: prefixed(s.storagePath) } });
    summary.signaturesMigrated += 1;
  }

  console.log(JSON.stringify(summary, null, 2));
  await db.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
