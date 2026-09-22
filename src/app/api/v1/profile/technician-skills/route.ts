// MOHD.HMS ENTERPRISE — Technician self-service skills (spec §6/§7).
// GET  /api/v1/profile/technician-skills — the session user's OWN technician
//        profile + structured skill entries. 404 when the account has no
//        technician profile (honest answer — never another profile's data).
// POST  — add a skill to the OWN profile. Self-only scope: no profile id is
//         accepted from the browser (IDOR-safe, spec §28); supervisors manage
//         other technicians exclusively through /api/v1/technicians/[id]/skills.
//
// Mutations mirror the technician-scoped rules: duplicate → 409, catalogue
// upsert, legacy CSV mirror re-sync, audit row.

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { handler, ok, Errors, parseBody } from "@/lib/hms/api";
import { clientIp } from "@/lib/hms/rate-limit";
import { addSkillSchema, addSkillEntry, listSkillEntries } from "../../technicians/_skills";

/** The session user's own technician profile (or null). */
function ownProfile(userId: string) {
  return db.technicianProfile.findUnique({
    where: { userId },
    include: { user: { select: { id: true, name: true, email: true } } },
  });
}

export const GET = handler(async ({ user }) => {
  const profile = await ownProfile(user.id);
  if (!profile) throw Errors.notFound("No technician profile is linked to your account.");
  const skills = await listSkillEntries(profile.id);
  return ok({
    profile: {
      id: profile.id,
      employeeNo: profile.employeeNo,
      skills: profile.skills,
      specialty: profile.specialty,
      status: profile.status,
      hourlyRateCents: profile.hourlyRateCents,
    },
    skills,
  });
});

export const POST = handler(async ({ req, user }) => {
  const profile = await ownProfile(user.id);
  if (!profile) throw Errors.notFound("No technician profile is linked to your account.");
  const body = await parseBody(req, addSkillSchema);
  const skill = await addSkillEntry({ profile, body, actor: user, ip: clientIp(req) });
  return ok(skill);
});
