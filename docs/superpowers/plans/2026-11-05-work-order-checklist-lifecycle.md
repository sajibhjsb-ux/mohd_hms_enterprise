# Work Order Checklist Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every Work Order automatically receives a category-appropriate checklist; technicians manage it with statuses, remarks, measurements, per-item evidence and audited soft removal; supervisors review, return or close it; backend validation blocks incomplete submission.

**Architecture:** Extend the existing centralized checklist engine (`ChecklistTemplate` → `ChecklistInstance` → materialized `WorkOrderChecklistItem`) in place. Auto-generation moves into the Work Order creation transaction with template-first selection and a GENERAL fallback. Execution rules live in a pure helper used by both routes and tests. Work Order COMPLETED remains "submitted for review"; CLOSED remains final approval, with a new supervisor-only return transition.

**Tech Stack:** Next.js App Router, TypeScript, Prisma/PostgreSQL, Zod, MinIO-backed Document rows, existing notification/audit services, Bun scripts.

**Spec:** `docs/superpowers/specs/2026-11-05-work-order-checklist-lifecycle-design.md`

## Global Constraints

- Follow the existing project structure; do not create a parallel checklist app or execution model.
- Do not run `next build` in the live canonical repo.
- Do not commit, amend, push or create a PR; the user has not asked and the working tree contains unrelated changes.
- Preserve existing Work Order, complaint, PM, invoice and realtime behavior.
- Never hard-delete checklist rows; removal is soft (`removedAt`, `removedById`, `removalReason`).
- Never store attachments locally; use the existing `storage`/MinIO path and `Document` metadata.
- All checklist mutation routes must enforce authorization and write `AuditLog` entries.
- Use `bun run db:push` for schema changes; no migrations directory exists.
- Changed-file typecheck filter: `bunx tsc --noEmit`; the full repo has pre-existing errors in scripts.
- Lint changed files with `bunx eslint <files>`.
- Run integration tests with `bun --conditions=react-server scripts/work-order-checklist-lifecycle.test.ts`.
- Live DB access: `docker exec hms-postgres psql -U mohd -d mohd_hms`.
- Mark known ceilings with `ponytail:` comments naming the upgrade path.

## Review Focus

1. Creating a Work Order with no matching template must still produce a usable GENERAL checklist, never a bare Work Order.
2. Creating the same Work Order path twice (retry/event) must not create duplicate instances or items.
3. A required item marked BLOCKED or NOT_APPLICABLE must behave differently: blocked stops submission, N/A satisfies only with a reason.
4. Per-item `requiresPhoto` must not be satisfied by a photo attached to a different item.
5. A technician must not remove safety-critical, required or already-completed evidence; supervisor removal must be audited.
6. Editing a template after a Work Order exists must not change that Work Order's materialized snapshot.
7. Item response edits must not silently mark an item COMPLETED.

---

### Task 1: Schema extensions, backfill and category templates

**Files:**
- Modify: `prisma/schema.prisma` (`WorkOrderChecklistItem`, `ChecklistInstance`)
- Create: `scripts/seed-checklist-templates.mjs`
- Test: live DB queries via `docker exec hms-postgres psql ...`

**Interfaces:**
- Produces new columns: `WorkOrderChecklistItem.status/statusReason/group/completedById/removedAt/removedById/removalReason`; `ChecklistInstance.submittedAt/reviewedAt/reviewedById/reviewNotes`.

- [ ] **Step 1: Add the additive schema fields**

In `WorkOrderChecklistItem` add:

```prisma
status        String    @default("PENDING") // PENDING | IN_PROGRESS | COMPLETED | NOT_APPLICABLE | BLOCKED
statusReason  String    @default("")
group         String    @default("")
completedById String?
removedAt     DateTime?
removedById   String?
removalReason String    @default("")
```

In `ChecklistInstance` add:

```prisma
submittedAt  DateTime?
reviewedAt   DateTime?
reviewedById String?
reviewNotes  String   @default("")
```

- [ ] **Step 2: Push and regenerate Prisma**

Run: `bun run db:push && bun run db:generate`
Expected: schema sync succeeds, Prisma client contains the new fields.

