# Notification Navigation Implementation Plan

> **For agentic workers:** Execute task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every in-app notification click opens the correct existing page/record, marks the item read immediately, and keeps the bell badge accurate on desktop and mobile.

**Architecture:** One pure `notification-target` resolver shared by the header and push pipeline. The header uses it to navigate; the API gains the missing `PATCH /api/v1/notifications`. Types without a dedicated detail page map to the best existing page (HR tab, inventory focused list, profile self-service); wrong creation values (WhatsApp chatId, PM finding id) are corrected at the source with resolver aliases for legacy rows.

**Tech Stack:** Next.js 16, React 19, Prisma, Bun, existing `api`/`navigateTo` utilities.

**Spec:** Existing notification investigation (no separate spec file).

## Global Constraints

- Do not change the Notification schema.
- Reuse `navigateTo`; add no routing library.
- Keep MOHD HMS branding and responsive behavior.
- Do not touch the 63 unrelated dirty working-tree files.
- No commits unless explicitly requested.

## Review Focus

- Notification with unknown/empty resource type: marks read, does not navigate or open a redirect.
- Soft-deleted/missing record: destination page shows its own not-found state, never a blank shell.
- Rapid double click: badge decrements once, never below zero.
- PATCH failure: optimistic read state rolls back and the user sees a toast.
- Keyboard click on a notification: same navigation as pointer click.

---

### Task 1: Mark-read API

**Files:**
- Modify: `src/lib/hms/notifications.ts` (restore `markNotificationsRead`)
- Modify: `src/app/api/v1/notifications/route.ts` (add `PATCH`)

**Interfaces:**
- Produces: `markNotificationsRead(userId: string, ids: string[]): Promise<{ updated: number; unread: number }>`
- Produces: `PATCH /api/v1/notifications` body `{ ids?: string[]; all?: boolean }` → `{ updated, unread }`

- [x] Add Zod schema (`ids` max 100, `all` boolean), require one mode.
- [x] Call `markAllNotificationsRead` for `all`, otherwise `markNotificationsRead`.
- [x] Return `ok(result)`.

### Task 2: Central resolver

**Files:**
- Create: `src/lib/hms/notification-target.ts`
- Modify: `src/lib/hms/router.ts` (remove duplicated `RESOURCE_ROUTES`)
- Modify: `src/lib/hms/push-server.ts` (delegate `routeFor`)
- Test: `src/lib/hms/notification-target.test.ts`

**Interfaces:**
- Produces: `type NotificationTarget = { module: string; seg: string[]; query?: Record<string, string> }`
- Produces: `notificationTarget(resourceType?: string | null, resourceId?: string | null): NotificationTarget | null`
- Produces: `notificationHref(resourceType?: string | null, resourceId?: string | null): string`
- Consumes: nothing

- [x] Canonical map: complaints, work-orders, equipment, customers, invoices, quotations, purchases, irms reports, checklists, files, email, whatsapp, HR letters/payroll, profile (USER/SESSION/ProfileChangeRequest/PAYROLL_ITEM), HR leave/overtime tabs, inventory focus query, PM tasks/plans.
- [x] Aliases: `PmTask→PM_TASK`, `LeaveRequest/HR_LEAVE→LEAVE_REQUEST`, `ProfileChangeRequest→PROFILE_CHANGE_REQUEST`, `InspectionReport→INSPECTION_REPORT`, `OvertimeRequest→OVERTIME_REQUEST`, `PayrollRun→PAYROLL_RUN`, `PayrollItem→PAYROLL_ITEM`, `PayrollAdjustment→PAYROLL_ADJUSTMENT`.
- [x] Unknown type or empty id → `null`; `notificationHref` → `/dashboard`.
- [x] Push `routeFor` returns `notificationHref(...)`.

### Task 3: Header dropdown

**Files:**
- Modify: `src/components/hms/shell/header.tsx:100-120,500-550`

- [x] `markRead`: snapshot state, optimistically set `readAt` + decrement badge, PATCH, adopt server `unread`; on error roll back and toast.
- [x] `markAllRead`: same optimistic pattern against `/read-all`.
- [x] Click: mark read, resolve target via `notificationTarget`, close dropdown + `navigateTo(module, seg, query)` when found.
- [x] Keep whole card a real `<button type="button">`; add descriptive `aria-label`; no nested buttons.

### Task 4: Destination + creation fixes

**Files:**
- Modify: `src/components/hms/modules/hr/index.tsx` (tab query)
- Modify: `src/components/hms/modules/inventory/index.tsx` (focus query filter)
- Modify: `src/app/api/v1/whatsapp/inbound.ts` (conversation id in notify)
- Modify: `src/app/api/v1/whatsapp/conversations/[id]/route.ts` (GET accepts chatId fallback)
- Modify: `src/app/api/v1/pm/findings/route.ts` (notify task/plan id)

- [x] HR: read `?tab=` (validated) and pass to `HrList` keyed by query.
- [x] Inventory: `?focus={id}` filters the item table to that row with a clear-filter banner.
- [x] WhatsApp handoff: look up conversation id by chatId; use it in both notifications. GET detail also resolves chatId.
- [x] PM finding: notify with `PM_TASK` + `pmTaskId` when present, else `PM_PLAN` + `planId`, else legacy `PM_FINDING`.

### Task 5: Verification

- [x] `bun test src/lib/hms/notification-target.test.ts`
- [x] `npx eslint` changed files
- [x] `npm run build`
- [ ] Manual (requires running app): login, click each seeded notification type, confirm route + badge; PATCH 200; failed PATCH rollback (offline).
