// scripts/mfa-test-fixtures.ts
// MFA_E2E=1 bun --conditions=react-server scripts/mfa-test-fixtures.ts
import { db } from "@/lib/db";
import { hashPassword } from "@/lib/hms/auth";

const USERS = [
  { email: "mfa-super@example.com", role: "SUPER_ADMIN" },
  { email: "mfa-admin@example.com", role: "ADMIN" },
  { email: "mfa-supervisor@example.com", role: "SUPERVISOR" },
] as const;

const PASSWORD = "Password@123";

async function main() {
  const passwordHash = await hashPassword(PASSWORD);
  for (const u of USERS) {
    await db.mfaChallenge.deleteMany({ where: { user: { email: u.email } } });
    await db.mfaRecoveryCode.deleteMany({ where: { user: { email: u.email } } });
    await db.session.deleteMany({ where: { user: { email: u.email } } });
    await db.userMfa.deleteMany({ where: { user: { email: u.email } } });
    await db.user.upsert({
      where: { email: u.email },
      update: { passwordHash, role: u.role, emailVerified: new Date(), status: "ACTIVE" },
      create: { email: u.email, passwordHash, role: u.role, emailVerified: new Date(), status: "ACTIVE", name: "MFA E2E" },
    });
  }
  console.log("mfa-fixtures: ok");
}

main().catch((e) => { console.error(e); process.exit(1); });
