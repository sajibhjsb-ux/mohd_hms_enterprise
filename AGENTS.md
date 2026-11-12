# CLAUDE.md / AGENTS.md — FacilityPro (MOHD.HMS ENTERPRISE)

Persistent instructions for future AI coding sessions. Read before modifying
the application. One hierarchy: this file is authoritative; MEMORY.md,
WORKFLOWS.md, DEPLOYMENT.md, OPERATIONS.md, DATABASE.md, API.md, SECURITY.md,
ARCHITECTURE.md, CHANGELOG.md support it.

## Mandatory architecture preservation
- Preserve the existing project structure; do not change it without a real
  technical requirement.
- Reuse existing services (`EmailService`, `NotificationService`, `AIService`,
  workflow engine); avoid duplicate modules.
- Frontend: Next.js 16 App Router + TypeScript 5 + React 19 + Tailwind CSS 4
  + shadcn/ui, under `src/app/` and `src/components/hms/`.
- Backend: Next.js API routes under `src/app/api/v1/`; logic in `src/lib/hms/`.
- Database: PostgreSQL via Prisma (`prisma/schema.prisma`); `prisma/seed.ts`
  is demo-only, never run against production.
- Storage: MinIO for media; PostgreSQL for metadata; Redis for cache/queue.

## Important project paths
- Repo: `/home/hasan/mohd_hms_enterprise`
- Start: `run-prod.sh` → `bun .next/standalone/server.js`; `bun run build`
- Slots: `/home/hasan/hms/releases/`, `/home/hasan/hms/slots/blue|green`
- Router: `/home/hasan/hms/shared/upstream` (port the :3000 router forwards to)
- State: `/home/hasan/hms/state.json`
- Deploy worker: `/home/hasan/hms-deploy/deploy.sh`; last_sha there
- systemd: `hms-router`, `hms-blue`, `hms-green`, `hms-realtime`, `hms-app`,
  `cloudflared-hms`
- Logs: `server.log`, `production.log`, `deploy.log`, `journalctl -u <unit>`

## Development commands
- `bun run dev` | `bun run build` | `bun run start` | `bun run lint`
- `bun run db:generate` | `bun run db:push` (never `db:reset` on prod)
- `curl -sf http://127.0.0.1:3000/api/health/ready`

## Business workflow rules (non-negotiable)
- Complaint → Work Order (one per complaint) → Complaint locked; no
  independent mark-completed on linked Complaint; Work Order status controls
  Complaint status; closing WO closes Complaint; reopening reopens both.
  Auto-created complaint WOs start `ACCEPTED` (ready to start); an existing
  `PENDING` WO is activated in place, never duplicated.
- Evidence: BEFORE (customer at intake + work-order photos before start;
  complaint media is read-only), DURING (technician, active WO), AFTER
  (completion photo required by default).
- Checklist: auto-generated per WO; no duplicates; mandatory safety items;
  Pass/Fail/N/A; progress from item statuses; no completion bypass.
- PM: backend scheduler; recurrence; next-date; overdue; duplicate prevention;
  scheduler recovery without duplicate WOs; suspending stops new scheduling.
- Notifications: NEW Complaint → Admin + Supervisor + customer (never Super
  Admin); WO events → Admin + Supervisor + technician + customer; idempotent.
- Email: centralized EmailService; provider persisted; honest delivery states;
  never claim delivery without evidence.
- WhatsApp AI: centralized AIService; customer confirmation before creating
  Complaint; duplicate prevention; never expose API keys.

## Storage rules
- MinIO stores objects; PostgreSQL stores metadata/relationships.
- No permanent production media in temporary container filesystems.
- Preserve PostgreSQL, MinIO, Redis across restart; never delete volumes/
  buckets; never reset administrator configuration.

## Security rules
- No hardcoded secrets; `.env` gitignored; secrets in
  `/home/hasan/hms/shared/.env` (0600).
- Backend enforces all rules; no frontend-only security.
- API key encryption; sender verified; HMAC webhook verification.
- Never print credentials; never expose private MinIO URLs or infra to
  customers.

## Deployment rules
- Authoritative production branch: `main`. The live release and commit are
  recorded in `/home/hasan/hms/state.json` (`current`, `last_commit`); never
  hardcode them here.
- Controller: `/home/hasan/hms/deployment/cli.sh` (`deploy dry-run`,
  `deploy deploy --auto`, `deploy promote`, `deploy rollback`, `deploy status`).
  The `hms-deploy` oneshot runs `deployment/deploy.sh`; the poller checks
  `origin/main` every 5 minutes.
- Blue/green slots: blue `:3100`, green `:3101`; router `:3000` proxies the
  active slot from `/home/hasan/hms/shared/upstream`.
- Build → health-check → deploy → post-deploy test → version verification →
  documentation update.
- Do not force a production deploy that cannot be verified.

## Documentation update requirements
Whenever code changes (models, routes, workflows, roles, workers, deployment,
integrations, env, security), update the matching Markdown file. Do not
document planned behaviour as implemented; record actual verification status.

## Regression prevention
- Every fix: committed, migrated, config survives restart, workers start,
  frontend+backend run intended version, e2e test passes, documentation
  updated, correct after full restart.
- Do not mark features completed without testing; do not mark emails delivered
  without evidence.
