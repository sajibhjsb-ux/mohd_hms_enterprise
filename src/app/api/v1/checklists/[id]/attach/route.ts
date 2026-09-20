// MOHD.HMS ENTERPRISE — Attach an approved checklist to a work order (spec §25/§68).
// POST /api/v1/checklists/[id]/attach { workOrderId }
import type { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { handler, ok, parseBody, Errors } from "@/lib/hms/api";
import { PERMISSIONS } from "@/lib/hms/constants";
import type { SessionUser } from "@/lib/hms/auth";
import { attachChecklistToWorkOrder } from "@/lib/hms/checklist/engine";
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
  workOrderId: z.string().min(1, "workOrderId is required."),
});

export const POST = withId(
  async (id, { req, user }) => {
    const body = await parseBody(req, bodySchema);
    const wo = await db.workOrder.findUnique({ where: { id: body.workOrderId }, select: { id: true } });
    if (!wo) throw Errors.notFound("Work order not found.");
    const result = await attachChecklistToWorkOrder({ actorId: user.id, actorEmail: user.email, instanceId: id, workOrderId: body.workOrderId });
    await emit({
      type: EVENT_TYPES.CHECKLIST_UPDATED,
      resourceType: "CHECKLIST_INSTANCE",
      resourceId: id,
      payload: { code: "", status: "ACTIVE", attached: true },
      actorType: "USER",
      actorId: user.id,
    });
    return ok(result);
  },
  { permission: PERMISSIONS.checklist_approve }
);
