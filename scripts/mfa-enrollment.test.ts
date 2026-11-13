// scripts/mfa-enrollment.test.ts
// bun --conditions=react-server scripts/mfa-enrollment.test.ts
import assert from "node:assert";
import { randomBytes } from "node:crypto";
import { db } from "@/lib/db";

process.env.MFA_ENCRYPTION_KEY = randomBytes(32).toString("base64");

const { startEnrollment, confirmEnrollment } = await import("@/lib/hms/mfa/enrollment");
const { totpCodeAt } = await import("@/lib/hms/mfa/totp");

const stamp = Date.now();
const user = await db.user.create({ data: { email: `mfa-enr-${stamp}@example.com`, passwordHash: "scrypt$x$y", name: "MFA Enrol" } });
try {
  const started = await startEnrollment(user);
  assert.match(started.qrDataUrl, /^data:image\/png;base64,/);
  assert.match(started.otpauthUri, /^otpauth:\/\/totp\//);
  const code = await totpCodeAt(started.secret, Math.floor(Date.now() / 1000));
  const confirmed = await confirmEnrollment(user.id, code);
  assert.equal(confirmed.recoveryCodes.length, 10);
  const row = await db.userMfa.findUnique({ where: { userId: user.id } });
  assert.equal(row?.mfaEnabled, true);
  assert.ok(row?.encryptedTotpSecret && !row.encryptedTotpSecret.includes(started.secret));
  await assert.rejects(() => confirmEnrollment(user.id, code), /Invalid verification code/);
} finally {
  await db.user.delete({ where: { id: user.id } });
}

console.log("mfa-enrollment: ok");
