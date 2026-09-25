// MOHD.HMS ENTERPRISE — Duplicate a template into a fresh DRAFT copy.
//
//   POST /api/v1/templates/[id]/duplicate

import { NextRequest, NextResponse } from "next/server";
import { handler, ok } from "@/lib/hms/api";
import { PERMISSIONS, type Permission } from "@/lib/hms/constants";
import type { SessionUser } from "@/lib/hms/auth";
import { duplicateTemplate } from "@/lib/hms/templates/service";

const withId = (
  permission: Permission,
  fn: (id: string, ctx: { req: NextRequest; user: SessionUser }) => Promise<NextResponse>
) => {
  return async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    return handler((c) => fn(id, c), { permission })(req);
  };
};

export const POST = withId(
  PERMISSIONS.templates_manage,
  async (id, { user }) => {
    const result = await duplicateTemplate(id, { id: user.id, email: user.email });
    return ok(result, 201);
  }
);