- [ ] **Step 3: Write the idempotent seed/backfill script**

`scripts/seed-checklist-templates.mjs` uses `@prisma/client` and:
- Defines one CORRECTIVE template per category: `HVAC`, `ELECTRICAL`, `PLUMBING`, `FIRE_PROTECTION`, `GENERATOR`, `LIFT`, `BUILDING`, `CIVIL`, `MECHANICAL`, `PEST_CONTROL`, `CLEANING`, `LANDSCAPE`, `GENERAL`.
- Each item uses the existing shape `{label, required, responseType, priority, safetyCritical, expectedResult, unit, requiresPhoto, failRequiresFinding}`.
- HVAC includes the 14 example tasks from the user spec; Electrical, Plumbing, Fire Protection and Generator include the user-spec example tasks; the remaining categories use equivalent 8–12 task lists.
- Idempotency key: existing template with the same `name` and `category` is skipped.
- After seeding, backfills `WorkOrderChecklistItem` where `done=true AND status="PENDING"` to `{status:"COMPLETED", doneAt: doneAt ?? now}`.
- Prints seeded/skipped counts.

- [ ] **Step 4: Run the seed against the live DB**

Run: `bun scripts/seed-checklist-templates.mjs`
Expected: prints 13 seeded (or fewer on repeat because existing seeds are skipped).

- [ ] **Step 5: Verify DB state**

Run:

```bash
docker exec hms-postgres psql -U mohd -d mohd_hms -c "select category, count(*) from \"ChecklistTemplate\" where status='ACTIVE' group by 1 order by 1;"
```

Expected: all 12 categories plus `GENERAL`.

- [ ] **Step 6: Verify no legacy completed item is still PENDING**

Run:

```bash
docker exec hms-postgres psql -U mohd -d mohd_hms -c "select count(*) from \"WorkOrderChecklistItem\" where done=true and status='PENDING';"
```

Expected: `0`.

---

### Task 2: Canonical categories, work types and item group type

**Files:**
- Modify: `src/lib/hms/checklist/context.ts`
- Modify: `src/lib/hms/checklist/types.ts`
- Modify: `src/lib/hms/checklist/engine.ts`
- Test: pure assertions in `scripts/work-order-checklist-lifecycle.test.ts` (created in Task 10; add assertions there)

**Interfaces:**
- Produces: `export function canonicalizeCategory(raw: string | null | undefined): string`
- Produces: `export function inferCategory(...texts: string[]): string`
- Produces: `export function inferWorkType(sourceType: string, title: string, description: string): string`
- Extends `ChecklistItemSpec` with `group?: string`.
- `findBestTemplate` compares canonicalized template categories.

- [ ] **Step 1: Add canonicalization**

In `context.ts` add an alias map:

```ts
const CATEGORY_ALIASES: Record<string, string> = {
  POWER: "ELECTRICAL", ELEC: "ELECTRICAL", ELECTRIC: "ELECTRICAL",
  FIRE_SAFETY: "FIRE_PROTECTION", FIRE: "FIRE_PROTECTION",
  VERTICAL_TRANSPORT: "LIFT", ELEVATOR: "LIFT", LIFT_ESCALATOR: "LIFT",
  BUILDING_MAINTENANCE: "BUILDING", CIVIL_WORKS: "CIVIL",
  PEST: "PEST_CONTROL",
};
export function canonicalizeCategory(raw: string | null | undefined): string {
  const v = (raw ?? "").trim().toUpperCase().replace(/[\s-]+/g, "_");
  if (!v) return "GENERAL";
  return CATEGORY_ALIASES[v] ?? v;
}
```

Apply canonicalization when setting `ctx.category` for COMPLAINT, WORK_ORDER/PM and IRMS equipment categories. Export `inferCategory` and `inferWorkType`.

- [ ] **Step 2: Add `group` to the item spec**

In `types.ts` add `group?: string;` with the comment that it is an optional task group/category. Include it in `ChecklistItemSpec`.

- [ ] **Step 3: Canonicalize template matching**

In `engine.ts` `findBestTemplate`, compare `canonicalizeCategory(t.category)` against `ctx.category` for exact/category matches. Keep work-type matching unchanged. Preserve GENERAL fallback.

