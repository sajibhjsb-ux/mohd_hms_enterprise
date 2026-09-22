// MOHD.HMS ENTERPRISE — Single technician skill API (spec §6/§7).
// PATCH  /api/v1/technicians/[id]/skills/[skillId] — edit level / certification /
//                                                    years of experience.
// DELETE /api/v1/technicians/[id]/skills/[skillId] — remove the skill.
//
// Access: technicians.manage holders or the profile owner (assertSkillAccess).
// The [id] path segment must match the skill's profileId — a mismatched pair is
// a 404, never a cross-profile write (IDOR-safe). Every mutation re-syncs the
// legacy skills CSV mirror and writes an audit row.

import { NextRequest, NextResponse } from "next/server";
import { handler, ok, parseBody } from "@/lib/hms/api";
import { clientIp } from "@/lib/hms/rate-limit";
import {
  removeSkillEntry,
  assertSkillAccess,
  loadTechnicianProfile,
  updateSkillEntry,
  updateSkillSchema,
} from "../../../_skills";

type Ctx = { params: Promise<{ id: string; skillId: string }> };

export async function PATCH(req: NextRequest, ctx: Ctx): Promise<NextResponse> {
  const { id, skillId } = await ctx.params;
  return handler(async ({ req: r, user }) => {
    const body = await parseBody(r, updateSkillSchema);
    const profile = await loadTechnicianProfile(id);
    assertSkillAccess(user, profile, "write");
    const skill = await updateSkillEntry({ profile, skillId, body, actor: user, ip: clientIp(r) });
    return ok(skill);
  })(req);
}

export async function DELETE(req: NextRequest, ctx: Ctx): Promise<NextResponse> {
  const { id, skillId } = await ctx.params;
  return handler(async ({ user }) => {
    const profile = await loadTechnicianProfile(id);
    assertSkillAccess(user, profile, "write");
    const skill = await removeSkillEntry({ profile, skillId, actor: user });
    return ok(skill);
  })(req);
}
