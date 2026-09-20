// GET /api/v1/push/admin/devices?userId=… — a target user's registered push
// devices for the admin test-notification dialog (spec §31). push.view
// permission required; tokens/endpoints are NEVER returned.

import { db } from "@/lib/db";
import { handler, ok, Errors } from "@/lib/hms/api";

export const GET = handler(
  async ({ req }) => {
    const userId = req.nextUrl.searchParams.get("userId") ?? "";
    if (!userId) throw Errors.badRequest("userId is required.");

    const user = await db.user.findUnique({ where: { id: userId }, select: { id: true, name: true, email: true, role: true } });
    if (!user) throw Errors.notFound("User not found.");

    const [fcmDevices, vapid] = await Promise.all([
      db.pushDevice.findMany({
        where: { userId },
        orderBy: { updatedAt: "desc" },
        select: { id: true, platform: true, deviceName: true, browser: true, operatingSystem: true, active: true, lastSeenAt: true },
      }),
      db.pushSubscription.findMany({
        where: { userId },
        orderBy: { updatedAt: "desc" },
        select: { id: true, platform: true, deviceName: true, browser: true, revokedAt: true, lastSeenAt: true },
      }),
    ]);

    return ok({
      user,
      devices: [
        ...fcmDevices.map((d) => ({
          id: d.id, kind: "FCM" as const,
          label: [d.deviceName, d.browser, d.operatingSystem].filter(Boolean).join(" · ") || d.platform,
          platform: d.platform, active: d.active, lastSeenAt: d.lastSeenAt,
        })),
        ...vapid.map((s) => ({
          id: s.id, kind: "VAPID" as const,
          label: [s.deviceName, s.browser].filter(Boolean).join(" · ") || "Browser",
          platform: s.platform, active: !s.revokedAt, lastSeenAt: s.lastSeenAt,
        })),
      ],
    });
  },
  { permission: "push.view" }
);
