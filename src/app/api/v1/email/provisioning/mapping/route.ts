// MOHD.HMS ENTERPRISE — ROLE → EMAIL ACCESS mapping API (email provisioning
// spec §15/§32). The mapping is an ADMINISTRATOR-MANAGED configuration — never
// hardcoded in the frontend (§15) — stored in the existing Setting store and
// validated against the REAL SHARED mailboxes in the mail architecture (§16:
// mapping targets are shared mailboxes, not aliases/distribution addresses).
//
//   GET /api/v1/email/provisioning/mapping → { mapping, roles, sharedMailboxes }
//   PUT /api/v1/email/provisioning/mapping → validate + persist; then
//       re-synchronize shared access of every ACTIVE corporate mailbox holder
//       so mapping changes take effect immediately (§17/§18/§21).
//
// RBAC: email_config only (the mailbox administration area, §23/§29).

import { z } from "zod";
import { db } from "@/lib/db";
import { handler, ok, parseBody } from "@/lib/hms/api";
import { PERMISSIONS } from "@/lib/hms/constants";
import {
  getRoleMailboxMap,
  setRoleMailboxMap,
  listMappingRoles,
  syncSharedAccess,
} from "@/lib/hms/email/provisioning";
import { audit } from "@/lib/hms/services";

export const GET = handler(async () => {
  const [mapping, roles] = await Promise.all([getRoleMailboxMap(), listMappingRoles()]);
  const shared = await db.mailbox.findMany({
    where: { kind: "SHARED" },
    select: { email: true, displayName: true, isActive: true },
    orderBy: { email: "asc" },
  });
  return ok({ mapping, roles, sharedMailboxes: shared });
}, { permission: PERMISSIONS.email_config });

const putSchema = z.object({
  mapping: z.record(z.string(), z.array(z.string())).optional(),
});

export const PUT = handler(async ({ req, user }) => {
  const body = await parseBody(req, putSchema);
  const mapping = await setRoleMailboxMap(body.mapping ?? {});

  // Re-synchronize every staff user with an ACTIVE corporate mailbox so the
  // saved mapping applies immediately (grant new / revoke removed — §18/§21).
  const holders = await db.mailboxProvisioning.findMany({
    where: { status: "ACTIVE" },
    select: { userId: true },
  });
  let synced = 0;
  const actor = { id: user.id, email: user.email };
  for (const holder of holders) {
    const u = await db.user.findUnique({ where: { id: holder.userId }, select: { role: true, status: true } });
    if (!u || u.status !== "ACTIVE" || u.role === "CUSTOMER") continue;
    await syncSharedAccess(holder.userId, u.role, actor);
    synced++;
  }

  await audit({
    actorId: user.id, actorEmail: user.email,
    action: "EMAIL_ROLE_MAPPING_UPDATED", resourceType: "SETTING", resourceId: "email_role_mailbox_map",
    metadata: { roles: Object.keys(mapping), resyncedUsers: synced },
  });

  return ok({ mapping, resyncedUsers: synced });
}, { permission: PERMISSIONS.email_config });
