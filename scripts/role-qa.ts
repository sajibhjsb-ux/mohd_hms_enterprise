/**
 * MOHD.HMS ENTERPRISE — Portal user ROLE CHANGE QA (scripts/role-qa.ts)
 *
 * Verifies the complete role-changing system against the REAL running server
 * and the REAL database (role-change spec §23):
 *
 *   SUCCESS:  CUSTOMER → TECHNICIAN (+ profile provisioning + roster visible +
 *             session permissions), CUSTOMER → SUPERVISOR, CUSTOMER → ADMIN
 *   FAILURES: unauthorized (supervisor/customer/technician), invalid role,
 *             unknown user, self-role escalation, non-SA touching SA target
 *   REVERSE:  TECHNICIAN → CUSTOMER (profile RETIRED, roster hidden,
 *             customer permissions back, history preserved, re-promotion reuses
 *             the SAME TEC number)
 *
 * Run: bun scripts/role-qa.ts   (dev server on :3000)
 */

import { db } from "../src/lib/db";

const BASE = "http://localhost:3000";
const PASSWORD = "Password@123";

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, extra?: string) {
  if (ok) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ""}`);
  }
}

type Jar = Map<string, string>;
function cookieHeader(jar: Jar) {
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}
function absorb(jar: Jar, res: Response) {
  const sc = res.headers.getSetCookie?.() ?? [];
  for (const c of sc) {
    const [pair] = c.split(";");
    const eq = pair.indexOf("=");
    if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
}

async function api(method: string, path: string, body?: unknown, jar?: Jar) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { "content-type": "application/json", ...(jar && jar.size ? { cookie: cookieHeader(jar) } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (jar) absorb(jar, res);
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    /* non-json */
  }
  return { status: res.status, data: data as Record<string, unknown> };
}

async function login(email: string): Promise<Jar> {
  const jar: Jar = new Map();
  const res = await api("POST", "/api/v1/auth/login", { email, password: PASSWORD }, jar);
  if (res.status !== 200) throw new Error(`login failed for ${email}: ${res.status}`);
  return jar;
}

const asRole = (jar: Jar | null) => {
  const d = (jar?.get("hms_session") ?? "").length > 10;
  return d;
};

async function main() {
  console.log("\n=== ROLE CHANGE QA ===\n");

  // ── Actors ──
  const admin = await login("admin@mohdhms.com"); // SUPER_ADMIN
  const operations = await login("operations@mohdhms.com"); // ADMIN
  const supervisor = await login("supervisor@mohdhms.com"); // SUPERVISOR (no users.update)
  const tech = await login("ahmad.tech@mohdhms.com"); // TECHNICIAN
  const customer = await login("customer1@demo.my"); // CUSTOMER (portal user)
  check("all five actor logins", [admin, operations, supervisor, tech, customer].every(asRole));

  // ── Locate the portal customer user (role-agnostic: a previous crashed run
  // may have left the account in another role) ──
  const portalList = await api("GET", "/api/v1/users?includeCustomers=1&search=customer1@demo.my&pageSize=50", undefined, admin);
  const portalUsers = (portalList.data.data as { id: string; email: string; role: string }[]) ?? [];
  const target = portalUsers.find((u) => u.email === "customer1@demo.my");
  check("portal customer located via list (includeCustomers=1)", !!target, JSON.stringify(portalList.data).slice(0, 120));
  if (!target) process.exit(1);
  const tid = target.id;

  // Deterministic start: force the target back to CUSTOMER (idempotent re-runs).
  await api("PATCH", `/api/v1/users/${tid}`, { role: "CUSTOMER" }, admin);

  // ── ROOT-CAUSE FIX proof: detail endpoint returns ANY user ──
  const detail = await api("GET", `/api/v1/users/${tid}`, undefined, admin);
  check("GET /users/{id} returns the portal user", detail.status === 200 && !!(detail.data.data as { role?: string })?.role, `status=${detail.status}`);
  const detailAsAdmin = await api("GET", `/api/v1/users/${tid}`, undefined, operations);
  check("ADMIN can also open the portal user detail", detailAsAdmin.status === 200);

  // ── CUSTOMER → TECHNICIAN (spec §11/§12 propagation) ──
  const toTech = await api("PATCH", `/api/v1/users/${tid}`, { role: "TECHNICIAN" }, operations);
  const toTechBody = (toTech.data.data as { role?: string; technicianProfile?: { employeeNo?: string } | null }) ?? {};
  check("ADMIN changes CUSTOMER → TECHNICIAN (200)", toTech.status === 200 && toTechBody.role === "TECHNICIAN", `status=${toTech.status} body=${JSON.stringify(toTech.data).slice(0, 150)}`);
  check("technician profile provisioned with TEC number", !!toTechBody.technicianProfile?.employeeNo, JSON.stringify(toTechBody.technicianProfile));

  const dbUser1 = await db.user.findUnique({ where: { id: tid }, include: { technicianProfile: true } });
  check("PostgreSQL: role column = TECHNICIAN", dbUser1?.role === "TECHNICIAN");
  check("PostgreSQL: TechnicianProfile row ACTIVE (AVAILABLE)", dbUser1?.technicianProfile?.status === "AVAILABLE" && !!dbUser1?.technicianProfile?.employeeNo);

  // Roster + assignment dropdowns see the new technician (§12)
  const roster = await api("GET", "/api/v1/technicians?pageSize=200", undefined, admin);
  const rosterRows = (roster.data.data as { id: string; employeeNo: string; user?: { email?: string } }[]) ?? [];
  check("Technician Management roster lists the converted user", rosterRows.some((r) => r.user?.email === "customer1@demo.my"));

  // Session: old customer session now resolves TECHNICIAN permissions live (§8)
  const sessAfter = await api("GET", "/api/v1/auth/session", undefined, customer);
  const sessUser = ((sessAfter.data.data as { user?: { role?: string; permissions?: string[] } }) ?? {}).user ?? {};
  check("affected user's session now resolves TECHNICIAN (live, no re-login)", sessUser.role === "TECHNICIAN", `role=${sessUser.role}`);
  check("technician permissions active (work_orders.read)", (sessUser.permissions ?? []).includes("work_orders.read"));
  check("customer-only permission removed (complaints.create)", !(sessUser.permissions ?? []).includes("complaints.create"));

  // Audit: dedicated role-change record (§17)
  const auditRows = await api("GET", `/api/v1/audit-logs?resourceType=USER&resourceId=${tid}&action=USER_ROLE_CHANGED&pageSize=5`, undefined, admin);
  const firstAudit = ((auditRows.data.data as { action: string; metadata?: Record<string, unknown> }[]) ?? [])[0];
  check("audit USER_ROLE_CHANGED recorded (previousRole → newRole, SUCCESS)", firstAudit?.metadata?.previousRole === "CUSTOMER" && firstAudit?.metadata?.newRole === "TECHNICIAN" && firstAudit?.metadata?.result === "SUCCESS", JSON.stringify(firstAudit?.metadata ?? {}).slice(0, 140));

  // ── FAILURES (spec §22/§23) ──
  const forbidden1 = await api("PATCH", `/api/v1/users/${tid}`, { role: "ADMIN" }, supervisor);
  check("SUPERVISOR role change → 403", forbidden1.status === 403);
  const forbidden2 = await api("PATCH", `/api/v1/users/${tid}`, { role: "ADMIN" }, customer);
  check("CUSTOMER (no users.update) role change → 403", forbidden2.status === 403);
  const forbidden3 = await api("PATCH", `/api/v1/users/${tid}`, { role: "ADMIN" }, tech);
  check("TECHNICIAN role change → 403", forbidden3.status === 403);
  const anon = await api("PATCH", `/api/v1/users/${tid}`, { role: "ADMIN" });
  check("anonymous role change → 401", anon.status === 401);
  const invalidRole = await api("PATCH", `/api/v1/users/${tid}`, { role: "GOD" }, admin);
  check("invalid role value → 400 VALIDATION_ERROR", invalidRole.status === 400 && JSON.stringify(invalidRole.data).includes("VALIDATION_ERROR"));
  const notFound = await api("PATCH", "/api/v1/users/nonexistent-user-id", { role: "ADMIN" }, admin);
  check("unknown target user → 404", notFound.status === 404);
  const selfEsc = await api("PATCH", "/api/v1/users/" + (((await api("GET", "/api/v1/auth/session", undefined, operations)).data.data as { user?: { id?: string } }).user?.id ?? ""), { role: "SUPER_ADMIN" }, operations);
  check("self role escalation (ADMIN → SUPER_ADMIN) → 400", selfEsc.status === 400, `status=${selfEsc.status}`);
  // Non-SUPER_ADMIN touching a SUPER_ADMIN target
  const superAdmins = await api("GET", "/api/v1/users?role=SUPER_ADMIN&pageSize=10", undefined, admin);
  const saId = ((superAdmins.data.data as { id: string }[]) ?? []).find((u) => u.id !== "")?.id;
  if (saId) {
    const touchSa = await api("PATCH", `/api/v1/users/${saId}`, { role: "CUSTOMER" }, operations);
    check("ADMIN modifies SUPER_ADMIN target → 403", touchSa.status === 403);
  }

  // ── Role option coverage (spec §2/§13): CUSTOMER→SUPERVISOR→ADMIN, then back ──
  const toSup = await api("PATCH", `/api/v1/users/${tid}`, { role: "SUPERVISOR" }, admin);
  check("CUSTOMER(TECH) → SUPERVISOR (200, profile RETIRED)", toSup.status === 200 && (toSup.data.data as { role?: string })?.role === "SUPERVISOR");
  const dbUser2 = await db.user.findUnique({ where: { id: tid }, include: { technicianProfile: true } });
  check("downgrade retires the technician profile (history kept)", dbUser2?.technicianProfile?.status === "RETIRED", `status=${dbUser2?.technicianProfile?.status}`);
  const rosterAfterDowngrade = await api("GET", "/api/v1/technicians?pageSize=200", undefined, admin);
  const rosterAfter = (rosterAfterDowngrade.data.data as { user?: { email?: string } }[]) ?? [];
  check("roster + assignment dropdowns no longer list the user (§13)", !rosterAfter.some((r) => r.user?.email === "customer1@demo.my"));
  const toAdmin = await api("PATCH", `/api/v1/users/${tid}`, { role: "ADMIN" }, admin);
  check("→ ADMIN (200)", toAdmin.status === 200 && (toAdmin.data.data as { role?: string })?.role === "ADMIN");

  // ── RE-PROMOTION reuses the SAME TEC number (one canonical identity, §12) ──
  const tecNoBefore = dbUser2?.technicianProfile?.employeeNo ?? "";
  const rePromote = await api("PATCH", `/api/v1/users/${tid}`, { role: "TECHNICIAN" }, admin);
  const reProfile = (rePromote.data.data as { technicianProfile?: { employeeNo?: string; status?: string } | null })?.technicianProfile;
  check("re-promotion reactivates the SAME profile/TEC number", rePromote.status === 200 && reProfile?.employeeNo === tecNoBefore && reProfile?.status === "AVAILABLE", `before=${tecNoBefore} after=${JSON.stringify(reProfile)}`);
  const dupCount = await db.technicianProfile.count({ where: { userId: tid } });
  check("no duplicate technician profiles created", dupCount === 1, `count=${dupCount}`);

  // ── Reverse final: TECHNICIAN → CUSTOMER, verify customer session (§13) ──
  const toCustomer = await api("PATCH", `/api/v1/users/${tid}`, { role: "CUSTOMER" }, admin);
  check("TECHNICIAN → CUSTOMER (200)", toCustomer.status === 200 && (toCustomer.data.data as { role?: string })?.role === "CUSTOMER");
  const sessFinal = await api("GET", "/api/v1/auth/session", undefined, customer);
  const finalUser = ((sessFinal.data.data as { user?: { role?: string; permissions?: string[] } }) ?? {}).user ?? {};
  check("session resolves CUSTOMER again (customer permissions back)", finalUser.role === "CUSTOMER" && (finalUser.permissions ?? []).includes("complaints.create"));
  check("technician permission removed (work_orders.complete)", !(finalUser.permissions ?? []).includes("work_orders.complete"));

  // ── SUPER_ADMIN protections (§6) ──
  // (a) ADMIN actor cannot touch a SUPER_ADMIN target (checked above).
  // (b) Self-role change blocked even for SUPER_ADMIN → the last active
  //     SUPER_ADMIN can never demote itself (zero-SA protection).
  const saId2 = ((await api("GET", "/api/v1/users?role=SUPER_ADMIN&pageSize=10", undefined, admin)).data.data as { id: string }[] ?? [])[0]?.id;
  const adminSession = await api("GET", "/api/v1/auth/session", undefined, admin);
  const selfSa = await api("PATCH", `/api/v1/users/${((adminSession.data.data as { user?: { id?: string } }).user?.id ?? "")}`, { role: "ADMIN" }, admin);
  check("last SUPER_ADMIN cannot demote itself (self-block → 400)", selfSa.status === 400);
  void saId2;

  // Cleanup: restore original role of the QA target.
  await api("PATCH", `/api/v1/users/${tid}`, { role: "CUSTOMER" }, admin);
  const restored = await db.user.findUnique({ where: { id: tid } });
  check("cleanup: target restored to CUSTOMER", restored?.role === "CUSTOMER");

  console.log(`\n=== RESULT: ${passed} passed, ${failed} failed ===\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("QA crashed:", e);
  process.exit(1);
});
