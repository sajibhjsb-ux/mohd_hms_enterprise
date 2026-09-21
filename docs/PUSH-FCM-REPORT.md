# Firebase Push Notification System — Implementation Report (FCM)

**Scope:** complete, production-ready push notifications for MOHD.HMS ENTERPRISE /
FacilityPro, integrated into the EXISTING notification architecture. No duplicate
notification tables, event systems, services, or service workers were created.

---

## 1. FIREBASE SETUP

What was added (all configuration-driven; nothing hardcoded):

| Environment variable | Purpose | Exposure |
|---|---|---|
| `FIREBASE_SERVICE_ACCOUNT` (inline JSON) **or** `FIREBASE_SERVICE_ACCOUNT_PATH` **or** `FIREBASE_PROJECT_ID`/`FIREBASE_CLIENT_EMAIL`/`FIREBASE_PRIVATE_KEY` | Admin SDK credential (HTTP v1 API) | **Server-only.** Never sent to the browser, never stored in DB, never logged |
| `FIREBASE_CLIENT_API_KEY`, `_AUTH_DOMAIN`, `_STORAGE_BUCKET`, `_MESSAGING_SENDER_ID`, `_APP_ID`, `_MEASUREMENT_ID` (optional) | Web client config for the Firebase Messaging SDK | **Public identifiers by design** — served to *authenticated* clients via `GET /api/v1/push/status`; ops can rotate without a rebuild |
| `FIREBASE_VAPID_KEY` | Web Push certificate public key (required by `getToken`) | Public by design |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT` | Legacy web-push transport (pre-existing system, unchanged behavior) | Public key public / private key server-only |

`.env.example` documents every variable + the Firebase console checklist
(FCM HTTP v1 API, Web Push certificate, authorized domain for
`https://www.mohdhms.com`).

**Honest status:** this sandbox has **no real Firebase project credentials**
(creating one requires Google Cloud console access). The FCM transport is
fully implemented and activates automatically the moment the service account +
client config are present. Every UI/API surface reports
`fcm.configured = false` **truthfully** instead of pretending. Real delivery
in this environment was verified through the **VAPID transport** (see §7).

## 2. BACKEND

New domain folder `src/lib/hms/push/` (mirrors the existing `email/` and
`whatsapp/` domains):

- **`fcm.ts`** — the ONE Firebase integration point. Lazy Admin SDK bootstrap
  (`initializeApp("hms-push")`, `cert()` credentials), `sendEachForMulticast`
  (current API) in chunks of **500 tokens** (FCM limit), **per-token result
  classification** (`sent` / `permanent` / `transient`), data-only messages,
  Web Push `Urgency` headers + Android `priority` from the payload priority.
  Loading is deferred — an unconfigured deployment never imports the SDK.
- **`vapid.ts`** — idempotent `setVapidDetails` wrapper. Fixes a real
  production defect found during testing: Next.js can load multiple module
  instances (scheduler bundle vs API bundles); the worker bundle previously
  sent requests **without** the VAPID Authorization header (Google answered
  401). `ensureVapidConfigured()` is now called at every delivery site.
- **`preferences.ts`** — per-user push categories (COMPLAINTS, WORK_ORDERS,
  PM, INVOICES, QUOTATIONS, PAYMENTS, EQUIPMENT, IRMS, HR, SYSTEM_ALERTS),
  resourceType → category resolution, sanitize/save/merge.
- **`worker.ts`** — the ONE push delivery loop (same pattern as
  EmailService/WhatsAppService): claim (`QUEUED → SENDING` via atomic
  `updateMany`), fan out to FCM devices + legacy VAPID subscriptions,
  per-recipient accounting, retry with backoff (30 s → 2 m → 10 m, max 3),
  `DEAD_LETTER` terminal state, stuck-`SENDING` recovery, invalid-token
  deactivation, daily cleanup (devices ≥5 consecutive failures; PushLog
  retention 90 days — in-app notifications are never touched).

- **`push-server.ts`** (existing file, evolved) — unified dispatcher. Public
  API unchanged (`sendPushToUser`, `vapidPublicKey`), now:
  **idempotent enqueue** (a QUEUED/SENDING/SENT row with the same
  `dedupeKey` = in-app notification id short-circuits duplicate events),
  per-user category preference gating, priority derivation
  (ERROR/WARNING → HIGH), server-computed RBAC-safe route (`routeFor`).
- **`services.ts`** — `notify()` now links the in-app notification with the
  push delivery (`notificationId`), carries priority. Email/WhatsApp flows
  untouched.
- **`workflows/scheduler.ts`** — `tickPushWorker` added to the EXISTING
  scheduler loop (no second scheduler).

**Endpoints** (all authenticated; backend derives the user from the session —
client-sent `user_id` is never trusted):

