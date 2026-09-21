// MOHD.HMS ENTERPRISE — Skill library (master catalogue) API (spec §8).
// GET  /api/v1/skills  — any staff account (suggestions for the skill picker);
//                        optional filters: ?category=HVAC&active=true&search=weld
// POST /api/v1/skills  — technicians.manage holders only; extends the catalogue
//                        with a new reusable skill (name unique → 409).
//
// The library is the suggestion source for both the supervisor skill manager
// and technician self-service. Name is the join key used by TechnicianSkill.

import { NextRequest } from "next/server";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { handler, ok, okList, Errors, parseBody } from "@/lib/hms/api";
import { PERMISSIONS } from "@/lib/hms/constants";
import { isStaff } from "@/lib/hms/rbac";
import { audit } from "@/lib/hms/services";
import { clientIp } from "@/lib/hms/rate-limit";
import { normalizeSkillCategory, normalizeSkillName } from "../technicians/_skills";

export const GET = handler(async ({ req, user }) => {
  // Staff-only (technicians pick from it too); customers have no use for it.
  if (!isStaff(user.role)) {
    throw Errors.forbidden("The skill library is available to staff accounts only.");
  }
  const sp = new URL(req.url).searchParams;
  const category = (sp.get("category") ?? "").trim().toUpperCase();
  const active = (sp.get("active") ?? "").trim();
  const search = (sp.get("search") ?? "").trim();

  const where: Prisma.SkillLibraryItemWhereInput = {};
  if (category) where.category = category;
  if (active === "true") where.active = true;
  if (active === "false") where.active = false;
  if (search) where.name = { contains: search };

  const items = await db.skillLibraryItem.findMany({
    where,
    orderBy: [{ category: "asc" }, { name: "asc" }],
    select: { id: true, name: true, category: true, active: true },
  });
  return okList(items, { total: items.length });
});

const libraryCreateSchema = z.object({
  name: z.string().trim().min(1, "Skill name is required.").max(80, "Skill name must be 80 characters or fewer."),
  category: z.string().trim().min(1, "Category is required.").max(40, "Category must be 40 characters or fewer."),
  description: z.string().trim().max(300, "Description must be 300 characters or fewer.").optional(),
});

export const POST = handler(
  async ({ req, user }) => {
    const body = await parseBody(req, libraryCreateSchema);
    const name = normalizeSkillName(body.name);
    const category = normalizeSkillCategory(body.category);

    const existing = await db.skillLibraryItem.findUnique({ where: { name }, select: { id: true } });
    if (existing) throw Errors.conflict("This skill already exists in the library.");

    const item = await db.skillLibraryItem.create({ data: { name, category, description: body.description ?? "" } });

    await audit({
      actorId: user.id,
      actorEmail: user.email,
      action: "SKILL_LIBRARY_ITEM_ADDED",
      resourceType: "SKILL_LIBRARY",
      resourceId: item.id,
      metadata: { skill: name, category },
      ip: clientIp(req),
    });

    return ok({ id: item.id, name: item.name, category: item.category, active: item.active }, 201);
  },
  { permission: PERMISSIONS.technicians_manage }
);
