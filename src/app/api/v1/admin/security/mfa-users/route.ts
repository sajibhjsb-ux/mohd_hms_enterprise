import { z } from "zod";
import { db } from "@/lib/db";
import { handler, ok, Errors } from "@/lib/hms/api";
import { PERMISSIONS, ALL_ROLES } from "@/lib/hms/constants";
import { clientIp } from "@/lib/hms/rate-limit";
import { assertMfaOrigin } from "@/lib/hms/mfa/http";
import { ensureMfaPolicies, getMfaPolicyMap } from "@/lib/hms/mfa/policy";

const nowIso = () => new Date();

function userState(u: { mfaEnabled: boolean | null; pendingEnrollmentExpiresAt: Date | null; graceUntil: Date | null }, policyMode: string, now: Date) {
  if (u.mfaEnabled) return "enrolled";
  if (u.pendingEnrollmentExpiresAt && u.pendingEnrollmentExpiresAt > now) return "pending";
  if (u.graceUntil && u.graceUntil > now) return "grace";
  if (policyMode !== "MANDATORY") return "not_enrolled";
  return "required";
}

export const GET = handler(
  async ({ req, user }) => {
    await ensureMfaPolicies();
    const map = await getMfaPolicyMap();
    const url = new URL(req.url);
    const role = url.searchParams.get("role");
    const includeCustomers = url.searchParams.get("includeCustomers") === "true";
    const state = url.searchParams.get("state");
    const search = (url.searchParams.get("search") ?? "").toLowerCase();
    const page = Math.max(1, parseInt(url.searchParams.get("page") ?? "1", 10) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(url.searchParams.get("pageSize") ?? "25", 10) || 25));
    const now = new Date();

    const staffRoles = ALL_ROLES.filter((r) => r !== "CUSTOMER");
    const roles = role ? [role] : staffRoles;
    const includeCust = includeCustomers || role === "CUSTOMER" || roles.includes("CUSTOMER");
    const where: { role?: { in: string[] }; status?: string } = { status: "ACTIVE" };
    if (!includeCust) where.role = { in: staffRoles };
    else if (roles.length && !roles.includes("CUSTOMER")) where.role = { in: [...roles, "CUSTOMER"] };

    const users = await db.user.findMany({
      where,
      include: { mfa: true },
      orderBy: [{ name: "asc" }, { email: "asc" }],
    });

    let rows = users.map((u) => {
      const mfa = u.mfa;
      const policy = map[u.role];
      const st = userState({ mfaEnabled: mfa?.mfaEnabled ?? null, pendingEnrollmentExpiresAt: mfa?.pendingEnrollmentExpiresAt ?? null, graceUntil: mfa?.graceUntil ?? null }, policy.policyMode, now);
      return {
        id: u.id,
        name: u.name,
        email: u.email,
        role: u.role,
        status: u.status,
        state: st,
        enrolledAt: mfa?.enrolledAt?.toISOString() ?? null,
        lastVerifiedAt: mfa?.lastVerifiedAt?.toISOString() ?? null,
        graceUntil: mfa?.graceUntil?.toISOString() ?? null,
        policyMode: policy.policyMode,
      };
    });

    if (search) rows = rows.filter((r) => (r.name + " " + r.email).toLowerCase().includes(search));
    if (state) rows = rows.filter((r) => r.state === state);
    // ponytail: in-memory state filter/pagination for the staff list; move to SQL when staff count makes it slow.
    const total = rows.length;
    const pageRows = rows.slice((page - 1) * pageSize, page * pageSize);

    // compliance over mandatory-role users
    let enrolled = 0, pending = 0, grace = 0, required = 0, notEnrolled = 0;
    for (const u of users) {
      const policy = map[u.role];
      if (policy.policyMode !== "MANDATORY") { notEnrolled++; continue; }
      const mfa = u.mfa;
      if (mfa?.mfaEnabled) enrolled++;
      else if (mfa?.pendingEnrollmentExpiresAt && mfa.pendingEnrollmentExpiresAt > now) pending++;
      else if (mfa?.graceUntil && mfa.graceUntil > now) grace++;
      else required++;
    }
    const mTotal = enrolled + pending + grace + required;

    return ok({
      users: pageRows,
      meta: { total, page, pageSize, pages: Math.ceil(total / pageSize) },
      compliance: {
        total: mTotal,
        enrolled,
        required,
        pending,
        grace,
        notEnrolled,
        percent: mTotal === 0 ? 100 : Math.round((enrolled / mTotal) * 100),
      },
    });
  },
  { permission: PERMISSIONS.mfa_policy_read }
);
