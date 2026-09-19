import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { storage } from "@/lib/hms/storage";

/** Readiness: verifies required dependencies (database + object storage). GET /api/health/ready */
export async function GET() {
  const checks: Record<string, string> = {};
  let ready = true;
  try {
    await db.$queryRaw`SELECT 1`;
    checks.database = "ok";
  } catch {
    checks.database = "unavailable";
    ready = false;
  }
  // Object storage (S3/MinIO) — authoritative file storage must be reachable.
  const s3 = await storage.healthCheck();
  checks.storage = s3.ok ? "ok" : "unavailable";
  if (!s3.ok) ready = false;
  return NextResponse.json(
    { ok: ready, status: ready ? "ready" : "degraded", checks, ts: new Date().toISOString() },
    { status: ready ? 200 : 503 }
  );
}
