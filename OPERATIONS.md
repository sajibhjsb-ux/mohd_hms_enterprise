# Operations — FacilityPro (MOHD.HMS ENTERPRISE)

Routine checks, health checks, log locations, restart and failure-recovery
procedures.

## Routine server checks
```bash
systemctl status hms-router hms-blue hms-green hms-realtime hms-app
cat /home/hasan/hms/state.json
cat /home/hasan/hms/shared/upstream        # port the router forwards to
ss -tlnp | grep -E "3000|3100|3101|5432|6379|6380|9001"
curl -sf http://127.0.0.1:3000/api/health/ready && echo "HEALTH OK"
```

## Application health checks
- Backend: `GET /api/health/ready` must return 200 (not merely process exists).
- Database: `mohd` user connected to `mohd_hms` on `:5432`; query a core table
  (e.g. `complaint`, `work_order`).
- Redis: `redis-cli -p 6379 ping` → PONG; queue depth sensible.
- MinIO: `mc alias set` + `mc ls` / console `:9001`; buckets present; objects
  retrievable; no permanent media in container filesystems.
- Workers: email worker tick running (`tickEmailWorker`); workflow engine
  processing DomainEvents; PM scheduler monitoring due dates.
- WhatsApp: OpenWA webhook reachable; AI config loaded.

## Log locations
| Component | Location |
|-----------|----------|
| Next.js app | `/home/hasan/mohd_hms_enterprise/server.log`, `dev.log`, `production.log` |
| Deploy worker | `/home/hasan/hms-deploy/deploy.log`, `webhook.log` |
| systemd units | `journalctl -u <unit>` |
| PostgreSQL | docker container logs / `/var/log/postgresql` |
| Redis | redis log / docker |
| MinIO | `/data` logs / container `:9001` |

## Restart procedures
```bash
systemctl restart hms-app            # Next.js standalone (this repo)
systemctl restart hms-blue hms-green hms-router  # release slots
systemctl restart hms-realtime       # WS/realtime
# After restart, wait for all services healthy, then reopen app and retest
# the previously fixed screens and complete business workflows.
```

## Failure recovery
- Deploy worker health-checks after swap; on failure it rolls back to the
  previous release automatically.
- Email worker `recoverStuckEmailLogs()` reclaims abandoned PROCESSING/
  SMTP_ACCEPTED rows on restart (rows with a Message-Id are finalized SENT,
  never re-sent; rows without delivery evidence are requeued).
- PM scheduler reconciles missed executions after downtime without duplicate
  Work Orders.
- Stuck email rows older than 5min are recovered on each tick.

## Queue health
- `EmailLog` rows: QUEUED/PROCESSING/SMTP_ACCEPTED/SENT/DEAD_LETTER/FAILED.
- Stuck rows (PROCESSING/SMTP_ACCEPTED > 5min) are recovered automatically.
- Dead-letter rows are audited (`EMAIL_DEAD_LETTER`) and can be retried via
  `retryEmail(id)`.

## Scheduler health
- Email tick (`tickEmailWorker`, 10s) guarded by a running flag (no double
  tick).
- Workflow engine processes DomainEvents; idempotent handlers (one SUCCESS run
  per event + business-state re-check).
- PM scheduler monitors due dates; recovers missed runs without duplicates.

## Database health
- PostgreSQL `mohd_hms` database reachable; core tables present;
  migrations tracked; no auto seed on startup.
- Back up before schema changes; verify backup before restore.

## MinIO health
- Buckets for complaint WO media, IRMS attachments, invoices, quotations,
  letters present and readable; private URLs never exposed; secure access
  controls; media persists across restart.

## Backup verification
- Verify PostgreSQL backup restores cleanly in a safe environment.
- Verify MinIO objects retrievable after restore.
- Record last verified backup date.
