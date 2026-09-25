// MOHD.HMS ENTERPRISE — Publish a template draft.
//
//   POST /api/v1/templates/[id]/publish
//
// Publish runs the FULL gate server-side: layout/style validation → sample
// PDF built through the REAL production renderer → version PUBLISHED +
// template ACTIVE. Segregation of duties: publish is a separate permission
// from editing (spec §32/§39).

import { NextRequest, NextResponse } from "next/server";
import { handler, ok } from "@/lib/hms/api";
import { PERMISSIONS, type Permission } from "@/lib/hms/constants";
import type { SessionUser } from "@/lib/hms/auth";
import { publishTemplate } from "@/lib/hms/templates/service";

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
    const result = await publishTemplate(id, { id: user.id, email: user.email });
    return ok(result);
  }
);
