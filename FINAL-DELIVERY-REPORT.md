# Final Delivery Report — FacilityPro Regression Recovery

**Application:** FacilityPro — Smart Facility Maintenance Management System
**Company:** MOHD.HMS ENTERPRISE
**Repository:** `/home/hasan/mohd_hms_enterprise`
**Date:** 2026-11-07
**Authoritative commit:** `bafbefa` on branch `dev` — `fix(recovery): persist previously-implemented production fixes`

---

## A. Regression Root Cause

**Confirmed cause (not a guess):** The previously approved UI, complaint-workflow,
evidence, checklist, PM, notification, email and WhatsApp AI fixes existed **only
as uncommitted working-tree changes** on branch `dev` (commit `e918103` + 138
uncommitted modified/new files) in `/home/hasan/mohd_hms_enterprise`. They were:

1. **Never committed to Git** — so they were not part of any release.
2. **Never built** — no `.next/standalone` build incorporated them.
3. **Never deployed** — the deploy worker (`/home/hasan/hms-deploy/deploy.sh`)
   builds from `origin/main` and the live blue/green slots run old `main`
   commits.

Consequently, on every server restart / redeploy, the production server loaded
the old committed code **without** the fixes → the fixes "disappeared after
restart."

**Contributing version mismatches observed:**

| Component | Version / commit | Status |
|-----------|------------------|--------|
| Authoritative Git (dev) | `bafbefa` (all fixes committed this session) | Committed, not deployed |
| `main` branch | `3d87fd3` (5 commits behind dev; missing evidence/checklist/complaint-lock/PM commits) | Not authoritative |
| Live router (`:3000`) | forwards to `upstream` file = `3100` | Running |
| Live blue slot (`:3100`) | release `20261105-143358-pm` = `dce8d6b` (notification-navigation) | Running (bun PID 88684) |
| Live green slot (`:3101`) | release `20261105-144713-evidence-fix` = `e918103` | **Port 3101 silent — not running** |
| `hms-app.service` (this repo via `run-prod.sh`) | defined but **inactive / not running** | Not running |
| `state.json` | current=`20261105-144713-evidence-fix`, port `3101`, last_commit=`e918103` | **Inconsistent** with `current` symlink (→`1cc49c1`) and `upstream` (`3100`) |
| Deploy worker last_sha | `33723d7` (baseline) | Builds `origin/main`, not `dev` |

None of the running versions is `bafbefa`, and none contains the uncommitted
fixes now committed at `bafbefa`.

---

## B. Recovery Report

### Previously missing changes (now recovered & committed at `bafbefa`)
138 files changed (4,843 insertions, 1,562 deletions) on branch `dev`:

- **Complaint workflow:** lock-to-work-order (`lockComplaintToWorkOrder`),
  remove independent mark-completed, one-WO-per-complaint guard,
  Work Order status controls Complaint status, auto closure/reopen.
- **Evidence:** three-stage BEFORE/DURING/AFTER photo/video; BEFORE lock after
  submission; BEFORE/DURING/AFTER panels.
- **Checklist:** auto-generate on Work Order creation; no duplicates;
  auto-attach complaint checklist to Work Order.
- **PM:** schedule module; TypeScript build fixes.
- **UI:** mobile responsive, bottom navigation, dashboard/complaint/work-order/PM
  cards, two-column record cards, narrow-screen overflow fix.
- **Notifications:** centralized distribution; Super Admin exclusion;
  deep-link + mark-read.
- **Email:** centralized EmailService; provider adapter; worker tick;
  idempotent [eventId, automationId] guard; honest delivery states.
- **WhatsApp AI:** centralized AIService via OpenWA; inbound routing; dedupe;
  no repeating static menus.
- Plus files, IRMS, push, technicians, users, invoices, reports, profile.

### Recovered changes
- Committed all 138 source files to `dev` @ `bafbefa` (authoritative repo).
- Temp `.mjs` diagnostic scripts and native build dirs (`android/`, `ios/`)
  intentionally excluded (not application source).

### Newly implemented changes (this session)
- `tests/regression.mjs` — regression test suite (16 static PASS, 0 FAIL).
- `MEMORY.md`, `WORKFLOWS.md`, `DEPLOYMENT.md`, `OPERATIONS.md`, `DATABASE.md`,
  `API.md`, `SECURITY.md`, `CHANGELOG.md`, `ARCHITECTURE.md`, `AGENTS.md`.
- `README.md` updated (corrected DB: PostgreSQL not SQLite; added production
  deployment + version info).

### Files modified (key)
`src/lib/hms/workflows/handlers.ts`, `complaint-work-order.ts`,
`complaint-notifications.ts`, `notifications.ts`,
`src/lib/hms/email/service.ts`, `src/lib/hms/pm/schedule.ts`,
`src/lib/hms/checklist/prompt.ts`, `src/lib/hms/whatsapp/*`,
`src/app/api/v1/complaints/*`, `work-orders/*`, `notifications/route.ts`,
`pm/*`, `push/*`, `whatsapp/*`, `src/components/hms/modules/*`,
`src/components/hms/shell.tsx`, `mobile-nav.tsx`, `session.tsx`,
`src/components/ui/*`, `package.json`, `tsconfig.json`, `.env.example`,
`.gitignore`, `bun.lock`.

