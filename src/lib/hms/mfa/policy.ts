import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { ROLES, type Role } from "@/lib/hms/constants";

export const MFA_POLICY_MODES = ["MANDATORY", "OPTIONAL", "DISABLED"] as const;
export type MfaPolicyMode = (typeof MFA_POLICY_MODES)[number];

export type MfaPolicyRecord = { role: string; policyMode: MfaPolicyMode; gracePeriodDays: number };

export const DEFAULT_MFA_POLICIES: Record<Role, { policyMode: MfaPolicyMode; gracePeriodDays: number }> = {
  SUPER_ADMIN: { policyMode: "MANDATORY", gracePeriodDays: 14 },
  ADMIN: { policyMode: "MANDATORY", gracePeriodDays: 14 },
  SUPERVISOR: { policyMode: "MANDATORY", gracePeriodDays: 14 },
  TECHNICIAN: { policyMode: "OPTIONAL", gracePeriodDays: 0 },
  CUSTOMER: { policyMode: "OPTIONAL", gracePeriodDays: 0 },
  FINANCE: { policyMode: "MANDATORY", gracePeriodDays: 14 },
  HR: { policyMode: "OPTIONAL", gracePeriodDays: 0 },
};

type Client = Prisma.TransactionClient;

export async function ensureMfaPolicies(client?: Client): Promise<void> {
  const c = client ?? db;
  for (const role of Object.values(ROLES)) {
    const defaults = DEFAULT_MFA_POLICIES[role];
    await c.mfaPolicy.upsert({
      where: { role },
      update: {},
      create: { role, policyMode: defaults.policyMode, gracePeriodDays: defaults.gracePeriodDays },
    });
  }
}

export async function getMfaPolicy(role: string, client?: Client): Promise<MfaPolicyRecord> {
  const c = client ?? db;
  await ensureMfaPolicies(c);
  const row = await c.mfaPolicy.findUnique({ where: { role } });
  if (!row) return { role, policyMode: "OPTIONAL", gracePeriodDays: 0 };
  return { role: row.role, policyMode: row.policyMode as MfaPolicyMode, gracePeriodDays: row.gracePeriodDays };
}

export async function getMfaPolicyMap(client?: Client): Promise<Record<string, MfaPolicyRecord>> {
  const c = client ?? db;
  await ensureMfaPolicies(c);
  const rows = await c.mfaPolicy.findMany();
  return Object.fromEntries(
    rows.map((row) => [row.role, { role: row.role, policyMode: row.policyMode as MfaPolicyMode, gracePeriodDays: row.gracePeriodDays }])
  );
}

export function privilegeRank(role: string): number {
  if (role === ROLES.SUPER_ADMIN) return 2;
  if (role === ROLES.ADMIN) return 1;
  return 0;
}

export function canManageRole(actorRole: string, targetRole: string): boolean {
  return privilegeRank(actorRole) > privilegeRank(targetRole);
}
