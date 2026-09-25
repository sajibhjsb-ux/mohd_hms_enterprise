// MOHD.HMS ENTERPRISE — Document Template detail + draft editing.
//
//   GET   /api/v1/templates/[id]   → full template (versions, current draft)
//   PATCH /api/v1/templates/[id]   → save draft (name/description/layout/style)
//
// Saving into an already-published state transparently creates the NEXT draft
// version — published versions are immutable (history is never rewritten).

import { z } from "zod";
import { NextRequest, NextResponse } from "next/server";
import { handler, ok, parseBody } from "@/lib/hms/api";
import { PERMISSIONS, type Permission } from "@/lib/hms/constants";
import type { SessionUser } from "@/lib/hms/auth";
import { getTemplate, updateDraft } from "@/lib/hms/templates/service";

const withId = (
  permission: Permission,
  fn: (id: string, ctx: { req: NextRequest; user: SessionUser }) => Promise<NextResponse>
) => {
  return async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    return handler((c) => fn(id, c), { permission })(req);
  };
};

export const GET = withId(
  PERMISSIONS.templates_read,
  async (id) => ok(await getTemplate(id))
);

const patchSchema = z.object({
  name: z.string().min(1).max(80).optional(),
  description: z.string().max(300).optional(),
  layout: z.unknown().optional(),
  style: z.unknown().optional(),
});

export const PATCH = withId(
  PERMISSIONS.templates_manage,
  async (id, { req, user }) => {
    const body = await parseBody(req, patchSchema);
    const result = await updateDraft(id, body, { id: user.id, email: user.email });
    return ok(result);
  }
);