- [ ] **Step 4: Run typecheck**

Run: `bunx tsc --noEmit 2>&1 | grep -E 'checklist/(context|types|engine)'`
Expected: no output.

---

### Task 3: Pure execution rules and item update logic

**Files:**
- Create: `src/lib/hms/checklist/execution.ts`
- Test: `scripts/work-order-checklist-lifecycle.test.ts`

**Interfaces:**

```ts
export type ChecklistExecutionItem = {
  id?: string; label: string; status: string; statusReason: string;
  done: boolean; required: boolean; responseType: string; response: string;
  notes: string; requiresPhoto: boolean; failRequiresFinding: boolean;
  safetyCritical?: boolean; removedAt?: Date | string | null;
};

export type ChecklistPhotoCounts = Record<string, number>;

export function validateChecklistForSubmission(
  items: ChecklistExecutionItem[],
  photoCounts: ChecklistPhotoCounts,
  mode: "START" | "SUBMIT",
): { ok: true } | { ok: false; missing: string[] };

export function resolveChecklistItemUpdate(input: {
  current: ChecklistExecutionItem & { priority?: string; expectedResult?: string; unit?: string; group?: string };
  patch: {
    label?: string; group?: string; priority?: string; expectedResult?: string;
    unit?: string; notes?: string; response?: string; status?: string;
    statusReason?: string; done?: boolean; required?: boolean;
    safetyCritical?: boolean; responseType?: string;
  };
  actorId: string;
  isSupervisor: boolean;
  now: Date;
}): { data: Record<string, unknown>; previous: Record<string, unknown>; next: Record<string, unknown> };

export function canRemoveChecklistItem(item: ChecklistExecutionItem, isSupervisor: boolean): boolean;
```

Rules:
- Ignore `removedAt` items entirely.
- Satisfied = `status === "COMPLETED"` or `status === "NOT_APPLICABLE"` or legacy `done === true` (when status is PENDING).
- `NOT_APPLICABLE` and `BLOCKED` require non-empty `statusReason` in SUBMIT.
- Required `BLOCKED` items block SUBMIT; optional blocked items do not block.
- START mode only checks required items have a response/satisfied state; it does not require per-item photos or N/A reasons.
- SUBMIT mode also checks required rich responses, FAIL/NO notes, and per-item photo counts.
- Missing labels are returned as human-readable strings, e.g. `Task result: Inspect compressor`, `Blocked task: Replace fan — awaiting part`, `Photo evidence: Inspect compressor`.
- `resolveChecklistItemUpdate`: `done=true` → COMPLETED; `done=false` → PENDING. Setting status COMPLETED stamps `done:true`, `completedAt: now`, `completedById: actorId`. Reopening COMPLETED requires `isSupervisor` unless status is set to IN_PROGRESS by the same supervisor; throw `Errors.forbidden()` from `@/lib/hms/api` when not allowed. Changing `required`, `safetyCritical` or `responseType` requires `isSupervisor`. N/A/BLOCKED without reason throws `Errors.badRequest(...)`. Response/notes changes move PENDING → IN_PROGRESS only. `done` mirrors COMPLETED only.
- `canRemoveChecklistItem`: supervisors can remove anything; technicians only non-required, non-safety-critical, non-completed items.

- [ ] **Step 1: Write failing assertions first**

Add to the test script (it can start as a standalone file that fails until this module exists):

```ts
const hvac = (over: Partial<ChecklistExecutionItem> = {}): ChecklistExecutionItem => ({
  id: "i1", label: "Inspect compressor", status: "PENDING", statusReason: "",
  done: false, required: true, responseType: "CHECKBOX", response: "", notes: "",
  requiresPhoto: false, failRequiresFinding: false, ...over,
});
assert.equal(validateChecklistForSubmission([hvac()], {}, "SUBMIT").ok, false);
assert.equal(validateChecklistForSubmission([hvac({ status: "NOT_APPLICABLE", statusReason: "Not installed" })], {}, "SUBMIT").ok, true);
assert.equal(validateChecklistForSubmission([hvac({ status: "NOT_APPLICABLE" })], {}, "SUBMIT").ok, false);
assert.equal(validateChecklistForSubmission([hvac({ status: "BLOCKED", statusReason: "Awaiting part" })], {}, "SUBMIT").ok, false);
assert.equal(validateChecklistForSubmission([hvac({ status: "BLOCKED", statusReason: "Awaiting part", required: false })], {}, "SUBMIT").ok, true);
assert.equal(validateChecklistForSubmission([hvac({ requiresPhoto: true, status: "COMPLETED" })], {}, "SUBMIT").ok, false);
assert.equal(validateChecklistForSubmission([hvac({ requiresPhoto: true, status: "COMPLETED" })], { i1: 1 }, "SUBMIT").ok, true);
```

