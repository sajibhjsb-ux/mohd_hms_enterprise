// MOHD.HMS ENTERPRISE — Shared server logic for technician skill management
// (spec §6/§7/§8). Used by:
//   • /api/v1/technicians/[id]/skills           (supervisor/admin or profile owner)
//   • /api/v1/profile/technician-skills         (self-service, own profile only)
//
// Rules enforced here for every mutation:
//   • access control (technicians.manage holders OR the profile owner; read is
//     additionally open to users.read holders),
//   • duplicate rejection (case-insensitive) → 409 CONFLICT,
//   • auto-extending the SkillLibraryItem catalogue (upsert by name),
//   • re-syncing the legacy TechnicianProfile.skills CSV mirror so existing
//     list chips and PM matching keep working,
//   • audit trail rows (TECHNICIAN_SKILL_ADDED / UPDATED / REMOVED).

import "server-only";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { Errors } from "@/lib/hms/api";
import { PERMISSIONS } from "@/lib/hms/constants";
import { roleCan } from "@/lib/hms/rbac";
import { audit } from "@/lib/hms/services";
import type { SessionUser } from "@/lib/hms/auth";

// ── Domain vocabularies (spec §7) ──

export const SKILL_LEVELS = ["BASIC", "INTERMEDIATE", "ADVANCED", "EXPERT"] as const;

export const SKILL_CATEGORIES = [
  "HVAC", "ELECTRICAL", "PLUMBING", "FIRE_PROTECTION", "GENERATOR", "LIFT_ESCALATOR",
  "MECHANICAL", "CIVIL", "CLEANING", "PEST_CONTROL", "LANDSCAPE", "OTHER",
] as const;

// ── Validation ──

export const addSkillSchema = z.object({
  name: z.string().trim().min(1, "Skill name is required.").max(80, "Skill name must be 80 characters or fewer."),
  category: z.string().trim().min(1, "Category is required.").max(40, "Category must be 40 characters or fewer."),
  level: z.enum(SKILL_LEVELS),
  certification: z.string().trim().max(120, "Certification must be 120 characters or fewer.").optional(),
  yearsExperience: z.union([z.number(), z.string(), z.null()]).optional(),
});

export const updateSkillSchema = z
  .object({
    level: z.enum(SKILL_LEVELS).optional(),
    certification: z.string().trim().max(120, "Certification must be 120 characters or fewer.").nullable().optional(),
    yearsExperience: z.union([z.number(), z.string(), z.null()]).optional(),
  })
  .refine((v) => v.level !== undefined || v.certification !== undefined || v.yearsExperience !== undefined, {
    message: "Nothing to update.",
  });

export type AddSkillInput = z.infer<typeof addSkillSchema>;
export type UpdateSkillInput = z.infer<typeof updateSkillSchema>;

/** Collapse internal whitespace and trim — "HVAC   systems" → "HVAC systems". */
export function normalizeSkillName(raw: string): string {
  const name = raw.replace(/\s+/g, " ").trim();
  if (!name) throw Errors.badRequest("Skill name is required.");
  if (name.length > 80) throw Errors.badRequest("Skill name must be 80 characters or fewer.");
  return name;
}

/** Uppercase + whitelist against the fixed category vocabulary (spec §7). */
export function normalizeSkillCategory(raw: string): string {
  const category = raw.replace(/[\s-]+/g, "_").trim().toUpperCase();
  if (!(SKILL_CATEGORIES as readonly string[]).includes(category)) {
    throw Errors.badRequest(
      `Unknown category "${raw}". Allowed: ${SKILL_CATEGORIES.join(", ").toLowerCase().replace(/_/g, " ")}.`,
    );
  }
  return category;
}

/** Accept 0–60, one decimal; empty/undefined/null → null. Honest 400 otherwise. */
export function normalizeYearsExperience(raw: number | string | null | undefined): number | null {
  if (raw === undefined || raw === null || raw === "") return null;
  const n = typeof raw === "number" ? raw : Number(String(raw).trim());
  if (!Number.isFinite(n) || n < 0 || n > 60) {
    throw Errors.badRequest("Years of experience must be a number between 0 and 60.");
  }
  return Math.round(n * 10) / 10;
}

// ── Access control ──

export type TechnicianProfileWithUser = NonNullable<
  Awaited<ReturnType<typeof loadTechnicianProfile>>
>;

/**
 * Load a TechnicianProfile with its owner. 404 when missing.
 * The owner (`user`) is needed both for access checks and audit metadata.
 */
export async function loadTechnicianProfile(profileId: string) {
  const profile = await db.technicianProfile.findUnique({
    where: { id: profileId },
    include: { user: { select: { id: true, name: true, email: true } } },
  });
  if (!profile) throw Errors.notFound("Technician profile not found.");
  return profile;
}

/**
 * Object-level authorization (spec §6/§7): write needs technicians.manage OR
 * ownership; read additionally allows users.read holders. The profile owner
 * (self) may always manage their own skills — this is the fix for the RBAC
 * lockout that previously left supervisors/technicians unable to add skills.
 */
export function assertSkillAccess(
  user: SessionUser,
  profile: { userId: string },
  mode: "read" | "write",
): void {
  if (profile.userId === user.id) return;
  if (roleCan(user.role, PERMISSIONS.technicians_manage)) return;
  if (mode === "read" && roleCan(user.role, PERMISSIONS.users_read)) return;
  throw Errors.forbidden("You do not have permission to manage this technician's skills.");
}

// ── Core operations ──

const SKILL_SELECT = {
  id: true,
  name: true,
  category: true,
  level: true,
  certification: true,
  yearsExperience: true,
  createdAt: true,
  updatedAt: true,
} as const;

