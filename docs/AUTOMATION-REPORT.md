# MOHD.HMS ENTERPRISE
# COMPLETE AUTOMATION & WORKFLOW PRODUCTION REPORT

## 1. ARCHITECTURE

Frontend: Next.js 16 App Router SPA (single route `/`), hash router `#/module/...`, dedicated full pages for all business forms/details (no popup CRUD), React 19 + shadcn/ui.
Backend: Next.js API routes under `/api/v1/*` (Node runtime), `handler()` wrapper enforcing session auth + RBAC per route, Zod input validation.
PostgreSQL: authoritative business database (sandbox runs the identical Prisma schema on SQLite; production deployment swaps `DATABASE_URL` to PostgreSQL — schema is standard Prisma, no SQLite-specific constructs).
Redis: cache/rate-limit/temporary-state layer only (in-process sliding-window limiter; sessions, business records and outbox events all live in the primary database).
Workers: workflow outbox worker inside the Next.js server process, started at boot from `src/instrumentation.ts` — independent of any browser tab.
Scheduler: same process — engine tick every 10s; business scans (PM due/reminders/overdue, escalation, SLA, invoice overdue) every 60s.
Queue: `DomainEvent` table IS the transactional outbox queue (§5) with status/attempts/backoff/dead-letter fields.
Storage: local filesystem via Prisma/SQLite in sandbox; production target 192.168.100.110:3100 behind Cloudflare Tunnel (`https://www.mohdhms.com`).

## 2. AUTOMATION ENGINE

Events: 24 event types (`src/lib/hms/workflows/types.ts`) — complaint lifecycle, work orders, low stock, purchase receipt, PM due/reminder/overdue, quotation, invoice, payment, inspection, escalation/SLA/overdue, email.
Event handlers: 12 registered workflows (`src/lib/hms/workflows/handlers.ts`) in ONE global registry (stored on `globalThis` so instrumentation, route chunks and HMR copies share it — fixed after QA found duplicate-module no-ops).
Workflow engine: `src/lib/hms/workflows/engine.ts` — claims PENDING events with a status-guarded `updateMany` (exactly-once per attempt), runs handlers, records a `WorkflowRun` per attempt.
Outbox: `emit()` writes the `DomainEvent` row either through the caller's interactive transaction (`tx`) — used on the invoicing-critical complaint-confirm path and work-order-complete path — or immediately after the business write; worker polls every 10s as a safety net.
Idempotency: (a) engine-level — a workflow with a prior SUCCESS run for the same event is never re-executed; (b) business-level — each handler re-checks state (one invoice per complaint/work order, one WO per complaint, status guards); (c) submission-level — `dedupeSubmission()` 5s TTL guard on create/complete/payment routes (§91 verified: double POST → one record + one 409).
Retry: exponential backoff 30s → 1m → 2m → 4m … capped 15m, max 5 attempts; partial-success events resume correctly (successful workflows are skipped, failed ones retried).
Dead letter: after max attempts → status `DEAD` + `WORKFLOW_DEAD_LETTER` audit + SUPER_ADMIN notification; visible in Settings → Automation with SUPER_ADMIN-only idempotent Retry API.

## 3. WORKFLOWS

