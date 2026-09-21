// MOHD.HMS ENTERPRISE — Skill library item removal (spec §8).
// DELETE /api/v1/skills/[id] — technicians.manage holders only. A catalogue
// entry that is still assigned to any technician (TechnicianSkill.name join)
// cannot be removed → 409 CONFLICT with the usage count.

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { handler, ok, Errors } from "@/lib/hms/api";
import { PERMISSIONS } from "@/lib/hms/constants";
import { audit } from "@/lib/hms/services";
import { clientIp } from "@/lib/hms/rate-limit";

type Ctx = { params: Promise<{ id: string }> };

export async function DELETE(req: NextRequest, ctx: Ctx): Promise<NextResponse> {
  const { id } = await ctx.params;
  return handler(
    async ({ user }) => {
      const item = await db.skillLibraryItem.findUnique({ where: { id } });
      if (!item) throw Errors.notFound("Skill library item not found.");

      const inUse = await db.technicianSkill.count({ where: { name: item.name } });
      if (inUse > 0) {
        throw Errors.conflict(
          `This skill is assigned to ${inUse} technician${inUse === 1 ? "" : "s"} and cannot be removed from the library.`,
        );
      }

      await db.skillLibraryItem.delete({ where: { id } });

      await audit({
        actorId: user.id,
        actorEmail: user.email,
        action: "SKILL_LIBRARY_ITEM_REMOVED",
        resourceType: "SKILL_LIBRARY",
        resourceId: item.id,
        metadata: { skill: item.name, category: item.category },
        ip: clientIp(req),
      });

      return ok({ id: item.id, name: item.name });
    },
    { permission: PERMISSIONS.technicians_manage }
  )(req);
}