### Database migrations
None required this session (schema unchanged; recovery was source-only).

### Deployment changes
None applied to the running deployment (intentionally — the live deployment
still runs old `main` commits and cannot be verified safe to change from this
session). **Required realignment (documented in DEPLOYMENT.md):** point the
deployment at `dev`/`bafbefa`, activate `hms-app` or cut a release from
`bafbefa`, align `state.json`, `upstream` file and slots, then health-check.

### Worker changes
No worker code changes needed; workers load from the deployed build. The email
worker (`tickEmailWorker`) and workflow engine are already idempotent and
recover stuck rows on restart.

---

## C. Infrastructure Report

**Running services (systemd, observed):**
- `cloudflared-hms` — Cloudflare Tunnel `app.mohdhms.com` (running)
- `hms-router` — edge router `:3000` → active slot (running; node PID 5529)
- `hms-blue` — release slot BLUE `:3100` = `dce8d6b` (running; bun PID 88684)
- `hms-green` — release slot GREEN `:3101` = `e918103` (**NOT listening**; port 3101 silent)
- `hms-realtime` — engine.io+WS `:3003`/`:3004` (running)
- `hms-app` — Next.js standalone from this repo (`run-prod.sh`) (**inactive**)
- `docker` — PostgreSQL `:5432`, MinIO `:9001` (running)
- Redis `:6379`, `:6380`, `:65515` (running)

**Application version:** Git `dev` @ `bafbefa` (committed, not deployed).
**Git commit:** `bafbefa5f46511cccc96ef9267c1626c1c2d6a2b`.
**Frontend build:** `.next/standalone` present (built 2026-11-07 06:58, pre-`bafbefa`; needs rebuild for `bafbefa`).
**Backend version:** `bafbefa` source committed; not running as a service.
**Worker versions:** load from deployed build; not independently versioned.
**Database migration version:** Prisma schema `prisma/schema.prisma`; migrations tracked; no auto seed on production startup.
**Persistent storage:** PostgreSQL `mohd_hms` on `:5432`; MinIO `/data`; Redis
`:6379/:6380/:65515`. All observed running; persistence across restart not
re-verifiable without an authorized reboot.

---

## D. Feature Verification

Post-restart verification was **not performed** in this session (requires an
authorized, operationally-safe full server reboot). Static checks (regression
suite `tests/regression.mjs`): **16 PASS, 0 FAIL, 29 NOT TESTED**.

| Module | Static code present | Post-restart verified |
|--------|---------------------|-----------------------|
| Complaint workflow (lock, no mark-completed, WO→closure) | PASS | NOT TESTED |
| Evidence BEFORE/DURING/AFTER | PASS | NOT TESTED |
| Checklist (auto-gen, no dupes) | PASS | NOT TESTED |
| PM scheduling | PASS | NOT TESTED |
| Notifications (Super Admin excluded) | PASS | NOT TESTED |
| Email service + worker | PASS | NOT TESTED |
| WhatsApp AI | PASS | NOT TESTED |
| Mobile responsive UI | PASS | NOT TESTED |
| Dashboard / WO / complaint cards | PASS | NOT TESTED |
| MinIO media persistence | — | NOT TESTED |
| PostgreSQL persistence | — | NOT TESTED |
| Redis queue recovery | — | NOT TESTED |

All "NOT TESTED" items require a live server + full restart verification and
must pass before production readiness is declared.

---

## E. Documentation Report

Markdown files reviewed/created/updated in `/home/hasan/mohd_hms_enterprise/`:

| File | Action | Contents |
|------|--------|----------|
| `README.md` | Updated | Project identity, stack, prod version, root cause, dev/prod commands, rules |
| `MEMORY.md` | Created | Project identity, architecture, dev rules, business rules, decision statuses |
| `WORKFLOWS.md` | Created | 14 business workflows + authorization rules |
| `DEPLOYMENT.md` | Created | Services, router/slots, startup order, commands, build, migration, backup, restore, rollback |
| `OPERATIONS.md` | Created | Routine checks, health checks, logs, restart, failure recovery, queue/scheduler/DB/MinIO health |
| `DATABASE.md` | Created | Connection, models, relationships, enums, migration strategy, idempotency, backup |
| `API.md` | Created | Route groups observed; notes exact bodies must be read from route files |
| `SECURITY.md` | Created | Auth, RBAC, secrets, file upload, webhooks, QR, audit logs, prod requirements |
| `CHANGELOG.md` | Created | Historical git entries + recovery entry |
| `ARCHITECTURE.md` | Created | Frontend/backend structure, DB, Redis, MinIO, workers, scheduler, auth, notifications, integrations, deployment |
| `AGENTS.md` | Created | Persistent AI-session instructions (paths, commands, workflow rules, storage, security, deployment, regression prevention) |

