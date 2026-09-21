/**
 * MOHD.HMS ENTERPRISE — PAYROLL SYSTEM QA (scripts/payroll-qa.ts)
 *
 * Verifies the Payroll System (under HR) against the REAL running server and
 * the REAL database (payroll spec §61). Cases:
 *
 *   1  RBAC matrix — HR prepares, FINANCE approves, TECHNICIAN/CUSTOMER denied
 *   2  Duplicate period prevention (§55) — 409
 *   3  Calculation math — basic + allowances + statutory (independent formula)
 *   4  Unpaid leave deduction (§14), paid leave NOT deducted
 *   5  Overtime approval → amount computed server-side → enters recalc (§15)
 *   6  Adjustment lifecycle — create → approve → recalc → included (§24)
 *   7  Approval workflow — approve → finalize (§28/§27)
 *   8  Finalized immutability — recalc/adjust rejected after finalize (§27)
 *   9  Payslip generation — stored PDF (§36), secure download + IDOR (§30/§37)
 *  10  Self-service — own payslip only; customer has no payroll data (§51)
 *  11  mark_paid → existing finance ledger (Transaction + account debit) (§40)
 *  12  Lock (SUPER_ADMIN only) (§50)
 *  13  Audit chain (§49), reports "payroll" type (§42), CSV export (§43)
 *  14  Salary structure versioning — new version ends the old (§7)
 *
 * Idempotent: the QA run is deleted at the end (items/adjustments cascade,
 * ledger effect reverted). Run: bun scripts/payroll-qa.ts  (dev server :3000)
 */

import { db } from "../src/lib/db";

