# Public QR Verification — `app.mohdhms.com`

Operational reference for the centralized public QR verification system.
Implementation follows the existing architecture: **one QRService**
(`src/lib/hms/qr/service.ts`), **one public verifier**
(`/verify/[token]` + `GET /api/v1/public/verify/[token]`), **one origin
setting**. No module builds its own QR URL; no second QR system exists.

## 1. Canonical public origin

Every QR code the system generates encodes:

```
https://app.mohdhms.com/verify/{token}
```

**Single authoritative source** (resolved in `verificationBaseUrl()`):

1. `Settings → public_url` (admin-editable in Settings → *Public Verification URL (QR)*) — the single source of truth
2. `PUBLIC_APP_URL` env (deployment-level fallback)
3. Incoming request origin (dev fallback only — never relied on in production)

Rules enforced everywhere:

- **HTTPS only** — QR URLs are never generated with `http://` (§9).
- **Never** `localhost`, `192.168.x.x`, `10.x.x.x`, or `www.mohdhms.com`
  inside a production QR (§2). `www.mohdhms.com` is *not* the verification
  origin; old codes carrying it are migrated (§4 below).
- The URL is derived at render time from the token — it is **not stored**
  per QR row, so changing the origin instantly canonicalises all future
  renders without a database migration (§11).

## 2. Token model

- `qr_codes` table (Prisma model `QrCode`): opaque `publicToken`
  (24 random bytes, base64url — unguessable, enumeration-proof),
  `entityType`, `entityId`, `documentVersion`, `status`, HMAC-SHA256
  `signature`, lifecycle timestamps.
- Tokens are **stable for the life of the record** (§12/§38): re-opening a
  record, re-printing a label or regenerating a PDF never rotates the token.
- `regenerateQr()` revokes the old identity (printed copies then verify as
  **REVOKED**) and issues a new one with `documentVersion + 1` (§17/§37).

## 3. Request flow (production)

```
Phone camera scan
  ↓
https://app.mohdhms.com/verify/{token}      (public — no login)
  ↓
Cloudflare DNS → Cloudflare Tunnel → Nginx → Next.js app
  ↓
/verify/[token] page → GET /api/v1/public/verify/{token}
  ↓
rate limit (20/min/IP) → token shape gate → indexed lookup
  → HMAC signature check → lifecycle check (REVOKED/EXPIRED)
  → entity load → status derivation (VALID/CANCELLED/SUPERSEDED)
  → safe whitelist DTO
  ↓
✓ VERIFIED  /  REVOKED  /  EXPIRED  /  CANCELLED  /  SUPERSEDED
  /  RESTRICTED  /  INVALID (not found, bad token, bad signature)
```

**Deployment checklist (must be verified from OUTSIDE the LAN, §23):**

- [ ] Cloudflare DNS `app` → tunnel (proxied, orange cloud)
- [ ] Tunnel ingress `app.mohdhms.com` → `http://localhost:3100` (app port)
- [ ] Nginx/vhost serves the Next.js app; `X-Forwarded-Proto/Host` forwarded
- [ ] HTTP→HTTPS redirect on (Cloudflare "Always Use HTTPS")
- [ ] `Settings → public_url = https://app.mohdhms.com` (or `PUBLIC_APP_URL`
      env set — the Settings value wins)
- [ ] Real-device test: scan a printed QR on **mobile data** (not Wi-Fi),
      confirm the page opens without login

## 4. Legacy QR migration (§36)

Old codes may embed `https://www.mohdhms.com/verify/…`, a LAN address or
`localhost`. Strategy:

1. **Origin migration** — `bun scripts/migrate-qr-origin.ts` rewrites the
   `public_url` setting from any legacy origin to
   `https://app.mohdhms.com`. Idempotent; safe to rerun. URLs are derived at
   render time, so no QR rows change.
2. **Host canonicalisation** — `src/middleware.ts` 308-redirects any
   non-canonical host on `/verify/*` to `https://app.mohdhms.com/verify/*`
   (active only when `PUBLIC_APP_URL` is set to an https origin). Old printed
   codes keep working; they land on the canonical verifier.
3. **In-app scanning** — the scan module and header QR dialog accept *both*
   formats: `/verify/{token}` URLs and legacy `/?resource=equipment:{token}`
   deep links.

## 5. Security posture

| Concern | Control |
|---|---|
| Enumeration | 24-byte random tokens + shape gate before DB + identical response for invalid/not-found/bad-signature |
| Abuse | Sliding-window rate limit 20 verifications/min/IP (429 + `Retry-After`), every rejection audited |
| Tampering | HMAC-SHA256 over canonical payload, constant-time compare |
| Data leakage | Whitelist public DTOs per type (`src/lib/hms/qr/verifiers.ts`); drafts/unapproved reports → RESTRICTED; no internal IDs, costs, notes, tokens |
| SEO | Page `robots: noindex, nofollow` + `X-Robots-Tag` on every API response (§25) |
| Caching | `Cache-Control: no-store` — every scan hits the live backend (§16/§62) |
| Audit | Every attempt logged to `qr_verification_logs` (result, hashed IP, UA snippet); VERIFIED increments `verifyCount` |
| Revocation | Revoked QRs still resolve publicly with "DOCUMENT NOT VALID" + reason (§28) — never a generic 404 |

## 6. Environment matrix (§35)

| Environment | Origin source | Value |
|---|---|---|
| Development | request origin fallback | `http://localhost:3000` |
| Staging | `Settings → public_url` / `PUBLIC_APP_URL` | staging origin |
| Production | `Settings → public_url` | `https://app.mohdhms.com` |

## 7. What must NOT exist (guard rails)

- No QR menu item in the navigation (§40) — verification is URL-only.
- No module-local URL construction — only `verificationUrl()` in the
  QRService (§39); PDF renderers only call `pdfQrBadge()` (§18).
- No `window.location.origin`-derived production QR (§34).
- No login required on `/verify/*`; no exposure of the internal entity APIs.
