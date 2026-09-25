// MOHD.HMS ENTERPRISE — Archive a template (soft retirement, nothing deleted).
//
//   POST /api/v1/templates/[id]/archive
//
// Versions stay immutable; documents pinned to this template keep rendering
// from their snapshots. Archiving clears the default flag.

import { NextRequest, NextResponse } from "next/server";
import { handler, ok } from "@/lib/hms/api";
import { PERMISSIONS, type Permission } from "@/lib/hms/constants";
import type { SessionUser } from "@/lib/hms/auth";
import { archiveTemplate } from "@/lib/hms/templates/service";

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
  PERMISSIONS.templates_publish,
  async (id, { user }) => {
    await archiveTemplate(id, { id: user.id, email: user.email });
    return ok({ status: "ARCHIVED" });
  }
);
