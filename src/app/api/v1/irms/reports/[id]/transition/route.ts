import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { handler, ok, parseBody, Errors } from "@/lib/hms/api";
import type { SessionUser } from "@/lib/hms/auth";
import { PERMISSIONS } from "@/lib/hms/constants";
import { roleCan } from "@/lib/hms/rbac";
import { audit, notify, notifyRole } from "@/lib/hms/services";
import { emit } from "@/lib/hms/workflows/bus";
import { EVENT_TYPES } from "@/lib/hms/workflows/types";
import { buildSnapshot, type TxClient } from "@/lib/hms/irms/storage";
import { ensureQr } from "@/lib/hms/qr/service";

function withId(fn: (id: string, ctx: { req: NextRequest; user: SessionUser; requestId: string }) => Promise<NextResponse>) {
  return async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    return handler((c) => fn(id, c))(req);
  };
}

const transitionSchema = z.object({
  action: z.enum([
    "submit",
    "review",
    "manager_approve",
    "client_request",
    "client_approve",
    "approve",
    "reject",
    "reopen",
    "archive",
  ]),
  comment: z.string().max(2000).optional(),
});

/**
 * 6. POST /api/v1/irms/reports/[id]/transition — full workflow matrix (§29):
 *   DRAFT → SUBMITTED → IN_REVIEW → MANAGER_APPROVAL → CLIENT_REVIEW → APPROVED → ARCHIVED
 *   reject: SUBMITTED/IN_REVIEW/MANAGER_APPROVAL/CLIENT_REVIEW → REJECTED; reopen: REJECTED → DRAFT.
 * Every successful action writes an InspectionApproval row; submit/approve write
 * revision snapshots; emits + audits + notifications exactly per contract §6.
 */