| Route | Purpose |
|---|---|
| `GET /api/v1/push/status` (extended) | VAPID key + FCM block (public client config) + device count |
| `POST /api/v1/push/devices/register` | FCM device upsert by token (token refresh safe, rate-limited, audited) |
| `POST /api/v1/push/devices/unregister` | Self-unregister (disable/logout), idempotent |
| `GET/DELETE /api/v1/push/devices` | Own devices (FCM + VAPID merged) / remove one (ownership-checked) |
| `GET/PUT /api/v1/push/preferences` | Per-category push preferences |
| `GET /api/v1/push/admin/overview` | Notification center stats (perm `push.view`) |
| `GET /api/v1/push/admin/devices?userId=` | Target user devices for the test dialog (perm `push.view`) |
| `POST /api/v1/push/admin/test` | **Real** test push, executed inline, returns the authoritative result (perm `push.manage`, rate-limited, audited, `isTest` flagged) |

## 3. FRONTEND

- **`push-client.ts`** (new) — FCM client: lazy `firebase/app` + `firebase/messaging`
  dynamic imports, config fetched from the server, `getToken` bound to the
  **existing `/sw.js` registration** (no `firebase-messaging-sw.js` — ONE
  service worker), Firebase Installation ID capture, foreground `onMessage`
  wired as a **refresh nudge only** (no duplicate OS notification in
  foreground — spec §16), `syncPushOnLogin()` silent re-registration
  (only when permission was already granted).
- **`pwa.ts`** — `enablePush()` is now ONE flow with automatic transport
  selection: FCM when configured → legacy VAPID otherwise. `disablePush()`
  disables both. Status type extended.
- **`public/sw.js`** — integrates FCM into the EXISTING service worker:
  `safePayload` unwraps the FCM data-envelope (`data.data`, defensive
  `notification` block). Version bumped `v2 → v3` (user-consented update
  flow untouched). PWA caching/offline/background-sync untouched.
- **`pwa-menu.tsx`** — contextual permission dialog (§18): explain →
  [Enable Notifications] / [Not Now] → granted → toast; denied →
  browser-settings instructions, never re-prompts automatically.
- **Profile** (`modules/profile/push-settings.tsx`) — "Registered devices"
  (kind badge, last seen, remove) + "Push preferences" (per-category switches),
  reusing the one shared enable flow.
- **Settings → Notifications tab** (`notifications-tab.tsx`, ADMIN via
  `push.view`) — channel status (honest "Not configured" + setup guidance),
  device counts, 7-day delivery stats, recent deliveries + errors, and the
  **test sender** (user → device → real send → actual result; "Success" only
  when the transport accepted the message).
- **`session.tsx`** — login: silent push re-binding; logout: this browser's
  FCM token unregisters (other devices untouched; VAPID keeps its existing
  owner-rebinding policy).

## 4. DATABASE (Prisma / SQLite → PostgreSQL-ready)

Added to the existing schema (no duplicate notification tables):

- **`PushDevice`** — the spec's `notification_devices`: unique FCM token,
  `installationId`, platform, device/browser/OS/appVersion, permission status,
  `active`, `lastSessionId`, `failureCount`/`lastError` (pruning inputs),
  `lastSeenAt`.
- **`PushLog`** — delivery history (EmailLog pattern): `QUEUED → SENDING →
  SENT / FAILED (retry) → DEAD_LETTER`, `SKIPPED` with explicit `errorCode`
  (`Unconfigured`, `NoDevices`, `Permanent`, `Transient`,
  `ChannelDisabled`), `dedupeKey` (idempotency), `notificationId` (in-app
  sync), route, priority, transport, per-recipient counts, `fcmMessageId`,
  `targetDeviceId` (test targeting), `isTest`, error class/message.
- **`NotificationPreference`** — one row per user, JSON category map.

Redis is **not** used as the history store (PostgreSQL remains authoritative).
The existing `Notification` table (in-app) is unchanged.

## 5. REDIS / QUEUE

The existing app architecture uses **DB-backed outbox queues driven by the
scheduler** (no Redis client in the Next.js app — matching EmailService/
WhatsAppService). Push follows the SAME pattern: enqueue in the business
transaction path is fire-and-forget; the worker runs in the existing
scheduler loop + is kicked directly after enqueue for low latency. FCM
being down **never** blocks a complaint/work-order/invoice transaction.

## 6. EVENTS

All business notifications flow through the ONE `notify()`/`notifyRole()`
service — every existing call site (~30 files: complaints, work orders, PM,
quotations, invoices, payments, IRMS, HR, users, equipment, checklist engine,
WhatsApp inbound, workflow handlers/scheduler) now also produces push
deliveries automatically, with:
- role-based recipients resolved from the canonical DB **at event time**
  (role changes affect eligibility immediately — no stale caches),
- per-user category preferences,
- `WARNING`/`ERROR` notifications automatically promoted to HIGH priority.

## 7. SECURITY

- Service-account private key / VAPID private key: **server env only**;
  never in code, DB, responses, or logs.
- Browser receives only public identifiers (Firebase web config + VAPID
  public key) via an authenticated endpoint.