- [ ] **Step 2: Run and confirm failure**

Run: `bun --conditions=react-server scripts/work-order-checklist-lifecycle.test.ts`
Expected: FAIL because `execution.ts` / the assertions do not exist yet.

- [ ] **Step 3: Implement the helper**

Implement the signatures above, importing `Errors` from `@/lib/hms/api`. Keep it deterministic and side-effect free except explicit throws from `resolveChecklistItemUpdate`.

- [ ] **Step 4: Run the assertions**

Run: `bun --conditions=react-server scripts/work-order-checklist-lifecycle.test.ts`
Expected: PASS for these assertions.

---

### Task 4: Transactional automatic checklist generation

**Files:**
- Modify: `src/lib/hms/checklist/engine.ts`
- Modify: `src/lib/hms/workflows/settings.ts`
- Modify: `src/app/api/v1/work-orders/route.ts`
- Test: `scripts/work-order-checklist-lifecycle.test.ts`

**Interfaces:**

```ts
export type NewWorkOrderChecklistInput = {
  workOrderId: string;
  title: string;
  description: string;
  sourceType: string;
  complaintId?: string | null;
  complaintTitle?: string | null;
  complaintDescription?: string | null;
  equipmentCategory?: string | null;
  manualLabels?: string[];
  actorId?: string | null;
};

export async function ensureChecklistForNewWorkOrderTx(
  tx: Prisma.TransactionClient,
  input: NewWorkOrderChecklistInput,
): Promise<{ instanceId: string | null; created: boolean; origin: string; itemCount: number }>;
```

- [ ] **Step 1: Add a GENERAL fallback item set**

In `engine.ts` define a 6-item GENERAL corrective fallback used only when no DB template exists: inspect condition, identify fault, perform approved corrective action, functional test, clean work area, record final result. Mark safety-critical where appropriate and use `required:true` only for genuine mandatory checks.

- [ ] **Step 2: Add transaction-scoped template lookup**

Refactor `findBestTemplate` to call `findBestTemplateTx(tx, ctx)`; the existing public function passes `db`. Compare canonicalized categories. Reuse the same exact → category → work-type → GENERAL order.

- [ ] **Step 3: Implement `ensureChecklistForNewWorkOrderTx`**

Order:
1. If a non-removed item count > 0 or a ChecklistInstance exists for the WO, return `{ created:false, ... }`.
2. If `complaintId`, find an APPROVED unattached instance for that complaint; if present call `materializeInstance(tx, instance.id, workOrderId)` and return its origin.
3. If `manualLabels?.length`, create a MANUAL ACTIVE instance and items.
4. Else derive category via `canonicalizeCategory(equipmentCategory)` falling back to `inferCategory(complaintTitle, complaintDescription, title, description)` and work type via `inferWorkType`.
5. Find the best template; if none use the fallback.
6. Create `ChecklistInstance` with `code` via `nextChecklistCode(tx)`, `sourceType:"WORK_ORDER"`, `sourceId`, `workOrderId`, `origin`, `status:"ACTIVE"`, `approvalRequired:false`, `itemsJson`, `templateId/templateVersion`.
7. `createMany` `WorkOrderChecklistItem` rows with `status:"PENDING"`, `group`, and all existing fields.
8. Return created counts.

- [ ] **Step 4: Call it inside the Work Order creation transaction**

