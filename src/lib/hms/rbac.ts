// MOHD.HMS ENTERPRISE — Centralized RBAC.
// Backend is authoritative: every API route must enforce permissions here.

import "server-only";
import type { Permission, Role } from "./constants";
import { ROLE_PERMISSIONS } from "./constants";

/** All permissions granted to a role. SUPER_ADMIN/ADMIN implicitly have everything. */
export function can(role: Role): Permission[] {
  return ROLE_PERMISSIONS[role] ?? [];
}

export function roleCan(role: string, permission: Permission): boolean {
  const perms = can(role as Role);
  return perms.includes(permission);
}

/** Staff roles can see cross-customer data; customers are scoped to their own customer id. */
export function isStaff(role: string): boolean {
  return role !== "CUSTOMER";
}

/** Data scope for list/detail queries. */
export function scopeFilter(role: string, customerId: string | null) {
  if (isStaff(role) || !customerId) return {};
  return { customerId };
}
