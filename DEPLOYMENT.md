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

## MFA (two-factor authentication) rollout
MFA is opt-in by default and must not be enforced on production until the
rollout path has been verified.

- `MFA_ENCRYPTION_KEY` — 32-byte base64 key for AES-256-GCM TOTP secret
  encryption (`openssl rand -base64 32`). Required once MFA enrolment is used;
  rotate only with the understanding that existing encrypted secrets become
  undecryptable.
- `MFA_ENFORCEMENT_DISABLED` — break-glass. `true` (default): MFA stays
  optional everywhere. Flip to `false` only AFTER running the rollout script and
  verifying an admin reset path works.
- `MFA_TOTP_TOLERANCE_SECONDS`, `MFA_CHALLENGE_TTL_SECONDS`,
  `MFA_ENROLL_TTL_SECONDS` — timing defaults (30 s / 300 s / 900 s).

Rollout order:
1. Add `MFA_ENCRYPTION_KEY` to `/home/hasan/hms/shared/.env` (mode 0600) and the
   release env; keep `MFA_ENFORCEMENT_DISABLED=true`.
2. `bun run db:generate && bun run db:push` (additive MFA models; never
   `db:reset` on production).
3. `bun --conditions=react-server scripts/mfa-seed.ts` — writes the default
   per-role MFA policies (MANDATORY for SUPER_ADMIN/ADMIN/SUPERVISOR/FINANCE
   with a 14-day grace; OPTIONAL for TECHNICIAN/CUSTOMER/HR).
4. `bun --conditions=react-server scripts/mfa-rollout.ts` — grants the grace
   window (`UserMfa.graceUntil`) to every unenrolled user of a MANDATORY role.
   Idempotent: a second run grants 0.
5. Verify the admin reset path (`POST /api/v1/admin/security/mfa-reset`) revokes
   the target's sessions and forces re-enrolment.
6. Flip `MFA_ENFORCEMENT_DISABLED=false` only after steps 1–5 are verified on
   a release slot. Existing grace windows continue to run until they expire.


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
