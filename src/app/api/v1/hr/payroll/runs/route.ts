// MOHD.HMS ENTERPRISE — Payroll runs API (spec §8/§10/§32/§55).
// GET  = list runs (payroll.read). POST = create a DRAFT run for one period
// (payroll.manage); the unique periodKey prevents duplicate runs (§55).

import { z } from "zod";
import { db } from "@/lib/db";
import { handler, ok, okList, parseBody, listQuery, pagedMeta, Errors } from "@/lib/hms/api";
import { PERMISSIONS } from "@/lib/hms/constants";
import { audit, nextNumber } from "@/lib/hms/services";
import { emit } from "@/lib/hms/workflows/bus";
import { EVENT_TYPES } from "@/lib/hms/workflows/types";
import { periodKeyOf, periodLabel } from "@/lib/hms/payroll/engine";

const createSchema = z.object({
  /** First day of the payroll period (ISO date) or a "YYYY-MM" month key. */
  period: z.string().min(7).max(10),
  name: z.string().trim().max(120).optional(),
  payDate: z.string().optional(),
});

function monthWindow(period: string): { start: Date; end: Date } {
  // Accepts "YYYY-MM" (preferred) or an ISO "YYYY-MM-DD" (its month).
  const m = /^(\d{4})-(\d{2})/.exec(period.trim());
  if (!m) throw Errors.badRequest("period must be YYYY-MM or an ISO date.");
  const year = Number(m[1]);
  const month = Number(m[2]);
  if (month < 1 || month > 12) throw Errors.badRequest("period month must be 01..12.");
  const start = new Date(Date.UTC(year, month - 1, 1));
  const end = new Date(Date.UTC(year, month, 0)); // last day of month
  return { start, end };
}

export const GET = handler(async ({ req }) => {
  const { page, pageSize, skip, take, search, status } = listQuery(req);
  const where = {
    ...(status ? { status } : {}),
    ...(search ? { OR: [{ code: { contains: search } }, { name: { contains: search } }, { periodKey: { contains: search } }] } : {}),
  };
  const [items, total] = await Promise.all([
    db.payrollRun.findMany({
      where,
      orderBy: { periodStart: "desc" },
      skip,
      take,
      include: {
        creator: { select: { name: true, email: true } },
        approver: { select: { name: true, email: true } },
      },
    }),
    db.payrollRun.count({ where }),
  ]);
  return okList(
    items.map((r) => ({ ...r, creatorName: r.creator?.name ?? "", approverName: r.approver?.name ?? "", creator: undefined, approver: undefined })),
    pagedMeta(page, pageSize, total),
  );
}, { permission: PERMISSIONS.payroll_read });

export const POST = handler(async ({ req, user }) => {
  const body = await parseBody(req, createSchema);
  const { start, end } = monthWindow(body.period);
  const periodKey = periodKeyOf(start);

  // §55 — one run per period; duplicates are rejected, never silently merged.
  const dup = await db.payrollRun.findUnique({ where: { periodKey } });
  if (dup) {
    throw Errors.conflict(`A payroll run for ${periodLabel(start)} already exists (${dup.code}).`);
  }

  const code = await nextNumber("PRR");
  const run = await db.payrollRun.create({
    data: {
      code,
      periodKey,
      name: body.name?.trim() || `${periodLabel(start)} Payroll`,
      periodStart: start,
      periodEnd: end,
      frequency: "MONTHLY",
      status: "DRAFT",
      payDate: body.payDate ? new Date(body.payDate) : null,
      createdById: user.id,
    },
  });

  await audit({
    actorId: user.id, actorEmail: user.email, action: "PAYROLL_RUN_CREATED",
    resourceType: "PAYROLL_RUN", resourceId: run.id,
    metadata: { code, periodKey, periodStart: start.toISOString(), periodEnd: end.toISOString() },
  });
  await emit({ type: EVENT_TYPES.PAYROLL_RUN_UPDATED, resourceType: "PayrollRun", resourceId: run.id, payload: { code, status: run.status }, actorType: "USER", actorId: user.id });
  return ok(run, 201);
}, { permission: PERMISSIONS.payroll_manage });
