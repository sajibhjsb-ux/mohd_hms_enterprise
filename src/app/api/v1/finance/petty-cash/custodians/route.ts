// MOHD.HMS ENTERPRISE — Petty cash custodian / requester directory.
//
//   GET /api/v1/finance/petty-cash/custodians — active staff for pickers (finance_read)
//
// The FINANCE role has no users_read permission, yet the fund dialogs need a
// custodian/requester picker — this minimal directory endpoint returns only
// what a picker needs (id, name, email, role) for ACTIVE staff accounts.

import { db } from "@/lib/db";
import { handler, ok } from "@/lib/hms/api";
import { PERMISSIONS } from "@/lib/hms/constants";

export const GET = handler(async () => {
  const users = await db.user.findMany({
    where: { status: "ACTIVE", role: { not: "CUSTOMER" } },
    orderBy: { name: "asc" },
    select: { id: true, name: true, email: true, role: true },
    take: 200,
  });
  return ok(users);
}, { permission: PERMISSIONS.finance_read });
