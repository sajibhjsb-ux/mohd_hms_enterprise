import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { handler, ok, parseBody, Errors } from "@/lib/hms/api";
import type { SessionUser } from "@/lib/hms/auth";
import { PERMISSIONS } from "@/lib/hms/constants";
import { audit } from "@/lib/hms/services";
import { emit } from "@/lib/hms/workflows/bus";
import { EVENT_TYPES } from "@/lib/hms/workflows/types";
import { buildSnapshot, type TxClient } from "@/lib/hms/irms/storage";

function withId(fn: (id: string, ctx: { req: NextRequest; user: SessionUser }) => Promise<NextResponse>) {
  return async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    return handler((c) => fn(id, c), { permission: PERMISSIONS.irms_manage })(req);
  };
}

const createSchema = z.object({ note: z.string().max(500).optional() });

/** 7. POST /api/v1/irms/reports/[id]/revisions (MANAGE) — manual snapshot. */
export const POST = withId(
  async (id, { req, user }) => {
    const body = await parseBody(req, createSchema);
    const report = await db.inspectionReport.findUnique({
      where: { id },
      include: { findings: { select: { finding: true, severity: true, recommendation: true } } },
    });
    if (!report) throw Errors.notFound("Inspection report not found.");

    const version = report.revision + 1;
    const created = await db.$transaction(async (tx: TxClient) => {
      const row = await tx.inspectionRevision.create({
        data: {
          reportId: id,
          version,
          snapshot: buildSnapshot(report, report.findings),
          note: body.note?.trim() || "Manual snapshot",
          createdById: user.id,
          createdByName: user.name,
        },
        select: { id: true, version: true, note: true, createdAt: true },
      });
      await tx.inspectionReport.update({ where: { id }, data: { revision: version } });
      await emit({
        type: EVENT_TYPES.IRMS_REPORT_UPDATED,
        resourceType: "INSPECTION_REPORT",
        resourceId: id,
        payload: { reportId: id, code: report.code, status: report.status },
        actorType: "USER",
        actorId: user.id,
        tx,
      });
      return row;
    });

    await audit({
      actorId: user.id,
      actorEmail: user.email,
      action: "INSPECTION_REVISION_CREATED",
      resourceType: "INSPECTION_REPORT",
      resourceId: id,
      metadata: { code: report.code, version },
    });
    return NextResponse.json({ ok: true, data: created }, { status: 201 });
  }
);

/** Convenience GET is not part of the contract — revisions ship inside report detail. */
export const GET = withId(async (id) => {
  const report = await db.inspectionReport.findUnique({ where: { id }, select: { id: true } });
  if (!report) throw Errors.notFound("Inspection report not found.");
  const revisions = await db.inspectionRevision.findMany({
    where: { reportId: id },
    orderBy: { version: "desc" },
    select: { id: true, version: true, note: true, createdByName: true, createdAt: true },
  });
  return ok({ items: revisions });
});
