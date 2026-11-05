# Work Order Checklist Lifecycle — Design

Date: 2026-11-05
Module: Work Orders / Technician Operations
Status: Proposed

## Intent

Every newly created Work Order must receive a relevant, job-specific checklist
automatically, and the assigned technician must be able to run that checklist
from the Work Order page: add/edit/remove permitted items, record status,
remarks, measurements and per-item photo evidence, then submit the Work Order
for supervisor review. Completion must be backend-enforced; no frontend-only
gates.

## Existing Architecture Findings

The app already has a centralized checklist engine, not a blank slate:

- `ChecklistTemplate` + `ChecklistTemplateVersion`: versioned, category/work-type
  aware template library with item JSON.
- `ChecklistInstance` + `ChecklistInstanceVersion`: draft/review/active snapshot
  per source (COMPLAINT | WORK_ORDER | PM | IRMS).
- `WorkOrderChecklistItem`: the single execution surface; items are materialized
  from an approved instance/template and frozen per Work Order.
- Template-first generation with optional AI assist and deterministic fallback.
- `WORK_ORDER_CREATED` workflow already attaches an approved complaint checklist
  or template-generates when automation is enabled.
- `WorkOrderChecklistItem` already supports `required`, rich response types
  (CHECKBOX/PASSFAIL/YESNO/NUMERIC/TEXT), notes, units, priority, safety flag,
  expected result, `requiresPhoto`, `failRequiresFinding`.
- Photo uploads use MinIO through `Document` rows under
  `checklists/{workOrderId}/photos/`; the API accepts an optional `itemId`.
- Template CRUD APIs exist for create/read/update-version/deactivate.

### Actual gaps

1. Auto-generation is gated by `auto_checklist_for_work_orders`, default OFF,
   and runs after Work Order creation rather than in the same transaction.
2. Only two live templates exist (`HVAC`, `ELEC`), while Equipment categories
   include `POWER`, `FIRE_SAFETY`, `VERTICAL_TRANSPORT`; there is no canonical
   alias mapping and no default template for all 12 required categories.
3. Execution items have only `done`; they lack
   PENDING/IN_PROGRESS/COMPLETED/NOT_APPLICABLE/BLOCKED with mandatory reasons,
   completed-by identity, and soft removal.
4. Technicians can add and toggle items but cannot edit descriptions or remove
   items with audit history.
5. `requiresPhoto` is validated against ALL Work Order photos, not the specific
   item's evidence.
6. Template admin UI is create-only; edit/duplicate/activate controls are missing.
7. Checklist submission/review timestamps are not recorded on the instance.
8. Blocked items and checklist submission do not notify supervisors distinctly.

## Goals

- Automatically create a checklist for every new Work Order, transactionally and
  idempotently.
- Seed sensible default templates for HVAC, Electrical, Plumbing, Fire
  Protection, Generator, Lift & Escalator, Building, Civil, Mechanical, Pest
  Control, Cleaning, Landscape, plus GENERAL fallback.
- Give assigned technicians full permitted checklist execution controls.
- Enforce mandatory items, N/A/blocked reasons, per-item evidence and completion
  validation in the backend.
- Preserve existing Work Order/PM/complaint workflows and the existing
  centralized engine structure.
- Extend template management without replacing it.

## Non-goals

- No separate checklist app or parallel execution model.
- No new AI provider integration; AI remains optional and template-first.
- No hard deletion of completed checklist records.
- No customer-facing exposure of internal remarks, safety notes or evidence.

## Decisions

### 1. Extend the existing engine in place

`ChecklistTemplate`, `ChecklistInstance` and `WorkOrderChecklistItem` remain the
only models used. New columns are additive. `AuditLog` remains the change-history
store with previous/new values in `metadata`.

### 2. Automatic generation is transactionally guaranteed

On manual Work Order creation, the Work Order and its initial checklist are
created in one PostgreSQL transaction. The event handler remains as an
idempotent safety net for other creation paths.

Selection order for a new Work Order:

1. If the linked complaint has an APPROVED unattached ChecklistInstance, attach
   and materialize that snapshot.
2. Otherwise find the best ACTIVE template by canonical category + work type,
   then category, then work type, then GENERAL.
3. If no database template exists, use a built-in GENERAL fallback item set.
4. If the creator explicitly supplied checklist labels, use those as a MANUAL
   checklist instead of template content. A ChecklistInstance is always created
   so submit/review timestamps have an owner.

