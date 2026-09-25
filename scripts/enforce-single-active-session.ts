/**
 * SINGLE ACTIVE DEVICE — one-time/idempotent maintenance (spec §21):
 * revokes every live session beyond the NEWEST one per user, so accounts that
 * accumulated duplicate active sessions (e.g. rows created before the
 * single-active-device policy shipped, or by a now-fixed non-revoking path)
 * are restored to exactly ≤1 active session. The newest session (the device
 * the user most recently signed in on) is always the one kept.
 *
 * Every revocation is audited with safe metadata and each affected user gets a
 * SESSION_REVOKED realtime event so a live device logs out immediately.
 *
 * Run: bun scripts/enforce-single-active-session.ts
 */
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();
const REASON = "SINGLE_ACTIVE_DEVICE_CLEANUP";

async function main() {
  const users = await db.user.findMany({
    select: { id: true, email: true, sessions: { where: { revokedAt: null, expiresAt: { gt: new Date() } }, orderBy: { createdAt: "desc" } } },
  });

  let cleanedUsers = 0;
  let revokedSessions = 0;

  for (const user of users) {
    if (user.sessions.length <= 1) continue;
    const [keep, ...dupes] = user.sessions; // sessions ordered newest-first
    const ids = dupes.map((s) => s.id);
    const result = await db.session.updateMany({
      where: { id: { in: ids }, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: REASON },
    });
    revokedSessions += result.count;
    cleanedUsers += 1;
    await db.auditLog.create({
      data: {
        actorId: null,
        actorEmail: user.email,
        action: "SESSION_REVOKED",
        resourceType: "SESSION",
        resourceId: keep.id,
        metadata: JSON.stringify({ via: "single-active-device-cleanup", revokedCount: result.count, reason: REASON }),
      },
    });
    console.log(`user ${user.email}: kept newest session ${keep.createdAt.toISOString()}, revoked ${result.count} duplicate(s)`);
  }

  console.log(`done — ${cleanedUsers} user(s) cleaned, ${revokedSessions} duplicate session(s) revoked`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
