import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { handler, ok, parseBody, Errors } from "@/lib/hms/api";
import type { SessionUser } from "@/lib/hms/auth";
import { PERMISSIONS } from "@/lib/hms/constants";
import { roleCan } from "@/lib/hms/rbac";
import { audit, notify, notifyRole } from "@/lib/hms/services";

function withId(fn: (id: string, ctx: { req: NextRequest; user: SessionUser }) => Promise<NextResponse>) {
  return async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    return handler((c) => fn(id, c))(req);
  };
}

const transitionSchema = z.object({ action: z.enum(["submit", "approve"]) });

/** Workflow: DRAFT → SUBMITTED (inspector/irms manage) → APPROVED (irms_manage). */
export const POST = withId(
  async (id, { req, user }) => {
    const body = await parseBody(req, transitionSchema);

    const report = await db.inspectionReport.findUnique({
      where: { id },
      include: {
        project: { include: { customer: { select: { companyName: true } } } },
        equipment: { select: { name: true, assetTag: true } },
        inspector: { select: { id: true, userId: true, user: { select: { name: true, email: true } } } },
      },
    });
    if (!report) throw Errors.notFound("Inspection report not found.");

    if (body.action === "submit") {
      const isInspector = report.inspector?.userId === user.id;
      if (!roleCan(user.role, PERMISSIONS.irms_manage) && !isInspector) {
        throw Errors.forbidden("Only the inspector or a supervisor can submit this report.");
      }
      if (report.status !== "DRAFT") {
        throw Errors.invalidTransition(`Only draft reports can be submitted (current: ${report.status}).`);
      }

      const updated = await db.inspectionReport.update({
        where: { id },
        data: { status: "SUBMITTED" },
        include: {
          project: { select: { id: true, name: true, code: true } },
          equipment: { select: { id: true, name: true, assetTag: true } },
          inspector: { select: { id: true, user: { select: { name: true } } } },
          findings: true,
        },
      });

      await audit({
        actorId: user.id,
        actorEmail: user.email,
        action: "INSPECTION_SUBMITTED",
        resourceType: "InspectionReport",
        resourceId: id,
        metadata: { code: report.code, project: report.project.name },
      });
      // Queue for admin review; email channel is logged for the delivery pipeline
      await notifyRole("ADMIN", {
        title: "Inspection report submitted",
        message: `${report.code} — ${report.title} (${report.project.name}) was submitted by ${user.name} for approval.`,
        type: "INFO",
        resourceType: "InspectionReport",
        resourceId: id,
        channels: ["IN_APP", "EMAIL"],
      });
      if (report.inspector?.userId) {
        await notify({
          userId: report.inspector.userId,
          title: "Report submitted",
          message: `Your inspection report ${report.code} was submitted and is awaiting approval.`,
          type: "INFO",
          resourceType: "InspectionReport",
          resourceId: id,
        });
      }
      return ok(updated);
    }

    // action === "approve"
    if (!roleCan(user.role, PERMISSIONS.irms_manage)) throw Errors.forbidden("Only supervisors can approve inspection reports.");
    if (report.status !== "SUBMITTED") {
      throw Errors.invalidTransition(`Only submitted reports can be approved (current: ${report.status}).`);
    }

    const updated = await db.inspectionReport.update({
      where: { id },
      data: { status: "APPROVED" },
      include: {
        project: { select: { id: true, name: true, code: true } },
        equipment: { select: { id: true, name: true, assetTag: true } },
        inspector: { select: { id: true, user: { select: { name: true } } } },
        findings: true,
      },
    });

    await audit({
      actorId: user.id,
      actorEmail: user.email,
      action: "INSPECTION_APPROVED",
      resourceType: "InspectionReport",
      resourceId: id,
      metadata: { code: report.code, approvedBy: user.name },
    });
    if (report.inspector?.userId) {
      await notify({
        userId: report.inspector.userId,
        title: "Inspection report approved",
        message: `${report.code} — ${report.title} was approved by ${user.name}.`,
        type: "SUCCESS",
        resourceType: "InspectionReport",
        resourceId: id,
      });
    }
    return ok(updated);
  }
);