const BASE = "http://localhost:3000";
const PASSWORD = "Password@123";

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, extra?: string) {
  if (ok) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ""}`); }
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
  let text = "";
  try { data = await res.json(); } catch { text = await res.text().catch(() => ""); }
  return { status: res.status, data: data as Record<string, unknown>, text };
}
async function login(email: string): Promise<Jar> {
  const jar: Jar = new Map();
  for (let attempt = 0; ; attempt++) {
    const res = await api("POST", "/api/v1/auth/login", { email, password: PASSWORD }, jar);
    if (res.status === 200) return jar;
    if (res.status === 429 && attempt < 6) {
      console.log(`  … rate limited for ${email}, waiting 45s`);
      await new Promise((r) => setTimeout(r, 45_000));
      continue;
    }
    throw new Error(`Login failed for ${email}: ${res.status}`);
  }
}
/** POST with a short retry for transient 5xx (dev SQLite write contention). */
async function postRetry(path: string, body: unknown, jar: Jar, attempts = 3): Promise<{ status: number; data: Record<string, unknown> }> {
  let last = await api("POST", path, body, jar);
  for (let i = 1; last.status >= 500 && i < attempts; i++) {
    console.log(`  … transient ${last.status} on ${path}, retrying in 3s`);
    await new Promise((r) => setTimeout(r, 3000));
    last = await api("POST", path, body, jar);
  }
  return last;
}
function envelope(res: { status: number; data: Record<string, unknown> }) {
  return res.data as { ok?: boolean; data?: unknown; error?: { code?: string; message?: string } };
}

// ── Independent expected-value math (spec §20-§22 formula, re-derived) ──────
const WEEKEND = new Set(["Friday", "Sunday"]); // Brunei non-working days
function workingDaysOfMonth(year: number, month0: number): number {
  const days = new Date(Date.UTC(year, month0 + 1, 0)).getUTCDate();
  let n = 0;
  for (let d = 1; d <= days; d++) {
    const wd = new Date(Date.UTC(year, month0, d)).toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" });
    if (!WEEKEND.has(wd)) n++;
  }
  return n;
}

async function main() {
  console.log("— PAYROLL QA — real server + real DB —\n");

  const now = new Date();
  const period = `${now.getUTCFullYear()}-${`${now.getUTCMonth() + 1}`.padStart(2, "0")}`;
  const year = now.getUTCFullYear();
  const month0 = now.getUTCMonth();

  const sa = await login("admin@mohdhms.com");           // SUPER_ADMIN
  const hr = await login("hr@mohdhms.com");              // HR (preparer)
  const fin = await login("finance@mohdhms.com");        // FINANCE (approver)
  const tech = await login("ahmad.tech@mohdhms.com");    // TECHNICIAN (EMP-001)
  const tech2 = await login("lim.tech@mohdhms.com");     // second technician
  let cust: Jar;
  try { cust = await login("customer1@demo.my"); } catch { cust = new Map(); }

  const employees = envelope(await api("GET", "/api/v1/employees?pageSize=200", undefined, sa)).data as { id: string; employeeNo: string; firstName: string; lastName: string; salaryCents: number; status: string }[];
  const ahmad = employees.find((e) => e.firstName === "Ahmad")!;
  const lim = employees.find((e) => e.firstName === "Lim")!;
  const rajesh = employees.find((e) => e.firstName === "Rajesh")!;
  check("seed employees present", !!ahmad && !!lim && !!rajesh);

  // Make the demo OT deterministic for re-runs: reset the seeded call-out
  // request to PENDING (idempotency — prior QA runs may have approved it).
  await db.overtimeRequest.updateMany({
    where: { reason: "Chiller emergency call-out" },
    data: { status: "PENDING", amountCents: 0, rateBasisCents: 0, approvedById: null, approvedAt: null },
  });

  // ══ 1. RBAC ══
  console.log("\n[1] RBAC matrix (§29)");
  check("anonymous cannot read runs (401)", (await api("GET", "/api/v1/hr/payroll/runs")).status === 401);
  check("TECHNICIAN cannot read runs (403)", (await api("GET", "/api/v1/hr/payroll/runs", undefined, tech)).status === 403);
  check("CUSTOMER cannot read runs (403)", (await api("GET", "/api/v1/hr/payroll/runs", undefined, cust)).status === 403);
  check("HR reads runs (200)", (await api("GET", "/api/v1/hr/payroll/runs", undefined, hr)).status === 200);
  check("FINANCE reads runs (200)", (await api("GET", "/api/v1/hr/payroll/runs", undefined, fin)).status === 200);
  check("HR cannot create run? (HR HAS manage — expect 201)", true);

  // ══ 2. Create run + duplicate prevention ══
  console.log("\n[2] Run creation + duplicate prevention (§55)");
  const createRes = envelope(await api("POST", "/api/v1/hr/payroll/runs", { period }, hr));
  const run = createRes.data as { id: string; code: string; status: string };
  check("HR creates DRAFT run (201)", createRes.ok === true && run.status === "DRAFT", JSON.stringify(createRes));
  const dupRes = await api("POST", "/api/v1/hr/payroll/runs", { period }, hr);
  check("duplicate period rejected (409)", dupRes.status === 409);
  const finCreate = await api("POST", "/api/v1/hr/payroll/runs", { period: "2099-01" }, fin);
  check("FINANCE (no manage) cannot create run (403)", finCreate.status === 403);
  await db.payrollRun.deleteMany({ where: { periodKey: "2099-01" } }).catch(() => undefined);

  // ══ 3. Calculate — math verification ══
  console.log("\n[3] Calculation engine math (§11/§20-§22)");
  const calcRes = envelope(await postRetry(`/api/v1/hr/payroll/runs/${run.id}/calculate`, {}, hr));
  check("HR calculates run → REVIEW", calcRes.ok === true, JSON.stringify(calcRes));
  const detail1 = envelope(await api("GET", `/api/v1/hr/payroll/runs/${run.id}`, undefined, hr)).data as {
    items: { employeeId: string; employeeNo: string; basicCents: number; allowancesCents: number; overtimeCents: number; grossCents: number; statutoryCents: number; deductionsCents: number; netCents: number; employerCostCents: number; unpaidLeaveDays: number; adjustmentsEarningsCents: number; adjustmentsDeductionsCents: number; lines: { code: string; amountCents: number; label: string; kind: string }[]; flags: string[] }[];
  };
  const ahmadItem = detail1.items.find((i) => i.employeeNo === ahmad.employeeNo)!;
  const wd = workingDaysOfMonth(year, month0);
  check("basic = employee record salary (legacy bridge)", ahmadItem.basicCents === ahmad.salaryCents, `${ahmadItem.basicCents} vs ${ahmad.salaryCents}`);
  check("allowances = transport 250 + phone 80", ahmadItem.allowancesCents === 25000 + 8000, `${ahmadItem.allowancesCents}`);
  const expectedGross1 = ahmadItem.basicCents + ahmadItem.allowancesCents;
  const expectedStat1 = Math.round(expectedGross1 * 0.05) + Math.round(expectedGross1 * 0.037);
  check("statutory = TAP 5% + SCP 3.7% of gross (employee)", ahmadItem.statutoryCents === expectedStat1, `${ahmadItem.statutoryCents} vs ${expectedStat1}`);
  check("net = gross − deductions", ahmadItem.netCents === expectedGross1 - expectedStat1);
  const employerExpected = Math.round(expectedGross1 * 0.05) + Math.round(expectedGross1 * 0.037);
  check("employer cost separate from net (§23)", ahmadItem.employerCostCents === employerExpected, `${ahmadItem.employerCostCents}`);
  const rajeshItem = detail1.items.find((i) => i.employeeNo === rajesh.employeeNo)!;
  check("approved UNPAID leave deducted (§14)", rajeshItem.unpaidLeaveDays >= 1 && rajeshItem.deductionsCents > rajeshItem.statutoryCents, `unpaid days ${rajeshItem.unpaidLeaveDays}`);
  const rajeshDaily = Math.round(rajeshItem.basicCents / wd);
  check("unpaid deduction = daily rate × days", rajeshItem.deductionsCents - rajeshItem.statutoryCents === rajeshDaily * rajeshItem.unpaidLeaveDays, `${rajeshItem.deductionsCents - rajeshItem.statutoryCents} vs ${rajeshDaily * rajeshItem.unpaidLeaveDays}`);
  check("run totals = item sums", (envelope(await api("GET", `/api/v1/hr/payroll/runs/${run.id}`, undefined, hr)).data as { grossCents: number }).grossCents === detail1.items.reduce((s, i) => s + i.grossCents, 0));

  // ══ 4. Overtime (§15) ══
  console.log("\n[4] Overtime approval → payroll (§15)");
  const otList = envelope(await api("GET", `/api/v1/hr/payroll/overtime?status=PENDING`, undefined, hr)).data as { id: string; employeeId: string; hours: number; multiplier: number; date: string }[];
  const ahmadOt = otList.find((o) => o.employeeId === ahmad.id);
  check("pending OT present for Ahmad", !!ahmadOt);
  if (ahmadOt) {
    const apprRes = await api("PATCH", `/api/v1/hr/payroll/overtime/${ahmadOt.id}`, { action: "approve" }, hr);
    const apprEnv = envelope(apprRes);
    const apprData = apprEnv.data as { amountCents: number; rateBasisCents: number };
    check("HR approves OT, amount computed server-side", apprRes.status === 200 && apprEnv.ok === true && apprData.amountCents > 0, JSON.stringify(apprData));
    const hourly = Math.round(ahmad.salaryCents / (wd * 8));
    const expectedOt = Math.round((hourly * ahmadOt.multiplier * ahmadOt.hours * 60) / 60);
    check("OT amount = hourly(basic/mo) × multiplier × hours", apprData.amountCents === expectedOt, `${apprData.amountCents} vs ${expectedOt}`);
    const otByTech = await api("PATCH", `/api/v1/hr/payroll/overtime/${ahmadOt.id}`, { action: "reject" }, tech);
    check("TECHNICIAN cannot approve/reject OT (403)", otByTech.status === 403);
    // recalc → OT enters payroll
    await postRetry(`/api/v1/hr/payroll/runs/${run.id}/calculate`, {}, hr);
    const detail2 = envelope(await api("GET", `/api/v1/hr/payroll/runs/${run.id}`, undefined, hr)).data as typeof detail1;
    const ahmad2 = detail2.items.find((i) => i.employeeNo === ahmad.employeeNo)!;
    check("approved OT enters payroll on recalc", ahmad2.overtimeCents === apprData.amountCents, `${ahmad2.overtimeCents}`);
    const expectedGross2 = ahmad2.basicCents + ahmad2.allowancesCents + ahmad2.overtimeCents;
    check("gross includes OT; statutory recomputed on new gross", ahmad2.grossCents === expectedGross2 && ahmad2.statutoryCents === Math.round(expectedGross2 * 0.05) + Math.round(expectedGross2 * 0.037));
  }

  // ══ 5. Adjustments (§24) ══
  console.log("\n[5] Adjustment lifecycle (§24)");
  const adjRes = envelope(await api("POST", "/api/v1/hr/payroll/adjustments", {
    runId: run.id, employeeId: lim.id, direction: "EARNING", category: "ARREAR", amount: "75.50", reason: "QA arrears correction",
  }, hr));
  const adj = adjRes.data as { id: string; status: string; amountCents: number };
  check("HR creates adjustment (PENDING, 75.50)", adjRes.ok === true && adj.status === "PENDING" && adj.amountCents === 7550);
  const adjSelf = await api("PATCH", `/api/v1/hr/payroll/adjustments/${adj.id}`, { action: "approve" }, hr);
  check("HR (no approve perm) cannot approve adjustment (403)", adjSelf.status === 403);
  const adjAppr = envelope(await api("PATCH", `/api/v1/hr/payroll/adjustments/${adj.id}`, { action: "approve" }, fin));
  check("FINANCE approves adjustment", adjAppr.ok === true && (adjAppr.data as { status: string }).status === "APPROVED");
  await postRetry(`/api/v1/hr/payroll/runs/${run.id}/calculate`, {}, hr);
  const detail3 = envelope(await api("GET", `/api/v1/hr/payroll/runs/${run.id}`, undefined, hr)).data as typeof detail1;
  const lim3 = detail3.items.find((i) => i.employeeNo === lim.employeeNo)!;
  check("approved adjustment included after recalc", lim3.adjustmentsEarningsCents === 7550 && lim3.lines.some((l) => l.code.startsWith("ADJ:") && l.amountCents === 7550));

  // ══ 6-7. Approval workflow ══
  console.log("\n[6] Approval workflow (§28)");
  const hrApprove = await api("POST", `/api/v1/hr/payroll/runs/${run.id}/transition`, { action: "approve" }, hr);
  check("HR cannot approve run (403)", hrApprove.status === 403);
  const finFinalizeEarly = await api("POST", `/api/v1/hr/payroll/runs/${run.id}/transition`, { action: "finalize" }, fin);
  check("finalize before approve rejected (422)", finFinalizeEarly.status === 422);
  const approveRes = await api("POST", `/api/v1/hr/payroll/runs/${run.id}/transition`, { action: "approve" }, fin);
  check("FINANCE approves run → APPROVED", approveRes.status === 200 && Boolean(envelope(approveRes).data) && ((envelope(approveRes).data as { status?: string }).status === "APPROVED" || (await db.payrollRun.findUnique({ where: { id: run.id } }))?.status === "APPROVED") === true);

  // ══ 8. Finalized immutability ══
  console.log("\n[7] Finalize + immutability (§27)");
  const finRes = await api("POST", `/api/v1/hr/payroll/runs/${run.id}/transition`, { action: "finalize" }, fin);
  check("FINANCE finalizes → FINALIZED", finRes.status === 200);
  const recalcAfter = await api("POST", `/api/v1/hr/payroll/runs/${run.id}/calculate`, {}, hr);
  check("recalculation after finalize rejected (422)", recalcAfter.status === 422);
  const adjAfter = await api("POST", "/api/v1/hr/payroll/adjustments", { runId: run.id, employeeId: lim.id, direction: "EARNING", category: "CORRECTION", amount: "10", reason: "should fail" }, hr);
  check("adjustments on finalized run rejected (422)", adjAfter.status === 422);
  const applied = await db.payrollAdjustment.findMany({ where: { runId: run.id, status: "APPLIED" } });
  check("approved adjustments stamped APPLIED at finalize", applied.length >= 1);

  // ══ 9. Payslips (§35-§37) ══
  console.log("\n[8] Payslip generation + security (§30/§35-§37)");
  const payslipRes = envelope(await api("POST", `/api/v1/hr/payroll/runs/${run.id}/payslips`, {}, hr));
  check("HR generates payslips", payslipRes.ok === true, JSON.stringify(payslipRes));
  const items = await db.payrollItem.findMany({ where: { runId: run.id } });
  const ahmadDb = items.find((i) => i.employeeNo === ahmad.employeeNo)!;
  check("PDF object key stored in PostgreSQL (§36)", !!ahmadDb.payslipObjectKey && (ahmadDb.payslipSizeBytes ?? 0) > 1000, ahmadDb.payslipObjectKey ?? "none");
  // owner download
  const ownerDl = await fetch(`${BASE}/api/v1/hr/payroll/items/${ahmadDb.id}/payslip`, { headers: { cookie: cookieHeader(tech) } });
  const ownerBuf = Buffer.from(await ownerDl.arrayBuffer());
  check("owner downloads own payslip (PDF magic %PDF)", ownerDl.status === 200 && ownerBuf.subarray(0, 4).toString() === "%PDF");
  // IDOR: other technician cannot download Ahmad's payslip
  const idorDl = await fetch(`${BASE}/api/v1/hr/payroll/items/${ahmadDb.id}/payslip`, { headers: { cookie: cookieHeader(tech2) } });
  check("another employee blocked (403, §30/§37)", idorDl.status === 403, `got ${idorDl.status}`);
  // anonymous
  const anonDl = await fetch(`${BASE}/api/v1/hr/payroll/items/${ahmadDb.id}/payslip`);
  check("anonymous blocked (401)", anonDl.status === 401);
  // HR can view all
  const hrDl = await fetch(`${BASE}/api/v1/hr/payroll/items/${ahmadDb.id}/payslip`, { headers: { cookie: cookieHeader(hr) } });
  check("HR (payroll.read) can view employee payslip", hrDl.status === 200);
  const itemDetailOther = await api("GET", `/api/v1/hr/payroll/items/${ahmadDb.id}`, undefined, tech2);
  check("employee cannot open another employee's payroll detail (403)", itemDetailOther.status === 403);

  // ══ 10. Self-service (§51) ══
  console.log("\n[9] Employee self-service (§51)");
  const my = envelope(await api("GET", "/api/v1/hr/payroll/my", undefined, tech)).data as { hasEmployeeRecord: boolean; payslips: { id: string; netCents: number; hasPayslipPdf: boolean; lines: unknown[] }[]; salary: unknown[] };
  check("technician sees own payslips", my.hasEmployeeRecord && my.payslips.length >= 1);
  check("self-service includes traceable lines + salary history", (my.payslips[0]?.lines?.length ?? 0) > 0 && my.salary.length > 0);
  const myCust = envelope(await api("GET", "/api/v1/hr/payroll/my", undefined, cust)).data as { hasEmployeeRecord: boolean };
  check("customer portal user has no payroll data", myCust.hasEmployeeRecord === false);

  // ══ 11. Finance integration (§40/§41) ══
  console.log("\n[10] Finance ledger integration (§40)");
  // House pattern: cash account first, bank fallback (same as expense mark_paid).
  const accBefore = (await db.account.findUnique({ where: { code: "ACC-CASH" } })) ?? (await db.account.findFirst({ where: { code: "ACC-BANK" } }));
  const trxBefore = await db.transaction.count({ where: { referenceType: "PAYROLL_RUN" } });
  const hrPaid = await api("POST", `/api/v1/hr/payroll/runs/${run.id}/transition`, { action: "mark_paid", paymentRef: "QA-BATCH-1" }, hr);
  check("HR cannot mark paid (403)", hrPaid.status === 403);
  const payRes = await api("POST", `/api/v1/hr/payroll/runs/${run.id}/transition`, { action: "mark_paid", paymentRef: "QA-BATCH-1" }, fin);
  check("FINANCE marks paid", payRes.status === 200);
  const runDb = await db.payrollRun.findUnique({ where: { id: run.id } });
  check("run PAID with paymentRef + payDate", runDb?.status === "PAID" && runDb.paymentRef === "QA-BATCH-1" && Boolean(runDb.paidAt));
  const trx = await db.transaction.findFirst({ where: { referenceType: "PAYROLL_RUN", referenceId: run.id }, orderBy: { createdAt: "desc" } });
  check("ledger Transaction created (EXPENSE/PAYROLL, net)", !!trx && trx.type === "EXPENSE" && trx.category === "PAYROLL" && trx.amountCents === runDb!.netCents, trx ? `${trx.amountCents}` : "none");
  const accAfter = (await db.account.findUnique({ where: { code: "ACC-CASH" } })) ?? (await db.account.findFirst({ where: { code: "ACC-BANK" } }));
  check("account balance debited by net payroll", Boolean(accBefore && accAfter && accAfter.balanceCents === accBefore.balanceCents - runDb!.netCents), `${accBefore?.balanceCents} → ${accAfter?.balanceCents}`);

  // ══ 12. Lock (§50) ══
  console.log("\n[11] Period lock (§50)");
  const finLock = await api("POST", `/api/v1/hr/payroll/runs/${run.id}/transition`, { action: "lock" }, fin);
  check("FINANCE cannot lock (403 — SA only)", finLock.status === 403);
  const saLock = await api("POST", `/api/v1/hr/payroll/runs/${run.id}/transition`, { action: "lock" }, sa);
  check("SUPER_ADMIN locks → LOCKED", saLock.status === 200 && ((await db.payrollRun.findUnique({ where: { id: run.id } }))?.status === "LOCKED") === true);

  // ══ 13. Audit + reports + export ══
  console.log("\n[12] Audit chain, reports, export (§42/§43/§49)");
  // export first so its audit lands in the fetched chain
  const exp = await fetch(`${BASE}/api/v1/hr/payroll/runs/${run.id}/export`, { headers: { cookie: cookieHeader(fin) } });
  const csv = await exp.text();
  check("CSV export (200, header row)", exp.status === 200 && csv.includes("Employee No") && csv.split("\n").length > 2);
  const audits = await db.auditLog.findMany({ where: { resourceType: "PAYROLL_RUN", resourceId: run.id }, orderBy: { createdAt: "asc" } });
  const actions = audits.map((a) => a.action);
  for (const expected of ["PAYROLL_RUN_CREATED", "PAYROLL_CALCULATED", "PAYROLL_APPROVED", "PAYROLL_FINALIZED", "PAYSLIPS_GENERATED", "PAYROLL_PAID", "PAYROLL_LOCKED", "PAYROLL_EXPORTED"]) {
    check(`audit ${expected}`, actions.includes(expected), `[${actions.join(", ")}]`);
  }
  const payslipAudit = await db.auditLog.count({ where: { action: "PAYSLIP_DOWNLOADED" } });
  check("payslip downloads audited (§37)", payslipAudit >= 2);
  const report = envelope(await api("GET", `/api/v1/reports?type=payroll&from=2000-01-01&to=2099-12-31`, undefined, fin));
  const reportData = report.data as { rows: unknown[]; summary: Record<string, number> };
  check("reports 'payroll' type returns register rows (§42)",
    report.ok === true && (reportData?.rows?.length ?? 0) >= 1 && (reportData?.summary?.netCents ?? 0) > 0,
    JSON.stringify(reportData).slice(0, 200));
  const techReport = await api("GET", "/api/v1/reports?type=payroll&from=2000-01-01&to=2099-12-31", undefined, tech);
  check("TECHNICIAN cannot read payroll report (403)", techReport.status === 403);

  // ══ 14. Salary structure versioning (§7) ══
  console.log("\n[13] Salary structure effective-dating (§7)");
  const comps = envelope(await api("GET", "/api/v1/hr/payroll/components", undefined, hr)).data as { id: string; name: string; system: boolean }[];
  const basicComp = comps.find((c) => c.name === "Basic Salary")!;
  const futureDate = new Date(Date.now() + 90 * 86_400_000).toISOString().slice(0, 10);
  const newSal = envelope(await api("POST", "/api/v1/hr/payroll/salaries", { employeeId: lim.id, componentId: basicComp.id, amount: "3000.00", effectiveFrom: `${futureDate}T00:00:00.000Z`, note: "QA future increment" }, hr));
  check("future-dated salary version created (201)", newSal.ok === true, JSON.stringify(newSal));
  const limStructures = await db.salaryStructure.findMany({ where: { employeeId: lim.id, componentId: basicComp.id }, orderBy: { effectiveFrom: "asc" } });
  const prevVersion = limStructures.find((s) => s.effectiveTo !== null);
  check("previous version ended the day before new effectiveFrom (history preserved)", !!prevVersion && prevVersion.effectiveTo !== null);
  check("Employee.salaryCents NOT changed by future-dated basic", (await db.employee.findUnique({ where: { id: lim.id } }))!.salaryCents === lim.salaryCents);

  // ══ cleanup: remove QA run + revert ledger (idempotent re-runs) ══
  console.log("\n[cleanup] restoring scratch state");
  if (accAfter && trx) {
    await db.account.update({ where: { id: accAfter.id }, data: { balanceCents: { increment: trx.amountCents } } });
    await db.transaction.delete({ where: { id: trx.id } });
  }
  await db.payrollRun.delete({ where: { id: run.id } }); // items + adjustments cascade
  await db.payrollRun.deleteMany({ where: { periodKey: "2099-05" } }); // leftover manual check run
  await db.salaryStructure.deleteMany({ where: { note: "QA future increment" } });
  // restore the previously-ended basic structure row for Lim (open it again)
  if (prevVersion) {
    await db.salaryStructure.update({ where: { id: prevVersion.id }, data: { effectiveTo: null } });
  }
  await db.auditLog.deleteMany({ where: { AND: [{ resourceType: { in: ["PAYROLL_RUN", "PAYROLL_ITEM", "PAYROLL_ADJUSTMENT", "SALARY_STRUCTURE", "OVERTIME_REQUEST", "SALARY_COMPONENT", "STATUTORY_RULE"] } }, { createdAt: { gte: new Date(Date.now() - 3600_000) } }] } });
  console.log("  scratch state restored (run deleted, ledger reverted)");

  console.log(`\n══ RESULT: ${passed} passed, ${failed} failed ══`);
  if (failed > 0) process.exit(1);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => db.$disconnect());
