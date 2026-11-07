# Architecture — FacilityPro (MOHD.HMS ENTERPRISE)

Actual repository paths and component names. No invented directories or
endpoints.

## Frontend structure
- `src/app/` — Next.js 16 App Router pages/API routes.
- `src/app/api/v1/` — REST API route groups (complaints, work-orders,
  notifications, users, technicians, dashboard, files, invoices, reports, pm,
  push, whatsapp, profile, email).
- `src/components/hms/` — feature modules: `dashboard/`, `complaints/`,
  `work-orders/`, `pm/`, `checklists/`, `email-config/`, `irms/`, `files/`,
  `finance/`, `hr/`, `inventory/`, `invoices/`, `technicians/`, `users/`,
  `whatsapp/`, `profile/`, `equipment/`.
- `src/components/hms/shell.tsx` — app shell; `header.tsx`, `mobile-nav.tsx`,
  `global-search.tsx`; `src/components/hms/session.tsx` — session/auth.
- `src/components/ui/` — shadcn/ui primitives (dialog, sheet, alert-dialog,
  data-table, document-header, ui-bits).
- `src/lib/hms/` — shared business logic: `notifications.ts`,
  `email/service.ts`, `whatsapp/`, `pm/schedule.ts`, `checklist/`,
  `workflows/`, `ai/`, `files/service.ts`, `irms/storage.ts`, `router.ts`,
  `pwa.ts`.

## Backend structure
- Next.js API routes (`src/app/api/v1/`) backed by Prisma client (`@/lib/db`).
- Business logic in `src/lib/hms/`:
  - `workflows/engine.ts` — workflow registration; idempotent (one SUCCESS run
    per event + business-state re-check).
  - `workflows/handlers.ts` — complaint→WO, lock, PM due/overdue/remind,
    escalation, SLA, invoice auto-create, email queue, checklist attach/generate.
  - `workflows/complaint-work-order.ts` — `lockComplaintToWorkOrder`.
  - `complaint-notifications.ts` — `notifyWorkOrderCreated`.
  - `notifications.ts` — mark-read, unread count, NOTIFICATION_READ outbox.
  - `email/service.ts` — EmailService: queueDirect, queueClientEmail, sendOtp,
    queueLetter, runEmailAutomations, tickEmailWorker (10s),
    recoverStuckEmailLogs, processOne, failOrRetry, retryEmail, cancelEmail,
    testConnection, sendTestEmail, emailHealth.
  - `email/config.ts`, `provider.ts`, `resolve.ts`, `render.ts`, `attachments.ts`,
    `catalog.ts`, `types.ts`, `workflows.ts`.
  - `whatsapp/automations.ts`, `openwa.ts`, `types.ts` — WhatsApp AI via OpenWA.
  - `ai/service.ts`, `providers.ts`, `features.ts` — centralized AIService.
  - `push-server.ts`, `push/fcm.ts`, `push/worker.ts`, `push/apns.ts` — push.
  - `files/service.ts` — MinIO file service.
  - `irms/storage.ts` — IRMS storage.
- `src/lib/hms/services.ts` — `audit`, `notify`, `notifyRole`.

## Database relationships
PostgreSQL (Prisma schema `prisma/schema.prisma`, 42 models). Key relationships:
complaint → work_order (1:N, locked), work_order → materials, pm_plan →
pm_task → work_order, work_order → checklist → items, complaint/work_order →
media metadata (MinIO keys), email_log ← notification/mail_message, audit_log
on state changes. See `DATABASE.md`.

## Redis queues
Redis (`:6379`, `:6380`, `:65515` observed); sessions and email/worker queue.
Not the authoritative database for permanent business records (PostgreSQL is).

## MinIO storage
MinIO (`/data`, console `:9001`); complaint WO photos/videos, IRMS attachments,
invoices, quotations, letters; PostgreSQL stores metadata only; no permanent
media in container filesystems; secure access; private URLs never exposed.

## Background workers
- Email worker tick (`tickEmailWorker`) — 10s scheduler loop; claim-guard
  (no double-send); recoverStuckEmailLogs on restart; retry with backoff
  (1m/5m/15m); dead-letter after maxAttempts.
- Workflow engine — processes DomainEvents; idempotent handlers.
- PM scheduler — monitors due dates; generates occurrences + Work Orders;
  reconciles missed executions without duplicates.

## Scheduler
PM scheduler runs independent of frontend; PM plan → due occurrence → one WO →
checklist → technician → execution → evidence → review → closure → next date.

## Authentication
DB-backed session token (HttpOnly cookie); 7 roles / 47 permissions; RBAC;
server-authoritative.

## Notification architecture
In-app `Notification` rows + centralized `EmailService` + WhatsApp AI
(OpenWA). Workflow engine emits DomainEvents; handlers route to `notify`/
`notifyRole` and `queueDirect`. Super Admin excluded from complaint-workflow
notifications.

## External integrations
- Email: SMTP or Resend provider (admin-configured; API key encrypted;
  sender verified).
- WhatsApp: OpenWA gateway; centralized AIService.
- MinIO: object storage.
- Push: FCM / VAPID / APNS (`src/lib/hms/push/`).
- Cloudflare Tunnel: `app.mohdhms.com`.

## Deployment architecture
systemd: `hms-router` (:3000 → active slot), `hms-blue` (:3100),
`hms-green` (:3101), `hms-realtime`, `hms-app` (this repo via `run-prod.sh`),
`cloudflared-hms`. Blue/green release slots under
`/home/hasan/hms/releases/`; router reads `/home/hasan/hms/shared/upstream`;
deploy worker `/home/hasan/hms-deploy/deploy.sh` builds `origin/main` in
staging, swaps, health-checks, auto-rollback. State in
`/home/hasan/hms/state.json`.

> Version mismatch: authoritative source is `dev` @ `bafbefa`; deploy worker
> builds `origin/main`; live slots run old main commits. Realign required
> (see DEPLOYMENT.md).
