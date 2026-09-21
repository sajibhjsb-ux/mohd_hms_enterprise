// MOHD.HMS ENTERPRISE — Checklist instance detail (spec §25 review page data / §52 customer sanitize).
// GET /api/v1/checklists/[id]
import type { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { handler, ok, Errors } from "@/lib/hms/api";
import { PERMISSIONS } from "@/lib/hms/constants";
import type { SessionUser } from "@/lib/hms/auth";
import { parseChecklistItems } from "@/lib/hms/checklist/types";

type Ctx = { req: NextRequest; user: SessionUser };

function withId(fn: (id: string, ctx: Ctx) => Promise<NextResponse>, opts?: Parameters<typeof handler>[1]) {
  return async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    return handler((c) => fn(id, c), opts)(req);
  };
}

export const GET = withId(
  async (id, { user }) => {
    const instance = await db.checklistInstance.findUnique({
      where: { id },
      include: {
        workOrder: {
          select: {
            id: true, code: true, title: true, status: true, customerId: true,
            technician: { select: { user: { select: { id: true, name: true } } } },
            checklist: { orderBy: { sortOrder: "asc" } },
          },
        },
        template: { select: { id: true, name: true, version: true, category: true } },
        versions: { orderBy: { version: "desc" }, select: { id: true, version: true, origin: true, note: true, createdAt: true } },
      },
    });
    if (!instance) throw Errors.notFound("Checklist not found.");
    // §38/§80 — the AI generation log row is fetched separately (no Prisma
    // relation needed) and never exposed to customers.
    const aiGeneration = user.role === "CUSTOMER"
      ? null
      : await db.checklistAiGeneration.findFirst({
          where: { instanceId: id },
          orderBy: { createdAt: "desc" },
          select: { id: true, promptVersion: true, provider: true, model: true, status: true, itemCount: true, createdAt: true },
        });

    // §52 — customers: own records only; sanitized payload (no technician notes,
    // no AI generation metadata, no approval internals).
    if (user.role === "CUSTOMER") {
      if (!instance.customerId || instance.customerId !== user.customerId) throw Errors.forbidden();
      return ok({
        id: instance.id, code: instance.code, title: instance.title, sourceType: instance.sourceType,
        sourceId: instance.sourceId, status: instance.status, version: instance.version,
        origin: instance.origin, createdAt: instance.createdAt, completedAt: instance.completedAt,
        items: parseChecklistItems(instance.itemsJson).map((it) => ({
          label: it.label, required: it.required, responseType: it.responseType, unit: it.unit, expectedResult: it.expectedResult,
        })),
        workOrder: instance.workOrder
          ? {
              id: instance.workOrder.id, code: instance.workOrder.code, title: instance.workOrder.title, status: instance.workOrder.status,
              results: instance.workOrder.checklist.map((c) => ({
                label: c.label, responseType: c.responseType, response: c.response, done: c.done, required: c.required,
              })),
            }
          : null,
      });
    }

    return ok({ ...instance, aiGeneration });
  },
  { permission: PERMISSIONS.checklist_view }
);
