# Deployment — FacilityPro (MOHD.HMS ENTERPRISE)

Production deployment, startup, shutdown, restart, migration, backup, restore
and rollback procedures. Commands are taken from the repository and server;
no service names or paths are invented.

## Production environment
- Ubuntu server; systemd process manager; PostgreSQL; Redis; MinIO; Next.js
  standalone build; blue/green release slots; edge router; Cloudflare Tunnel.

## Systemd services (observed running)
| Service | Purpose | Port |
|---------|---------|------|
| `hms-router` | Edge TCP router, forwards :3000 to active release slot | :3000 |
| `hms-blue` | Release slot BLUE | :3100 |
| `hms-green` | Release slot GREEN | :3101 |
| `hms-realtime` | engine.io + WebSocket (public :3003 / loopback :3004) | :3003/:3004 |
| `hms-app` | Next.js standalone from this repo (`run-prod.sh`) | :3000 (legacy) |
| `cloudflared-hms` | Cloudflare Tunnel app.mohdhms.com | — |
| `docker` | PostgreSQL / MinIO containers | :5432 / :9001 |

## Router & slots
- Router reads `/home/hasan/hms/shared/upstream` (currently `3100`) and
  forwards new connections to that slot without dropping in-flight connections.
- Slots: `/home/hasan/hms/slots/blue -> .../app`, `/home/hasan/hms/slots/green -> .../app`.
- Releases: `/home/hasan/hms/releases/<id>/app` with `meta.json` (commit,
  short, message, branch, built_at, schema_hash, status).
- State: `/home/hasan/hms/state.json` (current/previous release, ports,
  last_commit, last_deployment).

> **Version mismatch (regression root cause):** the authoritative source is
> branch `dev` @ `bafbefa` (all fixes committed). The deploy worker
> (`/home/hasan/hms-deploy/deploy.sh`) builds from `origin/main` and the live
> slots run old `main` commits. None run `bafbefa`. Realign the deployment to
> `dev`/`bafbefa` before declaring the fixes live. Do not force a production
> deploy that cannot be verified.

## Startup order (after reboot)
1. PostgreSQL (docker)
2. Redis
3. MinIO
4. Backend API / Next.js (`hms-app` or active slot)
5. Background workers + email worker tick
6. PM scheduler
7. Frontend (served by Next.js standalone)
8. Reverse proxy / Nginx + Cloudflare Tunnel (`hms-router`)

Services must not be marked healthy by process existence alone; verify actual
ability to perform their function (DB connectivity, Redis connectivity,
MinIO connectivity, `/api/health/ready`).

## Commands
```bash
# Status
systemctl status hms-router hms-blue hms-green hms-realtime hms-app
cat /home/hasan/hms/state.json
cat /home/hasan/hms/shared/upstream

# Restart app (this repo)
systemctl restart hms-app

# Restart slots
systemctl restart hms-blue hms-green hms-router

# Logs
journalctl -u hms-app -n 50
journalctl -u hms-blue -n 50
tail -n 50 /home/hasan/mohd_hms_enterprise/server.log
tail -n 50 /home/hasan/hms-deploy/deploy.log

# Deploy worker (builds origin/main in staging, swaps, health-checks, rollback)
/home/hasan/hms-deploy/deploy.sh

# Health check
curl -sf http://127.0.0.1:3000/api/health/ready
```

## Build
```bash
cd /home/hasan/mohd_hms_enterprise
bun run build        # next build + copy static/public into .next/standalone
# run-prod.sh starts bun .next/standalone/server.js
```

## Database migration
- Migrations are version-controlled (Prisma schema + tracked migrations).
- Production startup does NOT recreate existing records; no auto seed.
- Back up before any schema change (`/home/hasan/hms/backups/`).
- `prisma db push` is fail-closed: destructive changes block deployment;
  only an operator may override after reviewing the verified backup.
- Never run `prisma migrate reset` / `db:reset` against production.

## Backup
- PostgreSQL: `pg_dump` (or `docker exec hms-postgres pg_dump`) → gzip →
  `/home/hasan/hms/db-backups/` or `/home/hasan/hms/backups/`.
- MinIO: persistent `/data` volume; back up buckets (complaint WO media,
  IRMS attachments, invoices, quotations, letters).
- Verify backups before risky operations; test restoration in a safe env.

## Restore
- Restore PostgreSQL from the latest verified backup; run pending migrations.
- Restore MinIO objects from backup; verify media accessible after restart.
- Never delete production volumes or MinIO buckets during restore.

## Rollback
- `deploy rollback` restores the previous healthy release (router switches
  upstream back; previous release kept).
- Do not automatically roll back database changes without evaluating data
  compatibility.