In `src/app/api/v1/work-orders/route.ts`, after `tx.workOrder.create` and complaint sync, call:
```ts
const checklist = await ensureChecklistForNewWorkOrderTx(tx, { ... });
```
Read equipment category before the transaction (already selected for validation, add `category`) and complaint title/description (extend the complaint select). After commit, audit `CHECKLIST_GENERATED` or `CHECKLIST_ATTACHED` when `created` is true.

Remove the direct `checklist: { create: ... }` block; manual labels now flow through the helper.

- [ ] **Step 5: Change the automation default**

In `settings.ts` change `auto_checklist_for_work_orders` default to `"on"`. Do not rewrite existing Setting rows.

- [ ] **Step 6: Add transaction tests**

In the test script create a temp customer, equipment (category `HVAC`), and WorkOrder inside `db.$transaction` with the rollback sentinel; call `ensureChecklistForNewWorkOrderTx`; assert:
- instance exists and is ACTIVE
- items > 0 and include an HVAC label
- calling again returns `created:false` and same item count
- category `POWER` selects the ELECTRICAL template via canonicalization

Run: `bun --conditions=react-server scripts/work-order-checklist-lifecycle.test.ts`
Expected: PASS.

---

### Task 5: Work Order checklist item APIs

**Files:**
- Modify: `src/app/api/v1/work-orders/[id]/checklist/route.ts`
- Create: `src/app/api/v1/work-orders/[id]/checklist/[itemId]/route.ts`
- Modify: `src/app/api/v1/work-orders/_lib.ts`
- Test: lifecycle test DB assertions

**Interfaces:**
- `POST /api/v1/work-orders/{id}/checklist` accepts `{label, required?, responseType?, priority?, group?, expectedResult?, unit?, requiresPhoto?, safetyCritical?, notes?}`.
- `PATCH /api/v1/work-orders/{id}/checklist/{itemId}` accepts any mutable item field plus `{status, statusReason, done}`.
- `DELETE /api/v1/work-orders/{id}/checklist/{itemId}?reason=...` soft-removes.

- [ ] **Step 1: Extend add-item**

Add the optional fields to `postSchema`, create the item with `status:"PENDING"` and `group`, and audit `WO_CHECKLIST_ADDED` with the previous/new item snapshot and `workOrderId`.

- [ ] **Step 2: Create the item route**

`withId` resolves both params. Add a loader that:
- fetches the item and verifies `item.workOrderId === id`;
- fetches the WO and calls `assertViewWorkOrder`;
- allows the assigned technician or `work_orders_update` while WO status is open (`PENDING/ACCEPTED/IN_PROGRESS/ON_HOLD`);
- allows `isSupervisorPlus` when status is `COMPLETED`;
- rejects edits after `CLOSED/CANCELLED` with an explanatory `invalidTransition`.

PATCH uses `resolveChecklistItemUpdate`, updates the row, audits `WO_CHECKLIST_STATUS_CHANGED` or `WO_CHECKLIST_EDITED` with `{previous,next}`. When the new status is `BLOCKED`, call `notifyRole("SUPERVISOR", ...)` with the item label, reason and Work Order code.

DELETE requires `reason` (query param) for every removal. Use `canRemoveChecklistItem`; if false return `Errors.forbidden("Completed, required or safety-critical checklist items require supervisor authorization and a reason.")`. Set `removedAt`, `removedById`, `removalReason`, audit `WO_CHECKLIST_REMOVED` with previous status/label.

- [ ] **Step 3: Hide removed items from detail responses**

In `_lib.ts` change the checklist include to `{ where: { removedAt: null }, orderBy: { sortOrder: "asc" } }`. Keep removed rows in the DB for audit.

- [ ] **Step 4: Audit/DB test**

In the lifecycle test create a Work Order + auto checklist inside the rollback transaction, then:
- update an item's label/notes and assert audit metadata is written (query `AuditLog`);
- set `NOT_APPLICABLE` without reason and expect a throw;
- set `BLOCKED` with reason and assert supervisor notification row exists;
- soft-remove an optional item and assert `removedAt` is set and the detail-style query excludes it;
- attempt to remove a completed required item as a technician and expect a throw.

Run: `bun --conditions=react-server scripts/work-order-checklist-lifecycle.test.ts`
Expected: PASS.

---

