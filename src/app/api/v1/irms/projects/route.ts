import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { handler, ok, okList, parseBody, listQuery, pagedMeta, Errors } from "@/lib/hms/api";
import { PERMISSIONS } from "@/lib/hms/constants";
import { audit, nextNumber } from "@/lib/hms/services";
import { emit } from "@/lib/hms/workflows/bus";
import { EVENT_TYPES } from "@/lib/hms/workflows/types";

const PROJECT_STATUSES = ["PLANNING", "ACTIVE", "ON_HOLD", "COMPLETED"] as const;

export const GET = handler(
  async ({ req }) => {
    const q = listQuery(req);
    const where: Record<string, unknown> = {};
    if (q.status) where.status = q.status;
    if (q.search) {
      where.OR = [
        { code: { contains: q.search } },
        { name: { contains: q.search } },
        { siteLocation: { contains: q.search } },
      ];
    }

    const dir = q.dir === "asc" ? ("asc" as const) : ("desc" as const);
    const [items, total] = await Promise.all([
      db.irmsProject.findMany({
        where,
        include: {
          customer: { select: { id: true, companyName: true, contactPerson: true } },
          _count: { select: { inspections: true } },
        },
        orderBy: { createdAt: dir },
        skip: q.skip,
        take: q.take,
      }),
      db.irmsProject.count({ where }),
    ]);

    return okList(
      items.map((p) => ({ ...p, inspectionsCount: p._count.inspections })),
      pagedMeta(q.page, q.pageSize, total)
    );
  },
  { permission: PERMISSIONS.irms_read }
);

const createSchema = z.object({
  name: z.string().min(2, "Project name is required."),
  customerId: z.string().min(1).nullish(),
  siteLocation: z.string().max(300).nullish(),
  description: z.string().max(4000).nullish(),
  startDate: z.string().nullish(),
  endDate: z.string().nullish(),
});

export const POST = handler(
  async ({ req, user }) => {
    const body = await parseBody(req, createSchema);
    if (body.customerId) {
      const customer = await db.customer.findUnique({ where: { id: body.customerId } });
      if (!customer) throw Errors.badRequest("Selected customer does not exist.");
    }
    const start = body.startDate ? new Date(body.startDate) : null;
    const end = body.endDate ? new Date(body.endDate) : null;
    if (start && isNaN(start.getTime())) throw Errors.badRequest("Start date is invalid.");
    if (end && isNaN(end.getTime())) throw Errors.badRequest("End date is invalid.");
    if (start && end && end < start) throw Errors.badRequest("End date cannot be before start date.");

    const code = await nextNumber("PRJ");
    const project = await db.irmsProject.create({
      data: {
        code,
        name: body.name,
        customerId: body.customerId ?? null,
        siteLocation: body.siteLocation ?? "",
        description: body.description ?? "",
        status: "ACTIVE",
        startDate: start,
        endDate: end,
      },
      include: { customer: { select: { id: true, companyName: true, contactPerson: true } }, _count: { select: { inspections: true } } },
    });

    await audit({
      actorId: user.id,
      actorEmail: user.email,
      action: "IRMS_PROJECT_CREATED",
      resourceType: "IrmsProject",
      resourceId: project.id,
      metadata: { code, name: project.name },
    });

    // Realtime (STEP 16): IRMS staff views update live.
    await emit({ type: EVENT_TYPES.IRMS_PROJECT_UPDATED, resourceType: "IrmsProject", resourceId: project.id, payload: { code, action: "CREATED" }, actorType: "USER", actorId: user.id });
    return ok({ ...project, inspectionsCount: project._count.inspections }, 201);
  },
  { permission: PERMISSIONS.irms_manage }
);
