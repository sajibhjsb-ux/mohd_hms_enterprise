import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { handler, ok, parseBody, Errors } from "@/lib/hms/api";
import type { SessionUser } from "@/lib/hms/auth";
import { PERMISSIONS } from "@/lib/hms/constants";
import { audit } from "@/lib/hms/services";

function withId(fn: (id: string, ctx: { req: NextRequest; user: SessionUser }) => Promise<NextResponse>, permission?: (typeof PERMISSIONS)[keyof typeof PERMISSIONS]) {
  return async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    return handler((c) => fn(id, c), { permission })(req);
  };
}

export const GET = withId(
  async (id) => {
    const project = await db.irmsProject.findUnique({
      where: { id },
      include: {
        customer: { select: { id: true, companyName: true, contactPerson: true, email: true } },
        inspections: {
          orderBy: { inspectionDate: "desc" },
          take: 20,
          include: {
            inspector: { select: { user: { select: { name: true } } } },
            _count: { select: { findings: true } },
          },
        },
      },
    });
    if (!project) throw Errors.notFound("Project not found.");
    return ok({
      ...project,
      inspections: project.inspections.map((r) => ({ ...r, findingsCount: r._count.findings })),
    });
  },
  PERMISSIONS.irms_read
);

const patchSchema = z.object({
  name: z.string().min(2).optional(),
  customerId: z.string().min(1).nullish(),
  siteLocation: z.string().max(300).nullish(),
  description: z.string().max(4000).nullish(),
  status: z.enum(["PLANNING", "ACTIVE", "ON_HOLD", "COMPLETED"]).optional(),
  startDate: z.string().nullish(),
  endDate: z.string().nullish(),
});

export const PATCH = withId(
  async (id, { req, user }) => {
    const body = await parseBody(req, patchSchema);
    const project = await db.irmsProject.findUnique({ where: { id } });
    if (!project) throw Errors.notFound("Project not found.");

    if (body.customerId) {
      const customer = await db.customer.findUnique({ where: { id: body.customerId } });
      if (!customer) throw Errors.badRequest("Selected customer does not exist.");
    }
    const parseDate = (s: string | null | undefined): Date | null | undefined => {
      if (s === undefined) return undefined;
      if (s === null || s === "") return null;
      const d = new Date(s);
      if (isNaN(d.getTime())) throw Errors.badRequest("Date is invalid.");
      return d;
    };
    const start = parseDate(body.startDate);
    const end = parseDate(body.endDate);

    const updated = await db.irmsProject.update({
      where: { id },
      data: {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.customerId !== undefined ? { customerId: body.customerId ?? null } : {}),
        ...(body.siteLocation !== undefined ? { siteLocation: body.siteLocation ?? "" } : {}),
        ...(body.description !== undefined ? { description: body.description ?? "" } : {}),
        ...(body.status !== undefined ? { status: body.status } : {}),
        ...(start !== undefined ? { startDate: start } : {}),
        ...(end !== undefined ? { endDate: end } : {}),
      },
      include: { customer: { select: { id: true, companyName: true } }, _count: { select: { inspections: true } } },
    });

    await audit({
      actorId: user.id,
      actorEmail: user.email,
      action: "IRMS_PROJECT_UPDATED",
      resourceType: "IrmsProject",
      resourceId: id,
      metadata: { code: project.code, fields: Object.keys(body) },
    });

    return ok({ ...updated, inspectionsCount: updated._count.inspections });
  },
  PERMISSIONS.irms_manage
);

/**
 * DELETE: only allowed while a project has no inspection reports (real records
 * must not be destroyed). Otherwise the project is marked COMPLETED instead.
 */
export const DELETE = withId(
  async (id, { req, user }) => {
    const project = await db.irmsProject.findUnique({
      where: { id },
      include: { _count: { select: { inspections: true } } },
    });
    if (!project) throw Errors.notFound("Project not found.");

    if (project._count.inspections === 0) {
      await db.irmsProject.delete({ where: { id } });
      await audit({
        actorId: user.id,
        actorEmail: user.email,
        action: "IRMS_PROJECT_DELETED",
        resourceType: "IrmsProject",
        resourceId: id,
        metadata: { code: project.code, name: project.name },
      });
      return ok({ deleted: true, id });
    }

    const updated = await db.irmsProject.update({ where: { id }, data: { status: "COMPLETED" } });
    await audit({
      actorId: user.id,
      actorEmail: user.email,
      action: "IRMS_PROJECT_COMPLETED",
      resourceType: "IrmsProject",
      resourceId: id,
      metadata: { code: project.code, reason: "has inspection reports" },
    });
    return ok(updated);
  },
  PERMISSIONS.irms_manage
);
