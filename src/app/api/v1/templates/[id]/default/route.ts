// MOHD.HMS ENTERPRISE — Set a template as its document type's default.
//
//   POST /api/v1/templates/[id]/default
//
// Exactly ONE default per templateType — the previous default is cleared
// transactionally inside the service.

import { NextRequest, NextResponse } from "next/server";
import { handler, ok } from "@/lib/hms/api";
import { PERMISSIONS, type Permission } from "@/lib/hms/constants";
import type { SessionUser } from "@/lib/hms/auth";
import { setTemplateDefault } from "@/lib/hms/templates/service";

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
    await setTemplateDefault(id, { id: user.id, email: user.email });
    return ok({ isDefault: true });
  }
);
