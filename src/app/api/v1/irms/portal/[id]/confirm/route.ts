import { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { handler, ok, parseBody, Errors } from "@/lib/hms/api";
import { PERMISSIONS } from "@/lib/hms/constants";
import { audit, notify } from "@/lib/hms/services";
import { emit } from "@/lib/hms/workflows/bus";
import { EVENT_TYPES } from "@/lib/hms/workflows/types";
import { buildSnapshot, type TxClient } from "@/lib/hms/irms/storage";
import { assertTermsAccepted } from "@/lib/hms/legal/legal";

const confirmSchema = z.object({
  decision: z.enum(["confirm", "reject"]),
  comment: z.string().max(2000).optional(),
});

/**
 * 14c. POST /api/v1/irms/portal/[id]/confirm (PORTAL, customer-only).
 * Only while status = CLIENT_REVIEW and the report belongs to the caller's
 * customer + customerVisible. Routes through the same transition semantics as
 * the staff transition route: confirm → client_approve, reject → reject
 * (comment required). Audits INSPECTION_CLIENT_CONFIRMED / INSPECTION_CLIENT_REJECTED.
 */
export const POST = async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  return handler(
    async ({ user, requestId }) => {
      const body = await parseBody(req, confirmSchema);

      // Consent gate: confirming an inspection report is a customer action of
      // legal significance — require the current Terms & Conditions first.
      await assertTermsAccepted(user);

      const report = await db.inspectionReport.findUnique({
        where: { id },
        include: {
          project: { select: { id: true, customerId: true, name: true } },
          inspector: { select: { userId: true } },
          findings: { select: { finding: true, severity: true, recommendation: true } },
        },
      });
      // Existence hidden when not the owning customer's visible client-review report.
      if (!report || !user.customerId || report.project.customerId !== user.customerId || !report.customerVisible) {
        throw Errors.notFound("Inspection report not found.");
      }
      if (report.status !== "CLIENT_REVIEW") {
        throw Errors.invalidTransition("This report is not awaiting client confirmation.");
      }

      const now = new Date();
      const comment = (body.comment ?? "").trim();
      if (body.decision === "reject" && !comment) {
        throw Errors.badRequest("A comment is required when rejecting a report.");
      }
      const toStatus = body.decision === "confirm" ? "APPROVED" : "REJECTED";
      const version = report.revision + 1;

      const updated = await db.$transaction(async (tx: TxClient) => {
        const row = await tx.inspectionReport.update({
          where: { id },
          data:
            body.decision === "confirm"
              ? { status: "APPROVED", approvedAt: now, approvedById: user.id, revision: version, ...(comment ? { clientComment: comment } : {}) }
              : { status: "REJECTED", rejectedAt: now, rejectedById: user.id, revision: version },
          select: { id: true, code: true, status: true, revision: true },
        });
        if (body.decision === "confirm") {
          await tx.inspectionRevision.create({
            data: {
              reportId: id,
              version,
              snapshot: buildSnapshot(report, report.findings),
              note: "Approved (client confirmation)",
              createdById: user.id,
              createdByName: user.name,
            },
          });
        }
        await tx.inspectionApproval.create({
          data: {
            reportId: id,
            step: body.decision === "confirm" ? "CLIENT_APPROVE" : "REJECT",
            fromStatus: "CLIENT_REVIEW",
            toStatus,
            comment,
            userId: user.id,
            userName: user.name,
          },
        });
        for (const type of body.decision === "confirm"
          ? [EVENT_TYPES.INSPECTION_APPROVED, EVENT_TYPES.INSPECTION_COMPLETED]
          : [EVENT_TYPES.INSPECTION_REJECTED]) {
          await emit({
            type,
            resourceType: "INSPECTION_REPORT",
            resourceId: id,
            payload: { reportId: id, code: report.code, status: toStatus },
            actorType: "USER",
            actorId: user.id,
            requestId,
            tx,
          });
        }
        return row;
      });

      await audit({
        actorId: user.id,
        actorEmail: user.email,
        action: body.decision === "confirm" ? "INSPECTION_CLIENT_CONFIRMED" : "INSPECTION_CLIENT_REJECTED",
        resourceType: "INSPECTION_REPORT",
        resourceId: id,
        metadata: { code: report.code, from: "CLIENT_REVIEW", to: toStatus, viaPortal: true },
      });

      if (report.inspector?.userId) {
        await notify({
          userId: report.inspector.userId,
          title: body.decision === "confirm" ? "Inspection report approved" : "Inspection report rejected",
          message:
            body.decision === "confirm"
              ? `${report.code} — ${report.title} was confirmed by the client (${user.name}).`
              : `${report.code} — ${report.title} was rejected by the client (${user.name}).${comment ? ` Comment: ${comment}` : ""}`,
          type: body.decision === "confirm" ? "SUCCESS" : "WARNING",
          resourceType: "INSPECTION_REPORT",
          resourceId: id,
        });
      }
      return ok(updated);
    },
    { permission: PERMISSIONS.irms_portal }
  )(req);
};
