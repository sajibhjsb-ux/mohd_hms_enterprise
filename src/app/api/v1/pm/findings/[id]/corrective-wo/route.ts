// MOHD.HMS ENTERPRISE — PM finding → corrective work order bridge (PM §19/§22).
// POST /api/v1/pm/findings/[id]/corrective-wo — idempotent: a finding never
// spawns two corrective work orders; a repeated call returns the existing one.

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { handler, ok, Errors } from "@/lib/hms/api";
import type { SessionUser } from "@/lib/hms/auth";
import { PERMISSIONS } from "@/lib/hms/constants";
import { audit, nextNumber, notifyRole } from "@/lib/hms/services";
import { mapPriorityToWo } from "@/lib/hms/pm/schedule";

function withId(fn: (id: string, ctx: { req: NextRequest; user: SessionUser }) => Promise<NextResponse>, permission?: (typeof PERMISSIONS)[keyof typeof PERMISSIONS]) {
  return async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    return handler((c) => fn(id, c), { permission })(req);
  };
}

export const POST = withId(
  async (id, { user }) => {
    const finding = await db.pmFinding.findUnique({
      where: { id },
      include: {
        equipment: { select: { id: true, name: true, assetTag: true, customerId: true } },
        correctiveWorkOrder: { select: { id: true, code: true, status: true } },
      },
    });
    if (!finding) throw Errors.notFound("PM finding not found.");
    // §13 — a corrective work order must always carry a customer, which comes
    // from the equipment record (same requirement as the PM occurrence generator).
    if (!finding.equipment.customerId) {
      throw Errors.badRequest(`Equipment ${finding.equipment.assetTag} has no customer assigned — a corrective work order cannot be created.`);
    }

    // Idempotent link — the finding already carries its corrective work order.
    if (finding.correctiveWorkOrderId && finding.correctiveWorkOrder) {
      return ok({ alreadyLinked: true, workOrder: finding.correctiveWorkOrder });
    }

    const code = await nextNumber("WO");
    const description = [
      finding.description,
      finding.cause ? `Cause: ${finding.cause}` : "",
      finding.recommendation ? `Recommendation: ${finding.recommendation}` : "",
      finding.immediateAction ? `Immediate action taken: ${finding.immediateAction}` : "",
    ].filter(Boolean).join("\n");

    const workOrder = await db.workOrder.create({
      data: {
        code,
        customerId: finding.equipment.customerId,
        equipmentId: finding.equipmentId,
        title: `[Corrective] ${finding.title}`.slice(0, 200),
        description,
        priority: mapPriorityToWo(finding.severity), // CRITICAL→URGENT, else same scale
        sourceType: "CORRECTIVE",
        status: "PENDING",
      },
    });

    await db.pmFinding.update({ where: { id }, data: { correctiveWorkOrderId: workOrder.id } });

    await audit({
      actorId: user.id,
      actorEmail: user.email,
      action: "PM_CORRECTIVE_WO_CREATED",
      resourceType: "WORK_ORDER",
      resourceId: workOrder.id,
      metadata: { findingId: id, woCode: code, severity: finding.severity },
    });

    await notifyRole("SUPERVISOR", {
      title: "Corrective work order created",
      message: `Corrective work order ${code} was created from PM finding "${finding.title}" (${finding.severity}) on ${finding.equipment.name}.`,
      type: "WARNING",
      resourceType: "WORK_ORDER",
      resourceId: workOrder.id,
    });

    return ok(workOrder, 201);
  },
  PERMISSIONS.pm_manage
);
