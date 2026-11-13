// scripts/mfa-admin.test.ts
// bun --conditions=react-server scripts/mfa-admin.test.ts
import assert from "node:assert";
import { canManageRole } from "@/lib/hms/mfa/policy";

assert.equal(canManageRole("ADMIN", "ADMIN"), false, "ADMIN cannot edit ADMIN policy");
assert.equal(canManageRole("ADMIN", "SUPER_ADMIN"), false, "ADMIN cannot target SUPER_ADMIN");
assert.equal(canManageRole("SUPER_ADMIN", "SUPER_ADMIN"), false, "self/peer SUPER_ADMIN blocked by strict rank");
assert.equal(canManageRole("SUPER_ADMIN", "ADMIN"), true);
assert.equal(canManageRole("SUPERVISOR", "TECHNICIAN"), false, "supervisors have no MFA admin permission");

console.log("mfa-admin: ok");
