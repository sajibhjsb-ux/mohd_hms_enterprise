// scripts/mfa-surfaces.test.ts
// bun --conditions=react-server scripts/mfa-surfaces.test.ts
import assert from "node:assert";
import { readFileSync } from "node:fs";

const files = [
  "src/app/api/v1/auth/login/route.ts",
  "src/app/api/v1/auth/verify-email/route.ts",
  "src/app/api/v1/auth/google/callback/route.ts",
];

for (const file of files) {
  const src = readFileSync(file, "utf8");
  const gate = src.indexOf("resolveMfaGate(");
  const session = src.lastIndexOf("createSupersedingSession(");
  assert.ok(gate >= 0, `${file} must call resolveMfaGate`);
  assert.ok(session >= 0, `${file} must create a session`);
  assert.ok(gate < session, `${file} must gate before createSupersedingSession`);
}

console.log("mfa-surfaces: ok");
