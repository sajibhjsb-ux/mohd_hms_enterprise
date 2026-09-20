/**
 * MOHD.HMS ENTERPRISE — ROLE + POSITION separation QA (scripts/role-position-qa.ts)
 *
 * Verifies the ROLE (RBAC access) vs POSITION (job title) system against the
 * REAL running server and the REAL database (role/position spec §30):
 *
 *   CASE 1  role + position assigned together → correct access + correct title
 *   CASE 2  position-only change → role untouched
 *   CASE 3  role-only change → position untouched
 *   CASE 4  role + position in ONE request → both applied atomically
 *   CASE 5  unauthorized role change → 403 / 401
 *   CASE 6  unauthorized position change → 403 / 401 (incl. HR without users.update)
 *   CASE 7  fresh login after role change → new permissions apply (live RBAC)
 *   CASE 8  position-only change → permissions unchanged
 *   CASE 9  CUSTOMER → TECHNICIAN with position → Technician Management recognizes
 *   CASE 10 audit history: USER_ROLE_CHANGED / USER_POSITION_CHANGED /
 *           EMPLOYEE_POSITION_CHANGED rows with previous → new values
 *   plus:   position catalog CRUD RBAC (hr.manage), duplicate 409, inactive
 *           position not assignable, User ↔ Employee position mirror, notification
 *
 * Idempotent: the scratch target (finance user) and customer1 are restored.
 * Run: bun scripts/role-position-qa.ts   (dev server on :3000)
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
  // Login is rate-limited (8 / 5 min per IP+email). QA re-runs inside the
  // window can trip it — wait-and-retry instead of crashing mid-suite.
  for (let attempt = 0; ; attempt++) {
    const res = await api("POST", "/api/v1/auth/login", { email, password: PASSWORD }, jar);
    if (res.status === 200) return jar;
    if (res.status === 429 && attempt < 6) {
      console.log(`  … rate limited for ${email}, waiting 45s (attempt ${attempt + 1})`);
      await new Promise((r) => setTimeout(r, 45_000));
      continue;
    }
    throw new Error(`login failed for ${email}: ${res.status}`);
  }
}

const dd = (r: { data: Record<string, unknown> }) => (r.data.data ?? {}) as Record<string, never> & Record<string, unknown>;

async function main() {
  console.log("\n=== ROLE + POSITION QA ===\n");

  // ── Actors ──
  const admin = await login("admin@mohdhms.com"); // SUPER_ADMIN
  const operations = await login("operations@mohdhms.com"); // ADMIN (users.update, no SA identity fields)
  const supervisor = await login("supervisor@mohdhms.com"); // SUPERVISOR (users_read only)
  const hr = await login("hr@mohdhms.com"); // HR (employees_update + hr_manage, NO users_update)
  const finance = await login("finance@mohdhms.com"); // FINANCE
  const tech = await login("ahmad.tech@mohdhms.com"); // TECHNICIAN
  check("all actor logins", [admin, operations, supervisor, hr, finance, tech].every((j) => (j.get("hms_session") ?? "").length > 10));

  // ── Position catalog (seeded) ──
  const positions = (((await api("GET", "/api/v1/hr/positions?pageSize=200", undefined, admin)).data.data ?? []) as { id: string; name: string; status: string }[]);
  const byName = Object.fromEntries(positions.map((p) => [p.name, p.id]));
  const financeDirector = byName["Finance Director"];
  const accountsOfficer = byName["Accounts Officer"];
  const maintenanceSupervisor = byName["Maintenance Supervisor"];
  const financeOfficer = byName["Finance Officer"];
  const hvacTechnician = byName["HVAC Technician"];
  const seniorHvac = byName["Senior HVAC Technician"];
  const seniorTech = byName["Senior Technician"];
  check("position catalog seeded (24 titles readable)", positions.length >= 20, `got ${positions.length}`);
  const missing = ["Finance Director", "Accounts Officer", "Maintenance Supervisor", "Finance Officer", "HVAC Technician", "Senior HVAC Technician", "Senior Technician"].filter((n) => !byName[n]);
  check("key positions present", missing.length === 0, `missing: ${missing.join(",") || "none"} · got: ${positions.length}`);

  // ── Locate targets ──
  const users = (((await api("GET", "/api/v1/users?pageSize=200", undefined, admin)).data.data ?? []) as { id: string; email: string; role: string; position?: { name: string } | null }[]);
  const fin = users.find((u) => u.email === "finance@mohdhms.com");
  const ahmad = users.find((u) => u.email === "ahmad.tech@mohdhms.com");
  const cust = (((await api("GET", "/api/v1/users?includeCustomers=1&search=customer1@demo.my", undefined, admin)).data.data ?? []) as { id: string; email: string }[]).find(
    (u) => u.email === "customer1@demo.my"
  );
  check("scratch targets located (finance / ahmad / customer1)", !!(fin && ahmad && cust));
  if (!fin || !ahmad || !cust) process.exit(1);
  const fid = fin.id;
  const ahmadId = ahmad.id;

  // Deterministic start: FINANCE role, no position.
  await api("PATCH", `/api/v1/users/${fid}`, { role: "FINANCE", positionId: null }, admin);

  // ══ CASE 1 — role + position assigned together ══
  console.log("\nCASE 1 — role ADMIN + position Finance Director");
  const c1 = await api("PATCH", `/api/v1/users/${fid}`, { role: "ADMIN", positionId: financeDirector }, admin);
  const c1body = dd(c1) as { role?: string; position?: { name?: string } | null };
  check("PATCH {role, positionId} → 200 with both values", c1.status === 200 && c1body.role === "ADMIN" && c1body.position?.name === "Finance Director", JSON.stringify(dd(c1)).slice(0, 140));
  const c1fresh = dd(await api("GET", `/api/v1/users/${fid}`, undefined, admin)) as { role?: string; position?: { name?: string } | null };
  check("DB authoritative: role=ADMIN, position=Finance Director", c1fresh.role === "ADMIN" && c1fresh.position?.name === "Finance Director");

  // ══ CASE 2 — position-only change preserves role ══
  console.log("\nCASE 2 — position only → role untouched");
  const c2 = await api("PATCH", `/api/v1/users/${fid}`, { positionId: accountsOfficer }, operations);
  const c2body = dd(c2) as { role?: string; position?: { name?: string } | null };
  check("ADMIN (users.update) changes position only → 200", c2.status === 200 && c2body.position?.name === "Accounts Officer", JSON.stringify(dd(c2)).slice(0, 140));
  check("role remains ADMIN after position-only change", c2body.role === "ADMIN");

  // ══ CASE 3 — role-only change preserves position ══
  console.log("\nCASE 3 — role only → position untouched");
  const c3 = await api("PATCH", `/api/v1/users/${fid}`, { role: "SUPERVISOR" }, admin);
  const c3body = dd(c3) as { role?: string; position?: { name?: string } | null };
  check("role SUPERVISOR applied", c3.status === 200 && c3body.role === "SUPERVISOR");
  check("position remains Accounts Officer after role-only change", c3body.position?.name === "Accounts Officer");

  // ══ CASE 4 — both in ONE request (atomic) ══
  console.log("\nCASE 4 — role + position together in one transaction");
  const c4 = await api("PATCH", `/api/v1/users/${fid}`, { role: "FINANCE", positionId: financeOfficer }, admin);
  const c4body = dd(c4) as { role?: string; position?: { name?: string } | null };
  check("combined PATCH applies BOTH (role FINANCE + Finance Officer)", c4.status === 200 && c4body.role === "FINANCE" && c4body.position?.name === "Finance Officer", JSON.stringify(dd(c4)).slice(0, 140));
  const c4emp = await db.employee.findFirst({ where: { userId: fid }, select: { position: true, positionId: true } });
  check("linked Employee mirror follows (snapshot + FK) — no linked employee expected for finance user", c4emp === null || (c4emp.positionId === financeOfficer && c4emp.position === "Finance Officer"));

  // ══ CASE 5 — unauthorized role change ══
  console.log("\nCASE 5 — unauthorized role changes rejected");
  const c5a = await api("PATCH", `/api/v1/users/${fid}`, { role: "ADMIN" }, supervisor);
  check("SUPERVISOR role change → 403", c5a.status === 403, `status=${c5a.status}`);
  const c5b = await api("PATCH", `/api/v1/users/${fid}`, { role: "ADMIN" }, tech);
  check("TECHNICIAN role change → 403", c5b.status === 403, `status=${c5b.status}`);
  const c5c = await api("PATCH", `/api/v1/users/${fid}`, { role: "ADMIN" });
  check("anonymous role change → 401", c5c.status === 401, `status=${c5c.status}`);
  const c5d = await api("PATCH", `/api/v1/users/${fid}`, { role: "SUPER_ADMIN" }, operations);
  check("non-SA touching SA target → 403 (escalation blocked)", c5d.status === 403, `status=${c5d.status}`);

  // ══ CASE 6 — unauthorized position change ══
  console.log("\nCASE 6 — unauthorized position changes rejected");
  const c6a = await api("PATCH", `/api/v1/users/${fid}`, { positionId: financeDirector }, supervisor);
  check("SUPERVISOR position change → 403", c6a.status === 403, `status=${c6a.status}`);
  const c6b = await api("PATCH", `/api/v1/users/${fid}`, { positionId: financeDirector }, hr);
  check("HR (employees.update but NO users.update) position change → 403", c6b.status === 403, `status=${c6b.status}`);
  const c6c = await api("PATCH", `/api/v1/users/${fid}`, { positionId: financeDirector });
  check("anonymous position change → 401", c6c.status === 401, `status=${c6c.status}`);

  // ══ CASE 7 — role change → permissions (live RBAC, no cache) ══
  console.log("\nCASE 7 — login after role change picks up new permissions");
  await api("PATCH", `/api/v1/users/${fid}`, { role: "ADMIN" }, admin);
  const asAdmin = await login("finance@mohdhms.com");
  const adminSession = dd(await api("GET", "/api/v1/auth/session", undefined, asAdmin)) as { user?: { role?: string; permissions?: string[] } };
  check("session role = ADMIN", adminSession.user?.role === "ADMIN");
  check("admin-level permission live (employees.create present)", !!adminSession.user?.permissions?.includes("employees.create"));
  // Restore to FINANCE, then query with the SAME session: authorization is
  // resolved live from the User row, so the previously-ADMIN session must now
  // resolve FINANCE permissions with NO stale cache (spec §22).
  await api("PATCH", `/api/v1/users/${fid}`, { role: "FINANCE" }, admin);
  const finSession = dd(await api("GET", "/api/v1/auth/session", undefined, asAdmin)) as { user?: { role?: string; permissions?: string[] } };
  check("same session now resolves FINANCE — employees.create GONE (no stale cache)", finSession.user?.role === "FINANCE" && !finSession.user?.permissions?.includes("employees.create"));

  // ══ CASE 8 — position-only change leaves permissions unchanged ══
  console.log("\nCASE 8 — position change never touches permissions");
  const beforePerms = finSession.user?.permissions ?? [];
  await api("PATCH", `/api/v1/users/${fid}`, { positionId: accountsOfficer }, admin);
  // Reuse the SAME session (stronger than a fresh login: identical session, so
  // any permission delta could only come from the position change).
  const afterSession = dd(await api("GET", "/api/v1/auth/session", undefined, asAdmin)) as { user?: { role?: string; permissions?: string[] } };
  const afterPerms = afterSession.user?.permissions ?? [];
  check("permissions identical before/after position change", JSON.stringify(beforePerms) === JSON.stringify(afterPerms) && beforePerms.length > 0);
  check("role unchanged (FINANCE)", afterSession.user?.role === "FINANCE");

  // ══ CASE 9 — CUSTOMER → TECHNICIAN with position (§17/§18) ══
  console.log("\nCASE 9 — portal CUSTOMER → TECHNICIAN + position");
  await api("PATCH", `/api/v1/users/${cust.id}`, { role: "CUSTOMER", positionId: null }, admin);
  const c9 = await api("PATCH", `/api/v1/users/${cust.id}`, { role: "TECHNICIAN", positionId: hvacTechnician }, admin);
  const c9body = dd(c9) as { role?: string; technicianProfile?: { employeeNo?: string } | null; position?: { name?: string } | null };
  check("converted with position in the SAME transaction", c9.status === 200 && c9body.role === "TECHNICIAN" && c9body.position?.name === "HVAC Technician", JSON.stringify(dd(c9)).slice(0, 160));
  check("technician profile provisioned (recognizable by Technician Management)", !!c9body.technicianProfile?.employeeNo);
  const roster = (((await api("GET", "/api/v1/technicians?pageSize=100", undefined, admin)).data.data ?? []) as { user?: { email?: string } }[]);
  const rosterHas = roster.some((t) => t.user?.email === "customer1@demo.my");
  check("roster lists the converted technician", rosterHas);
  const c9user = dd(await api("GET", `/api/v1/users/${cust.id}`, undefined, admin)) as { position?: { name?: string } | null; employee?: { position?: string } | null };
  check("account position = HVAC Technician", c9user.position?.name === "HVAC Technician");
  // restore
  await api("PATCH", `/api/v1/users/${cust.id}`, { role: "CUSTOMER", positionId: null }, admin);

  // ══ Employee-side position change + User mirror (§13/§18 sync) ══
  console.log("\nEmployee ↔ User position mirror");
  const ahmadEmp = await db.employee.findFirst({ where: { userId: ahmadId }, select: { id: true, position: true } });
  check("Ahmad has a linked employee record", !!ahmadEmp);
  if (ahmadEmp) {
    const e1 = await api("PATCH", `/api/v1/employees/${ahmadEmp.id}`, { positionId: seniorTech }, hr);
    check("HR (employees.update) changes employee position → 200", e1.status === 200, `status=${e1.status} ${JSON.stringify(dd(e1)).slice(0, 120)}`);
    const e1user = dd(await api("GET", `/api/v1/users/${ahmadId}`, undefined, admin)) as { position?: { name?: string } | null; role?: string };
    check("mirror: linked user position follows (Senior Technician)", e1user.position?.name === "Senior Technician");
    check("mirror: role untouched (TECHNICIAN)", e1user.role === "TECHNICIAN");
    // restore through the USERS route (reverse mirror direction)
    const r1 = await api("PATCH", `/api/v1/users/${ahmadId}`, { positionId: seniorHvac }, admin);
    const r1body = dd(r1) as { position?: { name?: string } | null };
    check("restore via users route → position Senior HVAC Technician", r1.status === 200 && r1body.position?.name === "Senior HVAC Technician");
    const r1emp = await db.employee.findUnique({ where: { id: ahmadEmp.id }, select: { position: true, positionId: true } });
    check("reverse mirror: employee snapshot + FK follow the account", r1emp?.positionId === seniorHvac && r1emp?.position === "Senior HVAC Technician");
  }

  // ══ Position catalog CRUD + RBAC (§9) ══
  console.log("\nPosition catalog RBAC + lifecycle");
  const pRead = await api("GET", "/api/v1/hr/positions", undefined, supervisor);
  check("SUPERVISOR can READ positions (employees.read)", pRead.status === 200);
  const pTechRead = await api("GET", "/api/v1/hr/positions", undefined, tech);
  check("TECHNICIAN cannot read positions → 403", pTechRead.status === 403, `status=${pTechRead.status}`);
  const pCreateDenied = await api("POST", "/api/v1/hr/positions", { name: "QA Rogue Position" }, supervisor);
  check("SUPERVISOR cannot CREATE positions (hr.manage) → 403", pCreateDenied.status === 403, `status=${pCreateDenied.status}`);
  const qaName = `QA Temp Position ${Date.now()}`;
  const pCreate = await api("POST", "/api/v1/hr/positions", { name: qaName, description: "QA scratch", departmentId: null }, hr);
  check("HR creates a position (hr.manage) → 201", pCreate.status === 201, `status=${pCreate.status}`);
  const qaId = (dd(pCreate) as { id?: string }).id;
  if (qaId) {
    const dup = await api("POST", "/api/v1/hr/positions", { name: qaName }, hr);
    check("duplicate position name → 409", dup.status === 409, `status=${dup.status}`);
    const renamed = await api("PATCH", `/api/v1/hr/positions/${qaId}`, { name: `${qaName} v2` }, hr);
    check("rename works (hr.manage)", renamed.status === 200 && (dd(renamed) as { name?: string }).name === `${qaName} v2`);
    const deact = await api("DELETE", `/api/v1/hr/positions/${qaId}`, undefined, hr);
    check("DELETE = soft-deactivate (status INACTIVE, never hard delete)", deact.status === 200 && (dd(deact) as { status?: string }).status === "INACTIVE");
    const assignInactive = await api("PATCH", `/api/v1/users/${fid}`, { positionId: qaId }, admin);
    check("INACTIVE position not assignable → 400", assignInactive.status === 400, `status=${assignInactive.status}`);
    const react = await api("PATCH", `/api/v1/hr/positions/${qaId}`, { status: "ACTIVE" }, hr);
    check("reactivation works", react.status === 200 && (dd(react) as { status?: string }).status === "ACTIVE");
    await api("DELETE", `/api/v1/hr/positions/${qaId}`, undefined, hr); // leave deactivated (§24)
    const stillThere = await db.jobPosition.findUnique({ where: { id: qaId }, select: { status: true } });
    check("deactivated row RETAINED in DB (history valid)", stillThere?.status === "INACTIVE");
  }
  const unknownPos = await api("PATCH", `/api/v1/users/${fid}`, { positionId: "nonexistent-id" }, admin);
  check("unknown positionId → 400", unknownPos.status === 400, `status=${unknownPos.status}`);

  // ══ CASE 10 — audit history ══
  console.log("\nCASE 10 — audit history (never overwritten)");
  const parseMeta = (raw: string): Record<string, unknown> => {
    try { return JSON.parse(raw) as Record<string, unknown>; } catch { return {}; }
  };
  const roleAudits = await db.auditLog.findMany({ where: { resourceType: "USER", resourceId: fid, action: "USER_ROLE_CHANGED" }, orderBy: { createdAt: "desc" }, take: 5 });
  const roleMeta = roleAudits.map((a) => parseMeta(a.metadata));
  check("USER_ROLE_CHANGED rows with previousRole/newRole", roleAudits.length >= 3 && roleMeta.every((m) => typeof m.previousRole === "string" && typeof m.newRole === "string"), `rows=${roleAudits.length}`);
  check("role audit carries position context (combined-change review)", roleMeta.some((m) => "positionAtChange" in m));
  const posAudits = await db.auditLog.findMany({ where: { resourceType: "USER", resourceId: fid, action: "USER_POSITION_CHANGED" }, orderBy: { createdAt: "desc" }, take: 5 });
  const posMeta = posAudits.map((a) => parseMeta(a.metadata));
  check("USER_POSITION_CHANGED rows with previousPosition/newPosition", posAudits.length >= 3 && posMeta.every((m) => "previousPosition" in m && "newPosition" in m), `rows=${posAudits.length}`);
  if (ahmadEmp) {
    const empPosAudits = await db.auditLog.findMany({ where: { resourceType: "EMPLOYEE", resourceId: ahmadEmp.id, action: "EMPLOYEE_POSITION_CHANGED" }, orderBy: { createdAt: "desc" }, take: 3 });
    check("EMPLOYEE_POSITION_CHANGED audited (employee-side change)", empPosAudits.length >= 2);
  }

  // ══ Notification (§21) ══
  console.log("\nIn-app notification on position change");
  await api("PATCH", `/api/v1/users/${fid}`, { positionId: financeDirector }, admin);
  const note = await db.notification.findFirst({ where: { userId: fid, title: "Your position has been updated" }, orderBy: { createdAt: "desc" } });
  check("in-app notification created for the target user", !!note && (note.message ?? "").includes("Finance Director"), note?.message?.slice(0, 100));

  // ── Restore scratch state ──
  await api("PATCH", `/api/v1/users/${fid}`, { role: "FINANCE", positionId: null }, admin);
  const finCheck = dd(await api("GET", `/api/v1/users/${fid}`, undefined, admin)) as { role?: string; position?: unknown };
  check("scratch restored: finance user back to FINANCE, no position", finCheck.role === "FINANCE" && finCheck.position === null);

  console.log(`\n=== RESULT: ${passed} passed, ${failed} failed ===\n`);
  await db.$disconnect();
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error("QA crashed:", e);
  process.exit(1);
});
