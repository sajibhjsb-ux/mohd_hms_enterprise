// GET /api/v1/push/admin/overview — Push notification center visibility (§30):
// channel configuration state, delivery counts by status, recent failures,
// active device counts. push.view permission required (ADMIN/SUPER_ADMIN).

import { db } from "@/lib/db";
import { handler, ok } from "@/lib/hms/api";
import { fcmStatusSummary } from "@/lib/hms/push/fcm";
import { vapidPublicKey } from "@/lib/hms/push-server";
import { isAutomationEnabled } from "@/lib/hms/workflows/settings";

export const GET = handler(
  async () => {
    const since7d = new Date(Date.now() - 7 * 86_400_000);

    const [fcmDevices, fcmActive, vapidActive, statusCounts, recent, recentErrors, fcmToggle] = await Promise.all([
      db.pushDevice.count(),
      db.pushDevice.count({ where: { active: true } }),
      db.pushSubscription.count({ where: { revokedAt: null } }),
      db.pushLog.groupBy({ by: ["status"], _count: { _all: true }, where: { createdAt: { gte: since7d } } }),
      db.pushLog.findMany({
        orderBy: { createdAt: "desc" },
        take: 20,
        select: {
          id: true, status: true, channel: true, priority: true, type: true,
          title: true, body: true, resourceType: true, resourceId: true, route: true,
          deviceCount: true, sentCount: true, failedCount: true, skippedCount: true,
          attemptCount: true, errorCode: true, lastError: true, fcmMessageId: true,
          isTest: true, userId: true, createdAt: true, sentAt: true,
        },
      }),
      db.pushLog.findMany({
        where: { status: { in: ["FAILED", "DEAD_LETTER"] } },
        orderBy: { updatedAt: "desc" },
        take: 10,
        select: { id: true, status: true, channel: true, errorCode: true, lastError: true, title: true, updatedAt: true, userId: true },
      }),
      isAutomationEnabled("push_notifications"),
    ]);

    const users = await db.user.findMany({
      where: { id: { in: [...new Set(recent.map((r) => r.userId))] } },
      select: { id: true, name: true, email: true },
    });
    const userName = new Map(users.map((u) => [u.id, u.name || u.email]));

    const byStatus = Object.fromEntries(statusCounts.map((s) => [s.status, s._count._all]));

    return ok({
      channels: {
        fcm: { ...fcmStatusSummary(), toggleOn: !!fcmToggle },
        vapid: { configured: !!vapidPublicKey() },
      },
      devices: { fcmTotal: fcmDevices, fcmActive, vapidActive },
      deliveries7d: {
        queued: byStatus["QUEUED"] ?? 0,
        sending: byStatus["SENDING"] ?? 0,
        sent: byStatus["SENT"] ?? 0,
        failed: byStatus["FAILED"] ?? 0,
        deadLettered: byStatus["DEAD_LETTER"] ?? 0,
        skipped: byStatus["SKIPPED"] ?? 0,
      },
      recent: recent.map((r) => ({ ...r, userName: userName.get(r.userId) ?? r.userId })),
      recentErrors: recentErrors.map((r) => ({ ...r, userName: userName.get(r.userId) ?? r.userId })),
    });
  },
  { permission: "push.view" }
);
