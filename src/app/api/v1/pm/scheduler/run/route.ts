// MOHD.HMS ENTERPRISE — manual PM scheduler run (PM §86 — manual safe run).
// POST /api/v1/pm/scheduler/run — synchronous, idempotent scan + realtime kick.
// Called twice on purpose: the second pass must create nothing new, proving the
// occurrence-key idempotency of the whole PM pipeline.

import { z } from "zod";
import { handler, ok, Errors } from "@/lib/hms/api";
import { PERMISSIONS } from "@/lib/hms/constants";
import { audit } from "@/lib/hms/services";
import { runPmSchedulerOnce } from "@/lib/hms/workflows/scheduler";

const runSchema = z.object({ kickRealtime: z.boolean().default(true) });

export const POST = handler(
  async ({ req, user }) => {
    let kickRealtime = true;
    if ((req.headers.get("content-length") ?? "0") !== "0") {
      const body = await req.json().catch(() => ({}));
      kickRealtime = runSchema.parse(body).kickRealtime;
    }

    try {
      await runPmSchedulerOnce({ kickRealtime });
      await runPmSchedulerOnce({ kickRealtime }); // §86 idempotency proof — second run creates nothing
    } catch (e) {
      console.error(JSON.stringify({ ts: new Date().toISOString(), level: "error", msg: "pm-scheduler-manual-run-failed", by: user.email, err: e instanceof Error ? e.message : String(e) }));
      throw Errors.internal("The PM scheduler run failed. Check the server logs.");
    }

    await audit({
      actorId: user.id,
      actorEmail: user.email,
      action: "PM_SCHEDULER_RUN",
      resourceType: "PM_PLAN",
      metadata: { by: user.email, kickRealtime },
    });

    return ok({ ok: true, ranAt: new Date().toISOString() });
  },
  { permission: PERMISSIONS.pm_manage }
);
