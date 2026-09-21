// MOHD.HMS ENTERPRISE — Email client contacts directory.
// Minimal staff directory (name/email/role) for compose autocomplete and
// group management. Internal directory for staff mailbox users — customers
// are NOT exposed (external recipients go through SMTP directly).

import { db } from "@/lib/db";
import { handler, ok } from "@/lib/hms/api";
import { PERMISSIONS } from "@/lib/hms/constants";

export const GET = handler(
  async () => {
    const users = await db.user.findMany({
      where: { role: { not: "CUSTOMER" }, status: "ACTIVE" },
      select: { id: true, name: true, email: true, role: true, avatarUrl: true },
      orderBy: { name: "asc" },
      take: 500,
    });
    return ok(users);
  },
  { permission: PERMISSIONS.email_client }
);