The default `auto_checklist_for_work_orders` becomes `on`. AI is never run
automatically for Work Orders; AI remains an explicit Generate action. The
deployment changes only the code default, not existing `Setting` rows, so an
administrator who explicitly disabled automation stays disabled.

Idempotency: if the Work Order already has an instance or non-removed items,
generation returns the existing result.

### 3. Canonical categories

Add `canonicalizeCategory()` in `src/lib/hms/checklist/context.ts`:

- POWER, ELEC, ELECTRIC → ELECTRICAL
- FIRE_SAFETY, FIRE → FIRE_PROTECTION
- VERTICAL_TRANSPORT, LIFT_ESCALATOR, ELEVATOR → LIFT
- BUILDING_MAINTENANCE → BUILDING
- CIVIL_WORKS → CIVIL
- PEST, PEST_CONTROL → PEST_CONTROL
- CLEANING, LANDSCAPE, MECHANICAL, GENERATOR, HVAC, PLUMBING unchanged
- unknown → GENERAL

Category and work-type inference continue to use equipment facts plus complaint
title/description. `findBestTemplate` compares canonicalized categories so
legacy template categories still match where possible.

### 4. Execution item model

Add to `WorkOrderChecklistItem`:

- `status String @default("PENDING")` — PENDING | IN_PROGRESS | COMPLETED |
  NOT_APPLICABLE | BLOCKED
- `statusReason String @default("")`
- `group String @default("")` — optional task group/category
- `completedById String?`
- `removedAt DateTime?`
- `removedById String?`
- `removalReason String @default("")`

Compatibility: `done` is retained as a derived mirror — `done=true` only for
COMPLETED. Setting `done=true` maps to COMPLETED and `done=false` maps to PENDING
for existing PM/checklist review calls. Existing rows with `done=true` are
backfilled to COMPLETED after `db:push`. NOT_APPLICABLE is satisfied but is not
reported as `done`.

Satisfied rules:

- COMPLETED and NOT_APPLICABLE satisfy a required item.
- BLOCKED never satisfies.
- NOT_APPLICABLE and BLOCKED require a non-empty reason.
- COMPLETED records completing user and timestamp.
- Reopening a completed item requires supervisor permission and a reason; audit
  records old/new status.
- Response/notes edits only move PENDING → IN_PROGRESS; they do not auto-complete
  the item. The technician explicitly marks completion.
- A required BLOCKED item blocks submission. An optional BLOCKED item does not
  block submission but notifies the supervisor and is shown in progress totals.

### 5. Edit and soft-remove policy

- Assigned technician or `work_orders_update`: add/edit items while the Work
  Order is open.
- Supervisors (`isSupervisorPlus(role)`, matching the existing close/reopen
  guards) may also edit/reopen items while the Work Order is COMPLETED awaiting
  review.
- No checklist changes after CLOSED/CANCELLED; reopen the Work Order first.
- Removal is soft: `removedAt`, `removedById`, `removalReason`; rows are hidden
  from execution/progress but retained for audit.
- Removing a required, safety-critical or completed item requires supervisor
  permission and a reason. Technicians may remove optional pending items with a
  reason.
- Technician-editable fields: label, group, priority, expectedResult, unit,
  notes. Changing `required`, `safetyCritical` or `responseType` requires
  supervisor permission.
- Item edit/removal/reopen writes `AuditLog` with previous and new values.

### 6. Per-item evidence and measurements

- Evidence is a `Document` with `resourceType=WORK_ORDER`,
  `resourceId=workOrderId`, `category=WORK_ORDER`, and `label=<itemId>`.
- The existing upload route already accepts `itemId`; the UI adds an upload and
  thumbnail count per item.
- Submission validation counts photos by item label, not globally. Each item with
  `requiresPhoto=true` needs at least one linked photo.
- Measurements use the existing `response` + `unit` fields on NUMERIC items. No
  new measurement table is needed; values remain per checklist item and
  historical snapshots remain frozen.
- BEFORE/AFTER Work Order evidence remains unchanged for start/completion gates.

### 7. Backend validation helper

Create `src/lib/hms/checklist/execution.ts` with a pure
`validateChecklistForSubmission(items, photoCounts, mode)` function. `mode`
supports the existing pre-work `START` subset and the full `SUBMIT` rules; Start
keeps its existing "required items must be answered" gate so current behavior is
not broken. It returns the exact missing-item list for:

- required items not satisfied
- N/A without reason
- BLOCKED items with explanation
- required rich responses missing
- FAIL/NO without a finding note
- required per-item photo missing
- removed items ignored

