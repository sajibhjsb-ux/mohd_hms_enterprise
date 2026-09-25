// MOHD.HMS ENTERPRISE — Restore a historical version as a NEW draft.
//
//   POST /api/v1/templates/[id]/restore   { versionId: string }
//
// History is never rewritten: restoring copies the historical version into the
// next draft version and makes it the working copy.

import { z } from "zod";
import { NextRequest, NextResponse } from "next/server";
import { handler, ok, parseBody } from "@/lib/hms/api";
import { PERMISSIONS, type Permission } from "@/lib/hms/constants";
import type { SessionUser } from "@/lib/hms/auth";
import { restoreVersion } from "@/lib/hms/templates/service";

const withId = (
  permission: Permission,
  fn: (id: string, ctx: { req: NextRequest; user: SessionUser }) => Promise<NextResponse>
) => {
  return async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    return handler((c) => fn(id, c), { permission })(req);
  };
};

const bodySchema = z.object({ versionId: z.string().min(1) });

export const POST = withId(
  PERMISSIONS.templates_publish,
  async (id, { req, user }) => {
    const { versionId } = await parseBody(req, bodySchema);
    const result = await restoreVersion(id, versionId, { id: user.id, email: user.email });
    return ok(result);
  }
);
