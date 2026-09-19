// MOHD.HMS ENTERPRISE — Audit logging + document numbering + notifications
// (centralized services; modules must not implement these inline).

import "server-only";
import { db } from "@/lib/db";
import { emit } from "@/lib/hms/workflows/bus";
import { EVENT_TYPES } from "@/lib/hms/workflows/types";
import { sendPushToUser } from "./push-server";

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
    let notificationId = "";
    for (const channel of channels) {
      if (channel === "IN_APP") {
        const row = await db.notification.create({
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
        notificationId = row.id;
      } else {
        // Outbound WHATSAPP/PUSH are logged for the delivery pipeline (provider
        // integration point in production). EMAIL is delivered by the ONE
        // centralized EmailService (queued → worker → SMTP, §51 — same business
        // event, separate delivery channel).
        if (channel === "EMAIL") {
          try {
            const { queueDirect } = await import("@/lib/hms/email/service");
            const recipient = await db.user.findUnique({ where: { id: input.userId }, select: { email: true, name: true } });
            if (recipient?.email) {
              await queueDirect({
                templateKey: "GENERAL_NOTIFICATION",
                to: recipient.email,
                toUserId: input.userId,
                category: "SYSTEM",
                relatedType: input.resourceType,
                relatedId: input.resourceId,
                data: { NOTIFICATION_TITLE: input.title, NOTIFICATION_MESSAGE: input.message, USER_NAME: recipient.name },
              });
            }
          } catch (e) {
            console.error("email-channel-queue-failed", e);
          }
        }
        // WHATSAPP channel — delivered by the ONE centralized WhatsAppService
        // (queued → worker → OpenWA gateway). Best-effort, never blocking.
        if (channel === "WHATSAPP") {
          try {
            const { queueDirect } = await import("@/lib/hms/whatsapp/service");
            const recipient = await db.user.findUnique({ where: { id: input.userId }, select: { phone: true, name: true } });
            if (recipient?.phone) {
              await queueDirect({
                templateKey: "GENERAL_NOTIFICATION",
                toPhone: recipient.phone,
                category: "NOTIFICATION",
                relatedType: input.resourceType,
                relatedId: input.resourceId,
                data: { NOTIFICATION_TITLE: input.title, NOTIFICATION_MESSAGE: input.message, USER_NAME: recipient.name ?? "" },
              });
            }
          } catch (e) {
            console.error("whatsapp-channel-queue-failed", e);
          }
        }
        console.log(JSON.stringify({ ts: new Date().toISOString(), level: "info", channel, to: input.userId, title: input.title, queued: true }));
      }
    }
    // Web Push (PWA): deliver the same business notification the user already
    // receives in-app to their registered devices. Best-effort, never blocking.
    void sendPushToUser(input.userId, {
      title: input.title,
      body: input.message,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
    });
    // Realtime delivery (STEP 17): the persisted notification becomes an outbox
    // event so the recipient's badge/panel/toast update without any refresh.
    if (notificationId) {
      await emit({
        type: EVENT_TYPES.NOTIFICATION_CREATED,
        resourceType: "NOTIFICATION",
        resourceId: notificationId,
        payload: {
          userIds: [input.userId],
          notificationId,
          title: input.title,
          message: input.message,
          type: input.type ?? "INFO",
          resourceType: input.resourceType ?? "",
          resourceId: input.resourceId ?? "",
        },
        actorType: "SYSTEM",
      });
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
