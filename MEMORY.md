# Project Memory — FacilityPro (MOHD.HMS ENTERPRISE)

Permanent project memory so future developers and AI agents can understand the
system without rediscovering previous decisions. This file is authoritative
together with `CLAUDE.md`/`AGENTS.md`. Keep it synchronized with the code.

## 1. Project identity

- **Company:** MOHD.HMS ENTERPRISE
- **Application:** FacilityPro — Smart Facility Maintenance Management System
- **Business purpose:** End-to-end facility maintenance: customer complaints →
  work orders → technician execution → evidence → supervisor review → closure,
  plus preventive maintenance (PM) scheduling, invoicing, HR, IRMS inspections,
  and audit.
- **Technology stack:** Next.js 16 App Router + TypeScript 5 + React 19;
  Tailwind CSS 4 + shadcn/ui; Prisma ORM; PostgreSQL; Redis; MinIO; Capacitor
  (Android/iOS).
- **Production environment:** Existing Ubuntu server; systemd services;
  blue/green release slots under `/home/hasan/hms/releases`; edge router on
  `:3000`; Cloudflare Tunnel `app.mohdhms.com`.
- **Branding:** Green primary brand theme; white/light neutral backgrounds;
  dark readable text; Poppins typography; responsive desktop/tablet/mobile.
- **Locale / timezone:** Asia/Brunei; currency BND.

## 2. Architecture

- **Frontend:** `src/app/` (Next.js App Router), `src/components/hms/` (feature
  modules: dashboard, complaints, work-orders, pm, checklist, email-config,
  irms, files, invoices, technicians, users, whatsapp, profile, finance,
  inventory, hr), `src/components/hms/shell.tsx`, `mobile-nav.tsx`, `header.tsx`,
  `src/components/ui/` (shadcn primitives).
- **Backend:** Next.js API routes under `src/app/api/v1/`; shared DB client
  `@/lib/db`; business logic in `src/lib/hms/`.
- **Database:** PostgreSQL, Prisma schema `prisma/schema.prisma` (42 models).
  Authoritative application DB; migrations via `prisma db push` / tracked
  migrations; `prisma/seed.ts` is demo-only, never run against production.
- **Cache / queue:** Redis (`:6379`, `:6380`, `:65515` observed); sessions and
  email/worker queue.
- **Object storage:** MinIO (`/data`, console `:9001`); stores complaint WO
  photos/videos, IRMS attachments, invoices, quotations, letters. PostgreSQL
  stores metadata/relationships only — no permanent media in container
  filesystems.
- **Authentication:** DB-backed session tokens (HttpOnly cookie); 7 roles /
  47 permissions (RBAC); `src/components/hms/session.tsx`. TOTP multi-factor
  authentication (`src/lib/hms/mfa/`, RFC 6238): encrypted secret
  (AES-256-GCM, `MFA_ENCRYPTION_KEY`), login challenge gating session creation
  (`resolveMfaGate`), scrypt-hashed single-use recovery codes, role-based
  policy + grace window; enforcement is gated by `MFA_ENFORCEMENT_DISABLED`
  (opt-in, defaults off).
- **Notification architecture:** in-app `Notification` rows +
  centralized `EmailService` (`src/lib/hms/email/service.ts`) +
  WhatsApp AI (`src/lib/hms/whatsapp/` via OpenWA). Workflow engine
  (`src/lib/hms/workflows/`) emits `DomainEvents`; handlers route to
  `notify`/`notifyRole` and `queueDirect`. Super Admin is excluded from
  complaint-workflow notifications.
- **Deployment architecture:** systemd units `hms-router` (:3000), `hms-blue`
  (:3100), `hms-green` (:3101), `hms-realtime`; blue/green slots symlinked in
  `/home/hasan/hms/slots/`; router reads `/home/hasan/hms/shared/upstream`;
  deploy worker `/home/hasan/hms-deploy/deploy.sh` builds in staging and swaps;
  `hms-app.service` runs this repo via `run-prod.sh`.

## 3. Important development rules

- Preserve the existing project structure; do not change it without a real
  technical requirement.
- Reuse existing services (`EmailService`, `NotificationService`, `AIService`,
  workflow engine); avoid duplicate modules.
- No hardcoded business data; no fake statuses.
- Backend must enforce every business rule; no frontend-only security.
- Preserve production data (PostgreSQL, MinIO, Redis); never delete volumes,
  buckets, or run destructive Git/DB commands.
- Use actual provider integrations (SMTP/Resend, OpenWA, MinIO); no production
  mocks.
- Verify functionality after implementation and after every restart.
- Documentation must stay synchronized with code (models, routes, workflows,
  roles, workers, env, security). Every major feature records its actual
  verification status.

## 4. Important business rules

### Complaint workflow (non-negotiable)
1. Customer submits Complaint → Admin/Supervisor notified (Super Admin excluded).
2. Complaint reviewed → Work Order generated (auto, one per complaint, no duplicates).
3. Original Complaint automatically locked to the Work Order; read-only, driven
   exclusively by the Work Order lifecycle.
