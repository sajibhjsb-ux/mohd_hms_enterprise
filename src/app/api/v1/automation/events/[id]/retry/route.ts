// MOHD.HMS ENTERPRISE — Failed automation retry (§64 FAILED AUTOMATION UI).
// SUPER_ADMIN only. Re-queues a FAILED/DEAD (or even DONE for inspection) event.
// Idempotency is preserved: workflows with a prior SUCCESS run for the event are
// skipped by the engine, so a retry can never duplicate business records.

import { z } from "zod";
import { db } from "@/lib/db";
import { handler, ok, parseBody, Errors } from "@/lib/hms/api";
import { PERMISSIONS } from "@/lib/hms/constants";
import { audit } from "@/lib/hms/services";
import { requeueEvent } from "@/lib/hms/workflows/engine";

const bodySchema = z.object({});

export async function POST(req: import("next/server").NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return handler(
    async ({ user }) => {
      if (user.role !== "SUPER_ADMIN") throw Errors.forbidden("Only the super administrator can retry automation jobs.");
      await parseBody(req, bodySchema).catch(() => ({}));
      const event = await db.domainEvent.findUnique({
        where: { id },
        select: { id: true, type: true, status: true, attempts: true },
      });
      if (!event) throw Errors.notFound("Automation event not found.");
      const result = await requeueEvent(id);
      if (!result.ok) throw Errors.conflict(`Event ${event.id} cannot be retried from status ${event.status}.`);
      await audit({
        actorId: user.id, actorEmail: user.email, action: "AUTOMATION_EVENT_RETRIED",
        resourceType: "DOMAIN_EVENT", resourceId: id,
        metadata: { type: event.type, previousStatus: event.status, attempts: event.attempts },
      });
      return ok({ id, status: result.status });
    },
    { permission: PERMISSIONS.settings_read }
  )(req);
}