Use it in Work Order `start`, `complete` and `close` inside the existing
transactions/re-reads. The route returns the exact outstanding item labels in
the error message and structured details.

### 8. Submit/review lifecycle

Do not add a second approval pipeline. The existing Work Order lifecycle is the
checklist review lifecycle:

- Technician completes checklist items then `complete` action → Work Order
  COMPLETED = checklist submitted for review.
- Set `ChecklistInstance.submittedAt` on submission.
- Supervisor reviews and closes → Work Order CLOSED = checklist reviewed; set
  `reviewedAt`, `reviewedById`, `reviewNotes`.
- Add a supervisor-only `return` action for `COMPLETED → IN_PROGRESS` with a
  required reason. It clears `submittedAt`, sets the checklist instance back to
  ACTIVE, notifies the technician, and never emits the invoice/completion event.
  This is the correction path when review fails; CLOSED→IN_PROGRESS remains the
  existing reopen for approved work.
- Reopen Work Order → checklist instance returns to ACTIVE; clear submitted and
  review fields; item-level reopen remains audited separately.

### 9. Notifications and audit

Audit actions (existing `AuditLog`):

- `WO_CHECKLIST_ADDED`, `WO_CHECKLIST_EDITED`, `WO_CHECKLIST_REMOVED`
- `WO_CHECKLIST_STATUS_CHANGED`, `WO_CHECKLIST_ITEM_REOPENED`
- `WO_CHECKLIST_PHOTO_UPLOADED`
- `CHECKLIST_SUBMITTED`, `CHECKLIST_REVIEWED`
- existing `CHECKLIST_GENERATED`, `CHECKLIST_COMPLETED`

Notifications:

- Supervisor notified when checklist is submitted for review (already part of
  Work Order submission) and when an item becomes BLOCKED.
- Assigned technician notified if a supervisor reopens a completed item.

### 10. Template administration

Add an idempotent seed script
`scripts/seed-checklist-templates.mjs` with one CORRECTIVE template per required
category plus GENERAL. Items include realistic tasks, mandatory flags, priority,
response type, units and required evidence where relevant.

Extend the existing template API/UI:

- Duplicate endpoint: `POST /api/v1/checklists/templates/{id}/duplicate`
- Existing PATCH handles edit/new version and activate/deactivate.
- UI: category/work-type selectors, per-item required/priority/response type/
  unit/evidence controls, edit, duplicate, activate/deactivate.
- Existing generated Work Order snapshots remain immutable because they are
  materialized copies.

### 11. Permissions

Use existing roles/permissions:

- `checklist.view` — read templates/instances; customer portal excluded.
- `checklist.generate`, `checklist.edit`, `checklist.approve`,
  `checklist.template_manage` — existing staff capabilities.
- Assigned technician may manage execution items for their own Work Order.
- Supervisor (`work_orders_assign`) may review, reopen items, edit/remove
  protected items with reasons.
- Customer sees only approved completion summary; no internal notes/evidence.

Work Order detail API access continues through `assertViewWorkOrder`; list/detail
queries keep technician scoping.

### 12. UI changes on Work Order detail

- Keep the inline checklist card (mobile-first, no wide tables).
- Show progress: completed, pending, blocked, N/A, total, percentage.
- Per item: status badge, description, required/safety badges, evidence count,
  remarks, measurement input, complete/reopen, N/A and blocked actions with
  reason prompts, edit and remove controls per role.
- Add item form includes label, optional group/category, priority, mandatory,
  response type, unit, remarks, evidence-required.
- Per-item evidence upload using existing camera/photo uploader and MinIO route.
- Submitted/closed states are read-only except supervisor review actions.

## Database Changes

`prisma/schema.prisma` only, additive:

```prisma
model WorkOrderChecklistItem {
  // existing fields …
  status        String   @default("PENDING")
  statusReason  String   @default("")
  group         String   @default("")
  completedById String?
  removedAt     DateTime?
  removedById   String?
  removalReason String   @default("")
}

model ChecklistInstance {
  // existing fields …
  submittedAt  DateTime?
  reviewedAt   DateTime?
  reviewedById String?
  reviewNotes  String   @default("")
}
```

Apply with `bun run db:push`. Backfill legacy `done=true` rows to COMPLETED.

## Files Expected to Change

- `prisma/schema.prisma`
- `scripts/seed-checklist-templates.mjs`
- `scripts/work-order-checklist-lifecycle.test.ts`
- `src/lib/hms/constants.ts` — supervisor `return` transition
- `src/lib/hms/checklist/context.ts` — canonical categories
- `src/lib/hms/checklist/types.ts` — optional item group
- `src/lib/hms/checklist/engine.ts` — transactional auto-generation helper,
  canonical template matching, idempotency
