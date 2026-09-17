import { NextResponse } from "next/server";
import { db } from "@/lib/db";

/** Readiness: verifies required dependencies (database). GET /api/health/ready */
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
  return NextResponse.json(
    { ok: ready, status: ready ? "ready" : "degraded", checks, ts: new Date().toISOString() },
    { status: ready ? 200 : 503 }
  );
}
