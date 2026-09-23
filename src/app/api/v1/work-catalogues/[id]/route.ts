// MOHD.HMS ENTERPRISE — Work Catalogue detail + management (§12/§13).
// GET/PATCH/DELETE /api/v1/work-catalogues/[id] (catalogue_manage for writes).
// PATCH replaces the catalogue's issue list wholesale (catalogue-specific
// dynamic lists — never a flat global list).
import type { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { handler, ok, parseBody, Errors } from "@/lib/hms/api";
import type { SessionUser } from "@/lib/hms/auth";
import { PERMISSIONS } from "@/lib/hms/constants";
import type { Prisma } from "@prisma/client";

const issueSchema = z.object({
  id: z.string().optional(),
  name: z.string().min(2).max(200),
  active: z.boolean().default(true),
  sortOrder: z.number().int().min(0).default(0),
});
const updateSchema = z.object({
  name: z.string().min(2).max(200).optional(),
  description: z.string().max(2000).optional(),
  active: z.boolean().optional(),
  sortOrder: z.number().int().min(0).optional(),
  issues: z.array(issueSchema).min(1).max(100).optional(),
});

const ALL_INCLUDE = { issues: { orderBy: { sortOrder: "asc" as const } } } satisfies Prisma.WorkCatalogueInclude;

type Ctx = { req: NextRequest; user: SessionUser };

function withId(fn: (id: string, ctx: Ctx) => Promise<NextResponse>, permission?: (typeof PERMISSIONS)[keyof typeof PERMISSIONS]) {
  return async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    return handler((c) => fn(id, c), { permission })(req);
  };
}

export const GET = withId(
  async (id) => {
    const row = await db.workCatalogue.findUnique({ where: { id }, include: ALL_INCLUDE });
    if (!row) throw Errors.notFound("Catalogue not found.");
    return ok(row);
  },
  PERMISSIONS.complaints_create
);

export const PATCH = withId(
  async (id, { req, user }) => {
    const body = await parseBody(req, updateSchema);
    const existing = await db.workCatalogue.findUnique({ where: { id }, select: { id: true } });
    if (!existing) throw Errors.notFound("Catalogue not found.");

    await db.$transaction(async (tx) => {
      await tx.workCatalogue.update({
        where: { id },
        data: {
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.description !== undefined ? { description: body.description } : {}),
          ...(body.active !== undefined ? { active: body.active } : {}),
          ...(body.sortOrder !== undefined ? { sortOrder: body.sortOrder } : {}),
        },
      });
      if (body.issues) {
        await tx.catalogueIssue.deleteMany({ where: { catalogueId: id } });
        await tx.catalogueIssue.createMany({
          data: body.issues.map((it) => ({ catalogueId: id, name: it.name, active: it.active, sortOrder: it.sortOrder })),
        });
      }
    });
    const updated = await db.workCatalogue.findUnique({ where: { id }, include: ALL_INCLUDE });
    return ok(updated);
  },
  PERMISSIONS.catalogue_manage
);

export const DELETE = withId(
  async (id) => {
    const existing = await db.workCatalogue.findUnique({ where: { id }, select: { id: true } });
    if (!existing) throw Errors.notFound("Catalogue not found.");
    await db.workCatalogue.delete({ where: { id } });
    return ok({ deleted: true });
  },
  PERMISSIONS.catalogue_manage
);