Pre-existing reports preserved (not duplicated):
`docs/AI-CONFIG-REPORT.md`, `AUTOMATION-REPORT.md`, `BND-LOCALIZATION-REPORT.md`,
`IRMS-REPORT.md`, `KPI-DRILLDOWN-REPORT.md`, `NATIVE-MOBILE-REPORT.md`,
`PDF-SYSTEM-REPORT.md`, `PUSH-FCM-REPORT.md`, `QR-PUBLIC-VERIFICATION.md`,
`irms-contracts.md`, `mobile-ui-audit.md`, `mobile-ui-fix-plan.md`,
`docs/superpowers/`, `hms/docs/BACKUP.md`, `OPERATOR.md`, `REPORT.md`.

No conflicting duplicate documents created. Documentation hierarchy: `AGENTS.md`
is the entry point for future AI sessions; all other Markdown supports it.

**Remaining documentation gaps:** exact API request/response bodies (require
reading each route file); MinIO bucket names; precise cron/scheduler interval;
Redis queue depth thresholds.

---

## F. Regression Test Report

Suite: `tests/regression.mjs` (bun, stdlib `assert`, no framework).

| ID | Area | Result |
|----|------|--------|
| A1–A3 | Complaint lock / one-WO guard | PASS |
| A4–A7 | Complaint notification/lock/closure/reopen behavior | NOT TESTED |
| B1–B2 | Evidence panels exist | PASS |
| B3–B7 | Evidence lifecycle / MinIO persistence | NOT TESTED |
| C1–C2 | Checklist auto-generation | PASS |
| C3–C5 | No-dupe checklist / progress / mandatory items | NOT TESTED |
| D1 | PM schedule module | PASS |
| D2–D6 | PM recurrence / overdue / WO gen / recovery / dashboard | NOT TESTED |
| E1–E2 | Notification modules exist | PASS |
| E3–E6 | Recipient rules / Super Admin exclusion / dedupe | NOT TESTED |
| F1–F4 | EmailService / worker / idempotency / delivery states | PASS |
| F5–F7 | Provider persistence / test email / worker recovery | NOT TESTED |
| G1 | Authoritative commit `bafbefa` on `dev` | PASS |
| G2 | Recovery commit message | PASS |
| G3–G7 | Build/backend/worker/migration version match + reboot health | NOT TESTED |

**Totals:** 16 PASS, 0 FAIL, 29 NOT TESTED.
NOT TESTED items cannot be counted as PASS; they require an authorized full
server restart verification.

---

## G. Remaining Risks

1. **Version mismatch not yet resolved in the running deployment.** The live
   blue/green slots and deploy worker still run old `main` commits, not
   `dev`/`bafbefa`. The fixes are committed but not deployed. Realign the
   deployment to `bafbefa` and health-check before declaring live.
2. **`hms-green` slot (port 3101, `e918103`) is not listening** and
   `state.json` is inconsistent with the `current` symlink and `upstream` file.
   Reconcile deployment state.
3. **`hms-app.service` inactive** — the service that runs this repo is defined
   but not running; decide whether to activate it or use the slot system.
4. **Post-restart persistence not re-verified** (PostgreSQL, MinIO, Redis) —
   requires an authorized, operationally-safe full reboot.
5. **Frontend `.next` build predates `bafbefa`** — rebuild required for the
   committed fixes to ship.
6. **29 regression test items NOT TESTED** — cannot claim production readiness
   until these pass after restart.
7. **Deploy worker targets `origin/main`** while development is on `dev` —
   branch drift risk; align deploy target with the authoritative branch.

---

## H. Final Production Readiness

**FacilityPro is NOT yet declared ready for operational use after restart.**

Reason: although all previously fixed source code is now committed in the
authoritative repository (`dev` @ `bafbefa`) and documented, the running
production deployment still executes old committed code (main-branch slot
commits `dce8d6b` / `1cc49c1`, baseline `33723d7` in the deploy worker), none
of which contains the recovered fixes. The 29 "NOT TESTED" regression items
require a live server + full restart verification that has not been performed.

**To reach production readiness:**
1. Realign deployment to `dev`/`bafbefa` (build → health-check → deploy /
   activate `hms-app` or cut a release from `bafbefa`).
2. Rebuild the frontend `.next/standalone` from `bafbefa`.
3. Reconcile `state.json`, `upstream` file, and blue/green slots.
4. Perform an authorized full server restart; wait for all services healthy.
5. Run `bun tests/regression.mjs` and the 29 live verification items; all must
   PASS.
6. Confirm PostgreSQL, MinIO, Redis data/media persist after restart.
7. Update documentation for any deployment changes made.

Until steps 1–7 complete and pass, do not declare production readiness.
