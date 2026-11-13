// scripts/mfa-crypto.test.ts
// bun --conditions=react-server scripts/mfa-crypto.test.ts
import assert from "node:assert";
import { randomBytes } from "node:crypto";

process.env.MFA_ENCRYPTION_KEY = randomBytes(32).toString("base64");

const { encryptSecret, decryptSecret } = await import("@/lib/hms/mfa/crypto");
const { createTotpSecret, totpUri, totpCodeAt, verifyTotp } = await import("@/lib/hms/mfa/totp");

const RFC_SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"; // ASCII "12345678901234567890"

assert.equal(await totpCodeAt(RFC_SECRET, 59, 8), "94287082");
assert.equal(await totpCodeAt(RFC_SECRET, 1111111109, 8), "07081804");
assert.equal(await totpCodeAt(RFC_SECRET, 20000000000, 8), "65353130");

const stored = encryptSecret("JBSWY3DPEHPK3PXP", "user-a");
assert.equal(decryptSecret(stored, "user-a"), "JBSWY3DPEHPK3PXP");
assert.throws(() => decryptSecret(stored, "user-b"), /unable to authenticate|invalid/i);
assert.match(stored, /^v1:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/);

const secret = createTotpSecret();
assert.ok(secret.length >= 32);
assert.match(totpUri(secret, "admin@mohdhms.com"), /^otpauth:\/\/totp\/MOHD\.HMS%20ENTERPRISE:admin%40mohdhms\.com\?/);

const epoch = Math.floor(Date.now() / 1000);
const token = await totpCodeAt(secret, epoch);
const first = await verifyTotp(secret, token, null);
assert.equal(first.valid, true);
const replay = await verifyTotp(secret, token, first.timeStep);
assert.equal(replay.valid, false);

console.log("mfa-crypto: ok");
