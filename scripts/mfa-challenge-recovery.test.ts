// scripts/mfa-challenge-recovery.test.ts
// bun --conditions=react-server scripts/mfa-challenge-recovery.test.ts
import assert from "node:assert";
import { randomBytes } from "node:crypto";
import { NextRequest } from "next/server";
import { db } from "@/lib/db";

process.env.MFA_ENCRYPTION_KEY ??= randomBytes(32).toString("base64");
process.env.PUBLIC_APP_URL = "https://app.mohdhms.com";

const { createMfaChallenge, consumeMfaChallenge, registerMfaFailure } = await import("@/lib/hms/mfa/challenge");
const { generateRecoveryCodes, replaceRecoveryCodes, consumeRecoveryCode, countUnusedRecoveryCodes } = await import("@/lib/hms/mfa/recovery");
const { assertMfaOrigin } = await import("@/lib/hms/mfa/http");

class Rollback extends Error {}
const stamp = Date.now();

await db.$transaction(async (tx) => {
  const user = await tx.user.create({ data: { email: `mfa-ch-${stamp}@example.com`, passwordHash: "scrypt$x$y", name: "MFA Challenge" } });

  const c = await createMfaChallenge({ userId: user.id, purpose: "LOGIN", ttlMs: 300_000 }, tx);
  assert.equal(await consumeMfaChallenge(c.challengeId, tx), true);
  assert.equal(await consumeMfaChallenge(c.challengeId, tx), false, "single use");

  const c2 = await createMfaChallenge({ userId: user.id, purpose: "LOGIN", ttlMs: 300_000 }, tx);
  assert.equal(await registerMfaFailure(c2.challengeId, tx), 4);
  for (let i = 0; i < 4; i++) await registerMfaFailure(c2.challengeId, tx);
  assert.equal(await consumeMfaChallenge(c2.challengeId, tx), false, "exhausted challenge is dead");

  const codes = generateRecoveryCodes();
  assert.equal(codes.length, 10);
  assert.match(codes[0], /^[A-Z0-9]{5}-[A-Z0-9]{5}$/);
  await replaceRecoveryCodes(user.id, codes, tx);
  assert.equal(await countUnusedRecoveryCodes(user.id, tx), 10);
  assert.equal(await consumeRecoveryCode(user.id, codes[0].toLowerCase(), undefined, tx), true);
  assert.equal(await consumeRecoveryCode(user.id, codes[0], undefined, tx), false, "recovery code single use");
  assert.equal(await countUnusedRecoveryCodes(user.id, tx), 9);

  throw new Rollback();
}).catch((e) => { if (!(e instanceof Rollback)) throw e; });

const okReq = new NextRequest("https://app.mohdhms.com/api/v1/auth/mfa/verify", { headers: { origin: "https://app.mohdhms.com" } });
const badReq = new NextRequest("https://app.mohdhms.com/api/v1/auth/mfa/verify", { headers: { origin: "https://evil.example" } });
assert.doesNotThrow(() => assertMfaOrigin(okReq));
assert.throws(() => assertMfaOrigin(badReq), /origin/i);

console.log("mfa-challenge-recovery: ok");
