// MOHD.HMS ENTERPRISE — Email automation detail API (§32).
// GET    — full automation
// PATCH  — edit; disabling a CRITICAL automation requires SUPER_ADMIN (§32)
// DELETE — delete non-critical automations (history stays in the email log)

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { handler, ok, parseBody, Errors } from "@/lib/hms/api";
import { PERMISSIONS } from "@/lib/hms/constants";
import { audit } from "@/lib/hms/services";
import { automationPatchSchema } from "@/lib/hms/email/schemas";

function idOf(req: NextRequest): string {
  return new URL(req.url).pathname.split("/").filter(Boolean)[4] ?? "";
}

async function automationOf(req: NextRequest) {
  const id = idOf(req);
  const automation = await db.emailAutomation.findUnique({ where: { id } });
  if (!automation) throw Errors.notFound("Email automation not found.");
  // Automations reference templates by canonical key (no FK) — join manually.
  const template = await db.emailTemplate.findUnique({ where: { key: automation.templateKey }, select: { key: true, name: true, category: true } });
  return { ...automation, template };
}

export const GET = handler(
  async ({ req }) => {
    const a = await automationOf(req);
    const counts = { sent: 0, failed: 0, queued: 0 };
    const logs = await db.emailLog.groupBy({
      by: ["status"], where: { automationId: a.id }, _count: { _all: true },
    }).catch(() => [] as { status: string; _count: { _all: number } }[]);
    for (const l of logs) {
      if (l.status === "SENT") counts.sent = l._count._all;
      else if (l.status === "DEAD_LETTER" || l.status === "FAILED") counts.failed += l._count._all;
      else counts.queued += l._count._all;
    }
    return ok({ ...a, counts });
  },
  { permission: PERMISSIONS.email_view }
);

const patchSchema = automationPatchSchema;

export const PATCH = handler(
  async ({ req, user }): Promise<NextResponse> => {
    const a = await automationOf(req);
    const body = await parseBody(req, patchSchema);

    // §32 — security-critical automations (OTP) need explicit super-admin to disable.
    const disabling = body.enabled === false;
    if (disabling && a.critical && user.role !== "SUPER_ADMIN") {
      throw Errors.forbidden("Security-critical automations can only be disabled by a Super Admin.");
    }
    if (body.templateKey !== undefined) {
      if (!(await db.emailTemplate.findUnique({ where: { key: body.templateKey }, select: { key: true } }))) {
        throw Errors.badRequest(`Template key ${body.templateKey} does not exist.`);
      }
    }

    const data: Record<string, unknown> = {};
    for (const key of ["name", "templateKey", "senderName", "senderEmail", "replyTo", "delayMinutes", "maxAttempts", "dedupeHours", "enabled", "critical"] as const) {
      if (body[key] !== undefined) data[key] = body[key];
    }
    if (body.recipientRule !== undefined) data.recipientRule = JSON.stringify(body.recipientRule);
    if (body.conditions !== undefined) data.conditions = JSON.stringify(body.conditions);
    if (body.attachments !== undefined) data.attachments = JSON.stringify(body.attachments);

    const updated = await db.emailAutomation.update({ where: { id: a.id }, data });
    const action = disabling ? "EMAIL_AUTOMATION_DISABLED" : body.enabled === true ? "EMAIL_AUTOMATION_ENABLED" : "EMAIL_AUTOMATION_UPDATED";
    await audit({
      actorId: user.id, actorEmail: user.email, action,
      resourceType: "EMAIL_AUTOMATION", resourceId: updated.id,
      metadata: { name: updated.name, eventType: updated.eventType, enabled: updated.enabled },
    });
    return ok(updated);
  },
  { permission: PERMISSIONS.email_automations }
);

export const DELETE = handler(
  async ({ req, user }) => {
    const a = await automationOf(req);
    if (a.critical) throw Errors.forbidden("Security-critical automations cannot be deleted — disable requires Super Admin.");
    await db.emailAutomation.delete({ where: { id: a.id } });
    await audit({ actorId: user.id, actorEmail: user.email, action: "EMAIL_AUTOMATION_DELETED", resourceType: "EMAIL_AUTOMATION", resourceId: a.id, metadata: { name: a.name, eventType: a.eventType } });
    return ok({ id: a.id, deleted: true });
  },
  { permission: PERMISSIONS.email_automations }
);
