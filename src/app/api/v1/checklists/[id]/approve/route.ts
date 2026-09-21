// MOHD.HMS ENTERPRISE — Checklist approval (spec §24/§54, backend-authoritative).
// POST /api/v1/checklists/[id]/approve — approve draft; attaches + materializes
// the snapshot onto its work order in ONE transaction when linked (§68).
import type { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { handler, ok, Errors } from "@/lib/hms/api";
import { PERMISSIONS } from "@/lib/hms/constants";
import type { SessionUser } from "@/lib/hms/auth";
import { approveChecklist } from "@/lib/hms/checklist/engine";
import { emit } from "@/lib/hms/workflows/bus";
import { EVENT_TYPES } from "@/lib/hms/workflows/types";

type Ctx = { req: NextRequest; user: SessionUser };

function withId(fn: (id: string, ctx: Ctx) => Promise<NextResponse>, opts?: Parameters<typeof handler>[1]) {
  return async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    return handler((c) => fn(id, c), opts)(req);
  };
}

export const POST = withId(
  async (id, { user }) => {
    const instance = await db.checklistInstance.findUnique({ where: { id }, select: { id: true } });
    if (!instance) throw Errors.notFound("Checklist not found.");
    const result = await approveChecklist({ actorId: user.id, actorEmail: user.email, instanceId: id });
    await emit({
      type: EVENT_TYPES.CHECKLIST_UPDATED,
      resourceType: "CHECKLIST_INSTANCE",
      resourceId: id,
      payload: { code: result.code, status: result.status },
      actorType: "USER",
      actorId: user.id,
    });
    return ok(result);
  },
  { permission: PERMISSIONS.checklist_approve }
);
