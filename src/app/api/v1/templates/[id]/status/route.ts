// MOHD.HMS ENTERPRISE — Enable / disable a published template.
//
//   POST /api/v1/templates/[id]/status   { status: "ACTIVE" | "INACTIVE" }

import { z } from "zod";
import { NextRequest, NextResponse } from "next/server";
import { handler, ok, parseBody } from "@/lib/hms/api";
import { PERMISSIONS, type Permission } from "@/lib/hms/constants";
import type { SessionUser } from "@/lib/hms/auth";
import { setTemplateStatus } from "@/lib/hms/templates/service";

const withId = (
  permission: Permission,
  fn: (id: string, ctx: { req: NextRequest; user: SessionUser }) => Promise<NextResponse>
) => {
  return async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    return handler((c) => fn(id, c), { permission })(req);
  };
};

const bodySchema = z.object({ status: z.enum(["ACTIVE", "INACTIVE"]) });

export const POST = withId(
  PERMISSIONS.templates_publish,
  async (id, { req, user }) => {
    const { status } = await parseBody(req, bodySchema);
    await setTemplateStatus(id, status, { id: user.id, email: user.email });
    return ok({ status });
  }
);
