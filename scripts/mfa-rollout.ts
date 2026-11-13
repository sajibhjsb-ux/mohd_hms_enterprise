// scripts/mfa-rollout.ts
// bun --conditions=react-server scripts/mfa-rollout.ts
import { ensureMfaPolicies, getMfaPolicyMap } from "@/lib/hms/mfa/policy";
import { db } from "@/lib/db";

async function main() {
  await ensureMfaPolicies();
  const map = await getMfaPolicyMap();
  const now = new Date();
  const report: Array<{ role: string; granted: number }> = [];

  for (const [role, policy] of Object.entries(map)) {
    if (policy.policyMode !== "MANDATORY") continue;
    const users = await db.user.findMany({ where: { role, status: "ACTIVE" }, select: { id: true } });
    const mfas = await db.userMfa.findMany({ where: { userId: { in: users.map((u) => u.id) } } });
    const graceUntil = new Date(now.getTime() + policy.gracePeriodDays * 24 * 60 * 60 * 1000);
    let granted = 0;
    for (const u of users) {
      const mfa = mfas.find((m) => m.userId === u.id);
      if (mfa?.mfaEnabled) continue;
      if (mfa?.graceUntil && mfa.graceUntil > now) continue;
      await db.userMfa.upsert({
        where: { userId: u.id },
        update: { graceUntil },
        create: { userId: u.id, graceUntil },
      });
      granted++;
    }
    report.push({ role, granted });
  }
  console.log(JSON.stringify(report, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
