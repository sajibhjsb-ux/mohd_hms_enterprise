// scripts/mfa-gate.test.ts
// bun --conditions=react-server scripts/mfa-gate.test.ts
import assert from "node:assert";
import { decideMfaAction } from "@/lib/hms/mfa/gate";

const now = new Date("2026-01-01T00:00:00Z");
const future = new Date("2026-01-10T00:00:00Z");
const past = new Date("2025-12-01T00:00:00Z");

assert.equal(decideMfaAction({ mfaEnabled: false, policyMode: "MANDATORY", graceUntil: null, enforcementDisabled: true, now }).action, "allowed");
assert.equal(decideMfaAction({ mfaEnabled: true, policyMode: "OPTIONAL", graceUntil: null, enforcementDisabled: false, now }).action, "challenge");
assert.equal(decideMfaAction({ mfaEnabled: true, policyMode: "DISABLED", graceUntil: null, enforcementDisabled: false, now }).action, "challenge");
assert.equal(decideMfaAction({ mfaEnabled: false, policyMode: "OPTIONAL", graceUntil: null, enforcementDisabled: false, now }).action, "allowed");
assert.equal(decideMfaAction({ mfaEnabled: false, policyMode: "DISABLED", graceUntil: null, enforcementDisabled: false, now }).action, "allowed");
const grace = decideMfaAction({ mfaEnabled: false, policyMode: "MANDATORY", graceUntil: future, enforcementDisabled: false, now });
assert.equal(grace.action, "allowed");
assert.equal(grace.warning?.toISOString(), future.toISOString());
assert.equal(decideMfaAction({ mfaEnabled: false, policyMode: "MANDATORY", graceUntil: past, enforcementDisabled: false, now }).action, "enroll");
assert.equal(decideMfaAction({ mfaEnabled: false, policyMode: "MANDATORY", graceUntil: null, enforcementDisabled: false, now }).action, "enroll");

console.log("mfa-gate: ok");
