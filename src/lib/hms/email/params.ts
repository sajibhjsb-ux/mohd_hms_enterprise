// MOHD.HMS ENTERPRISE — Email client route helper: forward Next.js dynamic
// params into handler() (mirrors the house withId()/withParams pattern).

import "server-only";
import type { NextRequest } from "next/server";
import type { NextResponse } from "next/server";
import { handler } from "@/lib/hms/api";
import type { Permission } from "@/lib/hms/constants";

export function withMailParams<P extends Record<string, string>>(
  fn: (ctx: { req: NextRequest; requestId: string; user: { id: string; email: string; name: string; role: string }; params: P }) => Promise<NextResponse> | NextResponse,
  opts?: { permission?: Permission; auth?: boolean },
) {
  return async (req: NextRequest, ctx: { params: Promise<P> }) =>
    handler(async (c) => fn({ ...c, params: await ctx.params }), opts)(req);
}