- Device registration binds to the **session user**; client-sent user ids are
  ignored. Token upsert enforces one row per device (no duplicate delivery);
  cross-user token re-binding happens only through an authenticated request.
- Push routes are **server-computed** and relative (`/...`); the SW rejects
  anything else — no forged deep links. RBAC is enforced by the modules the
  route opens and by every underlying API.
- Rate limits: device register (30/5 min per user+IP), admin test
  (20/hour per admin). Duplicate suppression via `dedupeKey`.
- Audit events: `PUSH_DEVICE_REGISTERED`, `PUSH_DEVICE_UNREGISTERED`,
  `PUSH_DEVICE_REMOVED`, `PUSH_TEST_SENT`.

## 8. TESTING (real, not mocked)

**Verified in this environment** (Chromium, `channel="chromium"` new headless,
persistent context, real notification permission):

| Check | Result |
|---|---|
| Login → SW active → permission granted | ✅ |
| Enable via Profile UI → real `pushManager.subscribe` → Google endpoint | ✅ |
| Device persisted (PushSubscription / PushDevice) | ✅ |
| **Real business event** (complaint created) → `notify()` → queue → worker → **real push RECEIVED and displayed by the browser SW** | ✅ |
| Notification carries app icon + deep-link `/complaints/{id}` (relative, RBAC-safe) | ✅ |
| **Background delivery** (no open tab at send time) | ✅ |
| Admin test sender → pipeline `SENT` (per-device counts) | ✅ |
| **Retry system in real conditions**: transient 502 from the push service → backoff → retry → `SENT` | ✅ |
| Honest negative paths: `SKIPPED/NoDevices`, FCM `configured:false`, register refused without Firebase | ✅ |
| Duplicate suppression (`dedupeKey`), idempotent unregister/remove | ✅ |
| Preferences round-trip (10 categories) + gating | ✅ |
| Regression: login, complaints, dashboard, notifications, email health, WhatsApp health, push APIs — all 200; `eslint` clean | ✅ |
| Google FCM **accepted a real message for a real device** (HTTP **201 + message id**) and the live browser displayed it | ✅ |

**Environment limitation (honest):** this sandbox's egress intermittently
breaks POST bodies to `jmt17.google.com` (Chrome's push endpoint edge — hard
502, while `fcm.googleapis.com` answers correctly). Deliveries therefore
occasionally require the worker's retry pass (verified working), and the
end-to-end FCM transport could not be exercised with a REAL Firebase project
because none can be created from the sandbox. **Production claim:** push
notifications are verified up to real delivery through the VAPID transport
(same pipeline, same worker, same service worker); the FCM transport becomes
live by adding the documented Firebase credentials and enabling
Settings → Automation → Push notifications. Per the spec, no unverified FCM
delivery is claimed.

## 9. DELIVERY

**Yes — an actual push notification was received and displayed by a real
browser service worker** (business event "New complaint" with deep-link
route, and background delivery while no tab was open), and Google's push
infrastructure accepted the message with HTTP 201 + message id. Screenshot:
`/home/z/tmp-verify/settings-notifications-tab.png`.

## 10. KNOWN LIMITATIONS

1. Real-project FCM delivery requires production Firebase credentials
   (documented in `.env.example`); the UI/API report config status honestly.
2. FCM topics are intentionally **not** used for business notifications —
   user-level authorization is inherent to `notify()` recipients (topics would
   bypass per-user preferences/RBAC). Topic broadcast remains available in the
   FCM service design if a genuine broadcast need appears.
3. Push preferences gate the push channel only; in-app/email/WhatsApp keep
   their existing business rules (no behavioral change to those channels).
4. Safari/iOS PWA push follows the same Web Push path (16.4+); not testable
   from this Linux sandbox — no platform-specific code was added.
5. PushLog retention is 90 days (configurable constant in `push/worker.ts`);
   in-app Notification history is never pruned by the push system.

## 11. FILES

- Backend: `src/lib/hms/push/{fcm,vapid,preferences,worker}.ts`,
  `src/lib/hms/push-server.ts`, `src/lib/hms/services.ts`,
  `src/lib/hms/workflows/scheduler.ts`, `src/lib/hms/constants.ts`
- API: `src/app/api/v1/push/**` (status, devices, register, unregister,
  preferences, admin/{overview,devices,test})
- Frontend: `src/lib/hms/push-client.ts`, `src/lib/hms/pwa.ts`,
  `src/components/hms/shell/pwa-menu.tsx`,
  `src/components/hms/modules/profile/{index,push-settings}.tsx`,
  `src/components/hms/modules/settings/{index,notifications-tab}.tsx`,
  `src/components/hms/session.tsx`, `public/sw.js`
- Data: `prisma/schema.prisma` (+`PushDevice`, `PushLog`, `NotificationPreference`)
- Config/docs: `next.config.ts` (`serverExternalPackages: web-push, firebase-admin`),
  `.env.example`, QA scripts `scripts/push-*.py`, `scripts/send-webpush.js`
