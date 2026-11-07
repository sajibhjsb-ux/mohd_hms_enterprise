#!/usr/bin/env bun
// FacilityPro — Regression test suite (bun, stdlib assert only, no framework).
//
// Verifies the recovered fixes are present in the authoritative repository and
// documents the post-restart verification matrix. Run with:  bun tests/regression.mjs
//
// Statuses: PASS = actually checked; NOT TESTED = requires live server + restart
// (could not be verified in this session).

import assert from "node:assert";
import { execSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = "/home/hasan/mohd_hms_enterprise";
let pass = 0, fail = 0, notTested = 0;
const results = [];

function check(name, ok, detail = "") {
  if (ok) { pass++; results.push({ name, status: "PASS", detail }); }
  else { fail++; results.push({ name, status: "FAIL", detail }); }
}
function nt(name, detail = "") {
  notTested++; results.push({ name, status: "NOT TESTED", detail });
}

const read = (p) => {
  try { return readFileSync(join(ROOT, p), "utf8"); } catch { return ""; };
};
const exists = (p) => existsSync(join(ROOT, p));

function git(cmd) {
  try { return execSync(cmd, { cwd: ROOT, stdio: "pipe" }).toString().trim(); } catch { return ""; }
}

// ===========================================================================
// A. Complaint tests (static: code present; behavior = NOT TESTED without live restart)
// ===========================================================================
check("A1: complaint lock-to-work-order module exists",
  exists("src/lib/hms/workflows/complaint-work-order.ts"));
check("A2: complaint lock function referenced in handlers",
  read("src/lib/hms/workflows/handlers.ts").includes("lockComplaintToWorkOrder"));
check("A3: one work order per complaint guard exists",
  read("src/lib/hms/workflows/handlers.ts").includes("work order already exists for complaint"));
nt("A4: Create Complaint → Admin/Supervisor notified (live restart required)");
nt("A5: Work Order generation → Complaint locked (live restart required)");
nt("A6: Work Order status sync → Automatic Complaint closure (live restart required)");
nt("A7: Work Order reopening → Complaint reopened (live restart required)");

// ===========================================================================
// B. Evidence tests
// ===========================================================================
check("B1: BEFORE evidence panel exists",
  exists("src/components/hms/modules/complaints/before-evidence-panel.tsx"));
check("B2: DURING/AFTER evidence panel exists",
  exists("src/components/hms/modules/work-orders/evidence-panel.tsx"));
nt("B3: BEFORE upload before Complaint submission (live restart required)");
nt("B4: BEFORE lock after submission (live restart required)");
nt("B5: DURING upload during active Work Order (live restart required)");
nt("B6: AFTER evidence requirement (live restart required)");
nt("B7: MinIO persistence / access after restart (live restart required)");

// ===========================================================================
// C. Checklist tests
// ===========================================================================
check("C1: checklist engine module exists",
  exists("src/lib/hms/checklist/prompt.ts") || exists("src/components/hms/modules/checklists/index.tsx"));
check("C2: auto-generate checklist on Work Order creation",
  read("src/lib/hms/workflows/handlers.ts").includes("AUTO_CHECKLIST_WORK_ORDER"));
nt("C3: No duplicate checklist generation (live restart required)");
nt("C4: Checklist item editing + progress calculation (live restart required)");
nt("C5: Mandatory item enforcement + closure validation (live restart required)");

// ===========================================================================
// D. PM tests
// ===========================================================================
check("D1: PM schedule module exists",
  exists("src/lib/hms/pm/schedule.ts"));
nt("D2: PM recurrence + next maintenance date (live restart required)");
nt("D3: Overdue / due-today / upcoming detection (live restart required)");
nt("D4: Automatic Work Order generation + duplicate prevention (live restart required)");
nt("D5: Scheduler recovery after restart (live restart required)");
nt("D6: PM dashboard counts (live restart required)");

// ===========================================================================
// E. Notification tests
// ===========================================================================
check("E1: centralized notifications module exists",
  exists("src/lib/hms/notifications.ts"));
check("E2: complaint-notifications module exists",
  exists("src/lib/hms/complaint-notifications.ts"));
nt("E3: Admin + Supervisor notified on new Complaint (live restart required)");
nt("E4: Super Admin excluded from complaint notifications (live restart required)");
nt("E5: Technician assignment notification (live restart required)");
nt("E6: Duplicate events do not create duplicate notifications (live restart required)");

// ===========================================================================
// F. Email tests
// ===========================================================================
check("F1: EmailService exists",
  exists("src/lib/hms/email/service.ts"));
check("F2: Email queue + worker tick exists",
  read("src/lib/hms/email/service.ts").includes("tickEmailWorker"));
check("F3: Idempotent email guard [eventId, automationId]",
  read("src/lib/hms/email/service.ts").includes("already queued for this event (idempotent)")
);
check("F4: Honest delivery states (QUEUED/SENT/DEAD_LETTER)",
  read("src/lib/hms/email/service.ts").includes("DEAD_LETTER") &&
  read("src/lib/hms/email/service.ts").includes("SMTP_ACCEPTED"));
nt("F5: Provider configuration persistence (live restart required)");
nt("F6: Actual test email + delivery evidence (live restart required)");
nt("F7: Email worker recovery after restart (live restart required)");

// ===========================================================================
// G. Deployment / version tests
// ===========================================================================
const head = git("git rev-parse HEAD");
const branch = git("git branch --show-current");
check("G1: Authoritative commit present (bafbefa on dev)",
  head.startsWith("bafbefa") && branch === "dev",
  `HEAD=${head} branch=${branch}`);
check("G2: Recovery commit message present",
  git("git log --oneline -1").includes("fix(recovery): persist previously-implemented production fixes"));
nt("G3: Frontend build version matches commit (live restart required)");
nt("G4: Backend version matches commit (live restart required)");
nt("G5: Worker versions match commit (live restart required)");
nt("G6: Database migration version tracked (live restart required)");
nt("G7: Full server reboot + post-restart health (authorized, operationally safe only)");

// ===========================================================================
// Report
// ===========================================================================
console.log("\n===== FacilityPro Regression Test Suite =====\n");
for (const r of results) {
  const mark = r.status === "PASS" ? "PASS" : r.status === "FAIL" ? "FAIL" : "     ";
  console.log(`[${mark}] ${r.status.padEnd(11)} ${r.name}` + (r.detail ? `  — ${r.detail}` : ""));
}
console.log(`\nTOTAL: ${pass} PASS, ${fail} FAIL, ${notTested} NOT TESTED`);
console.log("NOT TESTED items require a live server + full restart verification "
            + "(authorized, operationally safe) and are NOT counted as PASS.\n");
process.exit(fail > 0 ? 1 : 0);
