// MOHD.HMS ENTERPRISE — Technician skills API (spec §6/§7).
// GET    /api/v1/technicians/[id]/skills  — list structured skill entries
//                                           (users.read holders, technicians.manage
//                                           holders, or the profile owner).
// POST   /api/v1/technicians/[id]/skills  — add a skill (technicians.manage
//                                           holders or the profile owner).
//
// The static-permission gate is deliberately NOT used: access is object-level
// (profile owner OR role permission) and decided inside the handler via
// assertSkillAccess. Every mutation re-syncs the legacy skills CSV mirror and
// writes an audit row.

import { NextRequest, NextResponse } from "next/server";
import { handler, ok, parseBody } from "@/lib/hms/api";
import { clientIp } from "@/lib/hms/rate-limit";
import {
  addSkillSchema,
  addSkillEntry,
  assertSkillAccess,
  listSkillEntries,
  loadTechnicianProfile,
} from "../../_skills";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, ctx: Ctx): Promise<NextResponse> {
  const { id } = await ctx.params;
  return handler(async ({ user }) => {
    const profile = await loadTechnicianProfile(id);
    assertSkillAccess(user, profile, "read");
    const skills = await listSkillEntries(profile.id);
    return ok({
      profile: { id: profile.id, employeeNo: profile.employeeNo, user: { id: profile.user.id, name: profile.user.name } },
      skills,
    });
  })(req);
}

export async function POST(req: NextRequest, ctx: Ctx): Promise<NextResponse> {
  const { id } = await ctx.params;
  return handler(async ({ req: r, user }) => {
    const body = await parseBody(r, addSkillSchema);
    const profile = await loadTechnicianProfile(id);
    assertSkillAccess(user, profile, "write");
    const skill = await addSkillEntry({ profile, body, actor: user, ip: clientIp(r) });
    return ok(skill);
  })(req);
}
