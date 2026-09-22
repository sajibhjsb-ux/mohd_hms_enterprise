/**
 * QA — USER-CONTROLLED AUTO LOGIN full-flow E2E against the LIVE app (:3000).
 * Covers spec §31 TESTs 1,2,3,4,5,6,8,9 (TEST 7 MFA = N/A — no MFA exists;
 * TEST 10 multi-tab = browser E2E) + audit-trail assertions.
 * Safe to re-run: creates dedicated *-alt*@mohd-test.local users, cleans up.
 * Run: bun scripts/auto-login-e2e.ts
 */
const BASE = "http://localhost:3000";
import crypto from "node:crypto";
import { PrismaClient } from "@prisma/client";
const db = new PrismaClient();

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  if (cond) { pass++; console.log(`  PASS ${name}${detail ? ` — ${detail}` : ""}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

const hashPw = (pw: string) => {
  const salt = crypto.randomBytes(16).toString("hex");
  const derived = crypto.scryptSync(pw, salt, 64);
  return `scrypt$${salt}$${derived.toString("hex")}`;
};

async function login(email: string, remember = false): Promise<{ cookie: string; body: any }> {
  const res = await fetch(`${BASE}/api/v1/auth/login`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "Password@123", remember }),
  });
  const cookie = res.headers.getSetCookie().map((c) => c.split(";")[0]).find((c) => c.startsWith("hms_session=")) ?? "";
  return { cookie, body: await res.json().catch(() => null) };
}
const get = (ck: string, p: string) => fetch(`${BASE}${p}`, { headers: { cookie: ck } }).then(async (r) => ({ status: r.status, headers: r.headers, body: await r.json().catch(() => null) }));
const post = (ck: string, p: string, d?: unknown) => fetch(`${BASE}${p}`, { method: "POST", headers: { cookie: ck, "Content-Type": "application/json" }, body: JSON.stringify(d ?? {}) }).then(async (r) => ({ status: r.status, headers: r.headers, body: await r.json().catch(() => null) }));
const del = (ck: string, p: string) => fetch(`${BASE}${p}`, { method: "DELETE", headers: { cookie: ck } }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
const patch = (ck: string, p: string, d?: unknown) => fetch(`${BASE}${p}`, { method: "PATCH", headers: { cookie: ck, "Content-Type": "application/json" }, body: JSON.stringify(d ?? {}) }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));

/** Pull the session token out of a cookie header for DB assertions. */
const tokOf = (ck: string) => decodeURIComponent(ck.split("hms_session=")[1] ?? "");

/** Simulate the user being away: rewind lastActivityAt past the idle timeout. */
async function idleExpire(cookie: string) {
  await db.session.updateMany({
    where: { token: tokOf(cookie) },
    data: { lastActivityAt: new Date(Date.now() - 6 * 60 * 1000) },
  });
}

async function makeUser(email: string, role: string) {
  await db.user.deleteMany({ where: { email } }); // idempotent re-runs
  // emailVerified set — otherwise CUSTOMER accounts hit the (correct) OTP gate
  // at login and never receive a session cookie.
  await db.user.create({ data: { email, name: `AL Test ${email.slice(3, 5)}`, passwordHash: hashPw("Password@123"), role, status: "ACTIVE", emailVerified: new Date() } });
}

async function auditExists(action: string, email: string): Promise<boolean> {
  const n = await db.auditLog.count({ where: { action, actorEmail: email } });
  return n > 0;
}

async function main() {
  console.log("── USER-CONTROLLED AUTO LOGIN E2E ──");
  const admin = await login("admin@mohdhms.com");
  ok("admin login", admin.cookie !== "");

  // ── TEST 1 — DEFAULT: OFF, no restoration ────────────────────────────────
  console.log("TEST 1 — default OFF, no restoration");
  await makeUser("al-t1-alt@mohd-test.local", "TECHNICIAN");
  const t1 = await login("al-t1-alt@mohd-test.local");
  const t1row = await db.session.findUnique({ where: { token: tokOf(t1.cookie) } });
  ok("session created with remember=false (default)", t1row?.remember === false);
  const t1ttlDays = t1row ? (t1row.expiresAt.getTime() - Date.now()) / 86400000 : 0;
  ok("default TTL is the 7-day policy (not 30)", t1ttlDays > 6 && t1ttlDays < 8, `${t1ttlDays.toFixed(2)}d`);
  await idleExpire(t1.cookie);
  const t1sess = await get(t1.cookie, "/api/v1/auth/session");
  ok("idle expiry → session unauthenticated (existing policy)", t1sess.body?.data?.authenticated === false);
  const t1restore = await post(t1.cookie, "/api/v1/auth/auto-login/restore");
  ok("restore refused for non-remember session", t1restore.body?.data?.restored === false, `reason=${t1restore.body?.data?.reason}`);
  ok("idle-deleted non-remember session (row gone)", (await db.session.findUnique({ where: { token: tokOf(t1.cookie) } })) === null);

  // ── TEST 2 — ENABLE via login checkbox → idle expiry → restoration ──────
  console.log("TEST 2 — enable at login, secure restoration");
  await makeUser("al-t2-alt@mohd-test.local", "TECHNICIAN");
  const t2 = await login("al-t2-alt@mohd-test.local", true);
  const t2row = await db.session.findUnique({ where: { token: tokOf(t2.cookie) } });
  ok("remember=true persisted from the explicit checkbox", t2row?.remember === true);
  const t2ttlDays = t2row ? (t2row.expiresAt.getTime() - Date.now()) / 86400000 : 0;
  ok("persistent TTL is the 30-day policy", t2ttlDays > 29 && t2ttlDays < 31, `${t2ttlDays.toFixed(2)}d`);
  ok("audit: PERSISTENT_SESSION_CREATED", await auditExists("PERSISTENT_SESSION_CREATED", "al-t2-alt@mohd-test.local"));
  await idleExpire(t2.cookie);
  const t2sess = await get(t2.cookie, "/api/v1/auth/session");
  ok("idle expiry logs the user OUT (401 policy preserved)", t2sess.status === 200 && t2sess.body?.data?.authenticated === false);
  const t2marked = await db.session.findUnique({ where: { token: tokOf(t2.cookie) } });
  ok("remember-grant kept (idle-revoked, restorable)", t2marked?.remember === true && t2marked?.idleRevokedAt !== null);
  const t2restore = await post(t2.cookie, "/api/v1/auth/auto-login/restore");
  ok("restoration granted", t2restore.body?.data?.restored === true, `user=${t2restore.body?.data?.user?.email}`);
  const newCookie = (t2restore.headers as any)?.getSetCookie?.().map((c: string) => c.split(";")[0]).find((c: string) => c.startsWith("hms_session=")) ?? "";
  ok("token ROTATED on restore (old credential dead)", newCookie !== "" && tokOf(newCookie) !== tokOf(t2.cookie));
  const t2after = await get(newCookie || t2.cookie, "/api/v1/auth/session");
  ok("session live again with the SAME user", t2after.body?.data?.authenticated === true && t2after.body?.data?.user?.email === "al-t2-alt@mohd-test.local");
  ok("restored session carries fresh permissions", Array.isArray(t2after.body?.data?.user?.permissions) && t2after.body?.data?.user?.permissions?.length > 0);
  ok("audit: PERSISTENT_SESSION_RESTORED", await auditExists("PERSISTENT_SESSION_RESTORED", "al-t2-alt@mohd-test.local"));
  // old token must now be dead
  const t2old = await post(t2.cookie, "/api/v1/auth/auto-login/restore");
  ok("old (pre-rotation) cookie rejected", t2old.body?.data?.restored === false);

  // ── TEST 4 — LOGOUT wins over auto login (on t2, grant is live again) ───
  console.log("TEST 4 — explicit logout always works");
  await idleExpire(newCookie || t2.cookie); // set up a restorable grant again
  await post(newCookie || t2.cookie, "/api/v1/auth/auto-login/restore"); // live session
  const t4logout = await post(newCookie || t2.cookie, "/api/v1/auth/logout");
  ok("manual logout accepted", t4logout.status === 200);
  ok("manual logout DELETED the grant (row gone)", (await db.session.findUnique({ where: { token: tokOf(newCookie || t2.cookie) } })) === null);
  const t4restore = await post(newCookie || t2.cookie, "/api/v1/auth/auto-login/restore");
  ok("NO silent re-login after explicit logout", t4restore.body?.data?.restored === false, `reason=${t4restore.body?.data?.reason}`);

  // ── TEST 3 — DISABLE from Security settings ─────────────────────────────
  console.log("TEST 3 — disable stops future restoration");
  await makeUser("al-t3-alt@mohd-test.local", "SUPERVISOR");
  const t3 = await login("al-t3-alt@mohd-test.local", true);
  const t3en = await post(t3.cookie, "/api/v1/auth/auto-login/enable");
  ok("enable endpoint flips the CURRENT session grant", t3en.body?.data?.autoLogin === true);
  ok("enable extended to the 30-day policy", ((await db.session.findUnique({ where: { token: tokOf(t3.cookie) } }))?.expiresAt.getTime() ?? 0) - Date.now() > 29 * 86400000);
  const t3sess1 = await get(t3.cookie, "/api/v1/auth/session");
  ok("enable does NOT terminate the current session", t3sess1.body?.data?.authenticated === true);
  ok("audit: AUTO_LOGIN_ENABLED", await auditExists("AUTO_LOGIN_ENABLED", "al-t3-alt@mohd-test.local"));
  const t3dis = await post(t3.cookie, "/api/v1/auth/auto-login/disable");
  ok("disable endpoint accepted", t3dis.body?.data?.autoLogin === false);
  const t3sess2 = await get(t3.cookie, "/api/v1/auth/session");
  ok("disable does NOT terminate the current session (spec §8)", t3sess2.body?.data?.authenticated === true);
  ok("audit: AUTO_LOGIN_DISABLED", await auditExists("AUTO_LOGIN_DISABLED", "al-t3-alt@mohd-test.local"));
  await idleExpire(t3.cookie);
  const t3restore = await post(t3.cookie, "/api/v1/auth/auto-login/restore");
  ok("no restoration after ON→OFF (grant was cleared)", t3restore.body?.data?.restored === false, `reason=${t3restore.body?.data?.reason}`);

  // ── TEST 5 — MULTI-DEVICE independence ───────────────────────────────────
  console.log("TEST 5 — per-device independence");
  const t5a = await login("al-t3-alt@mohd-test.local", true);  // desktop: ON
  const t5b = await login("al-t3-alt@mohd-test.local", false); // mobile: OFF
  const t5arow = await db.session.findUnique({ where: { token: tokOf(t5a.cookie) } });
  const t5brow = await db.session.findUnique({ where: { token: tokOf(t5b.cookie) } });
  ok("device A grant ON, device B grant OFF — independent rows", t5arow?.remember === true && t5brow?.remember === false);
  await idleExpire(t5b.cookie);
  const t5brestore = await post(t5b.cookie, "/api/v1/auth/auto-login/restore");
  ok("device B (OFF) not restored", t5brestore.body?.data?.restored === false);
  const t5b2 = await login("al-t3-alt@mohd-test.local", false); // fresh mobile login (B was deleted by idle)
  const t5asess = await get(t5a.cookie, "/api/v1/auth/session");
  ok("device A unaffected by device B", t5asess.body?.data?.authenticated === true);
  const t5list = await get(t5a.cookie, "/api/v1/auth/sessions");
  const t5rows = t5list.body?.data?.sessions ?? [];
  ok("session list shows per-session autoLogin + current flag", t5rows.length >= 2 && t5rows.some((r: any) => r.current && r.autoLogin === true) && t5rows.some((r: any) => !r.current && r.autoLogin === false), `${t5rows.length} rows`);

  // ── TEST 6 — PASSWORD CHANGE + admin reset (t4 user) ────────────────────
  console.log("TEST 6 — password change/reset revoke grants");
  await makeUser("al-t4-alt@mohd-test.local", "CUSTOMER");
  const t6main = await login("al-t4-alt@mohd-test.local", true);   // device that changes its password
  const t6other = await login("al-t4-alt@mohd-test.local", true);  // other device with a grant
  const t6change = await post(t6main.cookie, "/api/v1/auth/password", { currentPassword: "Password@123", newPassword: "NewPassword@123" });
  ok("password changed", t6change.status === 200);
  ok("other device's grant DELETED by password change (existing policy)", (await db.session.findUnique({ where: { token: tokOf(t6other.cookie) } })) === null);
  const t6otherRestore = await post(t6other.cookie, "/api/v1/auth/auto-login/restore");
  ok("old persistent auth cannot bypass the new password state", t6otherRestore.body?.data?.restored === false);
  const t6mainSess = await get(t6main.cookie, "/api/v1/auth/session");
  ok("the changing device's own session survives (existing policy)", t6mainSess.body?.data?.authenticated === true);
  // restore the old password hash for the admin-reset test
  await db.user.update({ where: { email: "al-t4-alt@mohd-test.local" }, data: { passwordHash: hashPw("Password@123") } });
  const t4id = (await db.user.findUnique({ where: { email: "al-t4-alt@mohd-test.local" } }))?.id ?? "";
  const t6adminReset = await patch(admin.cookie, `/api/v1/users/${t4id}`, { action: "reset_password", newPassword: "ResetPassword@123" });
  ok("admin password reset accepted", t6adminReset.status === 200 || t6adminReset.status === 201, `status=${t6adminReset.status}`);
  ok("admin reset deleted ALL sessions incl. grants", (await db.session.count({ where: { userId: t4id } })) === 0);

  // ── TEST 8 — ROLE CHANGE propagates to a live grant ─────────────────────
  console.log("TEST 8 — role change → fresh authoritative permissions");
  await db.user.update({ where: { email: "al-t4-alt@mohd-test.local" }, data: { passwordHash: hashPw("Password@123") } });
  const t8 = await login("al-t4-alt@mohd-test.local", true);
  const t8before = await get(t8.cookie, "/api/v1/auth/session");
  const custPerms = t8before.body?.data?.user?.permissions ?? [];
  // role change through the real admin path — PATCH body { role } on users/[id]
  const t8patch = await patch(admin.cookie, `/api/v1/users/${t4id}`, { role: "TECHNICIAN" });
  void t8patch;
  const t8after = await get(t8.cookie, "/api/v1/auth/session");
  ok("role change does not kill the session (existing design)", t8after.body?.data?.authenticated === true);
  ok("permissions re-resolved from the authoritative User row", t8after.body?.data?.user?.role === "TECHNICIAN" && JSON.stringify(t8after.body?.data?.user?.permissions) !== JSON.stringify(custPerms));
  // role change must also hold on RESTORATION (mark idle → restore)
  await idleExpire(t8.cookie);
  const t8restore = await post(t8.cookie, "/api/v1/auth/auto-login/restore");
  ok("restored session carries the CURRENT role", t8restore.body?.data?.restored === true && t8restore.body?.data?.user?.role === "TECHNICIAN");

  // ── TEST 9 — ADMIN REVOCATION kills auto login ───────────────────────────
  console.log("TEST 9 — admin revocation");
  await db.user.update({ where: { email: "al-t4-alt@mohd-test.local" }, data: { passwordHash: hashPw("Password@123") } });
  const t9 = await login("al-t4-alt@mohd-test.local", true);
  await idleExpire(t9.cookie); // make it restorable
  await patch(admin.cookie, `/api/v1/users/${t4id}`, { action: "reset_password", newPassword: "RevokeTest@123" });
  const t9restore = await post(t9.cookie, "/api/v1/auth/auto-login/restore");
  ok("admin-revoked grant cannot restore", t9restore.body?.data?.restored === false, `reason=${t9restore.body?.data?.reason}`);
  ok("audit: USER_PASSWORD_RESET", await auditExists("USER_PASSWORD_RESET", "admin@mohdhms.com"));

  // ── SESSION MANAGEMENT API (Profile → Security) ──────────────────────────
  console.log("Session management API");
  const t10a = await login("al-t2-alt@mohd-test.local", true);
  const t10b = await login("al-t2-alt@mohd-test.local", false);
  const t10list = await get(t10a.cookie, "/api/v1/auth/sessions");
  const rows = t10list.body?.data?.sessions ?? [];
  ok("own sessions listed with device/autoLogin/status", t10list.status === 200 && rows.length >= 2 && rows.every((r: any) => typeof r.autoLogin === "boolean" && !!r.device));
  ok("no tokens/secrets in the list payload", JSON.stringify(rows).includes("hms_session") === false && JSON.stringify(t10list.body).match(/"token"/) === null);
  const otherId = rows.find((r: any) => !r.current)?.id;
  const t10revoke = await del(t10a.cookie, `/api/v1/auth/sessions/${otherId}`);
  ok("per-session [Sign Out] deletes that device's grant", t10revoke.body?.data?.revoked === true && (await db.session.findUnique({ where: { id: otherId } })) === null);
  const t10brestore = await post(t10b.cookie, "/api/v1/auth/auto-login/restore");
  void t10brestore;
  const t10others = await post(t10a.cookie, "/api/v1/auth/sessions/revoke-others");
  ok("[Sign Out All Other Sessions] revokes the rest", t10others.body?.data?.revoked >= 0);
  const t10afterList = await get(t10a.cookie, "/api/v1/auth/sessions");
  ok("current session is the only one left", (t10afterList.body?.data?.sessions ?? []).every((r: any) => r.current));

  // ── unauthorized / cross-user guards ─────────────────────────────────────
  console.log("Guards");
  const anonRestore = await post("", "/api/v1/auth/auto-login/restore");
  ok("anonymous restore is a calm no (200 restored:false)", anonRestore.status === 200 && anonRestore.body?.data?.restored === false);
  const anonSessions = await get("", "/api/v1/auth/sessions");
  ok("sessions list requires auth (401)", anonSessions.status === 401);
  const t2sessList = await get((await login("al-t1-alt@mohd-test.local")).cookie, "/api/v1/auth/sessions");
  const leak = JSON.stringify(t2sessList.body?.data?.sessions ?? []).includes(tokOf(t2.cookie).slice(0, 12));
  ok("no cross-user session leakage", leak === false);
  const bogus = await del((await login("al-t1-alt@mohd-test.local")).cookie, "/api/v1/auth/sessions/clpxxxxxxxxxxxxxxxxxxxxxxxx");
  ok("foreign/unknown session id → 404 (no IDOR)", bogus.status === 404);

  // cleanup
  for (const e of ["al-t1-alt@mohd-test.local", "al-t2-alt@mohd-test.local", "al-t3-alt@mohd-test.local", "al-t4-alt@mohd-test.local"]) {
    await db.user.deleteMany({ where: { email: e } });
  }

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  await db.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (e) => { console.error(e); await db.$disconnect(); process.exit(1); });
