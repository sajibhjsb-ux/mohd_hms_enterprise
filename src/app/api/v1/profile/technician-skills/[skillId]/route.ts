// MOHD.HMS ENTERPRISE — Technician self-service: single own skill (spec §6/§7).
// PATCH  /api/v1/profile/technician-skills/[skillId] — edit level / certification /
//                                                      years of experience.
// DELETE — remove the skill.
//
// Self-only scope: the skill must belong to the session user's OWN technician
// profile. A skill owned by anyone else answers 404 (never 403 — existence of
// other people's skills is not disclosed). Mutations re-sync the legacy CSV
// mirror and write audit rows.

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { handler, ok, Errors, parseBody } from "@/lib/hms/api";
import { clientIp } from "@/lib/hms/rate-limit";
import { removeSkillEntry, updateSkillEntry, updateSkillSchema } from "../../../technicians/_skills";

type Ctx = { params: Promise<{ skillId: string }> };

async function requireOwnProfile(userId: string) {
  const profile = await db.technicianProfile.findUnique({
    where: { userId },
    include: { user: { select: { id: true, name: true, email: true } } },
  });
  if (!profile) throw Errors.notFound("No technician profile is linked to your account.");
  return profile;
}

export async function PATCH(req: NextRequest, ctx: Ctx): Promise<NextResponse> {
  const { skillId } = await ctx.params;
  return handler(async ({ req: r, user }) => {
    const profile = await requireOwnProfile(user.id);
    const body = await parseBody(r, updateSkillSchema);
    const skill = await updateSkillEntry({ profile, skillId, body, actor: user, ip: clientIp(r) });
    return ok(skill);
  })(req);
}

export async function DELETE(req: NextRequest, ctx: Ctx): Promise<NextResponse> {
  const { skillId } = await ctx.params;
  return handler(async ({ user }) => {
    const profile = await requireOwnProfile(user.id);
    const skill = await removeSkillEntry({ profile, skillId, actor: user });
    return ok(skill);
  })(req);
}