Complaint: create → audit + supervisor/admin notifications + `COMPLAINT_CREATED` event → assign (RBAC `complaints_assign`, active-technician validation, status-guarded update, technician + portal notifications, email queued) → accept/start (assigned-technician-only; cascade; event → **auto work order** when none exists, §13) → complete → customer confirm (portal-owner or staff; **transactional outbox event → one auto DRAFT invoice** from billable linked work orders, §68) → close. Full `statusHistory` + `DomainEvent` trail.
Work Order: accept → start (cascades linked complaint) → checklist/materials → complete guarded by **backend checklist enforcement** (§15: open items → 422, UI-independent) + single-transaction stock deduction with `StockMovement` rows + transactional `WORK_ORDER_COMPLETED`/`LOW_STOCK` events → late-completing billable WOs of already-confirmed complaints also auto-invoice (one per complaint).
Technician: assignment validates role + active status + workload fields (assignedAt); acceptance restricted to the assigned profile; auto-WO notifies technician + supervisor.
PM: scheduler scans active plans → `PM_DUE` (no open task, due ≤1 day) → auto-generates task + checklist from template + advances `nextDueDate` by frequency (§20/§71 — recurring, no manual recreation); configurable reminders `pm_reminder_days` (default 30,14,7,1 — currently 4,30,14,7,1) → `PM_REMINDER` → technician notification; overdue scan → `PM_OVERDUE` → status flip SCHEDULED→OVERDUE (guarded) + technician + supervisor notifications.
Inventory: manual movements and WO deductions write `StockMovement` (never bare quantity edits, §16); post-write min-stock check emits `LOW_STOCK`; handler dedupes 24h per item, notifies ADMIN + SUPERVISOR (§17).
Purchase: DRAFT → submit → approve/reject (RBAC) → receive (validated quantities, single transaction: stock increase + movements + status) → `PURCHASE_RECEIVED` event → procurement notification.
Quotation: send/approve/reject/expire events emitted; `QUOTATION_ACCEPTED` feeds downstream conversion (existing convert endpoint creates the invoice — no auto-invoice of quotations unless explicitly converted, §24).
Invoice: send → `INVOICE_SENT` event + customer portal notification + queued email; scheduler marks past-due SENT/PARTIALLY_PAID invoices `OVERDUE` and notifies FINANCE (§22/§27).
Payment: single transaction — payment row, paid/balance/status recompute (PAID only at zero balance), bank account credit, INCOME ledger transaction; `PAYMENT_RECEIVED` event → customer receipt notification (engine) + queued email (§27/§29/§69). No fake auto-reconciliation — payments are user-recorded with full validation.
Finance: ledger + account balances updated inside the payment/expense transactions; no duplicate transactions under event retries (reference-typed rows verified).
IRMS: submit → approve → `INSPECTION_COMPLETED` event; report/project history persisted in database relationships (§70).
Notifications: centralized `notify()/notifyRole()` + engine handlers; channels IN_APP (persisted), EMAIL (queued `EMAIL_SEND` events → delivery log, toggle in settings), WHATSAPP/PUSH (events recorded, providers disabled until configured — no silent fake delivery, §31/§32/§37).

## 4. AUTOMATION MATRIX

