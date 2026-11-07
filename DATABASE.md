# Database — FacilityPro (MOHD.HMS ENTERPRISE)

Authoritative application database: PostgreSQL. Do not copy outdated schemas;
`prisma/schema.prisma` is the source of truth.

## Connection
- `DATABASE_URL` in `.env` (gitignored), e.g.
  `postgresql://mohd:****@localhost:5432/mohd_hms?schema=public`
- Database: `mohd_hms`; user: `mohd`.
- Prisma ORM; client generated via `bun run db:generate`; schema applied via
  `bun run db:push` / tracked migrations.
- `prisma/seed.ts` is DEMO data only — never run against production.

## Important models (referenced in code)
Core tables observed in handlers/services/routes:
- `user` — accounts, role, status, email (7 roles / 47 permissions RBAC)
- `customer` — customers linked to users/portal users
- `complaint` — complaints; status, priority, customerId, equipmentId,
  assignedTechnicianId, createdById, code; locked once a Work Order exists
- `work_order` — work orders; complaintId, customerId, equipmentId,
  technicianId, sourceType (COMPLAINT), status, invoiceId, code
- `work_order_materials` / `inventory_item` — material lines on work orders
- `pm_plan`, `pm_task` — preventive maintenance plans and tasks; status
  (SCHEDULED/OVERDUE/...), technician, next due date
- `checklist`, `checklist_item` — work order checklists; Pass/Fail/N/A;
  progress from item statuses
- `complaint_media` / `work_order_media` / evidence — BEFORE/DURING/AFTER
  media metadata (MinIO object keys); stored in PostgreSQL
- `email_log` — QUEUED/PROCESSING/SMTP_ACCEPTED/SENT/DEAD_LETTER/FAILED;
  idempotent per [eventId, automationId]
- `email_template`, `email_automation` — email templates + automation rules
- `notification` — in-app notifications; readAt; unread count
- `audit_log` — actor, action, resourceType, resourceId, metadata
- `workflow_run` — workflow engine idempotence (one SUCCESS run per event)
- `invoice`, `quotation`, `purchase_order`, `payment`
- `inspection_report`, `irms` — IRMS inspections + attachments (MinIO keys)
- `letter`, `mail_message`, `mailbox`, `mailbox_member` — email client
- `setting`, `draft`, `device` (push), `equipment`, `vehicle`

## Relationships (key)
- Complaint 1:N Work Order (one WO per complaint; Complaint locked to WO)
- Work Order 1:N materials; Work Order N:1 technician/customer/equipment
- PM Plan 1:N PM Task; PM Task → Work Order
- Work Order → Checklist → Checklist items
- Complaint / Work Order → media metadata (MinIO objects)
- EmailLog ← Notification/mail message (delivery state mirrored)
- Audit log on every state-changing business action

## Status enums (observed)
- Complaint: NEW, ASSIGNED, ACCEPTED, STARTED, CLOSED, CANCELLED, ...
- Work Order: PENDING, IN_PROGRESS, SUBMITTED_FOR_REVIEW, APPROVED, CLOSED,
  REOPENED, CANCELLED, ...
- PM Task: SCHEDULED, OVERDUE, ...
- EmailLog: QUEUED, PROCESSING, SMTP_ACCEPTED, SENT, DEAD_LETTER, FAILED,
  CANCELED
- Notification: read via readAt (null = unread)

## Migration strategy
- Version-controlled; tracked migrations; repeatable only where safe.
- Production startup does not recreate existing records; no auto seed.
- Fail-closed: destructive schema changes block deployment; operator override
  only after verified backup.
- New fields receive safe defaults; existing data migrated correctly.
- Back up (`pg_dump`) before any schema change; test restore in safe env.

## Persistent volume
- PostgreSQL data on the intended persistent volume/container; survives
  server restart. Never delete production volumes; never reinitialize
  production storage; never reset administrator configuration.

## Idempotency rules
- Workflow engine: one SUCCESS run per event (§6) + business-state re-check in
  each handler.
- Email: unique [eventId, automationId] guard; dedupe window
  (`dedupeHours`); P2002 duplicate treated as idempotent.
- Checklist: no duplicate generation; existing checklist not regenerated.
- Work Order: one per complaint (sourceType=COMPLAINT filter).

## Backup strategy
- `pg_dump --dbname="$DATABASE_URL"` → gzip → `/home/hasan/hms/db-backups/`
  (or `/home/hasan/hms/backups/`); latest never auto-deleted; last 5 releases
  kept; `current`/`previous` never pruned.
- Verify backups before risky operations; test restoration in a safe env.