/** Skill entries ordered by category, then name (stable, matches the UI grouping). */
export async function listSkillEntries(profileId: string) {
  return db.technicianSkill.findMany({
    where: { profileId },
    orderBy: [{ category: "asc" }, { name: "asc" }],
    select: SKILL_SELECT,
  });
}

type Tx = Prisma.TransactionClient;

/**
 * Re-sync the legacy `TechnicianProfile.skills` CSV mirror from the canonical
 * TechnicianSkill rows (insertion order). Keeps existing list chips, search and
 * PM skill matching working while the structured store is authoritative.
 */
export async function syncLegacySkillsMirror(tx: Tx, profileId: string): Promise<string> {
  const rows = await tx.technicianSkill.findMany({
    where: { profileId },
    orderBy: { createdAt: "asc" },
    select: { name: true },
  });
  const csv = rows.map((r) => r.name).join(", ");
  await tx.technicianProfile.update({ where: { id: profileId }, data: { skills: csv } });
  return csv;
}

/** Case-insensitive duplicate check — "HVAC Systems" vs "hvac systems" collide. */
async function assertNoDuplicate(profileId: string, name: string, excludeSkillId?: string) {
  const rows = await db.technicianSkill.findMany({
    where: { profileId, ...(excludeSkillId ? { id: { not: excludeSkillId } } : {}) },
    select: { id: true, name: true },
  });
  if (rows.some((r) => r.name.toLowerCase() === name.toLowerCase())) {
    throw Errors.conflict("This skill is already assigned to the technician.");
  }
}

/**
 * Add a skill to a technician profile. Also upserts the skill library
 * catalogue (name unique) so free-text additions become suggestions later.
 * Caller MUST have verified access (assertSkillAccess) — no re-check here.
 */
export async function addSkillEntry(input: {
  profile: TechnicianProfileWithUser;
  body: AddSkillInput;
  actor: SessionUser;
  ip?: string;
}) {
  const { profile, actor } = input;
  const name = normalizeSkillName(input.body.name);
  const category = normalizeSkillCategory(input.body.category);
  const certification = input.body.certification?.trim() ?? "";
  const yearsExperience = normalizeYearsExperience(input.body.yearsExperience);

  await assertNoDuplicate(profile.id, name);

  const skill = await db.$transaction(async (tx) => {
    const created = await tx.technicianSkill.create({
      data: { profileId: profile.id, name, category, level: input.body.level, certification, yearsExperience },
      select: SKILL_SELECT,
    });
    // Auto-extend the catalogue. Existing entries stay canonical (update: {})
    // — the library is a curated list; technicians extend it, never rewrite it.
    await tx.skillLibraryItem.upsert({
      where: { name },
      update: {},
      create: { name, category },
    });
    await syncLegacySkillsMirror(tx, profile.id);
    return created;
  });

  await audit({
    actorId: actor.id,
    actorEmail: actor.email,
    action: "TECHNICIAN_SKILL_ADDED",
    resourceType: "TECHNICIAN",
    resourceId: profile.id,
    metadata: { skill: name, level: skill.level, category, technician: profile.user.name },
    ip: input.ip,
  });

  return skill;
}

/**
 * Update level / certification / years of an existing skill entry.
 * The skill must belong to the given profile (no cross-profile IDOR).
 */
export async function updateSkillEntry(input: {
  profile: TechnicianProfileWithUser;
  skillId: string;
  body: UpdateSkillInput;
  actor: SessionUser;
  ip?: string;
}) {
  const { profile, actor } = input;
  const existing = await db.technicianSkill.findFirst({
    where: { id: input.skillId, profileId: profile.id },
  });
  if (!existing) throw Errors.notFound("Skill not found for this technician.");

  const level = input.body.level ?? existing.level;
  const certification =
    input.body.certification !== undefined ? (input.body.certification?.trim() ?? "") : existing.certification;
  const yearsExperience =
    input.body.yearsExperience !== undefined
      ? normalizeYearsExperience(input.body.yearsExperience)
      : existing.yearsExperience;

  const skill = await db.$transaction(async (tx) => {
    const updated = await tx.technicianSkill.update({
      where: { id: existing.id },
      data: { level, certification, yearsExperience },
      select: SKILL_SELECT,
    });
    // Level/cert/years never affect the CSV name mirror, but keep the helper
    // symmetrical so the profile row timestamp reflects the change too.
    await syncLegacySkillsMirror(tx, profile.id);
    return updated;
  });

  await audit({
    actorId: actor.id,
    actorEmail: actor.email,
    action: "TECHNICIAN_SKILL_UPDATED",
    resourceType: "TECHNICIAN",
    resourceId: profile.id,
    metadata: { skill: existing.name, level, certification, technician: profile.user.name },
    ip: input.ip,
  });

  return skill;
}

/** Remove a skill entry (must belong to the profile) + re-sync the mirror. */
export async function removeSkillEntry(input: {
  profile: TechnicianProfileWithUser;
  skillId: string;
  actor: SessionUser;
  ip?: string;
}) {
  const { profile, actor } = input;
  const existing = await db.technicianSkill.findFirst({
    where: { id: input.skillId, profileId: profile.id },
  });
  if (!existing) throw Errors.notFound("Skill not found for this technician.");

  const skill = await db.$transaction(async (tx) => {
    const removed = await tx.technicianSkill.delete({
      where: { id: existing.id },
      select: SKILL_SELECT,
    });
    await syncLegacySkillsMirror(tx, profile.id);
    return removed;
  });

  await audit({
    actorId: actor.id,
    actorEmail: actor.email,
    action: "TECHNICIAN_SKILL_REMOVED",
    resourceType: "TECHNICIAN",
    resourceId: profile.id,
    metadata: { skill: existing.name, level: existing.level, technician: profile.user.name },
    ip: input.ip,
  });

  return skill;
}
