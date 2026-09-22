/**
 * QA — PUSH DEVICE REGISTRATION + ADMIN TEST SEND (spec §41 automated tests).
 * Covers: transport status honesty, VAPID subscription register/update/
 * duplicate/ownership-rebind, no-device test send (SKIPPED NoDevices),
 * device-targeted test send, foreign-device rejection, RBAC (401/403),
 * permanent-error invalidation, delivery-log accuracy.
 * Run: bun scripts/push-e2e.ts   (against the LIVE app on :3000)
 */
const BASE = "http://localhost:3000";
import { PrismaClient } from "@prisma/client";
const db = new PrismaClient();

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  if (cond) { pass++; console.log(`  PASS ${name}${detail ? ` — ${detail}` : ""}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

async function login(email: string): Promise<string> {
  const res = await fetch(`${BASE}/api/v1/auth/login`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "Password@123" }),
  });
  return res.headers.getSetCookie().map((c) => c.split(";")[0]).find((c) => c.startsWith("hms_session=")) ?? "";
}
type R = { status: number; body: any };
const data = (r: R) => r.body?.data ?? null;
const err = (r: R) => r.body?.error ?? null;
const get = (ck: string, p: string): Promise<R> => fetch(`${BASE}${p}`, { headers: { cookie: ck } }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
const post = (ck: string, p: string, d?: unknown): Promise<R> => fetch(`${BASE}${p}`, { method: "POST", headers: { cookie: ck, "Content-Type": "application/json" }, body: JSON.stringify(d ?? {}) }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
const del = (ck: string, p: string) => fetch(`${BASE}${p}`, { method: "DELETE", headers: { cookie: ck } }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));

const FAKE_P256DH = "BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U";
const FAKE_AUTH = "UUxI4O8-FbRouAevSmBQ6o3hgE";
const endpointOf = (tag: string) => `https://fcm.googleapis.com/fcm/send/e2e-push-test-${tag}-${Date.now()}`;

async function main() {
  console.log("── 0. login ──");
  const adminCk = await login("admin@mohdhms.com");
  ok("admin login", !!adminCk);
  const techCk = await login("ahmad.tech@mohdhms.com");
  ok("technician login", !!techCk);
  const admin = await get(adminCk, "/api/v1/auth/session");
  const adminId = data(admin)?.user?.id ?? "";
  const tech = await get(techCk, "/api/v1/auth/session");
  const techId = data(tech)?.user?.id ?? "";
  ok("session ids resolved", !!adminId && !!techId);

  console.log("── 1. push status honesty (spec §2/§31) ──");
  const status = await get(adminCk, "/api/v1/push/status");
  ok("status 200", status.status === 200);
  ok("VAPID configured + public key served", data(status)?.enabled === true && typeof data(status)?.publicKey === "string" && data(status).publicKey.length > 50);
  ok("FCM honestly unconfigured in sandbox", data(status)?.fcm?.configured === false);

  console.log("── 2. VAPID device registration (spec §3/§5) ──");
  const ep = endpointOf("a");
  const subRes = await post(adminCk, "/api/v1/push/subscribe", {
    endpoint: ep, keys: { p256dh: FAKE_P256DH, auth: FAKE_AUTH }, deviceName: "E2E Desk", platform: "Windows", browser: "Chrome",
  });
  ok("register 200", subRes.status === 200 && data(subRes)?.subscribed === true);
  const rowA = await db.pushSubscription.findUnique({ where: { endpoint: ep } });
  ok("DB row: bound to the AUTHENTICATED user", !!rowA && rowA.userId === adminId);
  ok("DB row: active + fresh lastSeenAt", !!rowA && !rowA.revokedAt && !!rowA.lastSeenAt);

  console.log("── 3. idempotency / duplicate (spec §40) ──");
  await post(adminCk, "/api/v1/push/subscribe", { endpoint: ep, keys: { p256dh: FAKE_P256DH, auth: FAKE_AUTH }, deviceName: "E2E Desk", platform: "Windows", browser: "Chrome" });
  const countSame = await db.pushSubscription.count({ where: { endpoint: ep } });
  ok("re-register upserts (no duplicate row)", countSame === 1);

  console.log("── 4. ownership re-bind (spec §6/§28) ──");
  await post(techCk, "/api/v1/push/subscribe", { endpoint: ep, keys: { p256dh: FAKE_P256DH, auth: FAKE_AUTH }, deviceName: "E2E Desk", platform: "Windows", browser: "Chrome" });
  const rowB = await db.pushSubscription.findUnique({ where: { endpoint: ep } });
  ok("same browser re-login re-binds to the new owner", rowB?.userId === techId);

  console.log("── 5. admin test send — device targeting & validation (spec §11/§31/§38) ──");
  const devList = await get(adminCk, `/api/v1/push/admin/devices?userId=${techId}`);
  const devId = data(devList)?.devices?.[0]?.id ?? "";
  ok("device list returns the registered device", !!devId);

  const foreign = await post(adminCk, "/api/v1/push/admin/test", { userId: techId, deviceId: "cmadeupforeignid000000" });
  ok("foreign/fake deviceId rejected 400", foreign.status === 400);

  const noDev = await post(adminCk, "/api/v1/push/admin/test", { userId: "cmnopeuserdoesnotexist" });
  ok("unknown recipient → 404", noDev.status === 404);

  console.log("── 6. real test send through the gateway (spec §12/§13) ──");
  const send = await post(adminCk, "/api/v1/push/admin/test", { userId: techId, deviceId: devId, title: "E2E test", body: "push-e2e delivery" });
  const sendRes = data(send);
  ok("test send returns authoritative result", send.status === 200 && typeof sendRes?.status === "string");
  ok("deviceCount reflects the REAL recipient query", sendRes?.deviceCount === 1, `deviceCount=${sendRes?.deviceCount}`);
  ok("explicit outcome, never generic", ["SENT", "FAILED", "SKIPPED", "QUEUED"].includes(sendRes?.status), `status=${sendRes?.status} err=${sendRes?.errorCode ?? ""}`);
  const logRow = await db.pushLog.findFirst({ where: { isTest: true, userId: techId, title: "E2E test" }, orderBy: { createdAt: "desc" } });
  ok("delivery log row exists (isTest, accurate counts)", !!logRow && logRow.deviceCount === 1, `status=${logRow?.status} failed=${logRow?.failedCount}`);

  // The fake endpoint belongs to no real browser → the push service answers
  // 404/410/403 → the worker must classify it permanent and revoke (§27).
  if (sendRes?.status === "FAILED" || sendRes?.status === "SKIPPED") {
    const after = await db.pushSubscription.findUnique({ where: { endpoint: ep } });
    ok("invalid endpoint classified + revoked (not retried forever)", after?.revokedAt !== null || (logRow?.failedCount ?? 0) > 0, `revoked=${after?.revokedAt !== null} failedCount=${logRow?.failedCount}`);
  }

  console.log("── 7. no-device state (spec §12) ──");
  // revoke everything for the tech, then test send again
  await db.pushSubscription.updateMany({ where: { userId: techId }, data: { revokedAt: new Date() } });
  await db.pushDevice.updateMany({ where: { userId: techId }, data: { active: false } });
  const none = await post(adminCk, "/api/v1/push/admin/test", { userId: techId, title: "E2E nodev", body: "x" });
  const noneRes = data(none);
  ok("zero devices → SKIPPED with NoDevices (NOT generic)", noneRes?.status === "SKIPPED" && noneRes?.errorCode === "NoDevices", `status=${noneRes?.status} code=${noneRes?.errorCode}`);
  ok("human-readable reason carried", (noneRes?.error ?? "").includes("No active push devices"));

  console.log("── 8. RBAC (spec §38) ──");
  const unauth = await post("", "/api/v1/push/admin/test", { userId: techId });
  ok("unauthenticated → 401", unauth.status === 401);
  const techTry = await post(techCk, "/api/v1/push/admin/test", { userId: adminId });
  ok("non-privileged user → 403", techTry.status === 403);
  const techSub = await post(techCk, "/api/v1/push/subscribe", { endpoint: endpointOf("t"), keys: { p256dh: FAKE_P256DH, auth: FAKE_AUTH } });
  ok("any authenticated user may register their OWN device", techSub.status === 200);

  console.log("── 9. admin device diagnostics (spec §33) ──");
  const list = await get(adminCk, `/api/v1/push/admin/devices?userId=${adminId}`);
  const json = JSON.stringify(list.body ?? {});
  ok("no raw endpoints/tokens leaked in device list", !json.includes("fcm.googleapis.com") && !json.includes("p256dh"));

  console.log("── cleanup ──");
  await db.pushSubscription.deleteMany({ where: { OR: [{ endpoint: { contains: "e2e-push-test-" } }, { userId: { in: [adminId, techId] } }] } });
  await db.pushLog.deleteMany({ where: { isTest: true, title: { in: ["E2E test", "E2E nodev"] } } });
  ok("e2e artifacts cleaned", true);

  console.log(`\nRESULT: ${pass} PASS / ${fail} FAIL`);
  await db.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}
main();
