// MOHD.HMS ENTERPRISE — Complaint Work Catalogue master-data API (§12/§13).
// GET  /api/v1/work-catalogues — active catalogues with catalogue-specific
//                              issue lists (consumed by the complaint form).
// POST /api/v1/work-catalogues — create/edit catalogue sets (catalogue_manage).
import { z } from "zod";
import { db } from "@/lib/db";
import { handler, ok, okList, parseBody, Errors } from "@/lib/hms/api";
import { PERMISSIONS } from "@/lib/hms/constants";
import { ensureDefaultCatalogues } from "@/lib/hms/catalogue";
import type { Prisma } from "@prisma/client";

const CATALOGUE_INCLUDE = { issues: { where: { active: true }, orderBy: { sortOrder: "asc" as const } } } satisfies Prisma.WorkCatalogueInclude;
const ALL_INCLUDE = { issues: { orderBy: { sortOrder: "asc" as const } } } satisfies Prisma.WorkCatalogueInclude;

const issueSchema = z.object({
  id: z.string().optional(),
  name: z.string().min(2, "Issue name must be at least 2 characters.").max(200),
  active: z.boolean().default(true),
  sortOrder: z.number().int().min(0).default(0),
});
const createSchema = z.object({
  code: z.string().min(2, "Catalogue code must be at least 2 characters.").max(20).regex(/^[A-Z0-9_-]+$/, "Catalogue code may only contain A–Z, 0–9, _ and -."),
  name: z.string().min(2, "Catalogue name must be at least 2 characters.").max(200),
  description: z.string().max(2000).optional().default(""),
  active: z.boolean().default(true),
  sortOrder: z.number().int().min(0).default(0),
  issues: z.array(issueSchema).min(1, "A catalogue must have at least one issue.").max(100),
});

export const GET = handler(
  async () => {
    await ensureDefaultCatalogues();
    const rows = await db.workCatalogue.findMany({
      where: { active: true },
      include: CATALOGUE_INCLUDE,
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    });
    return okList(rows);
  },
  { permission: PERMISSIONS.complaints_create }
);

export const POST = handler(
  async ({ req, user }) => {
    const body = await parseBody(req, createSchema);
    const existing = await db.workCatalogue.findUnique({ where: { code: body.code } });
    if (existing) throw Errors.conflict(`Catalogue code ${body.code} already exists.`);
    const created = await db.workCatalogue.create({
      data: {
        code: body.code,
        name: body.name,
        description: body.description,
        active: body.active,
        sortOrder: body.sortOrder,
        issues: { create: body.issues.map((it) => ({ name: it.name, active: it.active, sortOrder: it.sortOrder })) },
      },
      include: ALL_INCLUDE,
    });
    return ok(created, 201);
  },
  { permission: PERMISSIONS.catalogue_manage }
);