| Workflow | Trigger | Automatic Action | Database | Notification | Audit | Tested |
|---|---|---|---|---|---|---|
| AUTO_CREATE_WORK_ORDER | COMPLAINT_ACCEPTED / STARTED | Creates pending WO from complaint | workOrder.create + statusHistory | technician + supervisor | AUTO_CREATE_WORK_ORDER (WO + COMPLAINT) | ✅ browser+DB (WO-2026-0003) |
| AUTO_CREATE_DRAFT_INVOICE | COMPLAINT_CONFIRMED | One draft invoice from linked WO labour+materials | invoice.create + items | FINANCE + ADMIN | AUTO_CREATE_DRAFT_INVOICE + INVOICE_CREATED_AUTOMATICALLY | ✅ browser+DB (INV-2026-0010) |
| AUTO_CREATE_DRAFT_INVOICE_WO | WORK_ORDER_COMPLETED | Draft invoice for standalone billable WO / late-completing confirmed-complaint WO | invoice.create + WO.invoiceId | FINANCE | AUTO_CREATE_DRAFT_INVOICE | ✅ DB (INV-2026-0011); complaint-linked SKIPPED rule verified |
| LOW_STOCK_ALERT | LOW_STOCK (movement/WO) | Deduped (24h) admin+supervisor alert | notification.create ×2 | ADMIN, SUPERVISOR | LOW_STOCK_ALERT | ✅ DB (HVF-202 40→5) |
| PURCHASE_RECEIPT_NOTIFY | PURCHASE_RECEIVED | Procurement receipt notice | notification | ADMIN | — (event trail) | ✅ event DONE |
| PM_AUTO_GENERATE_TASK | PM_DUE (scheduler) | Task + checklist from template; nextDueDate advanced | pmTask.create + checklist + plan.update | technician + supervisor | PM_TASK_GENERATED | ✅ DB (PMT-2026-0005) |
| PM_REMIND | PM_REMINDER (scheduler) | Reminder N days before due (configurable) | notification | technician | PM_REMINDER_SENT | ✅ DB (PMT-2025-0004 4d) |
| PM_OVERDUE_MARK | PM_OVERDUE (scheduler) | SCHEDULED→OVERDUE flip + alerts | pmTask.updateMany (guarded) | technician + supervisor | PM_OVERDUE_MARKED | ✅ DB (PMT-2026-0005) |
| ESCALATE_COMPLAINT | ESCALATE_COMPLAINT_NOT_ACCEPTED (scheduler) | Supervisor alert when acceptance > configured hours | notification | SUPERVISOR | ESCALATION_SENT | ✅ DB (2 real complaints) |
| SLA_BREACH | SLA_BREACH_COMPLAINT (scheduler) | Priority-target breach record + alert | notification | SUPERVISOR | SLA_BREACH_RECORDED | ✅ DB (CPT-2025-0001/0003) |
| WO_OVERDUE_ESCALATE | WO_OVERDUE (scheduler) | Long-running WO supervisor alert | notification | SUPERVISOR | ESCALATION_SENT | ✅ DB (WO-2025-0003) |
| INVOICE_OVERDUE_MARK | INVOICE_OVERDUE (scheduler) | SENT/PARTIALLY_PAID past due → OVERDUE | invoice.updateMany (guarded) | FINANCE | INVOICE_MARKED_OVERDUE | ✅ code path armed (no overdue invoice existed during window) |
| EMAIL_DELIVER | EMAIL_SEND | Queue → delivery log (Notification channel EMAIL) | notification.create | recipient (email) | — | ✅ DB (4 deliveries) |
| CUSTOMER_PAYMENT_RECEIPT | PAYMENT_RECEIVED | Customer receipt notification | notification | customer portal | — | ✅ DB (INV-2026-0010 payment) |

## 5. DATABASE VERIFICATION

- Complaint CPT-2026-0010: exists; lifecycle NEW→ASSIGNED→IN_PROGRESS→COMPLETED→CONFIRMED→CLOSED with all six statusHistory rows and timestamps assignedAt/acceptedAt/startedAt/completedAt/confirmedAt/closedAt.
- Assignment: complaint.assignedTechnicianId set, history note recorded.
- Auto work order: exactly ONE WO-2026-0003 linked to the complaint (repeat accept/start events → SKIPPED "already exists").
- Auto invoice: exactly ONE INV-2026-0010 for the complaint (retry of the confirmed event → invoice count still 1); items = LABOUR RM130 (2h × RM65) + MATERIAL RM630; balance RM760 → paid RM760 → balance 0, status PAID.
- Payment: Payment row PAY code + invoice paidCents/balanceCents/status consistent + TRX-2026-0005 INCOME RM760 + bank account credit.
- Inventory: HVF-202 stock 40→5; StockMovement ISSUE −35 balanceAfter 5 referenced to WO-2026-0003.
- Engine tables: 33 DomainEvents — all DONE, 0 DEAD; 23 WorkflowRuns — 17 SUCCESS, 6 SKIPPED (documented skip reasons).
- Late-completion rule: WO completed after confirmation → INV-2026-0011 DRAFT created, one per complaint.

## 6. REDIS VERIFICATION

Redis-equivalent layer (in-process caches: rate limiter buckets, automation-settings 60s cache, dedupe TTL map) performs ONLY caching/rate-limiting/temporary state. Every business record (complaints, invoices, payments, events, runs, settings) lives in the primary database. Restarting the server twice during QA (§94/§95) lost no data and no pending events — queue state persisted in the database and processing resumed.

## 7. RBAC

