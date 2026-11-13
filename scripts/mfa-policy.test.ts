// scripts/mfa-policy.test.ts
// bun --conditions=react-server scripts/mfa-policy.test.ts
import assert from "node:assert";
import { db } from "@/lib/db";
import { DEFAULT_MFA_POLICIES, ensureMfaPolicies, getMfaPolicyMap, privilegeRank, canManageRole } from "@/lib/hms/mfa/policy";

class Rollback extends Error {}

assert.equal(privilegeRank("SUPER_ADMIN"), 2);
assert.equal(privilegeRank("ADMIN"), 1);
assert.equal(privilegeRank("SUPERVISOR"), 0);
assert.equal(canManageRole("SUPER_ADMIN", "ADMIN"), true);
assert.equal(canManageRole("ADMIN", "SUPER_ADMIN"), false);
assert.equal(canManageRole("ADMIN", "ADMIN"), false);
assert.equal(canManageRole("ADMIN", "SUPERVISOR"), true);
assert.equal(DEFAULT_MFA_POLICIES.SUPERVISOR.policyMode, "MANDATORY");
assert.equal(DEFAULT_MFA_POLICIES.SUPERVISOR.gracePeriodDays, 14);
assert.equal(DEFAULT_MFA_POLICIES.TECHNICIAN.policyMode, "OPTIONAL");

await db.$transaction(async (tx) => {
  await ensureMfaPolicies(tx);
  await ensureMfaPolicies(tx); // idempotent
  const map = await getMfaPolicyMap(tx);
  assert.equal(map.ADMIN.policyMode, "MANDATORY");
  assert.equal(map.CUSTOMER.policyMode, "OPTIONAL");
  throw new Rollback();
}).catch((e) => { if (!(e instanceof Rollback)) throw e; });

console.log("mfa-policy: ok");
