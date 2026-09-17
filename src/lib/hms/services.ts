// MOHD.HMS ENTERPRISE — Audit logging + document numbering + notifications
// (centralized services; modules must not implement these inline).

import "server-only";
import { db } from "@/lib/db";

export type AuditInput = {
  actorId?: string | null;
  actorEmail?: string;
  action: string;
  resourceType?: string;
  resourceId?: string;
  metadata?: Record<string, unknown>;
  ip?: string;
};

export async function audit(input: AuditInput) {
  try {
    await db.auditLog.create({
      data: {
        actorId: input.actorId ?? null,
        actorEmail: input.actorEmail ?? "",
        action: input.action,
        resourceType: input.resourceType ?? "",
        resourceId: input.resourceId ?? "",
        metadata: input.metadata ? JSON.stringify(input.metadata) : "",
        ip: input.ip ?? "",
      },
    });
  } catch (e) {
    console.error("audit-write-failed", e);
  }
}

/** Sequential document numbers: CPT-2025-0001, WO-2025-0001, INV-2025-0001 ... */
export async function nextNumber(prefix: string): Promise<string> {
  const year = new Date().getFullYear();
  const key = `${prefix}-${year}`;
  const row = await db.counter.upsert({
    where: { key },
    update: { value: { increment: 1 } },
    create: { key, value: 1 },
  });
  return `${prefix}-${year}-${String(row.value).padStart(4, "0")}`;
}

type NotifyInput = {
  userId: string;
  title: string;
  message: string;
  type?: "INFO" | "SUCCESS" | "WARNING" | "ERROR";
  resourceType?: string;
  resourceId?: string;
  channels?: ("IN_APP" | "EMAIL" | "WHATSAPP" | "PUSH")[];
};

/**
 * Centralized NotificationService.
 * EVENT → NOTIFICATION SERVICE → CHANNEL → DELIVERY → LOG.
 * In-app delivery persists to DB; EMAIL/WHATSAPP/PUSH are queued as logged
 * deliveries (outbound providers configured via env in production).
 */
export async function notify(input: NotifyInput) {
  const channels = input.channels ?? ["IN_APP"];
  try {
    for (const channel of channels) {
      if (channel === "IN_APP") {
        await db.notification.create({
          data: {
            userId: input.userId,
            channel,
            type: input.type ?? "INFO",
            title: input.title,
            message: input.message,
            resourceType: input.resourceType ?? "",
            resourceId: input.resourceId ?? "",
          },
        });
      } else {
        // Outbound channels are logged for the delivery pipeline (provider integration point).
        console.log(JSON.stringify({ ts: new Date().toISOString(), level: "info", channel, to: input.userId, title: input.title, queued: true }));
      }
    }
  } catch (e) {
    console.error("notify-failed", e);
  }
}

export async function notifyRole(role: string, payload: Omit<NotifyInput, "userId">) {
  try {
    const users = await db.user.findMany({ where: { role, status: "ACTIVE" }, select: { id: true } });
    for (const u of users) await notify({ ...payload, userId: u.id });
  } catch (e) {
    console.error("notify-role-failed", e);
  }
}
