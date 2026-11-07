// Pure ES256 provider-token signing for APNs (no server-only guard so it can
// be unit tested). Kept separate from apns.ts, which owns the HTTP/2 transport.

import { createPrivateKey, sign } from "node:crypto";

export function signProviderJwt(
  material: { key: string; keyId: string; teamId: string },
  iat = Math.floor(Date.now() / 1000),
): string {
  const header = Buffer.from(JSON.stringify({ alg: "ES256", kid: material.keyId })).toString("base64url");
  const claims = Buffer.from(JSON.stringify({ iss: material.teamId, iat })).toString("base64url");
  const signature = sign("sha256", Buffer.from(`${header}.${claims}`), {
    key: createPrivateKey(material.key),
    dsaEncoding: "ieee-p1363",
  }).toString("base64url");
  return `${header}.${claims}.${signature}`;
}
