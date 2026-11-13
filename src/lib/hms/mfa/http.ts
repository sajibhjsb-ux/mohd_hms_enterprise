import type { NextRequest } from "next/server";
import { Errors } from "@/lib/hms/api";

export function assertMfaOrigin(req: NextRequest): void {
  const origin = req.headers.get("origin");
  if (!origin) return;
  const expected = new URL(process.env.PUBLIC_APP_URL ?? req.url).origin;
  let actual: string;
  try {
    actual = new URL(origin).origin;
  } catch {
    throw Errors.forbidden("Invalid request origin.");
  }
  if (actual !== expected) throw Errors.forbidden("Invalid request origin.");
}
