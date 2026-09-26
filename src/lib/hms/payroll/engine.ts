import "server-only";

// MOHD.HMS ENTERPRISE — Centralized server-side payroll calculation engine
// (spec §11). ALL payroll math happens here, on the server, in integer cents
// (exact arithmetic — no floating-point money, §47). The frontend only ever
// displays stored results.

import { db } from "@/lib/db";
import { Errors } from "@/lib/hms/api";
import type { Prisma } from "@prisma/client";
import { PAYROLL_CONFIG, engineConfigSnapshot, periodKeyOf, type PayrollLine } from "./config";

// ── date helpers (all UTC-day based; periods are calendar dates) ────────────

const DAY_MS = 86_400_000;

function dayStart(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}
/** Inclusive day count between two dates (a..b). */
function daysInclusive(a: Date, b: Date): number {
  const start = dayStart(a).getTime();
  const end = dayStart(b).getTime();
  return Math.floor((end - start) / DAY_MS) + 1;
}
/** Overlap in inclusive days between two windows (0 when disjoint). */
function overlapDays(aStart: Date, aEnd: Date, bStart: Date, bEnd: Date): number {
  const s = dayStart(aStart) > dayStart(bStart) ? dayStart(aStart) : dayStart(bStart);
  const e = dayStart(aEnd) < dayStart(bEnd) ? dayStart(aEnd) : dayStart(bEnd);
  if (e < s) return 0;
  return daysInclusive(s, e);
}
/** Working days (non-weekend) inside a window. */
function workingDaysBetween(a: Date, b: Date): number {
  let count = 0;
  const cursor = dayStart(a);
  const end = dayStart(b);
  while (cursor <= end) {
    const weekday = cursor.toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" });
    if (!PAYROLL_CONFIG.weekendDays.includes(weekday)) count += 1;
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return count;
}
function addDays(d: Date, n: number): Date {
  const c = dayStart(d);
  c.setUTCDate(c.getUTCDate() + n);
  return c;
}

// ── statutory rule scope (spec §19) ─────────────────────────────────────────

function statutoryCategoryFor(country: string): "CITIZEN_PR" | "FOREIGN" {
  return country.toLowerCase().includes("brunei") ? "CITIZEN_PR" : "FOREIGN";
}

// ── per-employee calculation ────────────────────────────────────────────────

type EmployeeRow = {
  id: string;
  employeeNo: string;
  firstName: string;
  lastName: string;
  position: string;
  country: string;
  salaryCents: number;
  joinDate: Date | null;
  department: { name: string } | null;
};

type StructureRow = {
  id: string;
  amountCents: number;
  percentBps: number | null;
  effectiveFrom: Date;
  effectiveTo: Date | null;
  component: { id: string; name: string; category: string; type: string };
};

type OvertimeRow = { id: string; minutes: number; multiplier: number; amountCents: number; date: Date };

type LeaveRow = { id: string; type: string; startDate: Date; endDate: Date };

type AdjustmentRow = {
  id: string;
  direction: string;
  category: string;
  amountCents: number;
  reason: string;
};

type StatutoryRow = {
  id: string;
  name: string;
  payer: string;
  employeeCategory: string;
  calcType: string;
  rateBps: number;
  amountCents: number;
  appliesTo: string;
  thresholdCents: number;
  calcOrder: number;
};

export type CalculatedItem = {
  employeeId: string;
  employeeNo: string;
  employeeName: string;
  departmentName: string;
  positionName: string;
  status: "CALCULATED";
  excludedReason: string;
  workingDays: number;
  workedDays: number;
  paidLeaveDays: number;
  unpaidLeaveDays: number;
  absentDays: number;
  otMinutes: number;
  basicCents: number;
  allowancesCents: number;
  overtimeCents: number;
  bonusCents: number;
  adjustmentsEarningsCents: number;
  grossCents: number;
  statutoryCents: number;
  otherDeductionsCents: number;
  adjustmentsDeductionsCents: number;
  deductionsCents: number;
  netCents: number;
  employerCostCents: number;
  lines: PayrollLine[];
  exceptionFlags: string[];
};

export function calculateEmployeeItem(input: {
  employee: EmployeeRow;
  periodStart: Date;
  periodEnd: Date;
  periodDays: number;
  workingDays: number;
  structures: StructureRow[];
  overtime: OvertimeRow[];
  leaves: LeaveRow[];
  adjustments: AdjustmentRow[];
  statutory: StatutoryRow[];
  attendance: { worked: number; absent: number };
}): CalculatedItem {
  const { employee, periodStart, periodEnd, periodDays, workingDays } = input;
  const lines: PayrollLine[] = [];
  const flags: string[] = [];

  // Employment window (§25 — proration for joiners; terminations are excluded
  // from runs by eligibility, following the existing HR policy).
  const joinStart = employee.joinDate ? dayStart(employee.joinDate) : null;
  const empStart = joinStart && joinStart > dayStart(periodStart) ? joinStart : dayStart(periodStart);
  const employmentDays = daysInclusive(empStart, periodEnd);

  // ── BASIC salary (§7/§12): effective-dated structures, day-weighted blend
  //    when a salary change happens mid-period; joiners are prorated.
  const basicStructures = input.structures
    .filter((s) => s.component.category === "BASIC")
    .sort((a, b) => a.effectiveFrom.getTime() - b.effectiveFrom.getTime());

  let basicCents = 0;
  if (basicStructures.length === 0) {
    // Legacy bridge: employees managed before the salary-structure system keep
    // their canonical Employee.salaryCents (spec §5 — reuse existing records).
    basicCents = Math.round((employee.salaryCents * employmentDays) / periodDays);
    lines.push({
      code: "BASIC",
      label: "Basic Salary",
      kind: "EARNING",
      category: "BASIC",
      amountCents: basicCents,
      basis: "Employee record",
      detail:
        employmentDays < periodDays
          ? `Prorated ${employmentDays}/${periodDays} days (BND ${(employee.salaryCents / 100).toFixed(2)} monthly)`
          : "From employee record",
    });
  } else {
    for (const s of basicStructures) {
      const sEnd = s.effectiveTo ?? periodEnd;
      const active = overlapDays(empStart, periodEnd, s.effectiveFrom, sEnd);
      if (active <= 0) continue;
      const contribution = Math.round((s.amountCents * active) / periodDays);
      basicCents += contribution;
      lines.push({
        code: "BASIC",
        label: "Basic Salary",
        kind: "EARNING",
        category: "BASIC",
        amountCents: contribution,
        basis: `Effective ${s.effectiveFrom.toISOString().slice(0, 10)}`,
        detail:
          active < periodDays
            ? `Day-weighted: ${active}/${periodDays} days × BND ${(s.amountCents / 100).toFixed(2)}`
            : "Monthly rate",
      });
    }
  }

  // ── Recurring earning structures (allowances, bonuses…) + recurring
  //    deduction structures (loan repayments…) — §16/§17, overlap-prorated.
  let allowancesCents = 0;
  let otherDeductionsCents = 0;
  let absenceDeductionCents = 0;
  const recurringDeductions: StructureRow[] = [];
  for (const s of input.structures) {
    if (s.component.category === "BASIC") continue;
    const sEnd = s.effectiveTo ?? periodEnd;
    const active = overlapDays(empStart, periodEnd, s.effectiveFrom, sEnd);
    if (active <= 0) continue;
    if (s.component.type === "DEDUCTION") {
      recurringDeductions.push(s);
      continue; // deductions are priced below (absence needs the daily rate first)
    }
    let amount = 0;
    let detail: string;
    if (s.percentBps != null && s.percentBps > 0) {
      amount = Math.round((basicCents * s.percentBps) / 10000);
      detail = `${(s.percentBps / 100).toFixed(2)}% of basic`;
    } else {
      amount = Math.round((s.amountCents * active) / periodDays);
      detail = active < periodDays ? `Prorated ${active}/${periodDays} days` : "Fixed monthly";
    }
    allowancesCents += amount;
    lines.push({
      code: `CMP:${s.component.id}`,
      label: s.component.name,
      kind: "EARNING",
      category: s.component.category,
      amountCents: amount,
      detail,
    });
  }

  // ── Attendance (§13 — read-only integration; attendance is never re-keyed)
  const workedDays = input.attendance.worked;
  const absentDays = input.attendance.absent;

  // ── Leave (§14 — APPROVED only; unpaid leave is deducted, paid leave is not)
  let paidLeaveDays = 0;
  let unpaidLeaveDays = 0;
  for (const lv of input.leaves) {
    const d = overlapDays(empStart, periodEnd, lv.startDate, lv.endDate);
    if (d <= 0) continue;
    if (lv.type === "UNPAID") unpaidLeaveDays += d;
    else paidLeaveDays += d;
  }
  unpaidLeaveDays = Math.min(unpaidLeaveDays, workingDays);

  // Daily rate basis for unpaid-leave / absence deductions (traceable).
  const perDayRate = workingDays > 0 ? Math.round(basicCents / workingDays) : 0;

  // ── Overtime (§15 — approved amounts snapshotted at approval time)
  let overtimeCents = 0;
  let otMinutes = 0;
  for (const ot of input.overtime) {
    overtimeCents += ot.amountCents;
    otMinutes += ot.minutes;
  }
  if (input.overtime.length > 0) {
    lines.push({
      code: "OVERTIME",
      label: "Overtime",
      kind: "EARNING",
      category: "OVERTIME",
      amountCents: overtimeCents,
      detail: `${input.overtime.length} approved request(s), ${(otMinutes / 60).toFixed(2)} h`,
    });
  }

  // ── Approved adjustments (§24)
  let adjustmentsEarningsCents = 0;
  let adjustmentsDeductionsCents = 0;
  for (const adj of input.adjustments) {
    if (adj.direction === "EARNING") {
      adjustmentsEarningsCents += adj.amountCents;
      lines.push({
        code: `ADJ:${adj.id}`,
        label: "Adjustment",
        kind: "EARNING",
        category: adj.category,
        amountCents: adj.amountCents,
        detail: adj.reason,
      });
    } else {
      adjustmentsDeductionsCents += adj.amountCents;
      lines.push({
        code: `ADJ:${adj.id}`,
        label: "Adjustment (deduction)",
        kind: "DEDUCTION",
        category: adj.category,
        amountCents: adj.amountCents,
        detail: adj.reason,
      });
    }
  }

  // ── Recurring + engineered deductions (now that the daily rate exists)
  for (const s of recurringDeductions) {
    let amount = 0;
    let detail: string;
    if (s.component.category === "ABSENCE") {
      // Engine-computed: only when configured AND only for recorded absences —
      // never a silent deduction (§17).
      amount = perDayRate * absentDays;
      absenceDeductionCents += amount;
      detail = `${absentDays} recorded absence day(s) × BND ${(perDayRate / 100).toFixed(2)}/day`;
    } else if (s.percentBps != null && s.percentBps > 0) {
      amount = Math.round((basicCents * s.percentBps) / 10000);
      detail = `${(s.percentBps / 100).toFixed(2)}% of basic`;
    } else {
      const sEnd = s.effectiveTo ?? periodEnd;
      const active = overlapDays(empStart, periodEnd, s.effectiveFrom, sEnd);
      amount = Math.round((s.amountCents * active) / periodDays);
      detail = active < periodDays ? `Prorated ${active}/${periodDays} days` : "Fixed monthly";
    }
    otherDeductionsCents += amount;
    lines.push({
      code: `CMP:${s.component.id}`,
      label: s.component.name,
      kind: "DEDUCTION",
      category: s.component.category,
      amountCents: amount,
      detail,
    });
  }

  if (unpaidLeaveDays > 0) {
    const amount = perDayRate * unpaidLeaveDays;
    otherDeductionsCents += amount;
    lines.push({
      code: "UNPAID_LEAVE",
      label: "Unpaid Leave",
      kind: "DEDUCTION",
      category: "UNPAID_LEAVE",
      amountCents: amount,
      detail: `${unpaidLeaveDays} approved unpaid day(s) × BND ${(perDayRate / 100).toFixed(2)}/day`,
    });
  }

  // ── Gross pay (§20) — sum of all approved earning lines
  const grossCents =
    basicCents + allowancesCents + overtimeCents + adjustmentsEarningsCents;

  // ── Statutory rules (§18/§19) — configurable, versioned; EMPLOYEE rows are
  //    deducted, EMPLOYER rows are cost-only and never touch net pay.
  let statutoryCents = 0;
  let employerCostCents = 0;
  const empCategory = statutoryCategoryFor(employee.country);
  for (const rule of [...input.statutory].sort((a, b) => a.calcOrder - b.calcOrder)) {
    if (rule.employeeCategory !== "ALL" && rule.employeeCategory !== empCategory) continue;
    const base = rule.appliesTo === "BASIC" ? basicCents : grossCents;
    if (base < rule.thresholdCents) {
      lines.push({
        code: `STA:${rule.id}`,
        label: rule.name,
        kind: "INFO",
        category: "STATUTORY",
        amountCents: 0,
        basis: `${(base / 100).toFixed(2)} below threshold`,
        detail: "Not applicable — base below threshold",
      });
      continue;
    }
    const amount =
      rule.calcType === "PERCENTAGE" ? Math.round((base * rule.rateBps) / 10000) : rule.amountCents;
    const basisLabel = `${rule.calcType === "PERCENTAGE" ? `${(rule.rateBps / 100).toFixed(2)}%` : "Fixed"} of ${rule.appliesTo.toLowerCase()}`;
    if (rule.payer === "EMPLOYER") {
      employerCostCents += amount;
      lines.push({
        code: `STA:${rule.id}`,
        label: rule.name,
        kind: "EMPLOYER",
        category: "STATUTORY",
        amountCents: amount,
        basis: basisLabel,
        detail: "Employer contribution — not deducted from salary (§19)",
      });
    } else {
      statutoryCents += amount;
      lines.push({
        code: `STA:${rule.id}`,
        label: rule.name,
        kind: "DEDUCTION",
        category: "STATUTORY",
        amountCents: amount,
        basis: basisLabel,
      });
    }
  }

  // ── Totals (§21/§22) — net = gross − employee deductions; employer cost is
  //    reported separately and NEVER mixed into net pay (§23).
  const deductionsCents = statutoryCents + otherDeductionsCents + adjustmentsDeductionsCents;
  const netCents = grossCents - deductionsCents;

  lines.push(
    { code: "GROSS", label: "Gross Pay", kind: "INFO", category: "TOTAL", amountCents: grossCents, detail: "Sum of earnings" },
    { code: "TOTAL_DEDUCTIONS", label: "Total Deductions", kind: "INFO", category: "TOTAL", amountCents: deductionsCents, detail: "Statutory + other + adjustments" },
    { code: "NET", label: "Net Pay", kind: "INFO", category: "TOTAL", amountCents: netCents, detail: "Gross − employee deductions" },
  );
  if (employerCostCents > 0) {
    lines.push({
      code: "EMPLOYER_COST",
      label: "Employer Cost",
      kind: "INFO",
      category: "TOTAL",
      amountCents: employerCostCents,
      detail: "Employer contributions (separate from net pay, §23)",
    });
  }

  // ── Variance + exception review (§44/§45) — flags are filled by the caller
  //    (needs the previous run); salary-missing flags here.
  const hasBasic = basicCents > 0;
  if (!hasBasic) flags.push("MISSING_SALARY");
  if (netCents < 0) flags.push("NEGATIVE_NET");
  if (grossCents > 0) {
    if ((deductionsCents / grossCents) * 10000 > PAYROLL_CONFIG.variance.deductionRatioBps) flags.push("DEDUCTION_HEAVY");
    if ((overtimeCents / grossCents) * 10000 > PAYROLL_CONFIG.variance.overtimeRatioBps) flags.push("LARGE_OT");
  }

  return {
    employeeId: employee.id,
    employeeNo: employee.employeeNo,
    employeeName: `${employee.firstName} ${employee.lastName}`.trim(),
    departmentName: employee.department?.name ?? "",
    positionName: employee.position, // POSITION snapshot — never the RBAC role (§33/§4)
    status: "CALCULATED",
    excludedReason: "",
    workingDays,
    workedDays,
    paidLeaveDays,
    unpaidLeaveDays,
    absentDays,
    otMinutes,
    basicCents,
    allowancesCents,
    overtimeCents,
    bonusCents: 0,
    adjustmentsEarningsCents,
    grossCents,
    statutoryCents,
    otherDeductionsCents,
    adjustmentsDeductionsCents,
    deductionsCents,
    netCents,
    employerCostCents,
    lines,
    exceptionFlags: flags,
  };
}

// ── run-level calculation (transactional, idempotent — §55) ─────────────────

export type CalculateResult = {
  runId: string;
  status: string;
  employeeCount: number;
  grossCents: number;
  deductionsCents: number;
  employerCostCents: number;
  netCents: number;
  exceptionCount: number;
};

/**
 * Calculate (or recalculate) a payroll run. Allowed while DRAFT / FAILED /
 * REVIEW — never after APPROVED (§27 finalized immutability). Everything runs
 * inside one transaction: any failure rolls the whole run back to its previous
 * state, then the run is marked FAILED with a safe reason (§63).
 */
export async function calculateRun(runId: string, actorId: string): Promise<CalculateResult> {
  const run = await db.payrollRun.findUnique({ where: { id: runId } });
  if (!run) throw Errors.notFound("Payroll run not found.");
  if (!["DRAFT", "FAILED", "REVIEW"].includes(run.status)) {
    throw Errors.invalidTransition(
      `Run is ${run.status} — finalized payroll can only be corrected via adjustments (§27).`,
    );
  }

  const periodStart = dayStart(run.periodStart);
  const periodEnd = dayStart(run.periodEnd);
  const periodDays = daysInclusive(periodStart, periodEnd);
  const workingDays = workingDaysBetween(periodStart, periodEnd);

  try {
    const result = await db.$transaction(async (tx) => {
      await tx.payrollRun.update({ where: { id: runId }, data: { status: "CALCULATING", errorNote: "" } });

      // Eligible employees (§26): not terminated, joined by period end.
      const employees = (await tx.employee.findMany({
        where: {
          status: { not: "TERMINATED" },
          OR: [{ joinDate: null }, { joinDate: { lte: periodEnd } }],
        },
        include: { department: { select: { name: true } } },
        orderBy: { employeeNo: "asc" },
      })) as unknown as EmployeeRow[];

      const employeeIds = employees.map((e) => e.id);

      // All inputs are gathered from the canonical HR data (§13/§14/§15).
      const [structures, overtime, leaves, adjustments, statutory, attendanceRecords, prevRun] =
        await Promise.all([
          tx.salaryStructure.findMany({
            where: {
              employeeId: { in: employeeIds.length ? employeeIds : ["__none__"] },
              effectiveFrom: { lte: periodEnd },
              OR: [{ effectiveTo: null }, { effectiveTo: { gte: periodStart } }],
            },
            include: { component: { select: { id: true, name: true, category: true, type: true } } },
          }),
          tx.overtimeRequest.findMany({
            where: { employeeId: { in: employeeIds.length ? employeeIds : ["__none__"] }, status: "APPROVED", date: { gte: periodStart, lte: periodEnd } },
          }),
          tx.leaveRequest.findMany({
            where: { employeeId: { in: employeeIds.length ? employeeIds : ["__none__"] }, status: "APPROVED", endDate: { gte: periodStart }, startDate: { lte: periodEnd } },
          }),
          tx.payrollAdjustment.findMany({
            where: { runId, status: "APPROVED" },
          }),
          tx.statutoryRule.findMany({
            where: {
              active: true,
              effectiveFrom: { lte: periodEnd },
              OR: [{ effectiveTo: null }, { effectiveTo: { gte: periodStart } }],
            },
          }),
          tx.attendance.findMany({
            where: { employeeId: { in: employeeIds.length ? employeeIds : ["__none__"] }, date: { gte: periodStart, lte: periodEnd } },
            select: { employeeId: true, status: true },
          }),
          tx.payrollRun.findFirst({
            where: { periodEnd: { lt: periodStart }, status: { in: ["FINALIZED", "PAID", "LOCKED", "APPROVED", "REVIEW"] } },
            orderBy: { periodEnd: "desc" },
            select: { id: true, periodEnd: true },
          }),
        ]);

      // Attendance aggregation per employee (PRESENT/HALF_DAY/LEAVE → worked;
      // ABSENT → recorded absence; LEAVE status days are paid leave info).
      const attByEmp = new Map<string, { worked: number; absent: number }>();
      for (const r of attendanceRecords) {
        const bucket = attByEmp.get(r.employeeId) ?? { worked: 0, absent: 0 };
        if (r.status === "PRESENT") bucket.worked += 1;
        else if (r.status === "HALF_DAY") bucket.worked += 0.5;
        else if (r.status === "ABSENT") bucket.absent += 1;
        attByEmp.set(r.employeeId, bucket);
      }

      const structuresByEmp = new Map<string, StructureRow[]>();
      for (const s of structures) {
        const list = structuresByEmp.get(s.employeeId) ?? [];
        list.push(s as unknown as StructureRow);
        structuresByEmp.set(s.employeeId, list);
      }
      const otByEmp = new Map<string, OvertimeRow[]>();
      for (const o of overtime) {
        const list = otByEmp.get(o.employeeId) ?? [];
        list.push(o as unknown as OvertimeRow);
        otByEmp.set(o.employeeId, list);
      }
      const leaveByEmp = new Map<string, LeaveRow[]>();
      for (const l of leaves) {
        const list = leaveByEmp.get(l.employeeId) ?? [];
        list.push(l as unknown as LeaveRow);
        leaveByEmp.set(l.employeeId, list);
      }
      const adjByEmp = new Map<string, AdjustmentRow[]>();
      for (const a of adjustments) {
        const list = adjByEmp.get(a.employeeId) ?? [];
        list.push(a as unknown as AdjustmentRow);
        adjByEmp.set(a.employeeId, list);
      }

      // Previous-run nets for variance review (§44).
      const prevNets = new Map<string, number>();
      if (prevRun) {
        const prevItems = await tx.payrollItem.findMany({
          where: { runId: prevRun.id, status: "CALCULATED" },
          select: { employeeId: true, netCents: true },
        });
        for (const pi of prevItems) prevNets.set(pi.employeeId, pi.netCents);
      }

      let grossTotal = 0;
      let deductionsTotal = 0;
      let employerTotal = 0;
      let netTotal = 0;
      let exceptionCount = 0;
      let calculated = 0;
      const today = new Date();

      // Batch plan: existing rows are updated, missing rows are created with a
      // single createMany — fewer round-trips and a shorter write window inside
      // the run transaction (SQLite single-writer friendly, §F-13).
      const existingItems = await tx.payrollItem.findMany({ where: { runId }, select: { id: true, employeeId: true } });
      const existingItemIdByEmployee = new Map(existingItems.map((i) => [i.employeeId, i.id] as const));
      const rowsToCreate: Prisma.PayrollItemCreateManyInput[] = [];
      const rowsToUpdate: { id: string; data: Prisma.PayrollItemUpdateInput }[] = [];

      for (const employee of employees) {
        const item = calculateEmployeeItem({
          employee,
          periodStart,
          periodEnd,
          periodDays,
          workingDays,
          structures: structuresByEmp.get(employee.id) ?? [],
          overtime: otByEmp.get(employee.id) ?? [],
          leaves: leaveByEmp.get(employee.id) ?? [],
          adjustments: adjByEmp.get(employee.id) ?? [],
          statutory: statutory as unknown as StatutoryRow[],
          attendance: attByEmp.get(employee.id) ?? { worked: 0, absent: 0 },
        });

        // Variance vs the previous run (§44 — flag, never auto-reject).
        const prevNet = prevNets.get(employee.id);
        if (prevNet !== undefined) {
          item.exceptionFlags.push(...varianceFlags(item.netCents, prevNet));
        } else if (prevRun) {
          item.exceptionFlags.push("NEW_EMPLOYEE");
        }
        if (item.exceptionFlags.length > 0) exceptionCount += 1;

        grossTotal += item.grossCents;
        deductionsTotal += item.deductionsCents;
        employerTotal += item.employerCostCents;
        netTotal += item.netCents;
        calculated += 1;

        const data = {
          employeeNo: item.employeeNo,
          employeeName: item.employeeName,
          departmentName: item.departmentName,
          positionName: item.positionName,
          status: item.status,
          excludedReason: item.excludedReason,
          workingDays: Math.round(item.workingDays),
          workedDays: Math.round(item.workedDays),
          paidLeaveDays: item.paidLeaveDays,
          unpaidLeaveDays: item.unpaidLeaveDays,
          absentDays: item.absentDays,
          otMinutes: item.otMinutes,
          basicCents: item.basicCents,
          allowancesCents: item.allowancesCents,
          overtimeCents: item.overtimeCents,
          bonusCents: item.bonusCents,
          adjustmentsEarningsCents: item.adjustmentsEarningsCents,
          grossCents: item.grossCents,
          statutoryCents: item.statutoryCents,
          otherDeductionsCents: item.otherDeductionsCents,
          adjustmentsDeductionsCents: item.adjustmentsDeductionsCents,
          deductionsCents: item.deductionsCents,
          netCents: item.netCents,
          employerCostCents: item.employerCostCents,
          linesJson: JSON.stringify(item.lines),
          exceptionFlags: JSON.stringify(item.exceptionFlags),
          varianceBps: prevNet !== undefined && prevNet !== 0 ? Math.round(((item.netCents - prevNet) / prevNet) * 10000) : null,
          updatedAt: today,
        };

        const existingId = existingItemIdByEmployee.get(employee.id);
        if (existingId) {
          rowsToUpdate.push({ id: existingId, data });
        } else {
          rowsToCreate.push({ runId, employeeId: employee.id, ...data });
        }
      }

      if (rowsToCreate.length > 0) {
        await tx.payrollItem.createMany({ data: rowsToCreate });
      }
      for (const u of rowsToUpdate) {
        await tx.payrollItem.update({
          where: { id: u.id },
          data: { ...u.data, payslipObjectKey: null, payslipSizeBytes: null, payslipGeneratedAt: null },
        });
      }

      // Employees no longer eligible lose their (never-finalized) draft items.
      if (employeeIds.length > 0) {
        await tx.payrollItem.deleteMany({ where: { runId, employeeId: { notIn: employeeIds } } });
      } else {
        await tx.payrollItem.deleteMany({ where: { runId } });
      }

      const updated = await tx.payrollRun.update({
        where: { id: runId },
        data: {
          status: "REVIEW",
          employeeCount: calculated,
          grossCents: grossTotal,
          deductionsCents: deductionsTotal,
          employerCostCents: employerTotal,
          netCents: netTotal,
          exceptionCount,
          configJson: JSON.stringify(engineConfigSnapshot()),
        },
      });

      return {
        runId: updated.id,
        status: updated.status,
        employeeCount: calculated,
        grossCents: grossTotal,
        deductionsCents: deductionsTotal,
        employerCostCents: employerTotal,
        netCents: netTotal,
        exceptionCount,
      };
    });

    return result;
  } catch (err) {
    // §63 — no fake totals, no partially finalized payroll: mark FAILED with a
    // safe reason and let the previous state remain untouched.
    const reason = err instanceof Error ? err.message.slice(0, 300) : "Unknown calculation error";
    await db.payrollRun
      .update({ where: { id: runId }, data: { status: "FAILED", errorNote: reason } })
      .catch(() => undefined);
    throw Errors.internal(`PAYROLL CALCULATION FAILED — ${reason}`);
  }
}

/** §44 variance flags (percent change in basis points). */
function varianceFlags(net: number, prevNet: number): string[] {
  const flags: string[] = [];
  if (prevNet === 0) {
    if (net !== 0) flags.push("NET_CHANGE_GT_30");
    return flags;
  }
  const bps = Math.abs(((net - prevNet) / prevNet) * 10000);
  if (bps > PAYROLL_CONFIG.variance.netChangeBps) flags.push("NET_CHANGE_GT_30");
  return flags;
}

/** Overtime amount for one request, computed from the employee's monthly basic.
 *  The multiplier is converted to integer basis points and every intermediate
 *  step stays integer cents — a float multiplier can never drift the amount. */
export function computeOvertimeAmount(monthlyBasicCents: number, monthRef: Date, minutes: number, multiplier: number): { amountCents: number; rateBasisCents: number } {
  const monthStart = dayStart(monthRef);
  monthStart.setUTCDate(1);
  const monthEnd = addDays(monthStart, daysInMonth(monthStart) - 1);
  const monthWorkingDays = Math.max(workingDaysBetween(monthStart, monthEnd), 1);
  const hourly = Math.round(monthlyBasicCents / (monthWorkingDays * PAYROLL_CONFIG.standardHoursPerDay));
  const multBps = Math.round(multiplier * 10000);
  const amount = Math.round((hourly * multBps * minutes) / (10000 * 60));
  return { amountCents: amount, rateBasisCents: hourly };
}

function daysInMonth(monthStart: Date): number {
  return new Date(Date.UTC(monthStart.getUTCFullYear(), monthStart.getUTCMonth() + 1, 0)).getUTCDate();
}

/** Period display label, e.g. "September 2026". */
export function periodLabel(periodStart: Date): string {
  return periodStart.toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });
}

export { periodKeyOf };