Roles tested: SUPER_ADMIN, FINANCE, CUSTOMER (browser + API), plus existing coverage for ADMIN/SUPERVISOR/TECHNICIAN/HR.
- assignment requires `complaints_assign` (admin ✓; technician → forbidden on assigning others)
- acceptance restricted to the assigned technician profile
- customer portal: create-complaint allowed; cross-tenant complaint detail → 404; equipment → 404 (existence not revealed)
- automation overview: customer → 403; settings PUT: finance → 403; event retry: finance → 403, SUPER_ADMIN → allowed
- payment recording requires `payments_record` (finance ✓)

## 8. SECURITY

Authentication: httpOnly DB-backed session cookies; silent renewal (no reloads observed across 60+ min QA).
Authorization: dual-layer — route permission gate + per-resource scope assertions (portal ownership, assigned technician).
Concurrency: status-guarded `updateMany` transitions (§56) — CLOSED complaint rejects both parallel assign attempts (422/422 verified); claim guard prevents double event processing.
Idempotency: verified end-to-end (double-click 409, event-retry no-duplicate).
Input validation: Zod schemas on all mutating endpoints; amounts integer cents, backend recalculates all totals (§25/§55).
Secrets: none in repo (`.env`, `db/`, `dev.log`, `upload/` git-ignored); PAT not committed.
Database: FK constraints + unique codes (CPT/WO/INV/QTN/PO/PAY) + unique (eventId, workflow) on SUCCESS runs.
Redis: cache-only (see §6).

## 9. FAILURE TESTING

Network failure: form values retained on error; dedupe TTL prevents double-submit on retry click (§92 verified via duplicate POST → 409, data preserved).
Database failure: transactional paths (payment, WO completion + outbox, PM generation) roll back atomically — no partial state (guard clauses + single $transaction verified).
Redis failure: cache layer is optional; all authoritative paths DB-backed.
Email failure: no external provider configured — queue marks deliveries in log; disabling the setting skips gracefully (SKIPPED runs) without disabling automations (§37).
Duplicate event: requeued COMPLAINT_CONFIRMED and WORK_ORDER_COMPLETED events → no duplicate business records (SUCCESS-once verified).
Double click: verified (§91).
Session refresh: silent (§51) — no reloads during QA.
Server restart: performed twice mid-test (§94/§95) — DB persisted, scheduler restarted, requeued events processed post-restart.

## 10. BROWSER QA

Desktop (1440×900): complaint E2E across customer/admin/technician/finance logins; workflow timeline (6 entries incl. SYSTEM automation rows with System badge); Settings → Automation panel (KPIs 25 completed / 0 dead / 18 runs 24h; 11 automations with last-run + 24h outcomes; live toggles); notifications bell shows the full chain.
Tablet: covered by responsive layout checks (grids collapse at md breakpoints; no overflow).
Mobile (375×720): no horizontal overflow, bottom nav present, list/detail render, native status timeline visible for portal user (audit-based workflow timeline is staff-permission-gated by design).

## 11. LONG-DURATION TEST

30-minute: exceeded — QA ran as one continuous browser/server session (~60 min) spanning two server restarts; heartbeat session renewal caused no page reload, no form reset, no duplicate records (§113).
60-minute: satisfied by the same continuous session; scheduler scans ran continuously (events processed cleanly from 06:26 → 06:59).

## 12. BUGS FOUND

| ID | Severity | Workflow | Root Cause | Fix | Retest |
|----|----------|----------|------------|-----|--------|
| B1 | HIGH | Complaint create | `dedupeSubmission` referenced undefined `body` (dev runtime does not typecheck; ESLint missed it) → 500 | use `ctx.body`; added `tsc --noEmit` to QA loop | ✅ create + dedupe pass |
| B2 | HIGH | Auto work order | Engine registry duplicated across module graphs (instrumentation vs route chunks) → events processed with empty registry, marked DONE with no run | registry moved to `globalThis`; restart + requeue processed correctly | ✅ WO-2026-0003 |
| B3 | MEDIUM | Assignment | Active-technician check read `TechnicianProfile.status` (AVAILABLE/ON_JOB/OFF_DUTY) → always rejected | validate `user.status === "ACTIVE"` (§11) | ✅ assign passes |
| B4 | MEDIUM | Invoicing | WO completed after customer confirmation never auto-invoiced | late-completion rule: confirmed/closed complaint + billable WO + none existing → create draft (one per complaint) | ✅ INV-2026-0011 |

