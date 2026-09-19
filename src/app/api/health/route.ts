import { NextResponse } from "next/server";

/** Liveness: GET /api/health */
export async function GET() {
  return NextResponse.json({ ok: true, status: "alive", app: "MOHD.HMS ENTERPRISE", ts: new Date().toISOString() });
}
