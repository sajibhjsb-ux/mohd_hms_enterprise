// POST /api/v1/push/admin/test — send a REAL test push to a user through the
// production pipeline (spec §31) and return the ACTUAL delivery result.
//
// This endpoint never fabricates success: the response is the authoritative
// PushLog outcome (SENT / FAILED / DEAD_LETTER / SKIPPED with an explicit
// errorCode such as NoDevices / Unconfigured). A zero-device recipient is a
// SKIPPED outcome — distinguishable from a Firebase failure (spec §12/§37).
//
// Security (spec §38): push.manage permission required; userId/deviceId are
// validated server-side; device ids must belong to the target user; no tokens
// are ever returned. Rate-limited per admin.

import { z } from "zod";
import { db } from "@/lib/db";
import { handler, ok, parseBody, Errors } from "@/lib/hms/api";
import { rateLimit, clientIp } from "@/lib/hms/rate-limit";
import { runTestSend } from "@/lib/hms/push/worker";

const testSchema = z.object({
  userId: z.string().min(1),
  deviceId: z.string().min(1).optional(),
  title: z.string().min(1).max(120).default("Firebase test notification"),
  body: z.string().min(1).max(300).default("This is a test push from MOHD.HMS ENTERPRISE."),
});

export const POST = handler(
  async ({ req, user }) => {
    const ip = clientIp(req);
    const rl = rateLimit(`push-admin-test:${ip}:${user.id}`, 10, 60 * 1000);
    if (!rl.allowed) throw Errors.tooMany(`Too many test sends. Try again in ${rl.retryAfterSec}s.`);

    const body = await parseBody(req, testSchema);

    const target = await db.user.findUnique({
      where: { id: body.userId },
      select: { id: true, name: true, email: true },
    });
    if (!target) throw Errors.notFound("User not found.");

    // An explicit device must be an ACTIVE registration of THIS user (FCM
    // device or legacy VAPID subscription) — never a fabricated/foreign id.
    if (body.deviceId) {
      const [device, subscription] = await Promise.all([
        db.pushDevice.findFirst({ where: { id: body.deviceId, userId: body.userId, active: true }, select: { id: true } }),
        db.pushSubscription.findFirst({ where: { id: body.deviceId, userId: body.userId, revokedAt: null }, select: { id: true } }),
      ]);
      if (!device && !subscription) {
        throw Errors.badRequest("The selected device is not an active registration for this user. Refresh the device list and try again.");
      }
    }

    const result = await runTestSend({
      userId: body.userId,
      targetDeviceId: body.deviceId,
      title: body.title,
      body: body.body,
    });
    return ok(result);
  },
  { permission: "push.manage" }
);
