import "server-only";

// MOHD.HMS ENTERPRISE — Push pipeline (unified dispatcher).
// Integrates with the existing NotificationService: every in-app notification
// may also be delivered as a push to the recipient's registered devices.
//
//   notify() → sendPushToUser() → enqueuePush() → PushLog QUEUED
//            → push/worker.ts (scheduler loop) → FCM (Firebase) and/or
//              VAPID web-push → device
//
// Transports:
//   • FCM   — Firebase Cloud Messaging (spec §2), active when Firebase env is
//     configured AND the existing "push_notifications" automation toggle is on
//     (Settings → Automation, mirroring email/whatsapp channel toggles).
//   • VAPID — legacy direct web-push, preserved unchanged (existing devices
//     keep working — nothing breaks while Firebase is not yet configured).
//
// RBAC is inherent — recipients are the exact users the business event
// targets (notify()/notifyRole()), never a broadcast. VAPID private keys and
// the Firebase service account live ONLY in server env (never bundled/shipped).

import { db } from "@/lib/db";
import { isAutomationEnabled } from "@/lib/hms/workflows/settings";
import { resolvePushCategory, pushPrefEnabled } from "@/lib/hms/push/preferences";
import { fcmConfigured } from "@/lib/hms/push/fcm";
import { vapidPublicKey } from "@/lib/hms/push/vapid";

export { vapidPublicKey };

/** Existing resource → dedicated application route (mirrors RESOURCE_ROUTES). */
function routeFor(resourceType?: string, resourceId?: string): string {
  if (!resourceType || !resourceId) return "/dashboard";
  switch (resourceType) {
    case "COMPLAINT": return `/complaints/${resourceId}`;
    case "WORK_ORDER": return `/work-orders/${resourceId}`;
    case "EQUIPMENT": return `/equipment/${resourceId}`;
    case "CUSTOMER": return `/customers/${resourceId}`;
    case "INVOICE": return `/invoices/${resourceId}`;
    case "QUOTATION": return `/quotations/${resourceId}`;
    case "PAYMENT": return `/invoices/${resourceId}`;
    case "PURCHASE_ORDER": return `/purchases/${resourceId}`;
    case "INVENTORY_ITEM": return `/inventory/${resourceId}`;
    case "INSPECTION_REPORT": return `/irms/reports/${resourceId}`;
    case "IRMS_PROJECT": return `/irms/${resourceId}`;
    case "PM_PLAN":
    case "PM_TASK": return `/pm/${resourceId}`;
    case "HR_LEAVE": return `/hr/${resourceId}`;
    default: return "/dashboard";
  }
}

export type PushPayload = {
  title: string;
  body: string;
  resourceType?: string;
  resourceId?: string;
  /** In-app Notification id — links push + in-app (sync, spec §13). */
  notificationId?: string;
  /** DomainEvent id that produced this push (observability). */
  eventId?: string;
  type?: "INFO" | "SUCCESS" | "WARNING" | "ERROR";
  /** Explicit priority; defaults: ERROR→HIGH, WARNING→HIGH, else NORMAL. */
  priority?: "NORMAL" | "HIGH" | "CRITICAL";
};

function derivePriority(input: PushPayload): "NORMAL" | "HIGH" | "CRITICAL" {
  if (input.priority) return input.priority;
  if (input.type === "ERROR" || input.type === "WARNING") return "HIGH";
  return "NORMAL";
}

/**
 * Enqueue one push delivery for one user. Idempotent per in-app notification
 * (spec §26): a QUEUED/SENDING/SENT row with the same dedupe key short-circuits
 * a second enqueue — a repeated business event can never spam devices.
 * Per-user push preferences are honored here (opt-out per category).
 * Best-effort: any failure logs and returns without throwing — a push outage
 * must never break a business action.
 */
export async function sendPushToUser(userId: string, payload: PushPayload): Promise<void> {
  try {
    const dedupeKey = payload.notificationId ?? "";
    if (dedupeKey) {
      const existing = await db.pushLog.findFirst({
        where: { userId, dedupeKey, status: { in: ["QUEUED", "SENDING", "SENT"] } },
        select: { id: true },
      });
      if (existing) return; // duplicate suppression (§26)
    }

    // Per-user preference gating (push channel only — §19).
    const category = resolvePushCategory(payload.resourceType ?? "");
    if (!(await pushPrefEnabled(userId, category))) {
      console.log(JSON.stringify({ ts: new Date().toISOString(), level: "info", channel: "PUSH", msg: "push-skipped-user-pref", userId, category }));
      return;
    }

    await db.pushLog.create({
      data: {
        userId,
        dedupeKey,
        eventId: payload.eventId ?? "",
        notificationId: payload.notificationId ?? "",
        type: payload.type ?? "INFO",
        title: payload.title.slice(0, 120),
        body: payload.body.slice(0, 300),
        resourceType: payload.resourceType ?? "",
        resourceId: payload.resourceId ?? "",
        route: routeFor(payload.resourceType, payload.resourceId),
        priority: derivePriority(payload),
        channel: fcmConfigured() ? "FCM" : "VAPID",
      },
    });
    // Kick the ONE push worker directly for low latency; the scheduler loop is
    // the safety net (exactly the outbox/email/whatsapp pattern).
    const { kickPushWorker } = await import("@/lib/hms/push/worker");
    kickPushWorker();
  } catch (e) {
    console.error("push-enqueue-failed", e);
  }
}

/**
 * Whether the FCM transport may deliver right now (server config + the
 * existing automation channel toggle). VAPID is always attempted for legacy
 * devices — this gate only controls the NEW Firebase transport.
 */
export async function fcmTransportEnabled(): Promise<boolean> {
  if (!fcmConfigured()) return false;
  try {
    return (await isAutomationEnabled("push_notifications")) || false;
  } catch {
    return false;
  }
}
