// Self-check for the APNs provider JWT (ES256, raw R||S signature).
// Run: bun src/lib/hms/push/apns.test.ts
import assert from "node:assert/strict";
import { generateKeyPairSync, verify } from "node:crypto";
import { signProviderJwt } from "./apns-jwt";

const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const iat = 1_700_000_000;
const jwt = signProviderJwt({ key: pem, keyId: "ABC123DEFG", teamId: "TEAM123456" }, iat);
const [h, c, sig] = jwt.split(".");
assert.equal(JSON.parse(Buffer.from(h, "base64url").toString()).alg, "ES256");
assert.equal(JSON.parse(Buffer.from(h, "base64url").toString()).kid, "ABC123DEFG");
assert.deepEqual(JSON.parse(Buffer.from(c, "base64url").toString()), { iss: "TEAM123456", iat });
const ok = verify("sha256", Buffer.from(`${h}.${c}`), { key: publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(sig, "base64url"));
assert.equal(ok, true, "signature must verify against the EC public key");
assert.equal(Buffer.from(sig, "base64url").length, 64, "ES256 signature must be raw R||S (64 bytes)");
console.log("apns-jwt: ok");
