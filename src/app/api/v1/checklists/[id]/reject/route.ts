// MOHD.HMS ENTERPRISE — Checklist rejection (spec §25 review action).
// POST /api/v1/checklists/[id]/reject { reason }
import type { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { handler, ok, parseBody, Errors } from "@/lib/hms/api";
import { PERMISSIONS } from "@/lib/hms/constants";
import type { SessionUser } from "@/lib/hms/auth";
import { rejectChecklist } from "@/lib/hms/checklist/engine";
import { emit } from "@/lib/hms/workflows/bus";
import { EVENT_TYPES } from "@/lib/hms/workflows/types";

type Ctx = { req: NextRequest; user: SessionUser };

function withId(fn: (id: string, ctx: Ctx) => Promise<NextResponse>, opts?: Parameters<typeof handler>[1]) {
  return async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    return handler((c) => fn(id, c), opts)(req);
  };
}

const bodySchema = z.object({
  reason: z.string().min(3, "A rejection reason is required.").max(2000),
});

export const POST = withId(
  async (id, { req, user }) => {
    const body = await parseBody(req, bodySchema);
    const instance = await db.checklistInstance.findUnique({ where: { id }, select: { id: true } });
    if (!instance) throw Errors.notFound("Checklist not found.");
    const result = await rejectChecklist({ actorId: user.id, actorEmail: user.email, instanceId: id, reason: body.reason });
    await emit({
      type: EVENT_TYPES.CHECKLIST_UPDATED,
      resourceType: "CHECKLIST_INSTANCE",
      resourceId: id,
      payload: { code: result.code, status: "REJECTED" },
      actorType: "USER",
      actorId: user.id,
    });
    return ok(result);
  },
  { permission: PERMISSIONS.checklist_approve }
);