export const POST = withId(
  async (id, { req, user, requestId }) => {
    const body = await parseBody(req, transitionSchema);

    const report = await db.inspectionReport.findUnique({
      where: { id },
      include: {
        project: { select: { id: true, code: true, name: true, customerId: true, customer: { select: { id: true, companyName: true } } } },
        inspector: { select: { id: true, userId: true, user: { select: { name: true, email: true } } } },
        findings: { select: { finding: true, severity: true, recommendation: true } },
      },
    });
    if (!report) throw Errors.notFound("Inspection report not found.");

    const canManage = roleCan(user.role, PERMISSIONS.irms_manage);
    const isOwner = !!report.inspector && report.inspector.userId === user.id;
    // PORTAL user of the owning customer (only ever valid for client_approve / reject).
    const isPortalCustomer =
      roleCan(user.role, PERMISSIONS.irms_portal) && !!user.customerId && user.customerId === report.project.customerId;

    const now = new Date();
    const comment = (body.comment ?? "").trim();

    type RunInput = {
      step: string;
      from: string[];
      to: string;
      data: Record<string, unknown>;
      events: string[];
      snapshot?: boolean;
      snapshotNote?: string;
    };

    const run = async (input: RunInput) => {
      if (!input.from.includes(report.status)) {
        throw Errors.invalidTransition(
          `Action "${body.action}" is not allowed while the report is ${report.status.replace(/_/g, " ").toLowerCase()}.`
        );
      }
      const version = report.revision + 1;
      const updated = await db.$transaction(async (tx: TxClient) => {
        const row = await tx.inspectionReport.update({
          where: { id },
          data: input.snapshot ? { ...input.data, revision: version } : input.data,
          select: { id: true, code: true, status: true, revision: true },
        });
        if (input.snapshot) {
          await tx.inspectionRevision.create({
            data: {
              reportId: id,
              version,
              snapshot: buildSnapshot(report, report.findings),
              note: input.snapshotNote ?? "",
              createdById: user.id,
              createdByName: user.name,
            },
          });
        }
        await tx.inspectionApproval.create({
          data: {
            reportId: id,
            step: input.step,
            fromStatus: report.status,
            toStatus: input.to,
            comment,
            userId: user.id,
            userName: user.name,
          },
        });
        for (const type of input.events) {
          await emit({
            type,
            resourceType: "INSPECTION_REPORT",
            resourceId: id,
            payload: { reportId: id, code: report.code, status: input.to },
            actorType: "USER",
            actorId: user.id,
            requestId,
            tx,
          });
        }
        return row;
      });

      // Central QR identity on final approval (ch.35 §20/§60/§61) — drafts are
      // never publicly verifiable; failure is isolated from the business op.
      if (input.to === "APPROVED") {
        await ensureQr("INSPECTION_REPORT", id, { issuedById: user.id, auditContext: "report-approved" });
      }

      return updated;
    };

    const auditAndLog = async (action: string, toStatus: string, extra?: Record<string, unknown>) => {
      await audit({
        actorId: user.id,
        actorEmail: user.email,
        action,
        resourceType: "INSPECTION_REPORT",
        resourceId: id,
        metadata: { code: report.code, from: report.status, to: toStatus, step: body.action, ...(extra ?? {}) },
      });
    };

    switch (body.action) {
      case "submit": {
        if (!canManage && !isOwner) throw Errors.forbidden("Only the inspector or a supervisor can submit this report.");
        if (isPortalCustomer) throw Errors.forbidden();
        const updated = await run({
          step: "SUBMIT",
          from: ["DRAFT"],
          to: "SUBMITTED",
          data: { status: "SUBMITTED", submittedAt: now, submittedById: user.id },
          events: [EVENT_TYPES.INSPECTION_SUBMITTED],
          snapshot: true,
          snapshotNote: "Submitted",
        });
        await auditAndLog("INSPECTION_SUBMITTED", updated.status);
        await notifyRole("ADMIN", {
          title: "Inspection report submitted",
          message: `${report.code} — ${report.title} (${report.project.name}) was submitted by ${user.name} for approval.`,
          type: "INFO",
          resourceType: "INSPECTION_REPORT",
          resourceId: id,
          channels: ["IN_APP", "EMAIL"],
        });
        if (report.inspector?.userId && report.inspector.userId !== user.id) {
          await notify({
            userId: report.inspector.userId,
            title: "Report submitted",
            message: `Inspection report ${report.code} was submitted and is awaiting review.`,
            type: "INFO",
            resourceType: "INSPECTION_REPORT",
            resourceId: id,
          });
        }
        return ok(updated);
      }

      case "review": {
        if (!canManage) throw Errors.forbidden("Only supervisors/admins can start the review.");
        const updated = await run({
          step: "REVIEW",
          from: ["SUBMITTED"],
          to: "IN_REVIEW",
          data: { status: "IN_REVIEW", reviewedAt: now, reviewedById: user.id },
          events: [EVENT_TYPES.INSPECTION_REVIEWED],
        });
        await auditAndLog("INSPECTION_REVIEWED", updated.status);
        if (report.inspector?.userId) {
          await notify({
            userId: report.inspector.userId,
            title: "Report under review",
            message: `Inspection report ${report.code} is now being reviewed by ${user.name}.`,
            type: "INFO",
            resourceType: "INSPECTION_REPORT",
            resourceId: id,
          });
        }
        return ok(updated);
      }

      case "manager_approve": {
        if (!canManage) throw Errors.forbidden("Only supervisors/admins can record the manager approval.");
        const updated = await run({
          step: "MANAGER_APPROVAL",
          from: ["IN_REVIEW"],
          to: "MANAGER_APPROVAL",
          data: { status: "MANAGER_APPROVAL", reviewedAt: now, reviewedById: user.id },
          events: [EVENT_TYPES.INSPECTION_REVIEWED],
        });
        await auditAndLog("INSPECTION_REVIEWED", updated.status, { step: "MANAGER_APPROVAL" });
        return ok(updated);
      }

      case "client_request": {
        if (!canManage) throw Errors.forbidden("Only supervisors/admins can request client review.");
        const updated = await run({
          step: "CLIENT_REQUEST",
          from: ["MANAGER_APPROVAL"],
          to: "CLIENT_REVIEW",
          data: { status: "CLIENT_REVIEW", customerVisible: true },
          events: [EVENT_TYPES.INSPECTION_REVIEWED],
        });
        await auditAndLog("INSPECTION_REVIEWED", updated.status, { step: "CLIENT_REQUEST" });
        // Notify every portal user of the project's customer (contract §6).
        if (report.project.customerId) {
          const portalUsers = await db.user.findMany({
            where: { role: "CUSTOMER", customerId: report.project.customerId, status: "ACTIVE" },
            select: { id: true },
          });
          for (const u of portalUsers) {
            await notify({
              userId: u.id,
              title: "Client review requested",
              message: `Client review requested for report ${report.code} — ${report.title}.`,
              type: "INFO",
              resourceType: "INSPECTION_REPORT",
              resourceId: id,
            });
          }
        }
        return ok(updated);
      }

      case "client_approve": {
        if (!canManage && !isPortalCustomer) {
          throw Errors.forbidden("Only supervisors/admins or the owning customer can confirm client approval.");
        }
        if (isPortalCustomer && report.status !== "CLIENT_REVIEW") {
          throw Errors.invalidTransition("Client confirmation is only possible while the report is in client review.");
        }
        const updated = await run({
          step: "CLIENT_APPROVE",
          from: ["CLIENT_REVIEW"],
          to: "APPROVED",
          data: {
            status: "APPROVED",
            approvedAt: now,
            approvedById: user.id,
            ...(comment ? { clientComment: comment } : {}),
          },
          events: [EVENT_TYPES.INSPECTION_APPROVED, EVENT_TYPES.INSPECTION_COMPLETED],
          snapshot: true,
          snapshotNote: "Approved (client confirmation)",
        });
        await auditAndLog("INSPECTION_APPROVED", updated.status, { viaPortal: isPortalCustomer });
        if (report.inspector?.userId) {
          await notify({
            userId: report.inspector.userId,
            title: "Inspection report approved",
            message: `${report.code} — ${report.title} was approved by ${user.name}.`,
            type: "SUCCESS",
            resourceType: "INSPECTION_REPORT",
            resourceId: id,
          });
        }
        return ok(updated);
      }

      case "approve": {
        if (!canManage) throw Errors.forbidden("Only supervisors/admins can approve inspection reports.");
        const updated = await run({
          step: "APPROVE",
          from: ["MANAGER_APPROVAL", "CLIENT_REVIEW"],
          to: "APPROVED",
          data: { status: "APPROVED", approvedAt: now, approvedById: user.id },
          events: [EVENT_TYPES.INSPECTION_APPROVED, EVENT_TYPES.INSPECTION_COMPLETED],
          snapshot: true,
          snapshotNote: "Approved",
        });
        await auditAndLog("INSPECTION_APPROVED", updated.status);
        if (report.inspector?.userId) {
          await notify({
            userId: report.inspector.userId,
            title: "Inspection report approved",
            message: `${report.code} — ${report.title} was approved by ${user.name}.`,
            type: "SUCCESS",
            resourceType: "INSPECTION_REPORT",
            resourceId: id,
          });
        }
        return ok(updated);
      }

      case "reject": {
        const portalReject = isPortalCustomer && report.status === "CLIENT_REVIEW";
        if (!canManage && !portalReject) {
          throw Errors.forbidden("Only supervisors/admins can reject this report.");
        }
        if (portalReject && !comment) {
          throw Errors.badRequest("A rejection comment is required.");
        }
        const updated = await run({
          step: "REJECT",
          from: ["SUBMITTED", "IN_REVIEW", "MANAGER_APPROVAL", "CLIENT_REVIEW"],
          to: "REJECTED",
          data: { status: "REJECTED", rejectedAt: now, rejectedById: user.id },
          events: [EVENT_TYPES.INSPECTION_REJECTED],
        });
        await auditAndLog("INSPECTION_REJECTED", updated.status, { viaPortal: portalReject });
        if (report.inspector?.userId) {
          await notify({
            userId: report.inspector.userId,
            title: "Inspection report rejected",
            message: `${report.code} — ${report.title} was rejected by ${user.name}.${comment ? ` Comment: ${comment}` : ""}`,
            type: "WARNING",
            resourceType: "INSPECTION_REPORT",
            resourceId: id,
          });
        }
        return ok(updated);
      }

      case "reopen": {
        if (!canManage && !isOwner) throw Errors.forbidden("Only the inspector or a supervisor can reopen this report.");
        if (isPortalCustomer) throw Errors.forbidden();
        const updated = await run({
          step: "REOPEN",
          from: ["REJECTED"],
          to: "DRAFT",
          data: { status: "DRAFT" },
          events: [EVENT_TYPES.IRMS_REPORT_UPDATED],
        });
        await auditAndLog("INSPECTION_REOPENED", updated.status);
        return ok(updated);
      }

      case "archive": {
        if (!canManage) throw Errors.forbidden("Only supervisors/admins can archive reports.");
        const updated = await run({
          step: "ARCHIVE",
          from: ["APPROVED"],
          to: "ARCHIVED",
          data: { status: "ARCHIVED", archivedAt: now },
          events: [EVENT_TYPES.INSPECTION_ARCHIVED],
        });
        await auditAndLog("INSPECTION_ARCHIVED", updated.status);
        return ok(updated);
      }
    }
  }
);
