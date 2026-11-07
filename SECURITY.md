# Security — FacilityPro (MOHD.HMS ENTERPRISE)

## Authentication
- DB-backed session tokens (HttpOnly cookie); `src/components/hms/session.tsx`.
- 7 roles / 47 permissions (RBAC); server-authoritative.

## Authorization / RBAC
- Backend enforces every business rule; no frontend-only security.
- Customer-portal data scoping.
- Super Admin excluded from complaint-workflow notifications.
- Role-scoped online presence (backend-enforced); role-scoped presence privacy.

## Secrets
- `.env` is gitignored; production secrets live only in
  `/home/hasan/hms/shared/.env` (mode 0600); release bundles never carry
  secrets.
- Never print API keys / credentials in logs or reports.
- Email provider API key encrypted; sender verified.
- WhatsApp AI API keys never exposed.
- GitHub deploy webhook HMAC-SHA256 signature verification
  (`/home/hasan/hms-deploy/webhook.py`); repository whitelist; branch
  allowlist (`refs/heads/main`); rate limiting.

## File upload security
- Media uploaded to MinIO; metadata/relationships in PostgreSQL.
- No permanent production media in temporary container filesystems.
- Secure access controls on MinIO buckets; private MinIO URLs never exposed
  to customers.
- Attachments resolved at send time through authorized entities
  (`src/lib/hms/email/attachments.ts`).
- Header-injection guard: CR/LF stripped from subject/recipient headers
  (`email/service.ts`).
- Email recipient/sender validation; OTP critical emails bypass channel gate
  but never fake delivery.

## Webhooks
- GitHub push webhook: HMAC-SHA256, repo whitelist, branch allowlist, rate
  limit.
- Inbound email webhook: webhook-secret setting
  (`email_inbound_webhook_secret`).
- WhatsApp/OpenWA webhook: gateway-reachable URL; provisioned from
  `OPENWA_*` env.

## QR security
- QR labels with scan-to-open deep links per equipment unit; QR verification
  backend-enforced (`QR-PUBLIC-VERIFICATION.md`).

## Audit logs
- `audit_log` table: actor, action, resourceType, resourceId, metadata.
- Every state-changing business action audited; complaint timeline shows
  automation steps; email test/send/retry/cancel audited; dead-letter audited.

## Production security requirements
- No hardcoded business data or secrets in source.
- No destructive Git/Docker/DB commands on production.
- Preserve administrator configuration across restart.
- Health checks verify actual function, not mere process existence.
- Do not expose sensitive paths, credentials, or internal infrastructure to
  ordinary customers; authorized system diagnostics page for admins only.
