# mohd_hms_enterprise

**MOHD.HMS ENTERPRISE — Smart Facility Maintenance Management** (FacilityPro)

A production-ready enterprise platform that manages complaints, work orders,
preventive maintenance, equipment, customers, employees, technicians,
inventory, purchasing, vehicles, quotations, invoices, payments, finance,
HR, IRMS inspections, reporting and audit — in one secure, role-based system.

## Project identity

- **Company:** MOHD.HMS ENTERPRISE
- **Application:** FacilityPro — Smart Facility Maintenance Management System
- **Production environment:** Existing Ubuntu server
- **Timezone:** Asia/Brunei
- **Currency:** BND
- **Brand:** Green primary brand theme; white/light neutral backgrounds; dark readable text; Poppins typography

## Tech stack (production)

- **Frontend:** Next.js 16 (App Router) + TypeScript 5 + React 19, Tailwind CSS 4 + shadcn/ui, Capacitor (Android/iOS)
- **Backend:** Next.js API routes (same monorepo), Prisma ORM
- **Database:** PostgreSQL (production), persistent volume; `DATABASE_URL` in `.env` (gitignored)
- **Cache / queue:** Redis (sessions, email/worker queue)
- **Object storage:** MinIO (`/data`), persistent buckets for media/documents
- **Auth:** DB-backed session tokens (HttpOnly cookie), 7 roles / 47 permissions (RBAC)
- **Notifications:** in-app Notification rows + centralized EmailService (SMTP/Resend provider) + WhatsApp AI (OpenWA)
- **Background:** email worker tick (`tickEmailWorker`), workflow engine (DomainEvents), PM scheduler
- **Deployment:** systemd (`hms-router`, `hms-blue`, `hms-green`, `hms-realtime`), blue/green release slots (`/home/hasan/hms/releases`), edge router on :3000, Cloudflare Tunnel (`app.mohdhms.com`)
- **Reverse proxy:** Nginx / Cloudflare Tunnel as applicable

## Authoritative production version

- **Git branch:** `dev`
- **Git commit (HEAD):** `bafbefa` — `fix(recovery): persist previously-implemented production fixes`
- **Previous commit:** `e918103` — `fix(evidence): lock BEFORE evidence after complaint submission`
- **Build:** `next build` → `.next/standalone`, started via `run-prod.sh`
- **Database migration:** Prisma schema (`prisma/schema.prisma`), `prisma db push` / tracked migrations; no auto seed on production startup

> **Regression root cause (recovered):** the previously approved UI/workflow fixes existed only as uncommitted working-tree changes on `dev`. They were never committed, never built, never deployed. Production ran committed releases from `main` (baseline `33723d7` / slot commits `dce8d6b`, `1cc49c1`). On every restart the old code loaded without the fixes. All fixes are now committed at `bafbefa` on `dev`.

## Getting started (development)

```bash
bun install                 # or npm install
bun run db:generate         # prisma generate
bun run db:push             # push Prisma schema to database
bun run dev                 # next dev -p 3000
```

Open the app and sign in. `.env` is gitignored — create it from `.env.example`.

## Production (existing server)

```bash
# App service (Next.js standalone on :3000, WorkingDirectory = this repo)
systemctl status hms-app
systemctl restart hms-app

# Blue/green release slots (router :3000 -> :3100 / :3101)
systemctl status hms-router hms-blue hms-green hms-realtime
cat /home/hasan/hms/state.json
cat /home/hasan/hms/shared/upstream   # port the router forwards to

# Logs
journalctl -u hms-app -n 50
tail -n 50 /home/hasan/mohd_hms_enterprise/server.log
tail -n 50 /home/hasan/hms-deploy/deploy.log
```

See `DEPLOYMENT.md` and `OPERATIONS.md` for full procedures.

## Important development rules

- Preserve the existing project structure; do not change it without a real technical requirement.
- Reuse existing services (`EmailService`, `NotificationService`, `AIService`, workflow engine); do not create duplicate modules.
- No hardcoded business data; no fake statuses.
- Backend must enforce business rules; no frontend-only security.
- Preserve production data (PostgreSQL, MinIO, Redis); never run destructive Git/Docker/DB commands.
- Use actual provider integrations (SMTP/Resend, OpenWA, MinIO); never mock in production.
- Verify functionality after implementation and after every restart.
- Documentation must stay synchronized with code (models, routes, workflows, roles, workers, env, security).

## Commands

| Purpose | Command |
|---------|---------|
| Dev server | `bun run dev` |
| Production build | `bun run build` |
| Production start | `bun run start` (`run-prod.sh`) |
| Lint | `bun run lint` |
| Prisma generate | `bun run db:generate` |
| Prisma push | `bun run db:push` |
| Tests | see `TESTING` / regression suite under `tests/` |
