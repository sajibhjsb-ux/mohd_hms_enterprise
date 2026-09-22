// MOHD.HMS ENTERPRISE — Corporate email provisioning API (email provisioning
// spec §24/§27/§29). Backend-controlled mailbox lifecycle management:
//
//   GET  /api/v1/email/provisioning?userId={id}  → one user's provisioning
//       status (users_read — the User detail "Corporate email" card, §29).
//   GET  /api/v1/email/provisioning              → all provisioning records
//       (email_config — the Email Configuration admin area).
//   POST /api/v1/email/provisioning              → authorized admin actions
//       (email_config — §29): provision | retry | disable | enable.
//
// RBAC: every action is backend-enforced here — the frontend can NEVER trigger
// provisioning for arbitrary users without the email.config permission (§45).
// No credentials exist for internal corporate mailboxes (they are accessed
// through the user's application session), so nothing secret is ever returned.

import { z } from "zod";
import { db } from "@/lib/db";
import { handler, ok, parseBody, Errors } from "@/lib/hms/api";
import { PERMISSIONS } from "@/lib/hms/constants";
import { roleCan } from "@/lib/hms/rbac";
import {
  getStatusForUser,
  adminProvision,
  retryProvisioning,
  adminDisable,
  adminEnable,
} from "@/lib/hms/email/provisioning";
import { audit } from "@/lib/hms/services";

export const GET = handler(async ({ req, user }) => {
  const userId = req.nextUrl.searchParams.get("userId");
  if (userId) {
    return ok(await getStatusForUser(userId));
  }
  // The cross-user provisioning LIST is mailbox-administration area data
  // (email_config) — users_read alone only entitles the single-user card view.
  if (!roleCan(user.role, PERMISSIONS.email_config)) {
    throw Errors.forbidden("Mailbox administration access is required to list provisioning records.");
  }
  const rows = await db.mailboxProvisioning.findMany({
    include: {
      user: { select: { id: true, name: true, email: true, role: true, status: true } },
      mailbox: { select: { id: true, email: true, isActive: true } },
    },
    orderBy: { updatedAt: "desc" },
    take: 200,
  });
  return ok(
    rows.map((r) => ({
      id: r.id,
      userId: r.userId,
      user: r.user,
      corporateEmail: r.corporateEmail,
      mailbox: r.mailbox ? { id: r.mailbox.id, email: r.mailbox.email, isActive: r.mailbox.isActive } : null,
      status: r.status,
      previousRole: r.previousRole,
      newRole: r.newRole,
      attempts: r.attempts,
      lastError: r.lastError,
      provisionedAt: r.provisionedAt?.toISOString() ?? null,
      disabledAt: r.disabledAt?.toISOString() ?? null,
      updatedAt: r.updatedAt.toISOString(),
    })),
  );
}, { permission: PERMISSIONS.users_read });

const actionSchema = z.object({
  userId: z.string().min(1).max(64),
  action: z.enum(["provision", "retry", "disable", "enable"]),
});

export const POST = handler(async ({ req, user }) => {
  const body = await parseBody(req, actionSchema);
  const target = await db.user.findUnique({
    where: { id: body.userId },
    select: { id: true, email: true, name: true, role: true },
  });
  if (!target) throw Errors.notFound("User not found.");

  let status;
  switch (body.action) {
    case "provision":
      status = await adminProvision(body.userId, { id: user.id, email: user.email });
      break;
    case "retry":
      status = await retryProvisioning(body.userId, { id: user.id, email: user.email });
      break;
    case "disable":
      status = await adminDisable(body.userId, { id: user.id, email: user.email });
      break;
    case "enable":
      status = await adminEnable(body.userId, { id: user.id, email: user.email });
      break;
  }

  await audit({
    actorId: user.id, actorEmail: user.email,
    action: "EMAIL_PROVISIONING_ADMIN_ACTION", resourceType: "USER", resourceId: body.userId,
    metadata: { adminAction: body.action, targetEmail: target.email, resultStatus: status.status, corporateEmail: status.corporateEmail },
  });

  return ok(await getStatusForUser(body.userId));
}, { permission: PERMISSIONS.email_config });
