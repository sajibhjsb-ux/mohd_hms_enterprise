# Task ID: 4-a — full-stack-developer (PM backend)

## Context read
- worklog.md (Task 1 recon + Task 2-3 foundation) — conventions: `handler(fn,{permission})`, `withId` Promise-params bridge, `ok/okList/parseBody/listQuery/pagedMeta`, `Errors.*`, `audit`, `emit` outbox, `EVENT_TYPES`, `computePmMetrics`, `generatePmOccurrence`, `nextNumber`, storage streaming pattern (irms photos/file).

## Implemented (13 route files under src/app/api/v1/pm/)
1. `dashboard/route.ts` — GET pm_read; 11 live KPIs + §56 compliance (computePmMetrics, grace from Setting `automation.pm_grace_days`) + upcoming 6; customer-scoped.
2. `calendar/route.ts` — GET pm_read; from/to required (max 62d), grouped by ISO day; customer-scoped.
3. `tasks/[id]/reschedule/route.ts` — POST pm_manage; closed→422; tx task+WO.scheduledDate; audit PM_RESCHEDULED; notify tech.
4. `tasks/[id]/photos/route.ts` — GET pm_read / POST pm_manage|assigned-tech(pm_execute); magic-byte sniff (jpeg/png/webp ≤15MB, mp4/webm ≤50MB); key `pm/{taskId}/{phase}/{uuid}.{ext}`; Document resourceType PM_TASK label=phase; audit PM_PHOTO_UPLOADED; closed&&!manage→422.
5. `photos/[id]/file/route.ts` — GET pm_read; PM_TASK only; customer-scoped; streams buffer inline (private bucket).
6. `findings/route.ts` — GET (filters or recent 50; customer sanitize) / POST (pm_execute||pm_manage; equipmentId body→task→WO; HIGH/CRITICAL→notifyRole SUPERVISOR).
7. `findings/[id]/corrective-wo/route.ts` — POST pm_manage; idempotent; WO `[Corrective] …`, sourceType CORRECTIVE, CRITICAL→URGENT; audit; notify.
8. `meters/route.ts` — GET (recent 50 w/ 20 readings each) / POST pm_manage; audit PM_METER_CREATED.
9. `meter-readings/route.ts` — POST pm_execute||pm_manage; monotonic (backwards only pm_manage+isCorrection→422 with contract message); tx reading+meter; §62 PM_DUE emission w/ open-task dedupe → triggeredPlans.
10. `templates/route.ts` — GET (category/active filters, itemsParsed, categories = distinct∪standard13) / POST pm_manage.
11. `templates/[id]/route.ts` — GET +plansCount / PATCH / DELETE soft (active:false); audit PM_TEMPLATE_CHANGED.
12. `reports/route.ts` — GET pm_report; windowDays 7..365; compliance, overdue≤100, technicians (avgCompletionHours 1dp, checklistRate), costsByAsset/Customer, findingsSummary, upcoming 10.
13. `scheduler/run/route.ts` — POST pm_manage; `runPmSchedulerOnce()` ×2 (§86); audit PM_SCHEDULER_RUN; {ok,ranAt}.

## Also edited
- `src/lib/hms/workflows/scheduler.ts` — added exported `runPmSchedulerOnce()` (scanPm + dispatchPendingEvents).
- `src/app/api/v1/work-orders/route.ts` — `?source=` validated (GENERAL|COMPLAINT|PM|CORRECTIVE) → where.sourceType.
- `prisma/seed.ts` — HVAC(11)/Electrical(7) templates, generator meter 430h + readings, PM-2025-0006 meter plan, rich first-plan checklist, all equipment customer-scoped, ≥2 HIGH/CRITICAL.
- `src/lib/hms/storage/index.ts` — FIX: ensureBucket cached rejected promise on transient outage (poisoned process); now resets + retries. (Not in forbidden zones.)

## Verification
- `bun run prisma/seed.ts` → OK. Targeted eslint (all PM routes + work-orders + scheduler + storage + seed) → CLEAN.
- Full-project lint: only errors left are in `src/components/hms/modules/pm/task-detail.tsx` (frontend agent's file — untouched per hand-off).
- curl QA via `/api/v1/auth/login` (operations@mohdhms.com, cookie jar): dashboard 200, templates 200, scheduler/run 200 (idempotent ×2), work-orders?source=pm 200 (INVALID→400), calendar 200 (span>62→400), reports 200, meters 200, meter-readings 435→201 / 505→201 triggeredPlans[PM-2025-0006]→engine created PMT-2026-0001 / 300→422 / manager correction 201, findings 201, corrective-wo 201 then alreadyLinked, reschedule 400-short/200-valid, photos PNG 201 / txt 400 / file stream byte-identical; RBAC: tech photo 201, tech reschedule 403, customer dashboard 403.
- Started `mini-services/object-storage` (s3rver :3090) for storage verification.