4. No independent "Mark Completed" on a linked Complaint; Work Order status
   controls Complaint status.
5. Technician assigned → accepts → starts work → in progress.
6. Checklist completed; BEFORE/DURING/AFTER evidence captured.
7. Technician submits for review → Supervisor/Manager approves → Work Order CLOSED.
8. Closing the Work Order automatically CLOSES the linked Complaint.
9. Reopening a Work Order reopens its Complaint. Cancellation follows authorized
   workflow. All changes auditable.

### Evidence (BEFORE / DURING / AFTER)
- BEFORE: customer uploads multiple photos/videos (camera + gallery) before
  Complaint submission; locked after submission; no further ordinary BEFORE uploads.
- DURING: technician uploads progress/existing/maintenance/repair/testing media
  via the active Work Order.
- AFTER: completion evidence required before final review (at least one photo by
  default, configurable exceptions).
- MinIO stores objects; PostgreSQL stores metadata; media persists across restart.

### Checklist
- Auto-generated when a Work Order is created (correct category/scope); no
  duplicates; technicians may add/remove permitted items; mandatory safety
  items preserved; Pass/Fail/NA; remarks/measurements/evidence; progress
  calculated from item statuses; no unauthorized completion bypass.

### Preventive Maintenance
- PM Plan → equipment linked → frequency configured → activated → backend
  scheduler monitors due dates → occurrence generated → one Work Order →
  checklist → technician → execution → evidence → supervisor review → WO closed
  → PM occurrence completed → next date calculated.
- Recurrence, next-date, overdue, due-today, upcoming, technician assignment,
  WO relationships, duplicate prevention, scheduler recovery after restart.
- Suspending a PM plan stops new scheduling without deleting history.

### Notifications
- New Complaint → all eligible Admin + Supervisor + customer (never Super Admin).
- Technician assignment / Work Order creation → Admin + Supervisor + technician + customer.
- Status events (Accepted, Started, On Hold, Submitted for Review, Approved,
  Closed, Reopened, Cancelled) → appropriate recipients.
- Centralized `NotificationService`; backend events; idempotent (no duplicates
  on retry); works with no frontend user logged in.

### Email
- Admin configures provider (SMTP or Resend) + API key + sender info;
  `EmailService` initializes the adapter; provider config persisted; API key
  encrypted; sender verified; Redis queue; background email worker; retry with
  backoff; honest delivery states (QUEUED/PROCESSING/SMTP_ACCEPTED/SENT/
  DEAD_LETTER/FAILED); never claim delivery without evidence; no SMTP fields
  required for API-based provider.

### WhatsApp AI
- Centralized `AIService`; configured AI provider; maintains conversation
  context; asks clarifying questions; retrieves authorized Complaint/WO info;
  creates Complaints only after customer confirmation; prevents duplicates;
  supports human handover; no repeated static menus; never exposes API keys.

### CMS (visual page builder)
- Pages: slug, title, status (DRAFT/PUBLISHED/ARCHIVED), content JSON
  (blocks/elements), SEO fields, publishedAt. Every publish snapshots an
  immutable `cms_page_revision`.
- Rendering: `GET /[slug]` serves published CMS pages via shared `RenderPage`;
  drafts are never public (preview requires authenticated CMS session).
- Editor: debounced autosave drafts, undo/redo history, responsive device
  toggle, media-library image insertion, publish to public website.
- Permissions: `cms_pages_read/create/update/delete/publish`; publish
  ADMIN/SUPER_ADMIN only.

## 5. Previous implementation decisions (status)

| Area | Decision | Status |
|------|----------|--------|
| Complaint lock-to-WO | `lockComplaintToWorkOrder` in `src/lib/hms/workflows/complaint-work-order.ts` | Implemented & committed |
| Remove independent mark-completed | Complaint locked once WO exists | Implemented & committed |
| Three-stage evidence | BEFORE/DURING/AFTER photo+video | Implemented & committed |
| Auto checklist generation | Work Order → checklist, no duplicates | Implemented & committed |
| PM scheduling | `src/lib/hms/pm/schedule.ts`, `generate` | Implemented, partially verified |
| Notification distribution | `notify`/`notifyRole`, Super Admin excluded | Implemented & committed |
| EmailService | Centralized, provider adapter, worker tick | Implemented & committed |
| WhatsApp AI | Centralized AIService, OpenWA, dedupe | Implemented & committed |
| TOTP multi-factor authentication | `src/lib/hms/mfa/`: AES-256-GCM secret, `resolveMfaGate` login gate, recovery codes, role policy + grace, admin reset | Implemented & committed; enforcement opt-in via `MFA_ENFORCEMENT_DISABLED` |
| Mobile responsive UI | Bottom nav, breakpoints, safe areas | Implemented, needs post-restart verify |
| Dashboard cards | Responsive cards | Implemented, needs post-restart verify |
| `hms-app.service` active | Runs repo via `run-prod.sh` | NOT running (inactive) |
| Deploy target | Worker builds `origin/main`; dev is `bafbefa` | MISMATCH — realign required |

**Not verified after restart:** all of the above require a full server restart
verification (see Section 18 of the recovery task).