- `src/lib/hms/checklist/execution.ts` — new final validation helper
- `src/lib/hms/workflows/handlers.ts` — safety-net generation
- `src/lib/hms/workflows/settings.ts` — default auto-generation on
- `src/app/api/v1/work-orders/route.ts` — generate inside create transaction
- `src/app/api/v1/work-orders/_lib.ts` — include status/removed fields
- `src/app/api/v1/work-orders/[id]/checklist/route.ts` — extended add/status
- `src/app/api/v1/work-orders/[id]/checklist/[itemId]/route.ts` — new edit,
  status and soft-delete endpoint
- `src/app/api/v1/work-orders/[id]/transition/route.ts` — validation helper,
  per-item photo counts, instance review timestamps, blocked notification
- `src/app/api/v1/work-orders/[id]/photos/route.ts` — unchanged contract,
  audit/notification extension if needed
- `src/app/api/v1/checklists/templates/[id]/duplicate/route.ts` — new
- `src/app/api/v1/checklists/templates/route.ts` / detail route — canonical
  categories, duplicate support if needed
- `src/components/hms/modules/work-orders/detail-page.tsx` — checklist
  execution UI
- `src/components/hms/modules/work-orders/checklist-item-evidence.tsx` — new
  per-item evidence control (if keeping detail page manageable)
- `src/components/hms/modules/checklists/templates-page.tsx` — full template
  editor
- `src/components/hms/modules/checklists/detail-page.tsx` — status-aware
  execution compatibility

## Testing

`scripts/work-order-checklist-lifecycle.test.ts`, run with
`bun --conditions=react-server`, wrapped in a transaction that always rolls back:

1. Auto-generation for each seeded category selects the right template.
2. Auto-generation is idempotent; repeated calls create no duplicate instance or
   items.
3. Work Order create transaction creates Work Order + instance + items together.
4. Template edit/version updates do not alter an existing materialized snapshot.
5. Add item saves; edit item stores previous/new audit; soft removal hides item
   but retains row.
6. Status transitions: COMPLETED records user/time; N/A and BLOCKED require
   reasons; reopening requires supervisor permission.
7. Per-item evidence validation passes only when each `requiresPhoto` item has
   a linked Document.
8. Incomplete required items block submission with exact item labels.
9. Blocked item blocks submission and queues supervisor notification.
10. Reopen/return clear submitted/reviewed timestamps and reactivate the instance.

Also run `bunx tsc --noEmit` filtered to changed files and `bunx eslint` on all
changed files. Do not run a production build in the live canonical repo.

## Acceptance Mapping

- Every created Work Order receives a category-appropriate checklist
  transactionally and idempotently.
- All 12 category templates plus GENERAL are seeded and admin-editable.
- Technicians can add, edit, soft-remove, complete, reopen (where authorized),
  add remarks/measurements and upload per-item evidence.
- Mandatory/safety/completed item removal is protected and audited.
- Backend blocks submission with exact missing items.
- Work Order submit/close remains the review lifecycle.
- Mobile-friendly inline checklist UI.
- Existing Work Orders, PM, complaints and invoice flows remain intact.

## Accepted Calls

- The review correction path adds a supervisor-only `return` transition
  (`COMPLETED → IN_PROGRESS`) instead of overloading `close` or `reopen`.
- `done` is a derived mirror of COMPLETED; N/A satisfies validation but is not
  "done".
- Start keeps its existing pre-work required-response gate; full submission
  validation is used at complete/close.
- Optional BLOCKED items notify but do not block; required BLOCKED items block.
- Protected actions use the existing `isSupervisorPlus(role)` check, not a new
  permission.
- Explicit manual labels still create a MANUAL ChecklistInstance.
- "Description" maps to `label`; optional task group gets a new `group` column.
- Automation default changes in code only; explicit admin overrides are not
  rewritten.

## Outstanding / Left to Builder

- Exact wording/visual treatment of the mobile status controls and reason prompts.
- Whether the template editor is a modal or an inline expansion; either is fine
  as long as existing page structure is preserved.
- Whether to expose a separate "duplicate" audit action name or reuse
  `CHECKLIST_TEMPLATE_CREATED`; prefer an explicit `CHECKLIST_TEMPLATE_DUPLICATED`.
- Live-DB seeding is a data change and must be run explicitly during deployment.
