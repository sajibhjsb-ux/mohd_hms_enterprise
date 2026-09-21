// MOHD.HMS ENTERPRISE — Payroll run workflow transitions (spec §9/§27/§28/§39/§41).
//
//   calculate → REVIEW (see ./calculate) → approve → finalize → mark_paid → lock
//
// Permissions are enforced HERE, server-side (§28 — never frontend-only):
//   approve/finalize/mark_paid = payroll.approve (FINANCE/ADMIN/SA)
//   lock                       = SUPER_ADMIN only (explicit role check)
// mark_paid posts the NET payroll through the EXISTING finance ledger
// (Account/Transaction — the house Expense→Transaction pattern, §40/§41).

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { handler, ok, parseBody, Errors } from "@/lib/hms/api";
import { PERMISSIONS, humanize } from "@/lib/hms/constants";
import { roleCan } from "@/lib/hms/rbac";
import type { SessionUser } from "@/lib/hms/auth";
import { audit, nextNumber, notifyRole } from "@/lib/hms/services";
import { emit } from "@/lib/hms/workflows/bus";
import { EVENT_TYPES } from "@/lib/hms/workflows/types";

const bodySchema = z.object({
  action: z.enum(["submit", "approve", "finalize", "mark_paid", "lock", "cancel"]),
  paymentRef: z.string().trim().max(120).optional(),
  reason: z.string().trim().max(300).optional(),
});

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return handler(async ({ user }) => {
    const body = await parseBody(req, bodySchema);
    // Per-action authorization (§28 — enforced server-side, never frontend-only).
    // The route is auth-gated; EACH action checks its own permission here:
    //   submit/cancel          → payroll.manage   (HR preparation duties)
    //   approve/finalize/mark_paid → payroll.approve (Finance/admins)
    //   lock                   → SUPER_ADMIN only (explicit role check below)
    if (["submit", "cancel"].includes(body.action) && !roleCan(user.role, PERMISSIONS.payroll_manage)) {
      throw Errors.forbidden("You do not have permission to manage this payroll run.");
    }
    if (["approve", "finalize", "mark_paid"].includes(body.action) && !roleCan(user.role, PERMISSIONS.payroll_approve)) {
      throw Errors.forbidden("You do not have permission to approve or finalize payroll.");
    }
    const run = await db.payrollRun.findUnique({ where: { id } });
    if (!run) throw Errors.notFound("Payroll run not found.");

    switch (body.action) {
      // ── submit for approval: REVIEW → stays REVIEW but stamps the submitter.
      case "submit": {
        if (run.status !== "REVIEW") {
          throw Errors.invalidTransition(`Only runs under review can be submitted for approval (current: ${humanize(run.status)}).`);
        }
        const updated = await db.payrollRun.update({
          where: { id }, data: { submittedById: user.id, submittedAt: new Date() },
        });
        await audit({ actorId: user.id, actorEmail: user.email, action: "PAYROLL_SUBMITTED", resourceType: "PAYROLL_RUN", resourceId: id, metadata: { code: run.code } });
        await notifyRole("FINANCE", {
          title: "Payroll awaiting financial review",
          message: `${run.name} (${run.code}) was submitted for review by ${user.name}.`,
          type: "INFO", resourceType: "PAYROLL_RUN", resourceId: id,
        });
        return ok(updated);
      }

      // ── approve (§28): REVIEW → APPROVED. Finance/admin only.
      case "approve": {
        if (run.status !== "REVIEW") {
          throw Errors.invalidTransition(`Only runs under review can be approved (current: ${humanize(run.status)}).`);
        }
        const updated = await db.payrollRun.update({
          where: { id },
          data: { status: "APPROVED", approvedById: user.id, approvedAt: new Date() },
        });
        await audit({
          actorId: user.id, actorEmail: user.email, action: "PAYROLL_APPROVED",
          resourceType: "PAYROLL_RUN", resourceId: id,
          metadata: { code: run.code, netCents: run.netCents, exceptions: run.exceptionCount },
        });
        await emit({ type: EVENT_TYPES.PAYROLL_RUN_UPDATED, resourceType: "PayrollRun", resourceId: id, payload: { code: run.code, status: "APPROVED" }, actorType: "USER", actorId: user.id });
        await notifyRole("HR", {
          title: "Payroll approved",
          message: `${run.name} (${run.code}) was approved and can be finalized.`,
          type: "SUCCESS", resourceType: "PAYROLL_RUN", resourceId: id,
        });
        return ok(updated);
      }

      // ── finalize (§27): APPROVED → FINALIZED. Values become immutable;
      //    approved adjustments are stamped APPLIED (audit-preserved, §24).
      case "finalize": {
        if (run.status !== "APPROVED") {
          throw Errors.invalidTransition(`Only approved runs can be finalized (current: ${humanize(run.status)}).`);
        }
        const updated = await db.$transaction(async (tx) => {
          const fin = await tx.payrollRun.update({
            where: { id },
            data: { status: "FINALIZED", finalizedById: user.id, finalizedAt: new Date() },
          });
          await tx.payrollAdjustment.updateMany({
            where: { runId: id, status: "APPROVED" },
            data: { status: "APPLIED", appliedAt: new Date() },
          });
          return fin;
        });
        await audit({
          actorId: user.id, actorEmail: user.email, action: "PAYROLL_FINALIZED",
          resourceType: "PAYROLL_RUN", resourceId: id,
          metadata: { code: run.code, employees: run.employeeCount, netCents: run.netCents },
        });
        await emit({ type: EVENT_TYPES.PAYROLL_RUN_UPDATED, resourceType: "PayrollRun", resourceId: id, payload: { code: run.code, status: "FINALIZED" }, actorType: "USER", actorId: user.id });
        return ok(updated);
      }

      // ── mark paid (§39): FINALIZED → PAID. Explicit confirmation only —
      //    never a side effect of an export. Posts the net through the ledger.
      case "mark_paid": {
        if (run.status !== "FINALIZED") {
          throw Errors.invalidTransition(`Only finalized runs can be marked paid (current: ${humanize(run.status)}).`);
        }
        // Existing ledger pattern: debit the bank account (cash fallback) and
        // record one EXPENSE transaction referencing this run (§40/§41).
        const cash = await db.account.findUnique({ where: { code: "ACC-CASH" } });
        const bank = cash ? null : await db.account.findUnique({ where: { code: "ACC-BANK" } });
        const account = cash ?? bank;
        const trxCode = await nextNumber("TRX");

        const updated = await db.$transaction(async (tx) => {
          const paid = await tx.payrollRun.update({
            where: { id },
            data: {
              status: "PAID",
              paidById: user.id,
              paidAt: new Date(),
              payDate: run.payDate ?? new Date(),
              paymentRef: body.paymentRef ?? trxCode,
            },
          });
          if (account) {
            await tx.account.update({ where: { id: account.id }, data: { balanceCents: { decrement: run.netCents } } });
          }
          await tx.transaction.create({
            data: {
              code: trxCode,
              type: "EXPENSE",
              category: "PAYROLL",
              description: `Payroll ${run.name} — net salaries (${run.employeeCount} employees)`,
              amountCents: run.netCents,
              accountId: account?.id ?? null,
              date: paid.paidAt ?? new Date(),
              referenceType: "PAYROLL_RUN",
              referenceId: run.id,
              createdById: user.id,
            },
          });
          return paid;
        });

        await audit({
          actorId: user.id, actorEmail: user.email, action: "PAYROLL_PAID",
          resourceType: "PAYROLL_RUN", resourceId: id,
          metadata: { code: run.code, netCents: run.netCents, transaction: trxCode, paymentRef: updated.paymentRef },
        });
        await emit({ type: EVENT_TYPES.PAYROLL_RUN_UPDATED, resourceType: "PayrollRun", resourceId: id, payload: { code: run.code, status: "PAID" }, actorType: "USER", actorId: user.id });
        return ok(updated);
      }

      // ── lock (§9/§50): PAID → LOCKED. SUPER_ADMIN only (explicit role check —
      //    ADMIN holds every permission, locking is a super-admin duty).
      case "lock": {
        if (user.role !== "SUPER_ADMIN") throw Errors.forbidden("Only SUPER_ADMIN can lock a payroll period.");
        if (run.status !== "PAID") {
          throw Errors.invalidTransition(`Only paid runs can be locked (current: ${humanize(run.status)}).`);
        }
        const updated = await db.payrollRun.update({
          where: { id },
          data: { status: "LOCKED", lockedById: user.id, lockedAt: new Date() },
        });
        await audit({
          actorId: user.id, actorEmail: user.email, action: "PAYROLL_LOCKED",
          resourceType: "PAYROLL_RUN", resourceId: id, metadata: { code: run.code },
        });
        await emit({ type: EVENT_TYPES.PAYROLL_RUN_UPDATED, resourceType: "PayrollRun", resourceId: id, payload: { code: run.code, status: "LOCKED" }, actorType: "USER", actorId: user.id });
        return ok(updated);
      }

      // ── cancel: draft/failed runs only (§50 — never silently modify closed
      //    periods; finalized runs are corrected via adjustments instead).
      case "cancel": {
        if (!["DRAFT", "FAILED", "CALCULATING"].includes(run.status)) {
          throw Errors.invalidTransition(`Only draft/failed runs can be cancelled (current: ${humanize(run.status)}).`);
        }
        const reason = body.reason?.trim() || "Cancelled by " + user.name;
        await db.payrollRun.update({ where: { id }, data: { status: "CANCELLED", errorNote: reason } });
        await audit({
          actorId: user.id, actorEmail: user.email, action: "PAYROLL_RUN_CANCELLED",
          resourceType: "PAYROLL_RUN", resourceId: id, metadata: { code: run.code, reason },
        });
        await emit({ type: EVENT_TYPES.PAYROLL_RUN_UPDATED, resourceType: "PayrollRun", resourceId: id, payload: { code: run.code, status: "CANCELLED" }, actorType: "USER", actorId: user.id });
        return ok({ cancelled: true });
      }
    }
  })(req);
}