### Task 6: Transition validation, per-item evidence, review timestamps and return action

**Files:**
- Modify: `src/lib/hms/constants.ts`
- Modify: `src/app/api/v1/work-orders/[id]/transition/route.ts`
- Test: lifecycle test

**Interfaces:**
- `WO_TRANSITIONS.COMPLETED` becomes `["CLOSED", "IN_PROGRESS"]`.
- Transition body gains action `"return"` with required `reason`.
- `complete` sets `ChecklistInstance.submittedAt = now`; `close` sets `reviewedAt/reviewedById/reviewNotes`; `return` and `reopen` clear them and set instance ACTIVE.

- [ ] **Step 1: Add the return transition**

In `constants.ts` add `IN_PROGRESS` to `COMPLETED`. Do not remove the existing CLOSED reopen path.

- [ ] **Step 2: Replace duplicated checklist validation**

In `transition/route.ts`, centralize loading:
```ts
async function loadExecutionChecklist(tx: Prisma.TransactionClient, workOrderId: string) {
  const items = await tx.workOrderChecklistItem.findMany({
    where: { workOrderId, removedAt: null },
    select: { id:true,label:true,status:true,statusReason:true,done:true,required:true,
      responseType:true,response:true,notes:true,requiresPhoto:true,
      failRequiresFinding:true,safetyCritical:true },
  });
  const photos = await tx.document.findMany({
    where: { resourceType:"WORK_ORDER", resourceId:workOrderId, category:"WORK_ORDER",
      label:{ in: items.filter(i=>i.requiresPhoto).map(i=>i.id) } },
    select: { label:true },
  });
  const photoCounts: Record<string, number> = {};
  for (const p of photos) photoCounts[p.label] = (photoCounts[p.label] ?? 0) + 1;
  return { items, photoCounts };
}
```
Use `validateChecklistForSubmission(items, photoCounts, "SUBMIT")` in `complete` and `close`; throw `Errors.invalidTransition` with the missing list. Use mode `"START"` in `start` for the existing pre-work gate, preserving before-work photo requirements.

- [ ] **Step 3: Update `complete`**

When checklist validation passes, update the linked `ChecklistInstance` (if ACTIVE) with `submittedAt: now`; audit `CHECKLIST_SUBMITTED`; keep the existing supervisor notification.

- [ ] **Step 4: Update `close`**

Set `reviewedAt: now`, `reviewedById: user.id`, `reviewNotes: body.note ?? ""` when completing the instance. Keep existing `CHECKLIST_COMPLETED` audit/event.

- [ ] **Step 5: Add `return` action**

Add case `"return"`:
- `assertWoTransition("IN_PROGRESS", from, ...)`.
- require `isSupervisorPlus(user.role)` and a non-empty reason.
- transaction re-reads status; require `COMPLETED`.
- update WO: `status:"IN_PROGRESS"`, `completedAt:null`, `notes` maybe append reason.
- update instance: `status:"ACTIVE"`, `submittedAt:null`, `reviewedAt:null`, `reviewedById:null`, `reviewNotes:""`, `completedAt:null`.
- audit `WORK_ORDER_RETURNED` and `CHECKLIST_RETURNED` with reason.
- notify the assigned technician.
- do NOT emit `WORK_ORDER_COMPLETED` or close the complaint.

- [ ] **Step 6: Update `reopen`**

Clear `submittedAt/reviewedAt/reviewedById/reviewNotes` in the checklist instance update, not just `completedAt`.

- [ ] **Step 7: Test**

Add assertions for:
- incomplete required item blocks both `complete` and `close` with the label in the error;
- per-item photo for item A does not satisfy item B;
- complete sets `submittedAt`;
- return is supervisor-only, requires reason, clears submitted fields, leaves status IN_PROGRESS and no invoice event.

Run: `bun --conditions=react-server scripts/work-order-checklist-lifecycle.test.ts`
Expected: PASS.

---

### Task 7: Work Order checklist UI and per-item evidence

**Files:**
- Modify: `src/components/hms/modules/work-orders/detail-page.tsx`
- Create: `src/components/hms/modules/work-orders/checklist-item-evidence.tsx`

