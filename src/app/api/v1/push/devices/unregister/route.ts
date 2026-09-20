// POST /api/v1/push/devices/unregister — unregister THIS browser's FCM device.
// Called on explicit disable and on logout (spec §8/§34): the device row is
// deactivated (kept for audit/cleanup), never bulk-deleting the user's other
// devices. Idempotent: unknown/foreign tokens answer 200 without leaking state.

import { z } from "zod";
import { db } from "@/lib/db";
import { handler, ok, parseBody } from "@/lib/hms/api";
import { audit } from "@/lib/hms/services";

const unregisterSchema = z.object({ token: z.string().min(20).max(4096) });

export const POST = handler(
  async ({ req, user }) => {
    const { token } = await parseBody(req, unregisterSchema);
    const row = await db.pushDevice.findUnique({ where: { token }, select: { id: true, userId: true, active: true } });
    if (row && row.userId === user.id && row.active) {
      await db.pushDevice.update({
        where: { id: row.id },
        data: { active: false, lastError: "Unregistered by user.", lastSessionId: "" },
      });
      await audit({
        actorId: user.id,
        actorEmail: user.email,
        action: "PUSH_DEVICE_UNREGISTERED",
        resourceType: "PUSH_DEVICE",
        resourceId: row.id,
      });
    }
    return ok({ registered: false });
  },
  { auth: true }
);
