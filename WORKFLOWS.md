# Workflows — FacilityPro (MOHD.HMS ENTERPRISE)

Actual backend business workflows and authorization rules. Authoritative;
synchronized with `src/lib/hms/workflows/` and `src/app/api/v1/`.

## 1. Complaint creation
1. Customer submits Complaint with BEFORE evidence (multiple photos/videos,
   camera + gallery) and progress.
2. Server confirms upload; BEFORE media locked after submission — no ordinary
   further BEFORE uploads.
3. Backend creates Complaint row (status NEW), emits `COMPLAINT_CREATED`.
4. Notification: all eligible Admin + all eligible Supervisor + Complaint
   creator. **Never Super Admin.**
5. WhatsApp AI may create a Complaint only after customer confirmation;
   duplicates prevented; human handover supported.

## 2. Complaint review
1. Admin/Supervisor reviews the NEW Complaint.
2. Backend-authoritative status transition (NEW → ACCEPTED / STARTED / ...).
3. On ACCEPTED or STARTED, workflow `AUTO_CREATE_WORK_ORDER` fires if no Work
   Order exists yet (one per complaint, `sourceType=COMPLAINT`, idempotent).
   The created Work Order is `ACCEPTED` — accepted on the technician's behalf
   and ready to start; no separate technician acceptance step. If a `PENDING`
   Work Order already exists, it is activated in place (`WORK_ORDER_ACTIVATED`)
   instead of creating a duplicate.

## 3. Work Order generation
1. Work Order created linked to Complaint (`complaintId`), customer, equipment,
   technician (if assigned), title/description/priority. Complaint-driven
   auto-creation starts at `ACCEPTED` (ready to start); manual/other sources
   start at `PENDING`.
2. `lockComplaintToWorkOrder(tx, ...)` runs in the same transaction:
   Complaint becomes locked/read-only, driven exclusively by this Work Order.
3. Audit: `AUTO_CREATE_WORK_ORDER` + `WORK_ORDER_CREATED_AUTOMATICALLY`, or
   `WORK_ORDER_ACTIVATED` when an existing `PENDING` Work Order is activated.
4. Notification (`WORK_ORDER_CREATED_NOTIFY`): Admin + Supervisor + assigned
   Technician + customer/creator.
5. Checklist attached/generated for the Work Order (see §7).

## 4. Complaint locking
- Once a Work Order exists for a Complaint, the Complaint is locked:
  original submitted details remain read-only; operational updates happen only
  through the Work Order; Work Order status controls linked Complaint status.
- Closing the Work Order automatically CLOSES the Complaint.
- Reopening the Work Order reopens the Complaint.
- Backend enforces this; frontend cannot bypass.

## 5. Technician assignment
- Technician assigned to the Work Order (and Complaint).
- Notification: Admin + Supervisor + assigned Technician + customer/creator.
- Escalation if not accepted within configured hours (SUPERVISOR + ADMIN).

## 6. Technician acceptance
- Complaint-driven Work Orders are auto-accepted (`ACCEPTED`) when the
  Complaint is accepted/started; the technician can Start Work directly.
- Manual/other Work Orders may still be accepted explicitly. Start Work is
  available from both `PENDING` and `ACCEPTED`.
- Notification: appropriate recipients for "Accepted".

## 7. Work execution + checklist + evidence
- Checklist auto-generated for the Work Order (correct category/scope, no
  duplicates; mandatory safety/compliance items preserved).
- Technician adds/removes permitted items; Pass/Fail/N/A; remarks,
  measurements, checklist evidence.
- Progress calculated from actual item statuses; no unauthorized completion
  bypass.
- BEFORE evidence: complaint intake media is imported read-only into the Work
  Order's Before Work section; technicians/supervisors may add before-work
  photos (images only) while the Work Order is `PENDING`/`ACCEPTED`. Starting
  requires persisted before-work photo evidence (complaint media counts) and
  all required checklist items.
- DURING/AFTER evidence: technician captures progress/existing/maintenance/
  repair/testing photos/videos (camera + gallery) only while the Work Order is
  `IN_PROGRESS`/`ON_HOLD`.
- Work-order evidence can be deleted by an authorized updater under the same
  phase rules; complaint-sourced media is read-only. Deletion removes both the
  stored object and its metadata row.

## 8. AFTER evidence + review + closure
- Technician captures completion evidence before final review (at least one
  completion photo by default, configurable exceptions).
- Technician submits Work Order for review.
- Supervisor/Manager reviews; approves → Work Order CLOSED.
- Closing the Work Order automatically CLOSES the linked Complaint.
- Reopening reopens both. Cancellation follows authorized workflow.
- All changes auditable.

## 9. Preventive Maintenance scheduling
1. PM Plan created → equipment linked → frequency configured → activated.
2. Backend scheduler monitors due dates (independent of frontend).
3. Due PM occurrence generated → one Work Order generated (duplicate
   prevention) → checklist generated → technician assigned.
4. Maintenance executed; evidence captured; supervisor review; Work Order
   closed → PM occurrence completed → next maintenance date calculated.
5. Recurrence rules; next-date; overdue detection; due-today; upcoming;
   technician assignments; PM-WO relationships; duplicate prevention;
   scheduler recovery after restart (reconciles missed executions without
   duplicate Work Orders).
6. Suspending a PM plan stops new scheduling without deleting history.

## 10. Notification distribution (centralized NotificationService)
- Backend-generated from actual DomainEvents; idempotent (no duplicates on
  retry/retry); works with no frontend user logged in.
- Recipients by event: NEW Complaint → Admin + Supervisor + customer (no Super
  Admin); WO created/assignment → Admin + Supervisor + technician + customer;
- Status events (Accepted, Started, On Hold, Submitted for Review, Approved,
  Closed, Reopened, Cancelled) → appropriate recipients.

## 11. Email notifications
- Admin configures provider (SMTP/Resend) + API key + sender; `EmailService`
  initializes the adapter; config persisted; API key encrypted; sender verified.
- DomainEvent → outbox → `runEmailAutomations` → automation rules → recipient
  engine → template render → `EmailLog` QUEUED (idempotent per
  [eventId, automationId]) → `tickEmailWorker` (10s scheduler loop) → provider
  send → SENT / retry-with-backoff / DEAD_LETTER → `EmailLog` authoritative.
- Honest delivery: never mark QUEUED as SENT; never claim delivery without
  provider evidence (Message-Id); recovery sweep finalizes stuck rows
  (never re-sends rows with a Message-Id).

## 12. WhatsApp AI conversation
- Centralized `AIService` via OpenWA webhook; configured AI provider;
  conversation context; clarifying questions; retrieves authorized
  Complaint/Work Order info; creates Complaint only after customer confirmation;
  duplicate prevention; human handover; no repeated static menus; never exposes
  API keys.

## 13. Inspection Reports (IRMS)
- IRMS inspections, report generation, photo manager, attachments stored in
  MinIO; metadata in PostgreSQL; QR labels with scan-to-open deep links per
  equipment unit; QR verification backend-enforced.

## 14. Authorization rules (RBAC)
- 7 roles / 47 permissions; DB-backed session token (HttpOnly cookie).
- Server-authoritative RBAC; customer-portal data scoping.
- No frontend-only security; backend enforces every rule.
- Super Admin excluded from complaint-workflow notifications.