**Interfaces:**
- `ChecklistItem` type gains `status`, `statusReason`, `group`, `completedById`.
- New component `ChecklistItemEvidence({ workOrderId, itemId, canUpload, onChanged })`.

- [ ] **Step 1: Extend the detail type and progress logic**

Add the new fields. Compute:
```ts
const completed = items.filter(i => i.status === "COMPLETED").length;
const pending = items.filter(i => i.status === "PENDING" || i.status === "IN_PROGRESS").length;
const blocked = items.filter(i => i.status === "BLOCKED").length;
const na = items.filter(i => i.status === "NOT_APPLICABLE").length;
```
Display `Progress: X / N (pct%)` plus completed/pending/blocked/N/A badges.

- [ ] **Step 2: Add item status controls**

For each editable item show:
- Complete / Reopen toggle (PATCH `status`; reopen only when supervisor).
- `N/A` and `Blocked` buttons that prompt for a reason (`window.prompt`) and PATCH `status` + `statusReason`.
- Status badge with tone (PENDING gray, IN_PROGRESS amber, COMPLETED green, NOT_APPLICABLE slate, BLOCKED red).
- Remarks input (existing notes) and measurement input for NUMERIC (existing response/unit).

Keep mobile tap targets ≥44px and no wide tables.

- [ ] **Step 3: Add edit and soft-remove controls**

Add inline edit state for one item at a time: label, group, priority, expectedResult, unit, required (supervisor), safetyCritical (supervisor), responseType (supervisor). Save via PATCH. Delete opens a reason prompt and calls `api.del("/checklist/{itemId}?reason=...")`. Hide delete for non-removable items and show a tooltip/message explaining supervisor authorization.

- [ ] **Step 4: Extend the add-item form**

Add optional inputs/selects for group, priority, response type, unit, required and requiresPhoto. POST the extended payload; reload detail on success.

- [ ] **Step 5: Add per-item evidence component**

`checklist-item-evidence.tsx`:
- Fetch `/api/v1/work-orders/{id}/photos` on mount, filter `label === itemId`.
- Show count and thumbnails (`/photos/{photoId}/file`).
- If `canUpload`, render `PhotoUploader` with `onUpload` building FormData containing `file`, `itemId`, `uploadId`; POST to the existing photos route; call `onChanged`.
- Provide a visible "View evidence" count even when read-only.

Render it under each item, with `requiresPhoto` showing a warning when count is 0.

- [ ] **Step 6: Run typecheck/lint**

Run: `bunx tsc --noEmit 2>&1 | grep -E 'work-orders/(detail-page|checklist-item-evidence)'` and `bunx eslint src/components/hms/modules/work-orders/detail-page.tsx src/components/hms/modules/work-orders/checklist-item-evidence.tsx`.
Expected: no output.

---

### Task 8: Template duplicate API and full template editor

**Files:**
- Create: `src/app/api/v1/checklists/templates/[id]/duplicate/route.ts`
- Modify: `src/components/hms/modules/checklists/templates-page.tsx`
- Test: lifecycle test API-level assertion or direct DB check

**Interfaces:**
- `POST /api/v1/checklists/templates/{id}/duplicate` returns the new template; copies categories, work type, description, items, approval required; name becomes `"<name> (copy)"`.
- UI uses existing PATCH for edits/status and POST duplicate.

- [ ] **Step 1: Add duplicate route**

Load the template, create a copy with `version:1`, `status:"ACTIVE"`, `createdById:user.id`, and a `ChecklistTemplateVersion` row; audit `CHECKLIST_TEMPLATE_DUPLICATED` with source and new ids. Permission: `checklist_template_manage`.

- [ ] **Step 2: Extend the template page state**

Add `editingId`, `form` (name/category/workType/description/items), `duplicatingId`, `statusBusy`. Reuse one form for create and edit.

- [ ] **Step 3: Build the item editor**

Each item row controls: label, required (mandatory), priority, responseType, unit, requiresPhoto, safetyCritical, remove/add. Category select uses `PM_TEMPLATE_CATEGORIES`; work type uses `CHECKLIST_WORK_TYPES`.

- [ ] **Step 4: Wire actions**