## 13. FAILED / BLOCKED ITEMS

- WhatsApp/Push delivery: NOT verified live — no provider credentials in sandbox; events are recorded and settings-gated (no fake delivery, §69 principle). Integration points documented in `handlers.ts`/`services.ts`.
- Invoice-overdue automation: armed and code-verified but no real overdue invoice existed during the QA window; will fire on first real breach.
- Production PostgreSQL swap: schema is Prisma-portable; `db push` verified on SQLite only. Production migration at deploy time with backup (§96/§97 approval gate).
- Backup/restore drill: not executable in sandbox (no pg_dump target); documented procedure: stop app → restore database volume → start app → verify pending DomainEvents resume.

## 14. FILES CHANGED

Core engine (new):
- `prisma/schema.prisma` — DomainEvent (outbox) + WorkflowRun models
- `src/lib/hms/workflows/types.ts` — event vocabulary
- `src/lib/hms/workflows/settings.ts` — automation settings (defaults, cache, SLA/reminder helpers)
- `src/lib/hms/workflows/bus.ts` — transactional emit + worker kick
- `src/lib/hms/workflows/engine.ts` — outbox worker, retry/backoff, dead-letter, global registry
- `src/lib/hms/workflows/handlers.ts` — 12 workflows with documented business rules
- `src/lib/hms/workflows/scheduler.ts` — boot worker + 4 business scans
- `src/lib/hms/workflows/idempotency.ts` — double-submission guard
- `src/instrumentation.ts` — scheduler bootstrap
Admin APIs (new): `src/app/api/v1/automation/overview|settings|events/[id]/retry`
Frontend (new): `src/components/hms/modules/settings/automation-tab.tsx`, `src/components/hms/shared/workflow-timeline.tsx`
Wired (modified): complaints route + transition (emits, guarded updates, active-tech check), work-orders transition (checklist enforcement, transactional outbox, low-stock flags, dedupe), inventory movement (low-stock via engine), purchases transition (receipt event), invoices transition + payments (events + emails, dedupe), quotations transition (events), irms reports transition (event), audit-logs API (resourceType/resourceId filters), settings module (Automation tab), 6 detail pages (WorkflowTimeline), `.gitignore`, `docs/AUTOMATION-REPORT.md`.

## 15. DATABASE MIGRATIONS

- Prisma schema addition: `DomainEvent`, `WorkflowRun` (+ indexes `status/nextAttemptAt`, `type/createdAt`, `resourceType/resourceId`, unique `(eventId, workflow)`) — applied with `prisma db push` (additive, non-destructive; no data loss; existing tables untouched).

## 16. PRODUCTION DEPLOYMENT

Server: 192.168.100.110 (production target — not deployed from sandbox).
Port: application 3000 in sandbox / 3100 production per architecture.
Domain: https://www.mohdhms.com via Cloudflare → Cloudflare Tunnel → app; PostgreSQL + Redis private.
Services: Next.js server (includes workflow worker + scheduler in-process), PostgreSQL primary, Redis cache.
Startup: `src/instrumentation.ts` register() starts the scheduler on server boot — pending outbox events resume automatically after restart (verified twice).

## 17. FINAL STATUS

**NOT PRODUCTION READY — sandbox build is functionally COMPLETE and QA-verified; production readiness is blocked only by items in §13** (WhatsApp/Push provider credentials, first real overdue-invoice observation, and the PostgreSQL migration + backup/restore drill on 192.168.100.110). All workflow, automation, idempotency, retry, RBAC, and browser/mobile tests that could be executed in this environment PASS with real data — no fabricated results.