- Save create → POST.
- Save edit → PATCH with `{...fields, items, changelog}`.
- Duplicate → POST duplicate, reload.
- Activate/deactivate → PATCH `{status}`.
- Show version and item count on each card.

- [ ] **Step 5: Verify**

Run: `bunx tsc --noEmit 2>&1 | grep -E 'checklists/templates'` and `bunx eslint src/app/api/v1/checklists/templates/[id]/duplicate/route.ts src/components/hms/modules/checklists/templates-page.tsx`.
Expected: no output.

---

### Task 9: Workflow safety net and notification alignment

**Files:**
- Modify: `src/lib/hms/workflows/handlers.ts`
- Modify: `src/lib/hms/checklist/engine.ts`

**Interfaces:**
- `autoGenerateForWorkOrder` ignores removed items and closed WOs.
- Event handler remains idempotent when the create transaction already generated items.

- [ ] **Step 1: Update idempotency checks**

Change item counts to `where: { workOrderId, removedAt: null }`. Include `CLOSED` in "not open" checks (`["COMPLETED","CLOSED","CANCELLED"]`). Do the same in `autoAttachForComplaint` target selection and `materializeInstance` existing-count guard.

- [ ] **Step 2: Keep the event handler as a safety net**

No behavior change for manual creation; it should return "work order already has checklist items" after transactional generation. Do not auto-run AI.

- [ ] **Step 3: Verify**

Run: `bunx eslint src/lib/hms/workflows/handlers.ts src/lib/hms/checklist/engine.ts`.
Expected: clean.

---

### Task 10: Integration test, verification and implementation report

**Files:**
- Create/modify: `scripts/work-order-checklist-lifecycle.test.ts`
- No production code changes unless verification exposes a bug.

- [ ] **Step 1: Complete the DB scenarios**

Use the existing sentinel-rollback pattern (`throw new Rollback()` at the end, catch only that error). Cover:
1. HVAC/Electric/Plumbing/GENERAL template selection via canonical categories.
2. Auto-generation creates instance + items in one transaction.
3. Second call is idempotent.
4. Template edit after generation does not change materialized items.
5. Add/edit/soft-remove item behavior and audit rows.
6. Status rules: N/A reason, blocked reason, completed user/time, reopen permission.
7. Per-item photo validation.
8. Submission/return/close review timestamps.
9. Blocked required item blocks; optional blocked does not.
10. Existing checklist data remains readable after backfill.

- [ ] **Step 2: Run the integration test**

Run: `bun --conditions=react-server scripts/work-order-checklist-lifecycle.test.ts`
Expected: `PASS — work-order checklist lifecycle` and transaction rolled back.

- [ ] **Step 3: Typecheck changed files**

Run:
```bash
bunx tsc --noEmit 2>&1 | grep -E 'checklist|work-orders|complaints|workflows' || echo 'typecheck: no errors in changed files'
```
Expected: no changed-file errors.

- [ ] **Step 4: Lint changed files**

Run `bunx eslint` on every created/modified TS/TSX file.
Expected: clean.

- [ ] **Step 5: Verify live DB seed and schema**

Run the Task 1 psql checks again.
Expected: 13 templates, 0 legacy PENDING completed rows.

- [ ] **Step 6: Write the technical implementation report**

Report structure:
- Existing architecture findings
- Database changes and backfill
- Backend API changes
- Generation logic and idempotency
- Template management
- Permissions
- UI changes
- Audit/notifications
- Test results (actual command output)
- Files modified
- Outstanding issues / deployment notes

Do not claim the feature is deployed; state that production requires the normal build/deploy and that the seed script must be run once.

---

## Self-Review Notes

- Spec coverage is explicit in each task; no separate plan task for non-goals.
- Interface names are consistent: `ensureChecklistForNewWorkOrderTx`, `validateChecklistForSubmission`, `resolveChecklistItemUpdate`, `canRemoveChecklistItem`.
- Review Focus items map to: Task 4 (no-template fallback), Task 4/9 (idempotency), Task 3 (blocked vs N/A), Task 3/6 (per-item evidence), Task 5 (protected removal), Task 10 (template snapshot), Task 3 (no auto-complete).
